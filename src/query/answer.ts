/**
 * Top-level query orchestrator. Implements ARCH §6 steps 1–7 and returns a
 * fully shaped AskResult. The HTTP layer (stage 7) maps the result onto JSON
 * + adds answer caching + handles invalid_scope status codes.
 *
 * Pipeline:
 *   1. Validate inputs (question length, scope_id existence in pages table)
 *   1.5 Detect query lang (scope_id > current_page_id > text)
 *   2. Boundary filter is applied inside retrieval SQL (status='published',
 *      optional subtree_root match)
 *   3. Hybrid retrieve (vector + BM25 + RRF)
 *   4. Structural rerank (lang_boost / same_subtree_boost / nav_index_boost)
 *   5. Subtree aggregate → answer-same-lang | clarify | translate-fallback
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
import type { PromptConfig } from '../config.ts';
import type { DocsLang } from '../anydocs/types.ts';
import type { BreadcrumbNode } from '../db/schema.ts';
import { detectLangFromText, langFromScopeId } from './lang.ts';
import { sanitizeFtsQuery } from './sanitize.ts';
import { retrieveWithTrace, type RetrievalTrace, type RetrievedChunk } from './retrieval.ts';
import { computeTitleMatches } from './rerank.ts';
import { rerank, lookupSubtreeRoot, type RerankedChunk } from './rerank.ts';
import { aggregate, TOP_K_FOR_AGGREGATION, type AggregateOutcome, type SubtreeShare } from './aggregate.ts';
import { buildPrompt, detectFormatHint } from './prompt.ts';
import { postprocess } from './postprocess.ts';
import type { AskRequest, AskResult, ClarifyOption } from './types.ts';

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
  promptConfig?: PromptConfig;
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

  // 3. Hybrid retrieve.
  throwIfAborted(hooks.signal);
  await hooks.onStatus?.('retrieving');
  const queryVector = (await deps.embedder.embed([question]))[0]!.vector;
  throwIfAborted(hooks.signal);
  const ftsQuery = sanitizeFtsQuery(question);
  const entityTerms = extractEntityTerms(question);
  const { chunks: retrieved, trace: retrievalTrace } = retrieveWithTrace(deps.db, {
    queryVector,
    ftsQuery,
    scopeId,
    entityTerms,
  });

  // 4. Rerank.
  const currentSubtreeRoot = req.context?.current_page_id
    ? lookupSubtreeRoot(deps.db, req.context.current_page_id, queryLang)
    : null;
  const reranked = rerank(retrieved, {
    queryLang,
    currentSubtreeRoot,
    query: question,
    entityTerms,
  });

  const fusedTrace = buildFusedTrace(reranked, retrievalTrace);
  const top_final_score = reranked[0]?.final_score ?? 0;
  const confidence = computeConfidence(reranked);

  // 5. Aggregate.
  // Derive title-match subtrees so aggregate can skip clarify when the user's
  // query explicitly names a page.
  const titleMatchedPageIds = computeTitleMatches(retrieved, question);
  const titleMatchedSubtrees = new Set<string>();
  for (const c of reranked) {
    if (titleMatchedPageIds.has(c.page_id) && c.subtree_root) {
      titleMatchedSubtrees.add(c.subtree_root);
    }
  }
  const outcome = aggregate(reranked, { queryLang, currentSubtreeRoot, titleMatchedSubtrees });

  if (outcome.kind === 'clarify') {
    return {
      result: buildClarifyResult({ answerLang: queryLang, shares: outcome.topSubtrees }),
      trace: {
        fused: fusedTrace,
        subtree_ask_triggered: true,
        top_final_score,
        confidence,
        tokens_in: null,
        tokens_out: null,
      },
      queryVector,
    };
  }

  // 6 + 7. Generate + postprocess.
  const isCrossLang = outcome.kind === 'translate-fallback';
  const pickedChunks = pickContextChunks(outcome, req.options?.max_chunks, entityTerms);
  const formatHint = detectFormatHint(question);
  const prompt = buildPrompt({
    question,
    chunks: pickedChunks,
    answerLang: queryLang,
    isCrossLang,
    formatHint,
    ...(deps.promptConfig ? { promptConfig: deps.promptConfig } : {}),
    ...(entityTerms ? { entityTerms } : {}),
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
    rawAnswer: llmOutput.text,
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
          rawAnswer: retryOutput.text,
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
    },
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

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

function resolveQueryLang(db: DbHandle, question: string, req: AskRequest): DocsLang {
  const scopeId = req.context?.scope_id ?? null;
  if (scopeId) {
    const fromScope = langFromScopeId(scopeId);
    if (fromScope) return fromScope;
  }
  const currentPageId = req.context?.current_page_id ?? null;
  if (currentPageId) {
    const rows = db
      .prepare(`SELECT lang FROM pages WHERE page_id = ?`)
      .all(currentPageId) as Array<{ lang: DocsLang }>;
    if (rows.length === 1) return rows[0]!.lang;
    if (rows.length > 1) {
      // Same page id under multiple langs — disambiguate by text detection
      // and pick the lang that's actually present.
      const detected = detectLangFromText(question);
      if (rows.some((r) => r.lang === detected)) return detected;
      return rows[0]!.lang;
    }
  }
  return detectLangFromText(question);
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
  if (outcome.kind === 'clarify') return [];
  let picked =
    outcome.kind === 'translate-fallback'
      ? outcome.pick.slice(0, cap)
      : outcome.pick.slice(0, cap);

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
  return picked;
}

function translationNoticeFor(lang: DocsLang): string {
  return lang === 'zh'
    ? '原文为其他语言，已为您翻译要点。'
    : 'Source documents are in another language; key points translated below.';
}

function buildClarifyResult(args: {
  answerLang: DocsLang;
  shares: SubtreeShare[];
}): AskResult {
  const options: ClarifyOption[] = args.shares.slice(0, 4).map((share) => {
    const firstChunk = share.chunks[0]!;
    const subtreeBreadcrumb = breadcrumbToSubtree(firstChunk.breadcrumb, share.subtree_root);
    const samplePages = uniqueSamplePages(share.chunks).slice(0, 2);
    const label =
      subtreeBreadcrumb[subtreeBreadcrumb.length - 1]?.title ?? share.subtree_root;
    return {
      scope_id: share.subtree_root,
      lang: args.answerLang,
      label,
      breadcrumb: subtreeBreadcrumb,
      sample_pages: samplePages,
    };
  });

  return {
    type: 'clarify',
    answer_id: makeAnswerId(),
    answer_lang: args.answerLang,
    message: clarifyMessageFor(args.answerLang),
    options,
  };
}

function breadcrumbToSubtree(
  breadcrumb: BreadcrumbNode[],
  subtreeRoot: string,
): BreadcrumbNode[] {
  const idx = breadcrumb.findIndex((b) => b.id === subtreeRoot);
  if (idx < 0) return breadcrumb.slice(0, 1); // degenerate; fall back to depth-1 prefix
  return breadcrumb.slice(0, idx + 1);
}

function uniqueSamplePages(chunks: RerankedChunk[]): Array<{ id: string; title: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string }> = [];
  for (const c of chunks) {
    if (seen.has(c.page_id)) continue;
    seen.add(c.page_id);
    out.push({ id: c.page_id, title: c.page_title });
  }
  return out;
}

function clarifyMessageFor(lang: DocsLang): string {
  return lang === 'zh'
    ? '您的问题可能涉及以下几个范围，请选择一个：'
    : 'Your question could refer to several areas; pick one:';
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
