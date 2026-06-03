/**
 * Top-level query orchestrator. Implements ARCH §6 steps 1–7 and returns a
 * fully shaped AskResult. The HTTP layer (stage 7) maps the result onto JSON
 * + adds answer caching + handles invalid_scope status codes.
 *
 * Pipeline:
 *   1. Validate inputs (question length, scope_id existence in pages table)
 *   1.5 Detect query lang (scope_id > text)
 *   2. Boundary filter is applied inside retrieval SQL (status='published',
 *      optional subtree_root match)
 *   3. Hybrid retrieve (vector + BM25 + RRF)
 *   4. Structural rerank (lang_boost / same_subtree_boost / nav_index_boost)
 *   5. Subtree aggregate → answer-same-lang | translate-fallback
 *   6. Build prompt + generate via LLM
 *   7. Postprocess (citation legality, lang fill, truncation, hallucination)
 *
 * Step 8 (answer cache TTL 24h) is intentionally not done here — it's an
 * HTTP-layer concern in stage 7.
 */

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import type { DbHandle } from '../db/index.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM } from '../llm/types.ts';
import type { Reranker } from '../reranker/types.ts';
import type { PromptConfig, RerankerConfig } from '../config.ts';
import type { DocsLang } from '../anydocs/types.ts';
import { detectLangFromText, langFromScopeId } from './lang.ts';
import { sanitizeFtsQuery } from './sanitize.ts';
import { retrieveWithTrace, type RetrievalTrace, type RetrievedChunk } from './retrieval.ts';
import { computeTitleMatches } from './rerank.ts';
import { rerank, type RerankedChunk } from './rerank.ts';
import {
  apiReferenceChunkMatchesVersion,
  isApiReferenceChunk,
} from './api-intent.ts';
import { aggregate, TOP_K_FOR_AGGREGATION, type AggregateOutcome } from './aggregate.ts';
import { buildPrompt, detectFormatHint } from './prompt.ts';
import { LLMIntentRouter, type IntentRouter } from './intent-router.ts';
import { postprocess } from './postprocess.ts';
import type { AskRequest, AskResult } from './types.ts';

const MAX_QUESTION_CHARS = 500;
const HARD_MAX_CHUNKS = 20;
const DEFAULT_MAX_CHUNKS = 8;
/**
 * Number of times we retry an LLM call when postprocess strips every
 * citation. Bumped 1 → 2 after codex round-11 found ~10 % of the
 * problematic queries still 400'd on the first retry; a second retry
 * should bring residual flake rate below 1 %. Streaming requests don't
 * retry — see the retry loop in askWithTraceInternal.
 */
const MAX_CITATION_RETRIES = 2;

export type AskDeps = {
  db: DbHandle;
  embedder: Embedder;
  llm: LLM;
  /**
   * Cross-encoder reranker. Optional — when null/omitted the cross-encoder
   * rerank stage is skipped and the rule rerank is the only ranking
   * authority. answer.ts gates the entire stage on this being non-null so
   * v1 callers stay byte-equivalent.
   */
  reranker?: Reranker | null;
  /** Cross-encoder rerank config (window size etc). Optional; defaults
   *  applied inline so test deps don't need to construct one. */
  rerankerConfig?: RerankerConfig;
  promptConfig?: PromptConfig;
  intentRouter?: IntentRouter | null;
};

export type AskStatusStage = 'retrieving' | 'generating';

export type AskStreamHooks = {
  signal?: AbortSignal;
  onStatus?: (stage: AskStatusStage) => void | Promise<void>;
  onDelta?: (text: string) => void | Promise<void>;
};

/**
 * Diagnostic trace captured alongside the result. Persisted to runs.jsonl
 * (ARCH §16.4) but never sent on /v1/ask responses. v1.5 §15 §16.6 analyze
 * commands read this back to compute recall-failure / latency / etc. metrics.
 */
export type AskTrace = {
  /** Reranked chunks (sorted descending by final_score). Empty on early-error
   *  paths (validation / invalid_scope). */
  fused: AskTraceFusedChunk[];
  /** True when aggregate decided to fire a clarify (subtree-aggregation ask). */
  subtree_ask_triggered: boolean;
  /** Top final_score from rerank — raw RRF + nav-boost output. Kept for
   *  analyze diagnostics; not the value persisted as `answer.confidence`. */
  top_final_score: number;
  /** Normalized confidence: top1.final_score / sum(top-K.final_score), K=5.
   *  In [0,1]; `1.0` when only one candidate, `0` when no candidates.
   *  This is what runs.jsonl `answer.confidence` carries (ARCH §16.4). */
  confidence: number;
  /** LLM token counts when the provider exposes them. v1 leaves these null;
   *  later stages can set them when the LLM interface is widened. */
  tokens_in: number | null;
  tokens_out: number | null;
  /** Number of recovery retries issued after the first LLM response had
   *  zero valid citations. Bounded by MAX_CITATION_RETRIES (currently 2);
   *  0 on the success path. Persisted to runs.jsonl so analyze can track
   *  flake rate over time. */
  citation_retry_count?: number;
  /** RFC 0003 M4 — number of prior session turns the pipeline consumed for
   *  THIS call (embedding splice + prompt). Mirrors the field surfaced on
   *  the result body; duplicated into the trace so runs.jsonl analyses can
   *  filter / group on multi-turn calls without re-joining on session_id.
   *  Undefined / 0 on single-turn or `multiTurn.enabled=false` paths. */
  history_window?: number;
};

export type AskTraceFusedChunk = {
  chunk_id: number;
  page_id: string;
  rrf_score: number;
  final_score: number;
  vec_rank: number | null;
  bm25_rank: number | null;
  nav_index: number | null;
  /** Same formula as rerank.ts navIndexBoostFor. Captured here so analyze can
   *  inspect "why did this chunk win" without re-running the math. */
  nav_index_boost: number;
};

/**
 * Server-internal return shape for the ask pipeline.
 *
 * `queryVector` is the embedder's output for the user's question — null when
 * the pipeline short-circuits before embedding runs (validation / scope
 * errors). Surfaced so the γ implicit-signal layer (ARCH §15.2.2) can do
 * similarity against recent same-session asks without re-embedding. Never
 * serialized to clients.
 */
export type AskWithTraceResult = {
  result: AskResult;
  trace: AskTrace;
  queryVector: Float32Array | null;
};

export async function ask(deps: AskDeps, req: AskRequest): Promise<AskResult> {
  return (await askWithTrace(deps, req)).result;
}

export async function askWithTrace(
  deps: AskDeps,
  req: AskRequest,
): Promise<AskWithTraceResult> {
  return askWithTraceInternal(deps, req);
}

