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
 *   4. Keep RRF order; optionally replace it with cross-encoder scores
 *   5. Subtree aggregate → answer-same-lang | translate-fallback
 *   6. Build prompt + generate via LLM
 *   7. Postprocess (citation legality, lang fill, truncation, hallucination)
 *
 * Step 8 (answer cache TTL 24h) is intentionally not done here — it's an
 * HTTP-layer concern in stage 7.
 */

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { createInputCapture, type RunInputSnapshot } from '../runs/input-snapshot.ts';
import type { DbHandle } from '../db/index.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM, LLMGenerateOutput, LLMUsage } from '../llm/types.ts';
import type { Reranker } from '../reranker/types.ts';
import type { PromptConfig, RerankerConfig, RetrievalConfig } from '../config.ts';
import type { DocsLang } from '../anydocs/types.ts';
import { detectLangFromText, langFromScopeId } from './lang.ts';
import { extractExactIdentifiers, sanitizeFtsQuery } from './sanitize.ts';
import { retrieveWithTrace, type RetrievalTrace, type RetrievedChunk } from './retrieval.ts';
import { rankByRrf, type RerankedChunk } from './rerank.ts';
import { aggregate, TOP_K_FOR_AGGREGATION } from './aggregate.ts';
import { buildPrompt, detectFormatHint } from './prompt.ts';
import { LLMIntentRouter, type IntentProduct, type IntentRoute, type IntentRouter } from './intent-router.ts';
import { postprocess, searchHitFromChunk } from './postprocess.ts';
import type { AskRequest, AskResult, SearchResult } from './types.ts';
import {
  buildDiagnosticPromptQuestion,
  MAX_QUESTION_CHARS,
  prepareDiagnosticInput,
  QUESTION_REWRITE_THRESHOLD_CHARS,
  redactSensitiveText,
} from './diagnostic-input.ts';
import { observeLangfuse } from '../observability/langfuse.ts';

const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  topK: 20,
  rrfK: 60,
  maxChunksHardCap: 20,
};
const DEFAULT_MAX_CHUNKS = 8;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 8000;
const DEFAULT_PARENT_TOKEN_LIMIT = 3300;
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
   * Cross-encoder reranker. Optional — when null/omitted, RRF is the only
   * ranking authority. answer.ts gates the entire stage on this being
   * non-null.
   */
  reranker?: Reranker | null;
  /** Cross-encoder rerank config (window size etc). Optional; defaults
   *  applied inline so test deps don't need to construct one. */
  rerankerConfig?: RerankerConfig;
  /** Hybrid retrieval limits. Runtime callers pass config.retrieval. */
  retrievalConfig?: RetrievalConfig;
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
  input_snapshot?: RunInputSnapshot;
  /** Ranked chunks (RRF order, or cross-encoder order when enabled). Empty on
   *  early-error paths (validation / invalid_scope). */
  fused: AskTraceFusedChunk[];
  /** Query text used by retrieval and context hint logic after intent routing. */
  search_question?: string;
  /** Query text embedded for retrieval; may include rewritten multi-turn context. */
  retrieve_question?: string;
  /** Chunks actually sent into the LLM prompt after aggregation/context picking. */
  selected_context?: AskTraceContextChunk[];
  /** True when aggregate decided to fire a clarify (subtree-aggregation ask). */
  subtree_ask_triggered: boolean;
  /** Top final_score from RRF or the optional cross-encoder. */
  top_final_score: number;
  /** Wall-clock latency for each pipeline stage. */
  timings: AskStageTimings;
  /** LLM token counts when the provider exposes them. v1 leaves these null;
   *  later stages can set them when the LLM interface is widened. */
  tokens_in: number | null;
  tokens_out: number | null;
  /** Number of recovery retries issued after the first LLM response had
   *  zero valid citations. Bounded by MAX_CITATION_RETRIES (currently 2);
   *  0 on the success path. Persisted to runs.jsonl so analyze can track
   *  flake rate over time. */
  citation_retry_count?: number;
  /** Normalized LLM intent-router decision used to derive retrieval hints,
   *  history usage, and effective query. Persisted in eval case traces so
   *  route-vs-retrieval-vs-generation failures can be separated. */
  intent_route?: IntentRoute;
  /** RFC 0003 M4 — number of prior session turns the pipeline consumed for
   *  THIS call (embedding splice + prompt). Mirrors the field surfaced on
   *  the result body; duplicated into the trace so runs.jsonl analyses can
   *  filter / group on multi-turn calls without re-joining on session_id.
   *  Undefined / 0 on single-turn or `multiTurn.enabled=false` paths. */
  history_window?: number;
  /** Evidence-first Agentic RAG diagnostics. Present only when the candidate
   *  implementation handled this request; additive for runs compatibility. */
  agent?: {
    steps: number;
    citation_retry_count?: number;
    tool_calls: Array<{
      tool: string;
      ok: boolean;
      duration_ms: number;
      result_count?: number;
      error_code?: string;
    }>;
    evidence: Array<{
      evidence_id: string;
      page_id: string;
      lang: DocsLang;
      mode: string;
      selector: string | null;
      token_count: number;
      truncated: boolean;
      content_hash: string;
    }>;
    required_facts?: Array<{
      id: string;
      description: string;
      search_terms: string[];
      covered: boolean;
      evidence_ids: string[];
      missing_terms: string[];
    }>;
    budget: {
      discovery: { used: number; limit: number };
      read: { used: number; limit: number };
      supplemental: { used: number; limit: number };
    };
  };
};

