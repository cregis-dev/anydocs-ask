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
  /** True when the first LLM response had no valid citations and a second
   *  call with a reinforced citation prompt was issued. Visible in
   *  runs.jsonl for analyze to track flake rate over time. */
  citation_retry_attempted?: boolean;
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
  const reranked = rerank(retrieved, { queryLang, currentSubtreeRoot, query: question });

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
  const pickedChunks = pickContextChunks(outcome, req.options?.max_chunks);
  const formatHint = detectFormatHint(question);
  const prompt = buildPrompt({
    question,
    chunks: pickedChunks,
    answerLang: queryLang,
    isCrossLang,
    formatHint,
    ...(deps.promptConfig ? { promptConfig: deps.promptConfig } : {}),
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
  // — a documented flake mode (codex round-8). Issue one retry with a
  // reinforced system prompt that explicitly calls out the prior failure
  // and demands the marker. Streaming requests skip retry: the client
  // already received the failed deltas and a second pass would scramble
  // the user-visible stream. Non-streaming callers see a transparent
  // retry — same JSON shape, slightly higher latency.
  let citationRetryAttempted = false;
  if (post.used_chunks === 0 && !isStreaming) {
    citationRetryAttempted = true;
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
      }
    } catch {
      // Retry itself failed — fall through to the original no_citations
      // path below. We don't surface the retry error to the caller; the
      // primary diagnostic is "first call had no citations".
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
        citation_retry_attempted: citationRetryAttempted,
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
      citation_retry_attempted: citationRetryAttempted,
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
): RerankedChunk[] {
  const cap = Math.min(clientMax ?? DEFAULT_MAX_CHUNKS, HARD_MAX_CHUNKS);
  if (outcome.kind === 'translate-fallback') return outcome.pick.slice(0, cap);
  if (outcome.kind === 'answer-same-lang') return outcome.pick.slice(0, cap);
  // 'clarify' is handled before this function; defensive return.
  return [];
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
 * Extract individual concept terms from a multi-entity query. Only fires for
 * explicit comma-enumeration patterns like "sessions, checkpoints, and memory"
 * — requires at least 2 commas so that generic phrases with a single comma
 * ("what is the difference between X and Y?") are never affected.
 *
 * Each comma-segment is stripped of leading conjunctions (and/or/nor), then
 * the first significant word of each segment is taken as the entity term. The
 * result is undefined (injection skipped) unless ≥ 3 distinct terms survive.
 */
const ENTITY_SEGMENT_STRIP = /^\s*(and|or|nor)\s+/i;
const ENTITY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'this', 'that',
  'are', 'how', 'what', 'when', 'where', 'which', 'who', 'work', 'does',
  'use', 'used', 'using', 'works', 'have', 'also', 'some', 'each',
]);

function extractEntityTerms(question: string): string[] | undefined {
  // Gate: need at least 2 commas in the question to indicate an enumeration.
  const commaCount = (question.match(/,/g) ?? []).length;
  if (commaCount < 2) return undefined;

  // Split on commas and take the leading significant word of each segment.
  const terms: string[] = [];
  for (const segment of question.split(',')) {
    const cleaned = segment.replace(ENTITY_SEGMENT_STRIP, '').trim().toLowerCase();
    const word = cleaned.split(/\s+/)[0] ?? '';
    if (word.length >= 3 && !ENTITY_STOP_WORDS.has(word)) {
      terms.push(word);
    }
  }
  if (terms.length < 3) return undefined;
  return terms;
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