export async function askWithTraceStream(
  deps: AskDeps,
  req: AskRequest,
  hooks: AskStreamHooks,
): Promise<AskWithTraceResult> {
  return askWithTraceInternal(deps, req, hooks);
}

async function askWithTraceInternal(
  deps: AskDeps,
  req: AskRequest,
  hooks: AskStreamHooks = {},
): Promise<AskWithTraceResult> {
  const t0 = performance.now();
  const emptyTrace = (): AskTrace => ({
    fused: [],
    subtree_ask_triggered: false,
    top_final_score: 0,
    confidence: 0,
    tokens_in: null,
    tokens_out: null,
  });

  // 1. Input validation.
  if (req.question === undefined || req.question === null) {
    return {
      result: errorResult('invalid_question', "field 'question' is required"),
      trace: emptyTrace(),
      queryVector: null,
    };
  }
  const question = req.question.trim();
  if (question.length === 0) {
    return {
      result: errorResult('invalid_question', 'question must not be empty'),
      trace: emptyTrace(),
      queryVector: null,
    };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return {
      result: errorResult('invalid_question', `question exceeds ${MAX_QUESTION_CHARS} characters`),
      trace: emptyTrace(),
      queryVector: null,
    };
  }

  const scopeId = req.context?.scope_id ?? null;
  if (scopeId !== null) {
    const valid = isValidScopeId(deps.db, scopeId);
    if (!valid) {
      return {
        result: errorResult('invalid_scope', `scope_id '${scopeId}' is not a published subtree`),
        trace: emptyTrace(),
        queryVector: null,
      };
    }
  }

  // 1.5 Lang detection.
  const queryLang = resolveQueryLang(deps.db, question, req);
  const utilityAnswer = utilityAnswerFor(question, queryLang, deps.promptConfig);
  if (utilityAnswer) {
    return {
      result: {
        type: 'answer',
        answer_id: makeAnswerId(),
        answer_lang: queryLang,
        answer_md: utilityAnswer,
        translation_notice: null,
        citations: [],
        used_chunks: 0,
        model: 'static',
        latency_ms: Math.round(performance.now() - t0),
      },
      trace: emptyTrace(),
      queryVector: null,
    };
  }

  // 3. Hybrid retrieve.
  throwIfAborted(hooks.signal);
  await hooks.onStatus?.('retrieving');
  const currentSubtreeRoot = null;
  // RFC 0003 §4.2 — multi-turn history-aware retrieve query (M1).
  // A single LLM intent router now owns the semantic decisions that used to
  // be spread across deterministic query rewrite + API-intent rules:
  //   - whether this turn is standalone or a follow-up
  //   - whether session history should enter retrieval / prompt context
  //   - which retrieval hints should bias API reference/supporting context
  // The raw current question is still embedded separately for γ feedback
  // similarity; only the retrieve vector sees the router's effective query.
  const history = req.context?.history ?? [];
  const intentRouter = deps.intentRouter ?? new LLMIntentRouter(deps.llm);
  const intentRoute = await intentRouter.route({ question, history, lang: queryLang });
  const activeHistory = intentRoute.usesHistory ? history : [];
  const historyWindow = activeHistory.length;
  const searchQuestion = intentRoute.effectiveQuestion || question;
  const apiIntent = intentRoute.apiIntent;
  const signatureAuthIntent = intentRoute.signatureAuthIntent;
  const retrieveQuestion = intentRoute.usesHistory
    ? intentRoute.rewritten
      ? intentRoute.effectiveQuestion
      : `${activeHistory.map((h) => h.question).join('\n')}\n${question}`
    : searchQuestion;
  // Two distinct vectors when multi-turn is active:
  //   - `queryVector` (raw current question) is what we return and what γ
  //     uses for cross-turn similarity comparison. γ asks "did the user
  //     re-ask the same question?" — that signal must compare current_q to
  //     prior current_q. If γ saw the history-augmented vector, identical
  //     questions across turns would never reach the 0.85 threshold because
  //     the history prefix grows monotonically.
  //   - `retrieveVector` (history-augmented) is what feeds the vector
  //     retrieve path. RFC §4.2 — the splice anchors retrieval in the
  //     dialogue's prior region.
  // Batched into one embed() call so multi-turn asks pay one round-trip
  // instead of two (Embedder contract takes a `string[]` for exactly this
  // reason). Single-turn calls submit one input and keep the alpha.0 cost.
  const embedInputs = retrieveQuestion === question ? [question] : [question, retrieveQuestion];
  const embedded = await deps.embedder.embed(embedInputs);
  const queryVector = embedded[0]!.vector;
  const retrieveVector = embedded[1]?.vector ?? queryVector;
  throwIfAborted(hooks.signal);
  const ftsQuery = sanitizeFtsQuery(searchQuestion);
  const entityTerms = extractEntityTerms(searchQuestion);
  const projectSetupIntent = intentRoute.projectSetupIntent;
  const apiReferenceHints = intentRoute.apiReferenceHints;
  const supplementalContextHints = intentRoute.supplementalContextHints;
  const supplementalPageIds = intentRoute.supplementalPageIds;
  const apiReferenceVersionPrefs = intentRoute.apiReferenceVersionPrefs;
  const apiReferenceHintTerms = apiReferenceHints
    .flatMap((hint) => hint.toLowerCase().split(/\s+/))
    .filter(Boolean);
  const apiReferenceFtsQueries = apiReferenceHints
    .map((hint) => sanitizeFtsQuery(hint))
    .filter((hint): hint is string => !!hint);
  const supplementalFtsQueries = supplementalContextHints
    .map((hint) => sanitizeFtsQuery(hint))
    .filter((hint): hint is string => !!hint);
  const { chunks: retrieved, trace: retrievalTrace } = retrieveWithTrace(deps.db, {
    queryVector: retrieveVector,
    ftsQuery,
    scopeId,
    entityTerms,
    currentPageId: null,
    currentPageLang: queryLang,
    apiIntent,
    apiReferenceFtsQueries,
    supplementalFtsQueries,
    supplementalPageIds,
    apiReferencePagePrefix: null,
  });

  // 4. Rerank — rule rerank first (cheap, applies structural biases), then
  // optionally a cross-encoder pass on the top window. The cross-encoder
  // recovers semantic relevance signals the rules can't express (e.g. that a
  // chunk literally contains the field definition the user asked about); the
  // rules still do the cheap structural work (same-subtree, nav order).
  const ruleReranked = rerank(retrieved, {
    queryLang,
    currentSubtreeRoot,
    currentPageId: null,
    query: searchQuestion,
    entityTerms,
    apiIntent,
    apiReferenceHintTerms,
    apiReferenceVersionPrefs,
    apiReferencePagePrefix: null,
  });

  const reranked = deps.reranker
    ? await applyCrossEncoderRerank(deps.reranker, searchQuestion, ruleReranked, deps.rerankerConfig)
    : ruleReranked;

  const fusedTrace = buildFusedTrace(reranked, retrievalTrace);
  const top_final_score = reranked[0]?.final_score ?? 0;
  const confidence = computeConfidence(reranked);

  // 5. Aggregate.
  // Derive title-match subtrees so aggregate can skip clarify when the user's
  // query explicitly names a page.
  const aggregationCandidates = pickAggregationCandidates(reranked, {
    apiIntent,
    signatureAuthIntent,
  });
  const titleMatchedPageIds = computeTitleMatches(retrieved, searchQuestion);
  const titleMatchedSubtrees = new Set<string>();
  for (const c of aggregationCandidates) {
    if (titleMatchedPageIds.has(c.page_id) && c.subtree_root) {
      titleMatchedSubtrees.add(c.subtree_root);
    }
  }
  const outcome = aggregate(aggregationCandidates, { queryLang, currentSubtreeRoot, titleMatchedSubtrees });

  // 6 + 7. Generate + postprocess.
  const isCrossLang = outcome.kind === 'translate-fallback';
  const pickedChunks = pickContextChunks(outcome, req.options?.max_chunks, entityTerms, {
    apiIntent,
    apiReferenceCandidates: reranked,
    apiReferenceHintTerms,
    apiReferencePagePrefix: null,
    apiReferenceVersionPrefs,
    projectSetupIntent,
    supplementalPageIds,
    queryLang,
  });
  const formatHint = detectFormatHint(question);
  const prompt = buildPrompt({
    question,
    ...(intentRoute.rewritten ? { resolvedQuestion: intentRoute.effectiveQuestion } : {}),
    chunks: pickedChunks,
    answerLang: queryLang,
    isCrossLang,
    formatHint,
    ...(deps.promptConfig ? { promptConfig: deps.promptConfig } : {}),
    ...(entityTerms ? { entityTerms } : {}),
    ...(historyWindow > 0 ? { history: activeHistory } : {}),
  });

  let llmOutput;
  throwIfAborted(hooks.signal);
  await hooks.onStatus?.('generating');
  const llmInput = {
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
  };
  const isStreaming = !!(hooks.onDelta && deps.llm.streamGenerate);
  try {
    llmOutput = isStreaming
      ? await deps.llm.streamGenerate!(llmInput, {
          signal: hooks.signal,
          onDelta: hooks.onDelta!,
        })
      : await deps.llm.generate(llmInput);
  } catch (err) {
    // LLM call failure (gateway returned garbage / timed out / threw mid-
    // stream). Distinct from `llm_unavailable` which is the *construction*
    // failure (no API key / bad config) — that one short-circuits before
    // askWithTrace runs. Returning an error result here lets the HTTP layer
    // append a kind='error' record with the partial retrieval trace so
    // analyze D1 / D2 stay honest about upstream instability (ARCH §16.4).
    return {
      result: errorResult(
        'llm_failed',
        userMessageForError('llm_failed', queryLang),
        (err as Error).message,
      ),
      trace: {
        fused: fusedTrace,
        subtree_ask_triggered: false,
        top_final_score,
        confidence,
        tokens_in: null,
        tokens_out: null,
      },
      queryVector,
    };
  }
  throwIfAborted(hooks.signal);

  let post = postprocess({
    answerLang: queryLang,
    rawAnswer: withMandatoryApiReferenceCitation(llmOutput.text, prompt.chunkById, {
      apiIntent,
      apiReferenceHintTerms,
      answerLang: queryLang,
    }),
    chunkById: prompt.chunkById,
    question,
  });

  // Citation-validation retry. When the first response strips to zero
  // citations, the model produced text but forgot the `[cit_N]` markers
  // — a documented flake mode. Issue up to MAX_CITATION_RETRIES retries
  // with a reinforced system prompt that explicitly calls out the prior
  // failure and demands the marker. Streaming requests skip retry: the
  // client already received the failed deltas and a second pass would
  // scramble the user-visible stream. Non-streaming callers see a
  // transparent retry — same JSON shape, slightly higher latency.
  //
  // Bumped 1 → 2 in codex round-11 (2/20 still 400 on the first retry;
  // a second retry should bring flake rate below 1%).
  let citationRetryCount = 0;
  if (!isStreaming) {
    while (post.used_chunks === 0 && citationRetryCount < MAX_CITATION_RETRIES) {
      citationRetryCount += 1;
      const retryInput = {
        systemPrompt: prompt.system + '\n\n' + citationReinforcementFor(queryLang),
        userPrompt: prompt.user,
      };
      try {
        const retryOutput = await deps.llm.generate(retryInput);
        const retryPost = postprocess({
          answerLang: queryLang,
          rawAnswer: withMandatoryApiReferenceCitation(retryOutput.text, prompt.chunkById, {
            apiIntent,
            apiReferenceHintTerms,
            answerLang: queryLang,
          }),
          chunkById: prompt.chunkById,
          question,
        });
        if (retryPost.used_chunks > 0) {
          llmOutput = retryOutput;
          post = retryPost;
          break;
        }
      } catch {
        // Retry itself threw — keep looping; the primary diagnostic is
        // "first call had no citations" and the trace count records how
        // many recovery attempts we made.
      }
    }
  }

  // Guard: if postprocess stripped every citation (LLM produced no valid
  // citation markers, retry included), surface as an error so the caller
  // can distinguish "retrieved but couldn't cite" from a real answer.
  if (post.used_chunks === 0) {
    return {
      result: errorResult(
        'no_citations',
        userMessageForError('no_citations', queryLang),
        'LLM response contained no valid citations',
      ),
      trace: {
        fused: fusedTrace,
        subtree_ask_triggered: false,
        top_final_score,
        confidence,
        tokens_in: null,
        tokens_out: null,
        citation_retry_count: citationRetryCount,
      },
      queryVector,
    };
  }

  // Answer-text lang sanity (one-way correction only): if queryLang detected
  // as 'en' but the LLM actually replied in zh (common with mostly-ASCII zh
  // queries — the model picks up on Chinese phrasing and outputs zh even
  // when the prompt label said en), surface the answer as zh so the client
  // gets a coherent answer_lang. We DON'T correct the reverse (zh queryLang
  // with en answer) — that's the legitimate cross-lang fallback where the
  // LLM was told to translate en chunks to zh but the cross-lang prompt
  // failed or mock-LLM tests use stub responders; PRD §8 #11 explicitly
  // expects answer_lang=queryLang in that direction.
  const answerLangFromText = detectLangFromText(post.answer_md);
  const finalAnswerLang: DocsLang =
    queryLang === 'en' && answerLangFromText === 'zh' ? 'zh' : queryLang;
  const citationLangs = new Set(post.citations.map((c) => c.lang));
  const finalIsCrossLang = !citationLangs.has(finalAnswerLang);

  return {
    result: {
      type: 'answer',
      answer_id: makeAnswerId(),
      answer_lang: finalAnswerLang,
      answer_md: post.answer_md,
      translation_notice: finalIsCrossLang ? translationNoticeFor(finalAnswerLang) : null,
      citations: post.citations,
      used_chunks: post.used_chunks,
      model: llmOutput.modelUsed,
      latency_ms: Math.round(performance.now() - t0),
      ...(historyWindow > 0 ? { history_window: historyWindow } : {}),
    },
    trace: {
      fused: fusedTrace,
      subtree_ask_triggered: false,
      top_final_score,
      confidence,
      tokens_in: null,
      tokens_out: null,
      citation_retry_count: citationRetryCount,
      ...(historyWindow > 0 ? { history_window: historyWindow } : {}),
    },
    queryVector,
  };
}