export type AskStageTimings = {
  router_ms: number;
  embedding_ms: number;
  retrieval_ms: number;
  rerank_ms: number;
  generation_ms: number;
};

export type AskTraceFusedChunk = {
  chunk_id: number;
  page_id: string;
  content_hash?: string;
  lang?: DocsLang;
  page_title?: string;
  page_url?: string | null;
  in_page_path?: string;
  text_preview?: string;
  token_count?: number;
  parent_id?: number | null;
  chunk_kind?: string;
  object_path?: string | null;
  /** Indexed technical identifiers; additive for legacy trace compatibility. */
  identifiers?: string[];
  rrf_score: number;
  final_score: number;
  vec_rank: number | null;
  bm25_rank: number | null;
  exact_rank: number | null;
  nav_index: number | null;
};

export type AskTraceContextChunk = AskTraceFusedChunk & {
  lang: DocsLang;
  page_title: string;
  page_url: string | null;
  in_page_path: string;
  text_preview: string;
  context_rank: number;
  context_token_count: number;
  expanded_parent: AskTraceExpandedParent | null;
};

export type AskTraceExpandedParent = {
  parent_id: number;
  content_hash: string;
  parent_path: string;
  heading_path: string[];
  token_count: number;
  child_count: number;
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

export type AskRetrievalOnlyResult = {
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

export async function retrieveOnlyWithTrace(
  deps: AskDeps,
  req: AskRequest,
  hooks: Pick<AskStreamHooks, 'signal' | 'onStatus'> = {},
): Promise<AskRetrievalOnlyResult> {
  if (req.question === undefined || req.question === null) {
    return { trace: emptyTrace(), queryVector: null };
  }
  const question = req.question.trim();
  if (question.length === 0 || question.length > MAX_QUESTION_CHARS) {
    return { trace: emptyTrace(), queryVector: null };
  }
  const scopeId = req.context?.scope_id ?? null;
  if (scopeId !== null && !isValidScopeId(deps.db, scopeId)) {
    return { trace: emptyTrace(), queryVector: null };
  }
  const queryLang = resolveQueryLang(deps.db, question, req);
  if (utilityAnswerFor(question, queryLang, deps.promptConfig)) {
    return { trace: emptyTrace(), queryVector: null };
  }

  throwIfAborted(hooks.signal);
  await hooks.onStatus?.('retrieving');
  const retrieval = await runRetrievalPipeline(deps, req, question, queryLang, hooks.signal);
  return { trace: retrieval.trace, queryVector: retrieval.queryVector };
}

/** Default / hard ceiling for `search()` hit count (RFC 0007 `search` tool). */
export const SEARCH_DEFAULT_TOP_K = 8;
export const SEARCH_MAX_TOP_K = 100;

/**
 * RFC 0007 — retrieval-only entry point behind the MCP `search` tool. Runs the
 * exact same hybrid retrieve + rerank path as `ask()` (so `search` and `ask`
 * agree on what's relevant) but stops before the LLM call and returns the top
 * reranked chunks as public {@link SearchResult} hits. No LLM tokens spent.
 *
 * Reuses `ask`'s input validation so an agent passing a bad scope_id / empty
 * question gets a typed error instead of silent empty hits.
 */
export async function search(
  deps: AskDeps,
  req: AskRequest,
  topK: number = SEARCH_DEFAULT_TOP_K,
): Promise<SearchResult> {
  if (req.question === undefined || req.question === null) {
    return { type: 'error', code: 'invalid_question', message: "field 'question' is required" };
  }
  const question = req.question.trim();
  if (question.length === 0) {
    return { type: 'error', code: 'invalid_question', message: 'question must not be empty' };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return {
      type: 'error',
      code: 'invalid_question',
      message: `question exceeds ${MAX_QUESTION_CHARS} characters`,
    };
  }
  const scopeId = req.context?.scope_id ?? null;
  if (scopeId !== null && !isValidScopeId(deps.db, scopeId)) {
    return {
      type: 'error',
      code: 'invalid_scope',
      message: `scope_id '${scopeId}' is not a published subtree`,
    };
  }

  const hardCap = retrievalConfigFor(deps).maxChunksHardCap;
  const limit = Number.isFinite(topK)
    ? Math.min(SEARCH_MAX_TOP_K, hardCap, Math.max(1, Math.floor(topK)))
    : SEARCH_DEFAULT_TOP_K;
  const queryLang = resolveQueryLang(deps.db, question, req);
  const retrieval = await runRetrievalPipeline(deps, req, question, queryLang);
  const hits = retrieval.reranked.slice(0, limit).map(searchHitFromChunk);
  return { type: 'hits', hits };
}

function emptyTrace(): AskTrace {
  return {
    fused: [],
    subtree_ask_triggered: false,
    top_final_score: 0,
    timings: emptyStageTimings(),
    tokens_in: null,
    tokens_out: null,
  };
}

type RetrievalPipelineOutput = {
  safeHistory: NonNullable<AskRequest['context']>['history'];
  entityTerms: string[] | undefined;
  fusedTrace: AskTraceFusedChunk[];
  historyWindow: number;
  intentRoute: IntentRoute;
  queryVector: Float32Array;
  retrievalTrace: RetrievalTrace;
  retrieved: RetrievedChunk[];
  reranked: RerankedChunk[];
  retrieveQuestion: string;
  searchQuestion: string;
  top_final_score: number;
  timings: AskStageTimings;
  trace: AskTrace;
};

async function runRetrievalPipeline(
  deps: AskDeps,
  req: AskRequest,
  question: string,
  queryLang: DocsLang,
  signal?: AbortSignal,
): Promise<RetrievalPipelineOutput> {
  const scopeId = req.context?.scope_id ?? null;
  // RFC 0003 §4.2 — multi-turn history-aware retrieve query (M1).
  // A single LLM intent router owns the semantic decisions that feed
  // retrieval. Retrieval-only eval uses this exact helper so it measures the
  // same route/rewrite/rank path as production Ask.
  const history = req.context?.history ?? [];
  const intentRouter = deps.intentRouter ?? new LLMIntentRouter(deps.llm);
  const timings = emptyStageTimings();
  const routerStartedAt = performance.now();
  const intentRoute = await observeLangfuse(
    'classify-intent',
    'span',
    { input: { question, lang: queryLang, history_turns: history.length } },
    async (observation) => {
      const route = await intentRouter.route({ question, history, lang: queryLang });
      observation?.update({
        output: {
          intent: route.intent,
          product: route.product,
          effective_question: route.effectiveQuestion,
          uses_history: route.usesHistory,
          strategy: route.routerStrategy,
        },
      });
      return route;
    },
  );
  timings.router_ms = elapsedMs(routerStartedAt);
  const activeHistory = intentRoute.usesHistory ? history : [];
  const safeHistory = activeHistory.map((turn) => ({
    question: redactSensitiveText(turn.question),
    answer_summary: redactSensitiveText(turn.answer_summary),
  }));
  const historyWindow = activeHistory.length;
  const safeQuestion = intentRoute.safeQuestion ?? redactSensitiveText(question);
  const searchQuestion = intentRoute.effectiveQuestion || safeQuestion;
  const retrieveQuestion = intentRoute.usesHistory
    ? intentRoute.rewritten
      ? intentRoute.effectiveQuestion
      : `${safeHistory.map((h) => h.question).join('\n')}\n${redactSensitiveText(question)}`
    : searchQuestion;

  const compactLongInput = question.length > QUESTION_REWRITE_THRESHOLD_CHARS
    || intentRoute.diagnostic?.structured === true;
  const embedInputs = compactLongInput
    ? [retrieveQuestion]
    : retrieveQuestion === safeQuestion ? [safeQuestion] : [safeQuestion, retrieveQuestion];
  const embeddingStartedAt = performance.now();
  const embedded = await observeLangfuse(
    'embed-query',
    'embedding',
    {
      input: embedInputs,
      model: deps.embedder.model,
      metadata: { input_count: embedInputs.length },
    },
    async (observation) => {
      const output = await deps.embedder.embed(embedInputs);
      observation?.update({
        output: { vectors: output.length, dimensions: output[0]?.vector.length ?? 0 },
      });
      return output;
    },
  );
  timings.embedding_ms = elapsedMs(embeddingStartedAt);
  const queryVector = embedded[0]!.vector;
  const retrieveVector = compactLongInput ? queryVector : embedded[1]?.vector ?? queryVector;
  throwIfAborted(signal);

  const ftsQuery = sanitizeFtsQuery(searchQuestion);
  const exactIdentifiers = extractExactIdentifiers(`${safeQuestion}\n${searchQuestion}`);
  const entityTerms = extractEntityTerms(searchQuestion);
  const apiReferencePagePrefix = apiReferencePagePrefixForProduct(
    intentRoute.product,
    `${safeQuestion}\n${searchQuestion}`,
  );
  const retrievalConfig = retrievalConfigFor(deps);
  const retrievalStartedAt = performance.now();
  const { chunks: retrieved, trace: retrievalTrace } = await observeLangfuse(
    'retrieve-context',
    'retriever',
    {
      input: { query: searchQuestion, fts_query: ftsQuery, exact_identifiers: exactIdentifiers },
      metadata: {
        scope_id: scopeId,
        top_k: retrievalConfig.topK,
        rrf_k: retrievalConfig.rrfK,
      },
    },
    async (observation) => {
      const output = retrieveWithTrace(deps.db, {
        queryVector: retrieveVector,
        ftsQuery,
        scopeId,
        perPathK: retrievalConfig.topK,
        finalK: Math.min(retrievalConfig.topK, retrievalConfig.maxChunksHardCap),
        rrfK: retrievalConfig.rrfK,
        currentPageLang: queryLang,
        apiReferencePagePrefix,
        exactIdentifiers,
      });
      observation?.update({
        output: output.chunks.map((chunk) => ({
          chunk_id: chunk.chunk_id,
          page_id: chunk.page_id,
          path: chunk.in_page_path,
          text: chunk.text,
          rrf_score: chunk.rrf_score,
          vector_rank: output.trace.vecRanks.get(chunk.chunk_id) ?? null,
          bm25_rank: output.trace.bm25Ranks.get(chunk.chunk_id) ?? null,
          exact_rank: output.trace.exactRanks.get(chunk.chunk_id) ?? null,
        })),
      });
      return output;
    },
  );
  timings.retrieval_ms = elapsedMs(retrievalStartedAt);

  const rrfRanked = rankByRrf(retrieved);

  const rerankStartedAt = performance.now();
  const reranked = deps.reranker
    ? await observeLangfuse(
        'rerank-context',
        'retriever',
        { input: { query: searchQuestion, candidates: rrfRanked.length } },
        async (observation) => {
          const output = await applyCrossEncoderRerank(
            deps.reranker!,
            searchQuestion,
            rrfRanked,
            deps.rerankerConfig,
            retrievalConfig.rrfK,
          );
          observation?.update({
            output: output.map((chunk) => ({
              chunk_id: chunk.chunk_id,
              page_id: chunk.page_id,
              final_score: chunk.final_score,
            })),
          });
          return output;
        },
      )
    : rrfRanked;
  timings.rerank_ms = elapsedMs(rerankStartedAt);

  const fusedTrace = buildFusedTrace(reranked, retrievalTrace);
  const top_final_score = reranked[0]?.final_score ?? 0;
  const trace: AskTrace = {
    fused: fusedTrace,
    search_question: searchQuestion,
    retrieve_question: retrieveQuestion,
    subtree_ask_triggered: false,
    top_final_score,
    timings,
    tokens_in: null,
    tokens_out: null,
    intent_route: intentRoute,
    ...(historyWindow > 0 ? { history_window: historyWindow } : {}),
  };

  return {
    safeHistory,
    entityTerms,
    fusedTrace,
    historyWindow,
    intentRoute,
    queryVector,
    retrievalTrace,
    retrieved,
    reranked,
    retrieveQuestion,
    searchQuestion,
    top_final_score,
    timings,
    trace,
  };
}

async function askWithTraceInternal(
  deps: AskDeps,
  req: AskRequest,
  hooks: AskStreamHooks = {},
): Promise<AskWithTraceResult> {
  const t0 = performance.now();

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
  const retrieval = await runRetrievalPipeline(deps, req, question, queryLang, hooks.signal);
  throwIfAborted(hooks.signal);
  const {
    safeHistory,
    entityTerms,
    fusedTrace,
    historyWindow,
    intentRoute,
    queryVector,
    retrievalTrace,
    retrieved,
    reranked,
    retrieveQuestion,
    searchQuestion,
    top_final_score,
    timings,
  } = retrieval;
  // 5. Aggregate.
  const retrievalConfig = retrievalConfigFor(deps);
  const outcome = aggregate(reranked, {
    queryLang,
    topK: Math.min(retrievalConfig.topK, retrievalConfig.maxChunksHardCap),
  });

  // 6 + 7. Generate + postprocess.
  const isCrossLang = outcome.kind === 'translate-fallback';
  const contextCap = contextChunkCap(
    req.options?.max_chunks,
    entityTerms,
    retrievalConfig.maxChunksHardCap,
  );
  // Preserve aggregate/RRF order. The only transformation after ranking is
  // structural parent expansion below, which changes context granularity but
  // never promotes a lower-ranked child over a higher-ranked one.
  const contextCandidates = outcome.pick.slice(0, retrievalConfig.maxChunksHardCap);
  const pickedChunks = await observeLangfuse(
    'select-generation-context',
    'span',
    { input: { candidates: contextCandidates.length, max_items: contextCap } },
    async (observation) => {
      const output = selectContextWithParents(deps.db, contextCandidates, {
        maxItems: contextCap,
        maxTotalTokens: DEFAULT_CONTEXT_TOKEN_BUDGET,
        maxParentTokens: DEFAULT_PARENT_TOKEN_LIMIT,
      });
      observation?.update({
        output: output.map((chunk) => ({
          chunk_id: chunk.chunk_id,
          page_id: chunk.page_id,
          parent_id: chunk.parent_id,
          expanded_parent: chunk.expanded_parent?.parent_id ?? null,
          tokens: chunk.context_token_count,
        })),
      });
      return output;
    },
  );
  const selectedContextTrace = buildSelectedContextTrace(pickedChunks, retrievalTrace);
  const formatHint = detectFormatHint(question);
  const preparedPromptInput = prepareDiagnosticInput(question);
  const promptQuestion = buildDiagnosticPromptQuestion(
    preparedPromptInput,
    intentRoute.diagnostic ?? preparedPromptInput.diagnostic,
    intentRoute.effectiveQuestion,
  );
  const prompt = buildPrompt({
    question: promptQuestion,
    ...(intentRoute.rewritten && !intentRoute.diagnostic
      ? { resolvedQuestion: intentRoute.effectiveQuestion }
      : {}),
    chunks: pickedChunks,
    answerLang: queryLang,
    isCrossLang,
    formatHint,
    ...(deps.promptConfig ? { promptConfig: deps.promptConfig } : {}),
    ...(entityTerms ? { entityTerms } : {}),
    ...(historyWindow > 0 ? { history: safeHistory } : {}),
  });

  let llmOutput: LLMGenerateOutput;
  let totalUsage: LLMUsage | undefined;
  throwIfAborted(hooks.signal);
  await hooks.onStatus?.('generating');
  const llmInput = {
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    traceName: 'generate-answer',
  };
  const inputCapture = createInputCapture({
    question, prompt_question: promptQuestion, search_question: searchQuestion,
    retrieve_question: retrieveQuestion, current_page: req.context?.current_page_id ?? null,
    history: safeHistory ?? [],
    documents: [...prompt.chunkById].map(([citation_id, chunk], index) => ({
      citation_id, chunk_id: chunk.chunk_id, page_id: chunk.page_id, title: chunk.page_title,
      lang: chunk.lang, url: chunk.page_url, path: chunk.in_page_path, text: chunk.text,
      content_hash: chunk.content_hash, parent_id: chunk.parent_id ?? null,
      expanded_parent: pickedChunks[index]?.expanded_parent ?? null,
    })),
  });
  const initialAttempt = inputCapture.addAttempt(llmInput);
  const isStreaming = !!(hooks.onDelta && deps.llm.streamGenerate);
  const generationStartedAt = performance.now();
  try {
    llmOutput = isStreaming
      ? await deps.llm.streamGenerate!(llmInput, {
          signal: hooks.signal,
          onDelta: hooks.onDelta!,
        })
      : await deps.llm.generate(llmInput);
    initialAttempt.outcome = 'returned';
    initialAttempt.model = llmOutput.modelUsed;
    totalUsage = addUsage(totalUsage, llmOutput.usage);
  } catch (err) {
    initialAttempt.outcome = 'error';
    timings.generation_ms = elapsedMs(generationStartedAt);
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
        input_snapshot: inputCapture.snapshot,
        fused: fusedTrace,
        search_question: searchQuestion,
        retrieve_question: retrieveQuestion,
        selected_context: selectedContextTrace,
        subtree_ask_triggered: false,
        top_final_score,
        timings,
        tokens_in: totalUsage?.inputTokens ?? null,
        tokens_out: totalUsage?.outputTokens ?? null,
        intent_route: intentRoute,
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
  initialAttempt.accepted = post.used_chunks > 0;
  if (!isStreaming) {
    while (post.used_chunks === 0 && citationRetryCount < MAX_CITATION_RETRIES) {
      citationRetryCount += 1;
      const retryInput = {
        systemPrompt: prompt.system + '\n\n' + citationReinforcementFor(queryLang),
        userPrompt: prompt.user,
        traceName: 'generate-answer',
      };
      const retryAttempt = inputCapture.addAttempt(retryInput);
      try {
        const retryOutput = await deps.llm.generate(retryInput);
        retryAttempt.outcome = 'returned';
        retryAttempt.model = retryOutput.modelUsed;
        totalUsage = addUsage(totalUsage, retryOutput.usage);
        const retryPost = postprocess({
          answerLang: queryLang,
          rawAnswer: retryOutput.text,
          chunkById: prompt.chunkById,
          question,
        });
        if (retryPost.used_chunks > 0) {
          retryAttempt.accepted = true;
          llmOutput = retryOutput;
          post = retryPost;
          break;
        }
      } catch {
        retryAttempt.outcome = 'error';
        // Retry itself threw — keep looping; the primary diagnostic is
        // "first call had no citations" and the trace count records how
        // many recovery attempts we made.
      }
    }
  }
  timings.generation_ms = elapsedMs(generationStartedAt);

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
        input_snapshot: inputCapture.snapshot,
        fused: fusedTrace,
        search_question: searchQuestion,
        retrieve_question: retrieveQuestion,
        selected_context: selectedContextTrace,
        subtree_ask_triggered: false,
        top_final_score,
        timings,
        tokens_in: totalUsage?.inputTokens ?? null,
        tokens_out: totalUsage?.outputTokens ?? null,
        citation_retry_count: citationRetryCount,
        intent_route: intentRoute,
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
      input_snapshot: inputCapture.snapshot,
      fused: fusedTrace,
      search_question: searchQuestion,
      retrieve_question: retrieveQuestion,
      selected_context: selectedContextTrace,
      subtree_ask_triggered: false,
      top_final_score,
      timings,
      tokens_in: totalUsage?.inputTokens ?? null,
      tokens_out: totalUsage?.outputTokens ?? null,
      citation_retry_count: citationRetryCount,
      intent_route: intentRoute,
      ...(historyWindow > 0 ? { history_window: historyWindow } : {}),
    },
    queryVector,
  };
}

function emptyStageTimings(): AskStageTimings {
  return {
    router_ms: 0,
    embedding_ms: 0,
    retrieval_ms: 0,
    rerank_ms: 0,
    generation_ms: 0,
  };
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

function addUsage(total: LLMUsage | undefined, usage: LLMUsage | undefined): LLMUsage | undefined {
  if (!usage) return total;
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
    cacheReadInputTokens: (total?.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (total?.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
  };
}

/**
 * Children win retrieval; bounded structural parents supply generation context.
 * Multiple hits from the same parent collapse to one context item, preventing
 * repeated prefixes and arbitrary field-boundary cuts in the prompt.
 */
export function expandParentContext(
  db: DbHandle,
  chunks: RerankedChunk[],
  maxParentChars = 6000,
): RerankedChunk[] {
  return selectContextWithParents(db, chunks, {
    maxItems: chunks.length,
    maxTotalTokens: Number.POSITIVE_INFINITY,
    maxParentTokens: Number.POSITIVE_INFINITY,
    maxParentChars,
  });
}

export type ContextSelectionOptions = {
  maxItems: number;
  maxTotalTokens?: number;
  maxParentTokens?: number;
  /** Compatibility guard for callers that still express the parent bound in characters. */
  maxParentChars?: number;
};

export type SelectedContextChunk = RerankedChunk & {
  /** Non-null only when this child was replaced by its structural parent. */
  expanded_parent: AskTraceExpandedParent | null;
  context_token_count: number;
};

/**
 * Materialize ranked child candidates into prompt context units.
 *
 * Expand a structural parent at most once, keep the complete context under a
 * global token budget, and continue scanning candidates after duplicate child
 * hits collapse. This makes the item limit apply to actual prompt citations,
 * not to the pre-expansion child list.
 */
export function selectContextWithParents(
  db: DbHandle,
  candidates: RerankedChunk[],
  options: ContextSelectionOptions,
): SelectedContextChunk[] {
  const maxItems = Math.max(0, Math.floor(options.maxItems));
  if (maxItems === 0 || candidates.length === 0) return [];
  const maxTotalTokens = options.maxTotalTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const maxParentTokens = options.maxParentTokens ?? DEFAULT_PARENT_TOKEN_LIMIT;
  const maxParentChars = options.maxParentChars ?? Number.POSITIVE_INFINITY;
  const parentIds = [...new Set(candidates.map((chunk) => chunk.parent_id).filter((id): id is number => id !== null))];
  if (parentIds.length === 0) {
    return takeWithinTokenBudget(candidates, maxItems, maxTotalTokens);
  }
  const placeholders = parentIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT cp.parent_id, cp.text, cp.content_hash, cp.parent_path,
            cp.heading_path, cp.token_count, COUNT(c.chunk_id) AS child_count
       FROM chunk_parents cp
       LEFT JOIN chunks c ON c.parent_id = cp.parent_id
      WHERE cp.parent_id IN (${placeholders})
      GROUP BY cp.parent_id, cp.text, cp.token_count`,
  ).all(...parentIds) as Array<{
    parent_id: number;
    text: string;
    content_hash: string;
    parent_path: string;
    heading_path: string;
    token_count: number;
    child_count: number;
  }>;
  const parents = new Map(rows.map((row) => [row.parent_id, row] as const));
  const emittedParents = new Set<number>();
  const emittedParentFallbacks = new Set<number>();
  const emittedChildren = new Set<number>();
  const out: SelectedContextChunk[] = [];
  let usedTokens = 0;
  for (const chunk of candidates) {
    if (out.length >= maxItems) break;
    if (emittedChildren.has(chunk.chunk_id)) continue;
    emittedChildren.add(chunk.chunk_id);

    let expandedParent: AskTraceExpandedParent | null = null;
    let selected: RerankedChunk = chunk;
    let selectedTokens = estimateContextTokens(chunk.text);
    let parentFallbackId: number | null = null;
    const parent = chunk.parent_id === null ? undefined : parents.get(chunk.parent_id);
    if (
      parent &&
      parent.child_count >= 2 &&
      parent.token_count <= maxParentTokens &&
      parent.text.length <= maxParentChars
    ) {
      if (emittedParents.has(parent.parent_id)) continue;
      if (usedTokens + parent.token_count <= maxTotalTokens) {
        emittedParents.add(parent.parent_id);
        selected = { ...chunk, text: parent.text };
        selectedTokens = parent.token_count;
        expandedParent = {
          parent_id: parent.parent_id,
          content_hash: parent.content_hash,
          parent_path: parent.parent_path,
          heading_path: parseHeadingPath(parent.heading_path),
          token_count: parent.token_count,
          child_count: parent.child_count,
        };
      } else {
        // The full parent no longer fits. Keep only its best-ranked child so
        // later siblings do not consume the slots that refill should use for
        // distinct context units.
        if (emittedParentFallbacks.has(parent.parent_id)) continue;
        parentFallbackId = parent.parent_id;
      }
    }

    if (usedTokens + selectedTokens > maxTotalTokens) continue;
    if (parentFallbackId !== null) emittedParentFallbacks.add(parentFallbackId);
    out.push({ ...selected, expanded_parent: expandedParent, context_token_count: selectedTokens });
    usedTokens += selectedTokens;
  }
  return out;
}

function takeWithinTokenBudget(
  candidates: RerankedChunk[],
  maxItems: number,
  maxTotalTokens: number,
): SelectedContextChunk[] {
  const out: SelectedContextChunk[] = [];
  const seen = new Set<number>();
  let usedTokens = 0;
  for (const chunk of candidates) {
    if (out.length >= maxItems) break;
    if (seen.has(chunk.chunk_id)) continue;
    seen.add(chunk.chunk_id);
    const tokens = estimateContextTokens(chunk.text);
    if (usedTokens + tokens > maxTotalTokens) continue;
    out.push({ ...chunk, expanded_parent: null, context_token_count: tokens });
    usedTokens += tokens;
  }
  return out;
}

function parseHeadingPath(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function estimateContextTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const nonCjkLength = text.replace(/[\u3400-\u9fff]/gu, '').length;
  return Math.max(1, cjk + Math.ceil(nonCjkLength / 4));
}

export function apiReferencePagePrefixForProduct(product: IntentProduct, query = ''): string | null {
  if (/\/openapi\/|\bteam\s+api\b|团队\s*API/i.test(query)) return 'api-team-api-';
  if (product === 'payment_engine') return 'api-payment-engine-api-';
  if (product === 'waas') return 'api-waas-api-';
  return null;
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

function buildFusedTrace(
  reranked: RerankedChunk[],
  retrievalTrace: RetrievalTrace,
): AskTraceFusedChunk[] {
  return reranked.map((c) => ({
    chunk_id: c.chunk_id,
    page_id: c.page_id,
    content_hash: c.content_hash,
    lang: c.lang,
    page_title: c.page_title,
    page_url: c.page_url,
    in_page_path: c.in_page_path,
    text_preview: previewText(c.text),
    token_count: c.token_count,
    parent_id: c.parent_id,
    chunk_kind: c.chunk_kind,
    object_path: c.object_path,
    identifiers: c.identifiers,
    rrf_score: c.rrf_score,
    final_score: c.final_score,
    vec_rank: retrievalTrace.vecRanks.get(c.chunk_id) ?? null,
    bm25_rank: retrievalTrace.bm25Ranks.get(c.chunk_id) ?? null,
    exact_rank: retrievalTrace.exactRanks.get(c.chunk_id) ?? null,
    nav_index: c.nav_index,
  }));
}

function buildSelectedContextTrace(
  chunks: SelectedContextChunk[],
  retrievalTrace: RetrievalTrace,
): AskTraceContextChunk[] {
  return chunks.map((c, index) => ({
    chunk_id: c.chunk_id,
    page_id: c.page_id,
    lang: c.lang,
    page_title: c.page_title,
    page_url: c.page_url,
    in_page_path: c.in_page_path,
    text_preview: previewText(c.text),
    token_count: c.token_count,
    parent_id: c.parent_id,
    chunk_kind: c.chunk_kind,
    object_path: c.object_path,
    identifiers: c.identifiers,
    content_hash: c.content_hash,
    context_rank: index + 1,
    context_token_count: c.context_token_count,
    expanded_parent: c.expanded_parent,
    rrf_score: c.rrf_score,
    final_score: c.final_score,
    vec_rank: retrievalTrace.vecRanks.get(c.chunk_id) ?? null,
    bm25_rank: retrievalTrace.bm25Ranks.get(c.chunk_id) ?? null,
    exact_rank: retrievalTrace.exactRanks.get(c.chunk_id) ?? null,
    nav_index: c.nav_index,
  }));
}

function previewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

const DEFAULT_RERANK_TOP_K = 8;
const DEFAULT_RERANK_WEIGHT = 0.6;

/**
 * Cross-encoder rerank — feeds the top-N RRF-ranked candidates to a
 * Reranker as (query, chunk_text) pairs, then blends the cross-encoder rank
 * with the original RRF rank. This preserves strong exact/BM25 evidence while
 * still letting semantic relevance promote better candidates.
 *
 * The chunk text already carries its heading_path prefix (set in
 * extractMarkdownSections) so the reranker sees enough context to score
 * field-table chunks against natural-language questions without us having
 * to re-stitch the breadcrumb here.
 *
 * The blend is weighted reciprocal-rank fusion. Raw cross-encoder logits are
 * used only to derive their order because score scales differ across models.
 * Chunks beyond rerankTopK keep their RRF order after the blended window.
 *
 * Returns a NEW array — input is not mutated.
 */
export async function applyCrossEncoderRerank(
  reranker: Reranker,
  query: string,
  rrfRanked: RerankedChunk[],
  config: RerankerConfig | undefined,
  rrfK: number,
): Promise<RerankedChunk[]> {
  const topK = config?.rerankTopK ?? DEFAULT_RERANK_TOP_K;
  const weight = config?.weight ?? DEFAULT_RERANK_WEIGHT;
  if (rrfRanked.length === 0) return rrfRanked;
  const window = rrfRanked.slice(0, topK);
  const tail = rrfRanked.slice(topK);
  const docs = window.map((c) => ({ chunk_id: c.chunk_id, text: c.text }));
  const scores = await reranker.rerank(query, docs);
  const rawScoreByChunk = new Map(scores.map((s) => [s.chunk_id, s.score]));
  const rerankerRank = new Map(
    [...window]
      .sort((a, b) =>
        (rawScoreByChunk.get(b.chunk_id) ?? Number.NEGATIVE_INFINITY)
        - (rawScoreByChunk.get(a.chunk_id) ?? Number.NEGATIVE_INFINITY))
      .map((chunk, index) => [chunk.chunk_id, index + 1]),
  );
  const rrfRank = new Map(window.map((chunk, index) => [chunk.chunk_id, index + 1]));
  const reordered = window
    .map((c) => {
      const originalRank = rrfRank.get(c.chunk_id)!;
      const semanticRank = rerankerRank.get(c.chunk_id) ?? originalRank;
      const finalScore =
        weight / (rrfK + semanticRank)
        + (1 - weight) / (rrfK + originalRank);
      return { ...c, final_score: finalScore };
    })
    .sort((a, b) => b.final_score - a.final_score);
  // Aggregation consumes final_score, while the untouched tail still carries
  // RRF scores. Reassign the original window's descending score slots to the
  // blended order so scores remain monotonic and on one scale across the
  // rerank boundary.
  const scoreSlots = window.map((chunk) => chunk.final_score).sort((a, b) => b - a);
  const rescored = reordered.map((chunk, index) => ({
    ...chunk,
    final_score: scoreSlots[index]!,
  }));
  return [...rescored, ...tail];
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
    return `你好！我是 ${assistantName}，可以回答 Cregis 文档里的支付引擎、WaaS项目和 API 接入问题。你可以直接问具体接口、参数、签名、回调、错误码或接入步骤。`;
  }
  return `Hi! I'm ${assistantName}. I can help with Cregis documentation for Payment Engine, WaaS project, and API integration. Ask about endpoints, parameters, signatures, callbacks, error codes, or integration steps.`;
}

function normalizeUtilityQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/[\s"'`~!@#$%^&*_\-+=|\\/.,;:?[{\]}，。！？、；：“”‘’（）【】《》<>]+/g, '');
}

function isValidScopeId(db: DbHandle, scopeId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS hit FROM pages WHERE subtree_root = ? AND status = 'published' LIMIT 1`)
    .get(scopeId) as { hit: number } | undefined;
  return !!row;
}

function contextChunkCap(
  clientMax: number | undefined,
  entityTerms: string[] | undefined,
  hardMaxChunks: number,
): number {
  const defaultCap =
    entityTerms && entityTerms.length >= 2
      ? Math.min(hardMaxChunks, Math.max(DEFAULT_MAX_CHUNKS, entityTerms.length * 5))
      : DEFAULT_MAX_CHUNKS;
  const requested = clientMax !== undefined && Number.isFinite(clientMax)
    ? Math.floor(clientMax)
    : defaultCap;
  return Math.min(hardMaxChunks, Math.max(1, requested));
}

function retrievalConfigFor(deps: AskDeps): RetrievalConfig {
  return deps.retrievalConfig ?? DEFAULT_RETRIEVAL_CONFIG;
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
 * The result is undefined unless ≥ 2 distinct terms survive. The terms are
 * used only to size context and guide the prompt; they never change rank.
 *
 * Codex round-8 surfaced two miss cases this widening covers:
 *   - "sessions、checkpoints、memory 有什么区别？" — Chinese 、 was not
 *     recognized, so the prompt lost one of the comparison subjects.
 *   - "sessions, checkpoints and memory" — only one `,`, so the previous
 *     ≥2-comma gate rejected it.
 */
const ENTITY_SEGMENT_STRIP = /^\s*(and|or|nor|vs\.?|versus)\s+/i;
const ENTITY_SPLIT_RE = /,|、|\s+(?:and|or|nor|vs\.?|versus)\s+/gi;
// Comparative-intent hint: any of these words anywhere in the query means
// the user is explicitly comparing entities, so a single separator is enough
// to retain both subjects in prompt guidance. A two-entity comparison has only
// one separator, unlike a longer comma-separated list.
const ENTITY_COMPARE_HINT_RE = /\b(compare|compares|comparison|vs\.?|versus)\b/i;
const ENTITY_CLAUSE_START_RE = /^(?:do|does|did|is|are|was|were|can|could|should|would|will|must|may|might|have|has|had|what|when|where|which|who|why|how|if|but|however)\b/i;
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
  const segments = question.split(splitRe);
  // Enumeration starts with a short subject. Long introductory clauses and
  // question clauses after separators are not named entities.
  if (
    (segments[0]?.trim().split(/\s+/).length ?? 0) > 4
    || segments.slice(0, -1).some((segment) => /[?？]/.test(segment))
    || segments.slice(1, -1).some((segment) => /[，。]/.test(segment))
    || segments.slice(1).some((segment) => ENTITY_CLAUSE_START_RE.test(segment.trim()))
  ) {
    return undefined;
  }
  const terms: string[] = [];
  for (const segment of segments) {
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
  // Deduplicate before adding the terms to prompt guidance.
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