/**
 * Reinforced instruction appended to the system prompt when the first LLM
 * call returned text without citation markers. The retry prompt names the
 * prior failure explicitly so the model is less likely to skip them again.
 */
function citationReinforcementFor(lang: DocsLang): string {
  if (lang === 'zh') {
    return [
      '【重要修正】上一次回答没有包含任何 [cit_N] 标记，输出被丢弃。',
      '这一次必须在答案中每个事实陈述后内联 [cit_1] / [cit_2] 等标记。',
      '可用 cit 编号已经在上方参考片段每个 [cit_N] 标头处给出，请逐条引用。',
    ].join('\n');
  }
  return [
    '[Important correction] The previous response contained no [cit_N] markers and was discarded.',
    'This time you MUST end every factual statement with an inline [cit_1] / [cit_2] / ... marker.',
    'The available cit ids are shown at the head of each context snippet above. Use them verbatim.',
  ].join('\n');
}

/**
 * Confidence proxy: share of top-1 within the top-K (K=5) reranked pool.
 * Bounded [0,1]; clarify gating still uses aggregate's subtree thresholds —
 * this number is for downstream eval / display only.
 */
const CONFIDENCE_TOP_K = 5;
function computeConfidence(reranked: RerankedChunk[]): number {
  if (reranked.length === 0) return 0;
  const top1 = reranked[0]!.final_score;
  if (reranked.length === 1) return top1 > 0 ? 1 : 0;
  let sum = 0;
  for (let i = 0; i < Math.min(CONFIDENCE_TOP_K, reranked.length); i++) {
    sum += reranked[i]!.final_score;
  }
  return sum > 0 ? top1 / sum : 0;
}

function buildFusedTrace(
  reranked: RerankedChunk[],
  retrievalTrace: RetrievalTrace,
): AskTraceFusedChunk[] {
  return reranked.map((c) => ({
    chunk_id: c.chunk_id,
    page_id: c.page_id,
    rrf_score: c.rrf_score,
    final_score: c.final_score,
    vec_rank: retrievalTrace.vecRanks.get(c.chunk_id) ?? null,
    bm25_rank: retrievalTrace.bm25Ranks.get(c.chunk_id) ?? null,
    nav_index: c.nav_index,
    nav_index_boost: navIndexBoostForTrace(c.nav_index),
  }));
}

function navIndexBoostForTrace(navIndex: number | null): number {
  // Mirrors rerank.ts navIndexBoostFor (kept as a sibling to avoid leaking
  // the internal helper through rerank.ts's public surface).
  if (navIndex === null) return 0;
  return 0.1 * (1 / Math.log(navIndex + 2));
}

const DEFAULT_RERANK_TOP_K = 20;

/**
 * Cross-encoder rerank — feeds the top-N rule-reranked candidates to a
 * Reranker as (query, chunk_text) pairs and reorders by relevance score.
 *
 * The chunk text already carries its heading_path prefix (set in
 * extractMarkdownSections) so the reranker sees enough context to score
 * field-table chunks against natural-language questions without us having
 * to re-stitch the breadcrumb here.
 *
 * Score normalization: bge-reranker-v2-m3 emits raw logits in roughly
 * [-10, +10]. We sigmoid them into (0, 1) and overwrite `final_score` for
 * the reranked window so downstream code (computeConfidence, aggregate) sees
 * a coherent scale within the top-N. Chunks beyond rerankTopK keep their
 * rule-rerank final_score; this is rare in practice because the retrieval
 * top-K and rerankTopK both default to 20.
 *
 * Returns a NEW array — input is not mutated.
 */
async function applyCrossEncoderRerank(
  reranker: Reranker,
  query: string,
  ruleReranked: RerankedChunk[],
  config: RerankerConfig | undefined,
): Promise<RerankedChunk[]> {
  const topK = config?.rerankTopK ?? DEFAULT_RERANK_TOP_K;
  if (ruleReranked.length === 0) return ruleReranked;
  const window = ruleReranked.slice(0, topK);
  const tail = ruleReranked.slice(topK);
  const docs = window.map((c) => ({ chunk_id: c.chunk_id, text: c.text }));
  const scores = await reranker.rerank(query, docs);
  const scoreByChunk = new Map<number | bigint, number>();
  for (const s of scores) scoreByChunk.set(s.chunk_id, sigmoid(s.score));
  const rescored = window
    .map((c) => ({ ...c, final_score: scoreByChunk.get(c.chunk_id) ?? 0 }))
    .sort((a, b) => b.final_score - a.final_score);
  return [...rescored, ...tail];
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function preferNonApiContext(chunks: RerankedChunk[]): RerankedChunk[] {
  const nonApi = chunks.filter((c) => !isApiReferenceChunk(c));
  return nonApi.length > 0 ? nonApi : chunks;
}

function pickAggregationCandidates(
  chunks: RerankedChunk[],
  opts: { apiIntent: boolean; signatureAuthIntent: boolean },
): RerankedChunk[] {
  const allowApiReference = opts.apiIntent;
  const pool = allowApiReference ? chunks : preferNonApiContext(chunks);
  if (allowApiReference) return pool;
  const nonApi = pool;
  if (!opts.signatureAuthIntent) return nonApi;
  const signatureContext = nonApi.filter(isSignatureAuthContext);
  return signatureContext.length > 0 ? signatureContext : nonApi;
}

function isSignatureAuthContext(c: RerankedChunk): boolean {
  const haystack = `${c.page_id} ${c.page_title} ${c.text}`.toLowerCase();
  return (
    /signature|sign field|md5|authentication|authenticate|auth|webhook/.test(haystack) ||
    /签名|验签|认证|鉴权|字典序|升序/.test(haystack)
  );
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

function resolveQueryLang(db: DbHandle, question: string, req: AskRequest): DocsLang {
  const scopeId = req.context?.scope_id ?? null;
  if (scopeId) {
    const fromScope = langFromScopeId(scopeId);
    if (fromScope) return fromScope;
  }
  return detectLangFromText(question);
}

const ZH_UTILITY_QUERIES = new Set([
  '你好',
  '您好',
  '嗨',
  '哈喽',
  '在吗',
  '在么',
  '早',
  '早上好',
  '下午好',
  '晚上好',
  '你是谁',
  '你是什么',
  '你是什么模型',
  '你能做什么',
  '你可以做什么',
  '你会什么',
  '你能回答什么',
  '你能帮我什么',
  '你能帮我做什么',
  '介绍一下你自己',
]);

const EN_UTILITY_QUERIES = new Set([
  'hi',
  'hello',
  'hey',
  'hellothere',
  'help',
  'whoareyou',
  'whatareyou',
  'whatmodelareyou',
  'introduceyourself',
  'whatcanyoudo',
  'whatdoyoudo',
  'whatcanyouhelpwith',
  'whatquestionscanyouanswer',
]);

function utilityAnswerFor(
  question: string,
  lang: DocsLang,
  promptConfig: PromptConfig | undefined,
): string | null {
  const normalized = normalizeUtilityQuestion(question);
  const isUtility = ZH_UTILITY_QUERIES.has(normalized) || EN_UTILITY_QUERIES.has(normalized);
  if (!isUtility) return null;

  const assistantName = promptConfig?.assistantName?.trim() || 'Cregis AI Assistant';
  if (lang === 'zh') {
    return `你好！我是 ${assistantName}，可以回答 Cregis 文档里的支付引擎、WaaS 钱包和 API 接入问题。你可以直接问具体接口、参数、签名、回调、错误码或接入步骤。`;
  }
  return `Hi! I'm ${assistantName}. I can help with Cregis documentation for Payment Engine, WaaS Wallet, and API integration. Ask about endpoints, parameters, signatures, callbacks, error codes, or integration steps.`;
}

function normalizeUtilityQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/[\s"'`~!@#$%^&*_\-+=|\\/.,;:?[{\]}，。！？、；：“”‘’（）【】《》<>]+/g, '');
}

const CITATION_MARKER_IN_ANSWER = /\[(cit_\d+)\]/g;

function withMandatoryApiReferenceCitation(
  rawAnswer: string,
  chunkById: Map<string, RerankedChunk>,
  opts: {
    apiIntent: boolean;
    apiReferenceHintTerms: string[];
    answerLang: DocsLang;
  },
): string {
  if (!opts.apiIntent) return rawAnswer;
  const citedIds = new Set([...rawAnswer.matchAll(CITATION_MARKER_IN_ANSWER)].map((m) => m[1]!));
  const matchingApiRefs = [...chunkById.entries()]
    .filter(([, chunk]) => isApiReferenceChunk(chunk))
    .filter(([, chunk]) => apiReferenceMatchesHints(chunk, opts.apiReferenceHintTerms));
  if (matchingApiRefs.length === 0) return rawAnswer;
  let answer = rawAnswer;
  if (
    !matchingApiRefs.some(([id]) => citedIds.has(id)) &&
    rawAnswerHasApiAnswerSubstance(answer, opts.apiReferenceHintTerms)
  ) {
    const [id, chunk] = matchingApiRefs[0]!;
    const endpoint = extractEndpointForMandatoryCitation(chunk);
    const suffix = opts.answerLang === 'zh'
      ? `\n\nAPI reference：${endpoint ? `\`${endpoint}\` ` : ''}[${id}]。`
      : `\n\nAPI reference: ${endpoint ? `\`${endpoint}\` ` : ''}[${id}].`;
    answer = answer.trimEnd() + suffix;
  }
  return withMandatoryApiParameterExamples(answer, matchingApiRefs, opts);
}

function withMandatoryApiParameterExamples(
  rawAnswer: string,
  apiRefs: Array<[string, RerankedChunk]>,
  opts: { apiReferenceHintTerms: string[]; answerLang: DocsLang },
): string {
  if (
    !opts.apiReferenceHintTerms.includes('payout') ||
    !opts.apiReferenceHintTerms.includes('coins') ||
    /\b195@195\b/.test(rawAnswer)
  ) {
    return rawAnswer;
  }
  const exampleRef = apiRefs.find(([, chunk]) => /\b195@195\b/.test(chunk.text));
  if (!exampleRef) return rawAnswer;
  const [id] = exampleRef;
  const suffix = opts.answerLang === 'zh'
    ? `\n\n参数示例：\`currency\` 使用 \`chain_id@token_id\` 格式，例如 \`195@195\` [${id}]。`
    : `\n\nParameter example: \`currency\` uses the \`chain_id@token_id\` format, for example \`195@195\` [${id}].`;
  return rawAnswer.trimEnd() + suffix;
}

function extractEndpointForMandatoryCitation(chunk: RerankedChunk): string | null {
  const text = `${chunk.page_title}\n${chunk.text}`;
  const match = text.match(/\b(GET|POST|PUT|PATCH|DELETE)\b\s+`?(\/api\/[A-Za-z0-9_./{}:-]+)/i);
  if (!match) return null;
  return `${match[1]!.toUpperCase()} ${match[2]!}`;
}

function rawAnswerHasApiAnswerSubstance(rawAnswer: string, terms: string[]): boolean {
  const text = rawAnswer.toLowerCase();
  if (terms.includes('checkout')) {
    return /\/api\/v2\/checkout\b/i.test(rawAnswer) ||
      /\bcheckout_url\b/i.test(rawAnswer) ||
      /\bcregis_id\b/i.test(rawAnswer) ||
      /\bcallback_url\b/i.test(rawAnswer) ||
      /\border_id\b/i.test(rawAnswer) ||
      /\bpayer_id\b/i.test(rawAnswer) ||
      /\bvalid_time\b/i.test(rawAnswer) ||
      /\b(?:checkout|payment)[ -]?url\b/i.test(rawAnswer) ||
      /\bpayment link\b/i.test(rawAnswer) ||
      /\bhosted checkout\b/i.test(rawAnswer) ||
      /创建订单|支付链接|付款链接|托管收银台|收银台/.test(rawAnswer) ||
      /\border_currency\b/i.test(rawAnswer) ||
      /\border_amount\b/i.test(rawAnswer) ||
      /\busdt\b/i.test(rawAnswer) ||
      /\bcrypto(?:currency)?\b/i.test(rawAnswer) ||
      /\b(?:coinmarketcap|cmc)\b/i.test(rawAnswer);
  }
  if (terms.includes('order') && terms.includes('info') && terms.includes('status')) {
    return (
      /\bevent_type\b/i.test(rawAnswer) &&
      (/\bdata\.status\b/i.test(rawAnswer) || /状态映射|当前状态/.test(rawAnswer))
    );
  }
  if (terms.includes('payout')) {
    return /\bpayout\b|\bwithdrawal\b|\bcid\b|提币|出款|提现/i.test(rawAnswer);
  }
  if (terms.includes('sub_address_balance')) {
    return /\bsub_address_balance\b|\bsub[- ]address\b|\bbalance\b|\baddress\b|子地址|余额/i.test(rawAnswer);
  }
  if (terms.includes('sub_address_withdrawal')) {
    return /\bsub_address_withdrawal\b|\bsub[- ]address\b|\bfrom_address\b/i.test(rawAnswer);
  }
  if (terms.includes('coins')) {
    return /\bcoins\b|\bchain_id\b|\btoken_id\b|\bcurrency\b|币种|代币/i.test(rawAnswer);
  }
  return text.trim().length >= 80;
}

function isValidScopeId(db: DbHandle, scopeId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS hit FROM pages WHERE subtree_root = ? AND status = 'published' LIMIT 1`)
    .get(scopeId) as { hit: number } | undefined;
  return !!row;
}

function pickContextChunks(
  outcome: AggregateOutcome,
  clientMax: number | undefined,
  entityTerms: string[] | undefined,
  opts: {
    apiIntent?: boolean;
    apiReferenceCandidates?: RerankedChunk[];
    apiReferenceHintTerms?: string[];
    apiReferencePagePrefix?: string | null;
    apiReferenceVersionPrefs?: string[];
    projectSetupIntent?: boolean;
    supplementalPageIds?: string[];
    queryLang?: DocsLang;
  } = {},
): RerankedChunk[] {
  // Multi-entity queries need more headroom in the prompt context — each
  // named concept must have at least one supporting chunk reach the LLM,
  // not just the candidate pool. Without this widening, entity injection
  // got the right chunks into rerank top-15 but the default 8-chunk cap
  // still left e.g. `checkpoints` outside the prompt. The lift is
  // proportional to the entity count (3 entities → 15 chunks) and capped
  // by HARD_MAX_CHUNKS so an unreasonable enumeration can't blow up cost.
  const defaultCap =
    entityTerms && entityTerms.length >= 2
      ? Math.min(HARD_MAX_CHUNKS, Math.max(DEFAULT_MAX_CHUNKS, entityTerms.length * 5))
      : DEFAULT_MAX_CHUNKS;
  const cap = Math.min(clientMax ?? defaultCap, HARD_MAX_CHUNKS);
  let picked =
    outcome.kind === 'translate-fallback'
      ? outcome.pick.slice(0, cap)
      : outcome.pick.slice(0, cap);

  if (!opts.apiIntent) {
    const nonApiPicked = picked.filter((c) => !isApiReferenceChunk(c));
    if (nonApiPicked.length > 0) {
      picked = nonApiPicked;
    }
  }

  if (opts.projectSetupIntent) {
    picked = preferProjectSetupContext(picked, opts.apiReferenceCandidates, opts.queryLang, cap);
  }

  if (opts.supplementalPageIds?.length && opts.apiReferenceCandidates?.length) {
    picked = mergeSupplementalContextPages(
      picked,
      opts.apiReferenceCandidates,
      opts.supplementalPageIds,
      opts.queryLang,
      cap,
    );
  }

  if (opts.apiIntent && opts.apiReferenceCandidates?.length) {
    const apiContextLimit = apiReferenceContextLimit(opts.apiReferenceHintTerms);
    const allApiRefs = [...opts.apiReferenceCandidates]
      .filter((c) => c.lang === opts.queryLang && isApiReferenceChunk(c))
      .filter((c) => !opts.apiReferencePagePrefix || c.page_id.startsWith(opts.apiReferencePagePrefix));
    const hasVersionPreferredApiRef = allApiRefs.some((c) =>
      apiReferenceChunkMatchesVersion(c, opts.apiReferenceVersionPrefs),
    );
    if (hasVersionPreferredApiRef) {
      picked = picked.filter(
        (c) =>
          !isApiReferenceChunk(c) ||
          apiReferenceChunkMatchesVersion(c, opts.apiReferenceVersionPrefs),
      );
    }
    picked = picked.filter(
      (c) => !isApiReferenceChunk(c) || apiReferenceMatchesHints(c, opts.apiReferenceHintTerms),
    );
    const seen = new Set(picked.map((c) => c.chunk_id));
    const apiRefs = allApiRefs
      .filter(
        (c) =>
          !hasVersionPreferredApiRef ||
          apiReferenceChunkMatchesVersion(c, opts.apiReferenceVersionPrefs),
      )
      .filter((c) => apiReferenceMatchesHints(c, opts.apiReferenceHintTerms))
      .sort(
        (a, b) =>
          apiReferenceHintScore(b, opts.apiReferenceHintTerms) -
            apiReferenceHintScore(a, opts.apiReferenceHintTerms) ||
          b.final_score - a.final_score,
      )
      .filter((c) => !seen.has(c.chunk_id))
      .slice(0, apiContextLimit);
    if (apiRefs.length > 0) {
      const ordered = reorderApiReferenceContext(
        [...apiRefs, ...picked].filter(
          (c, idx, arr) => arr.findIndex((x) => x.chunk_id === c.chunk_id) === idx,
        ),
        opts,
      );
      picked = pruneCheckoutContextNoise(
        limitApiReferenceContext(ordered, apiContextLimit),
        opts,
      ).slice(0, cap);
    } else {
      picked = pruneCheckoutContextNoise(
        limitApiReferenceContext(
          reorderApiReferenceContext(picked, opts),
          apiContextLimit,
        ),
        opts,
      ).slice(0, cap);
    }
  }

  if (entityTerms && entityTerms.length >= 2) {
    // Entity-coverage reorder: hoist the highest-ranked chunk matching each
    // entity to the front of the picked list. LLMs disproportionately
    // attend to early citation slots when assembling comparison-style
    // answers — without this, `checkpoints` chunks ranked at cit_12 got
    // ignored in favor of cit_1..cit_3 even when the entity-coverage
    // prompt rule asked for full coverage. Codex round-9 follow-up.
    const seen = new Set<number>();
    const lead: RerankedChunk[] = [];
    for (const term of entityTerms) {
      const termLower = term.toLowerCase();
      const candidate = picked.find(
        (c) =>
          !seen.has(c.chunk_id) &&
          (c.page_id.toLowerCase().includes(termLower) ||
            (c.page_title ?? '').toLowerCase().includes(termLower)),
      );
      if (candidate) {
        lead.push(candidate);
        seen.add(candidate.chunk_id);
      }
    }
    if (lead.length > 0) {
      const remaining = picked.filter((c) => !seen.has(c.chunk_id));
      picked = [...lead, ...remaining];
    }
  }
  if (opts.queryLang && outcome.kind !== 'translate-fallback') {
    picked = dropCrossLanguageDuplicatePages(picked, opts.queryLang);
  }
  return picked;
}

function mergeSupplementalContextPages(
  picked: RerankedChunk[],
  candidates: RerankedChunk[],
  pageIds: string[],
  queryLang: DocsLang | undefined,
  cap: number,
): RerankedChunk[] {
  const pageIdSet = new Set(pageIds);
  const seen = new Set(picked.map((c) => c.chunk_id));
  const supplemental = candidates
    .filter((c) => (!queryLang || c.lang === queryLang) && !isApiReferenceChunk(c) && pageIdSet.has(c.page_id))
    .filter((c) => !seen.has(c.chunk_id))
    .slice(0, pageIdSet.size * 2);
  if (supplemental.length === 0) return picked;
  return [...supplemental, ...picked]
    .filter((c, idx, arr) => arr.findIndex((x) => x.chunk_id === c.chunk_id) === idx)
    .slice(0, cap);
}

function dropCrossLanguageDuplicatePages(chunks: RerankedChunk[], queryLang: DocsLang): RerankedChunk[] {
  const sameLangPageIds = new Set(
    chunks.filter((c) => c.lang === queryLang).map((c) => c.page_id),
  );
  if (sameLangPageIds.size === 0) return chunks;
  return chunks.filter((c) => c.lang === queryLang || !sameLangPageIds.has(c.page_id));
}

function preferProjectSetupContext(
  picked: RerankedChunk[],
  candidates: RerankedChunk[] | undefined,
  queryLang: DocsLang | undefined,
  cap: number,
): RerankedChunk[] {
  const setupCandidates = (candidates ?? [])
    .filter((c) => !queryLang || c.lang === queryLang)
    .filter((c) => !isApiReferenceChunk(c))
    .filter(isProjectSetupChunk)
    .slice(0, 4);
  const merged = [...setupCandidates, ...picked].filter(
    (c, idx, arr) => arr.findIndex((x) => x.chunk_id === c.chunk_id) === idx,
  );
  const withoutQuickstart = merged.filter((c) => !isQuickstartChunk(c));
  if (withoutQuickstart.some(isProjectSetupChunk)) {
    return withoutQuickstart.slice(0, cap);
  }
  return merged.slice(0, cap);
}

function isProjectSetupChunk(c: RerankedChunk): boolean {
  const haystack = `${c.page_id} ${c.page_title} ${c.text}`.toLowerCase();
  return (
    /\bsetup\b|\bintegration setup\b|\bintroduction\b|\boverview\b/.test(haystack) ||
    /接入准备|集成准备|平台概览|概览/.test(haystack)
  );
}

function isQuickstartChunk(c: RerankedChunk): boolean {
  const haystack = `${c.page_id} ${c.page_title}`.toLowerCase();
  return /quickstart|30[- ]?minute|30 分钟|30分鐘/.test(haystack);
}

function isPreferredApiReference(c: RerankedChunk, pagePrefix: string | null | undefined): boolean {
  return isApiReferenceChunk(c) && (!pagePrefix || c.page_id.startsWith(pagePrefix));
}

function reorderApiReferenceContext(
  chunks: RerankedChunk[],
  opts: {
    apiReferenceHintTerms?: string[];
    apiReferencePagePrefix?: string | null;
  },
): RerankedChunk[] {
  return chunks.sort(
    (a, b) =>
      Number(isPreferredApiReference(b, opts.apiReferencePagePrefix)) -
        Number(isPreferredApiReference(a, opts.apiReferencePagePrefix)) ||
      apiReferenceHintScore(b, opts.apiReferenceHintTerms) -
        apiReferenceHintScore(a, opts.apiReferenceHintTerms) ||
      b.final_score - a.final_score,
  );
}

function apiReferenceHintScore(c: RerankedChunk, terms: string[] | undefined): number {
  if (!terms?.length) return 0;
  const haystack = `${c.page_id} ${c.page_title} ${c.text}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (term && haystack.includes(term)) score += 1;
  }
  return score;
}

function apiReferenceMatchesHints(c: RerankedChunk, terms: string[] | undefined): boolean {
  if (!terms?.length) return true;
  const haystack = `${c.page_id} ${c.page_title} ${c.text}`.toLowerCase();
  if (terms.includes('checkout')) {
    return haystack.includes('checkout') || haystack.includes('/api/v2/checkout');
  }
  const wantsSubAddressWithdrawal = terms.includes('sub_address_withdrawal');
  const wantsSubAddressBalance = terms.includes('sub_address_balance');
  const wantsCoins = terms.includes('coins');
  const wantsPayout = terms.includes('payout');
  if (wantsSubAddressWithdrawal || wantsSubAddressBalance || wantsCoins || wantsPayout) {
    return (
      (wantsSubAddressWithdrawal && matchesSubAddressWithdrawalApi(haystack)) ||
      (wantsSubAddressBalance && matchesSubAddressBalanceApi(haystack)) ||
      (wantsCoins && matchesCoinsApi(haystack)) ||
      (wantsPayout && matchesWalletPayoutApi(haystack))
    );
  }
  if (terms.includes('order') && terms.includes('info') && terms.includes('status')) {
    return (
      haystack.includes('/order/info') ||
      haystack.includes('order info') ||
      haystack.includes('查询订单信息')
    );
  }
  return apiReferenceHintScore(c, terms) > 0;
}

function matchesSubAddressWithdrawalApi(haystack: string): boolean {
  return (
    haystack.includes('sub_address_withdrawal') ||
    haystack.includes('/api/v1/sub_address_withdrawal') ||
    haystack.includes('sub-address withdrawal') ||
    haystack.includes('子地址出款') ||
    haystack.includes('发起子地址提币')
  );
}

function matchesSubAddressBalanceApi(haystack: string): boolean {
  return (
    haystack.includes('sub_address_balance') ||
    haystack.includes('/api/v1/sub_address_balance') ||
    haystack.includes('sub-address balance') ||
    haystack.includes('子地址余额')
  );
}

function matchesCoinsApi(haystack: string): boolean {
  return (
    haystack.includes('/api/v1/coins') ||
    haystack.includes('api-v1-coins') ||
    haystack.includes('post-api-v1-coins') ||
    haystack.includes('查询项目支持币种') ||
    haystack.includes('supported project coins')
  );
}

function matchesWalletPayoutApi(haystack: string): boolean {
  return (
    /\/api\/v[0-9]+\/payout\b/.test(haystack) ||
    /api-v[0-9]+-payout\b/.test(haystack) ||
    haystack.includes('create wallet payout') ||
    haystack.includes('发起钱包提币')
  );
}

function apiReferenceContextLimit(terms: string[] | undefined): number {
  if (terms?.includes('checkout')) return 1;
  if (terms?.includes('sub_address_withdrawal')) {
    return 1;
  }
  if (terms?.includes('coins') && terms.includes('payout')) return 2;
  if (terms?.includes('sub_address_balance')) return 1;
  if (terms?.includes('coins')) return 1;
  return terms?.includes('payout') ? 2 : 3;
}

function limitApiReferenceContext(chunks: RerankedChunk[], maxApiRefs: number): RerankedChunk[] {
  const out: RerankedChunk[] = [];
  let apiRefs = 0;
  for (const chunk of chunks) {
    if (isApiReferenceChunk(chunk)) {
      if (apiRefs >= maxApiRefs) continue;
      apiRefs += 1;
    }
    out.push(chunk);
  }
  return out;
}

function pruneCheckoutContextNoise(
  chunks: RerankedChunk[],
  opts: {
    apiReferenceHintTerms?: string[];
  },
): RerankedChunk[] {
  if (!opts.apiReferenceHintTerms?.includes('checkout')) return chunks;
  const allowedPages = new Set([
    'supported-currencies',
    'payment-engine-quickstart-30min',
    'pe-business-flow',
  ]);
  const pruned = chunks.filter(
    (chunk) => isApiReferenceChunk(chunk) || allowedPages.has(chunk.page_id),
  );
  return pruned.length > 0 ? pruned : chunks;
}

function translationNoticeFor(lang: DocsLang): string {
  return lang === 'zh'
    ? '原文为其他语言，已为您翻译要点。'
    : 'Source documents are in another language; key points translated below.';
}

/**
 * Extract individual concept terms from a multi-entity query.
 *
 * Recognized enumeration separators (any combination ≥2 total):
 *   - Latin comma `,`
 *   - Chinese ideographic comma `、`
 *   - English `and` / `or` / `nor` conjunctions (e.g. "sessions, checkpoints
 *     and memory" — the trailing `and` counts as one of the separators)
 *
 * Once split, leading conjunctions are stripped, the first significant word
 * of each segment is taken as the entity term, and stop-words are removed.
 * The result is undefined (injection skipped) unless ≥ 2 distinct terms
 * survive — a single-entity question shouldn't trigger entity injection.
 *
 * Codex round-8 surfaced two miss cases this widening covers:
 *   - "sessions、checkpoints、memory 有什么区别？" — Chinese 、 wasn't
 *     recognized; entity injection never fired and `checkpoints` dropped
 *     out of the candidate pool.
 *   - "sessions, checkpoints and memory" — only one `,`, so the previous
 *     ≥2-comma gate rejected it.
 */
const ENTITY_SEGMENT_STRIP = /^\s*(and|or|nor|vs\.?|versus)\s+/i;
const ENTITY_SPLIT_RE = /,|、|\s+(?:and|or|nor|vs\.?|versus)\s+/gi;
// Comparative-intent hint: any of these words anywhere in the query means
// the user is explicitly comparing entities, so a single separator is enough
// to trigger entity injection. Without this gate relaxation, 2-entity
// compare queries ("Compare sessions and checkpoints") had only 1 separator
// and skipped injection entirely (codex round-9 finding).
const ENTITY_COMPARE_HINT_RE = /\b(compare|compares|comparison|vs\.?|versus)\b/i;
const ENTITY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'this', 'that',
  'are', 'how', 'what', 'when', 'where', 'which', 'who', 'work', 'does',
  'use', 'used', 'using', 'works', 'have', 'also', 'some', 'each',
  // Question/comparison verbs that often precede the real entity. Without
  // these, "compare sessions and ..." picked up `compare` as an entity and
  // `sessions` got dropped (taking the first non-stop word per segment).
  'compare', 'show', 'list', 'describe', 'explain', 'tell', 'about',
  'difference', 'differ', 'between',
]);

export function extractEntityTerms(question: string): string[] | undefined {
  // Gate: need ≥2 enumeration separators (any of `,`, `、`, `and`/`or`/`nor`,
  // `vs`/`versus`) to indicate a list — UNLESS the query carries a comparative
  // hint word (`compare`/`comparison`/`vs`/`versus`), in which case a single
  // separator is enough. `Compare sessions and checkpoints` has only one
  // `and`-separator but is unambiguously a 2-entity comparison.
  const sepMatches = question.match(ENTITY_SPLIT_RE) ?? [];
  const minSeps = ENTITY_COMPARE_HINT_RE.test(question) ? 1 : 2;
  if (sepMatches.length < minSeps) return undefined;

  // Split on any recognized separator and take the leading significant word
  // of each segment. We use a fresh regex (the global flag mutates lastIndex
  // between match/split, so reuse is unsafe here).
  const splitRe = /,|、|\s+(?:and|or|nor|vs\.?|versus)\s+/gi;
  const terms: string[] = [];
  for (const segment of question.split(splitRe)) {
    const cleaned = segment.replace(ENTITY_SEGMENT_STRIP, '').trim().toLowerCase();
    // Walk the segment and take the FIRST non-stop-word ≥3 chars. The old
    // logic took only [0]; segments like "how do sessions" then dropped to
    // "how" (stop) and skipped the segment entirely, missing `sessions` as
    // an entity. Walking lets the question prefix carry the first entity.
    for (const word of cleaned.split(/\s+/)) {
      if (word.length >= 3 && !ENTITY_STOP_WORDS.has(word)) {
        terms.push(word);
        break;
      }
    }
  }
  // Deduplicate (repeating the same term in the prompt would inflate
  // injection cost without adding signal).
  const unique = [...new Set(terms)];
  if (unique.length < 2) return undefined;
  return unique;
}

function errorResult(code: string, message: string, detail?: string | null): AskResult {
  return { type: 'error', code, message, detail: detail ?? null };
}

/**
 * Localized user-facing messages for error codes whose original strings
 * leaked internal phrasing (e.g. "LLM response contained no valid citations").
 * Internal codes like `invalid_question` already pass acceptable strings;
 * only the codes listed here are remapped.
 */
function userMessageForError(code: 'no_citations' | 'llm_failed', lang: DocsLang): string {
  if (code === 'no_citations') {
    return lang === 'zh'
      ? '文档中没有找到能够回答这个问题的内容。'
      : "Couldn't find content in the documentation that answers this question.";
  }
  // llm_failed
  return lang === 'zh'
    ? '回答生成服务暂时不可用，请稍后重试。'
    : 'The answer generation service is temporarily unavailable. Please try again.';
}

function makeAnswerId(): string {
  // Stable enough for cache joins; not security-sensitive. 8 hex bytes.
  return `ans_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('request aborted');
  }
}

// re-export for tests / callers.
export { TOP_K_FOR_AGGREGATION };
export type { RetrievedChunk };
