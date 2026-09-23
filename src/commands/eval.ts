/**
 * `anydocs-ask eval <projectRoot>` — runs the project's approved Golden cases
 * against an in-process Runtime, computes retrieval / citation / answer
 * diagnostics, and
 * writes a Markdown report under `<state>/reports/<YYYY-MM-DD>-eval.md`.
 *
 * Report semantics:
 *   - Core quality: MRR, Hit@5, Context-P@5, citation anchor, Kind, API rule.
 *   - Retrieval diagnostics: Hit@1 and Hit@3.
 *   - Citation calibration: unexpected citation pages/rate.
 *   - Answer text diagnostics: brittle keyword/regex overlap.
 *
 * The eval driver builds a Runtime in-process (warm-up loads the embedder +
 * runs fullReindex once). Each case round-trips through `askWithTrace`; the
 * server is not booted because eval doesn't need the HTTP layer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Runtime } from '../server/runtime.ts';
import { loadConfig } from '../config.ts';
import type { LLM } from '../llm/types.ts';
import {
  askWithTrace,
  askWithTraceStream,
  retrieveOnlyWithTrace,
  type AskDeps,
  type AskRetrievalOnlyResult,
  type AskTrace,
  type AskWithTraceResult,
} from '../query/answer.ts';
import { fallbackRoute, type IntentRouter } from '../query/intent-router.ts';
import { readApproved } from '../golden/store.ts';
import {
  failedCase,
  scoreCase,
  scoreRetrievalCase,
  summarizeRetrievalResults,
  summarizeResults,
  type CaseResult,
  type EvalSummary,
  type RetrievalCaseResult,
  type RetrievalEvalSummary,
} from '../eval/scoring.ts';
import type { GoldenCase } from '../golden/types.ts';
import type { AskRequest, AskResult } from '../query/types.ts';
import {
  hasRuntimeBuildMetadata,
  readRuntimeBuildMetadata,
  type RuntimeBuildMetadata,
} from '../runtime-build.ts';

export type EvalOptions = {
  projectRoot: string;
  stateRoot: string;
  /** Compare against this baseline file path. Defaults to most recent prior eval report. */
  baselinePath?: string;
  /** Retrieval-only eval: bypass LLM router and measure raw question retrieval. */
  retrievalNoRouter?: boolean;
  /**
   * Optional per-phase progress callback. Receives lifecycle + per-case
   * events as the loop advances. CLI users don't set this (output goes via
   * process.stdout as before); the console wraps it with the streaming
   * NDJSON endpoint so the Eval-tab UI can render a real progress bar.
   */
  onProgress?: (event: EvalProgressEvent) => void;
};

export type EvalCaseTraceRecord = {
  schema_version: 2;
  case_id: string;
  index: number;
  total: number;
  query: string;
  lang: string;
  request: AskRequest;
  expected: GoldenCase['expected'];
  score: CaseResult;
  result: AskResult;
  trace: AskTrace | null;
  diagnostics: EvalTraceDiagnostics;
  runtime_build: RuntimeBuildMetadata | null;
  /** Stable hand-off contract for the separate Python/Ragas evaluator. */
  ragas_sample: EvalRagasSample;
};

export type EvalRagasSample = {
  user_input: string;
  response: string | null;
  retrieved_contexts: string[];
  reference: string | null;
  reference_facts: string[];
  rubric: Record<string, string>;
  /** Full redacted prompt snapshot is preferred; preview is test/legacy fallback. */
  context_source: 'prompt_snapshot' | 'agent_evidence' | 'trace_preview' | 'none';
};

export type RetrievalEvalCaseTraceRecord = {
  schema_version: 1;
  case_id: string;
  index: number;
  total: number;
  query: string;
  lang: string;
  request: AskRequest;
  expected: GoldenCase['expected'];
  score: RetrievalCaseResult;
  trace: AskTrace | null;
  diagnostics: EvalTraceDiagnostics;
};

export type EvalTraceDiagnostics = {
  route: EvalTraceRouteDiagnostic | null;
  search_question: string | null;
  retrieve_question: string | null;
  retrieved_top20: EvalTraceChunkDiagnostic[];
  prompt_context: EvalTraceChunkDiagnostic[];
};

export type EvalTraceRouteDiagnostic = {
  original_question: string;
  effective_query: string;
  uses_history: boolean;
  rewritten: boolean;
  intent: string;
  product: string;
  api_intent: boolean;
  signature_auth_intent: boolean;
  project_setup_intent: boolean;
  api_reference_hints: string[];
  supplemental_page_ids: string[];
  api_reference_version_prefs: string[];
  reason: string | null;
};

export type EvalTraceChunkDiagnostic = {
  rank: number;
  chunk_id: number;
  page_id: string;
  page_title?: string;
  page_url?: string | null;
  lang?: string;
  in_page_path?: string;
  text_preview?: string;
  identifiers?: string[];
  final_score: number;
  rrf_score: number;
  vec_rank: number | null;
  bm25_rank: number | null;
  nav_index: number | null;
};

export type EvalProgressEvent =
  | { type: 'boot'; totalCases: number }
  | { type: 'warm'; bootMs: number; chunks: number }
  | { type: 'case-start'; i: number; total: number; caseId: string; query: string; lang: string }
  | {
      type: 'case-done';
      i: number;
      total: number;
      caseId: string;
      latencyMs: number;
      kind: CaseResult['kind'];
      hit_at_5: boolean;
      hit_at_1: boolean;
      hit_at_3: boolean;
      mrr: number;
      context_precision_at_5: number;
      citation_anchor_pass: boolean;
      unexpected_citation_rate: number;
      /** Diagnostic only — see scoring.ts for the deprecation note. */
      answer_rule_pass: boolean;
    }
  | { type: 'done'; reportPath: string; totalMs: number; summary: EvalSummary };

const EVAL_CASE_ATTEMPTS = 2;
const EVAL_RETRY_DELAY_MS = 1500;

export async function runEval(opts: EvalOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const { config, source } = await loadConfig(projectRoot);
  if (source) {
    process.stdout.write(`anydocs-ask eval: loaded config from ${source}\n`);
  }

  // 1. Load approved cases.
  const { rows: cases, malformed } = readApproved(stateRoot);
  if (cases.length === 0) {
    process.stderr.write(
      `error: no approved Golden cases at ${stateRoot}/golden/cases.jsonl\n` +
        `       run 'anydocs-ask golden generate' then 'anydocs-ask golden review' first.\n`,
    );
    return 1;
  }
  if (malformed > 0) {
    process.stderr.write(`[ask] eval: skipped ${malformed} malformed line(s)\n`);
  }
  process.stdout.write(`anydocs-ask eval: ${cases.length} cases loaded\n`);
  opts.onProgress?.({ type: 'boot', totalCases: cases.length });

  // 2. Boot Runtime (no HTTP). skipWatcher avoids chokidar reindex churn during eval.
  const runtime = new Runtime({ projectRoot, stateRoot, config, skipWatcher: true });
  const t0 = performance.now();
  const start = await runtime.start();
  process.stdout.write(
    `anydocs-ask eval: warm in ${start.boot_ms}ms — chunks=${start.initialIndex.chunks.totalChunks}\n`,
  );
  opts.onProgress?.({ type: 'warm', bootMs: start.boot_ms, chunks: start.initialIndex.chunks.totalChunks });

  // 3. Run cases.
  const agentEnabled = runtime.config.agent.enabled;
  // The Agent owns its evidence-search dependencies. Supplying retrieval-only
  // deps here keeps the retry harness type-safe without constructing the
  // legacy answer/router LLMs on an Agent eval run.
  const deps = agentEnabled
    ? askDepsForRetrievalEval(runtime, { noRouter: true })
    : askDepsForEval(runtime);
  const askOnce: EvalAskFn = agentEnabled
    ? (_deps, req) => runtime.agentRunner.ask(req)
    : askWithTraceForEval;
  process.stdout.write(
    `anydocs-ask eval: execution mode=${agentEnabled ? 'agent' : 'legacy'}\n`,
  );
  const results: CaseResult[] = [];
  const caseTraces: EvalCaseTraceRecord[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    opts.onProgress?.({
      type: 'case-start',
      i, total: cases.length,
      caseId: c.id, query: c.query, lang: c.lang,
    });
    const t1 = performance.now();
    let traced;
    let caseResult: CaseResult;
    try {
      traced = await runEvalCaseWithRetries(c, deps, askOnce);
      caseResult = scoreCase(c, traced.result, traced.trace);
      caseResult.latency_ms = Math.round(performance.now() - t1);
    } catch (err) {
      process.stderr.write(`[ask] eval: case ${c.id} threw: ${(err as Error).message}\n`);
      caseResult = failedCase(c, performance.now() - t1);
    }
    results.push(caseResult);
    caseTraces.push(buildEvalCaseTraceRecord({
      c,
      index: i,
      total: cases.length,
      caseResult,
      traced: traced ?? null,
    }));
    opts.onProgress?.({
      type: 'case-done',
      i, total: cases.length,
      caseId: c.id,
      latencyMs: caseResult.latency_ms,
      kind: caseResult.kind,
      hit_at_5: caseResult.hit_at_5,
      hit_at_1: caseResult.hit_at_1,
      hit_at_3: caseResult.hit_at_3,
      mrr: caseResult.mrr,
      context_precision_at_5: caseResult.context_precision_at_5,
      citation_anchor_pass: caseResult.citation_anchor_pass,
      unexpected_citation_rate: caseResult.unexpected_citation_rate,
      answer_rule_pass: caseResult.answer_rule_pass,
    });
    if ((i + 1) % 5 === 0 || i === cases.length - 1) {
      process.stdout.write(`  ${i + 1}/${cases.length} cases done\n`);
    }
  }
  await runtime.stop();
  const totalMs = Math.round(performance.now() - t0);

  // 4. Aggregate.
  const summary = summarizeResults(results);

  // 5. Diff against baseline (last prior eval report if not specified).
  const baseline = loadBaseline(stateRoot, opts.baselinePath);

  // 6. Write report.
  const { reportPath, caseTracePath } = writeReport(stateRoot, {
    summary,
    results,
    caseTraces,
    totalMs,
    baseline,
  });
  process.stdout.write(
    `anydocs-ask eval: wrote ${reportPath}\n` +
      `anydocs-ask eval: wrote ${caseTracePath}\n` +
      `  MRR=${summary.mrr.toFixed(2)}  H@5=${summary.hit_at_5.toFixed(2)}  CP@5=${summary.context_precision_at_5.toFixed(2)}  Field=${summary.retrieval_content_pass === null ? '—' : summary.retrieval_content_pass.toFixed(2)}  Anchor=${summary.citation_anchor_pass.toFixed(2)}  Kind=${summary.kind_pass.toFixed(2)}  Api=${summary.api_rule_pass === null ? '—' : summary.api_rule_pass.toFixed(2)}  (retrieval diagnostics: H@1=${summary.hit_at_1.toFixed(2)} H@3=${summary.hit_at_3.toFixed(2)}; citations: unexpected=${summary.unexpected_citation_rate.toFixed(2)}; ${results.length} cases, ${totalMs}ms)\n`,
  );
  opts.onProgress?.({ type: 'done', reportPath, totalMs, summary });
  return 0;
}

export async function runRetrievalEval(opts: EvalOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const { config, source } = await loadConfig(projectRoot);
  if (source) {
    process.stdout.write(`anydocs-ask retrieval eval: loaded config from ${source}\n`);
  }

  const { rows: cases, malformed } = readApproved(stateRoot);
  if (cases.length === 0) {
    process.stderr.write(
      `error: no approved Golden cases at ${stateRoot}/golden/cases.jsonl\n` +
        `       run 'anydocs-ask golden generate' then 'anydocs-ask golden review' first.\n`,
    );
    return 1;
  }
  if (malformed > 0) {
    process.stderr.write(`[ask] retrieval eval: skipped ${malformed} malformed line(s)\n`);
  }
  process.stdout.write(`anydocs-ask retrieval eval: ${cases.length} cases loaded\n`);

  const runtime = new Runtime({ projectRoot, stateRoot, config, skipWatcher: true });
  const t0 = performance.now();
  const start = await runtime.start();
  process.stdout.write(
    `anydocs-ask retrieval eval: warm in ${start.boot_ms}ms — chunks=${start.initialIndex.chunks.totalChunks}\n`,
  );

  const deps = askDepsForRetrievalEval(runtime, { noRouter: opts.retrievalNoRouter === true });
  const results: RetrievalCaseResult[] = [];
  const caseTraces: RetrievalEvalCaseTraceRecord[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const t1 = performance.now();
    let traced: AskRetrievalOnlyResult | null = null;
    let caseResult: RetrievalCaseResult;
    try {
      traced = await retrieveOnlyWithTrace(deps, goldenToAskRequest(c));
      caseResult = scoreRetrievalCase(c, traced.trace, performance.now() - t1);
    } catch (err) {
      process.stderr.write(`[ask] retrieval eval: case ${c.id} threw: ${(err as Error).message}\n`);
      caseResult = scoreRetrievalCase(c, { fused: [] }, performance.now() - t1);
    }
    results.push(caseResult);
    caseTraces.push(buildRetrievalEvalCaseTraceRecord({
      c,
      index: i,
      total: cases.length,
      caseResult,
      traced,
    }));
    if ((i + 1) % 20 === 0 || i === cases.length - 1) {
      process.stdout.write(`  ${i + 1}/${cases.length} retrieval cases done\n`);
    }
  }
  await runtime.stop();
  const totalMs = Math.round(performance.now() - t0);
  const summary = summarizeRetrievalResults(results);
  const { reportPath, caseTracePath } = writeRetrievalReport(stateRoot, {
    summary,
    results,
    caseTraces,
    totalMs,
    noRouter: opts.retrievalNoRouter === true,
  });
  process.stdout.write(
    `anydocs-ask retrieval eval: wrote ${reportPath}\n` +
      `anydocs-ask retrieval eval: wrote ${caseTracePath}\n` +
      `  MRR=${summary.mrr.toFixed(2)}  H@5=${summary.hit_at_5.toFixed(2)}  CP@5=${summary.context_precision_at_5.toFixed(2)}  Field=${summary.retrieval_content_pass === null ? '—' : summary.retrieval_content_pass.toFixed(2)}  (retrieval diagnostics: H@1=${summary.hit_at_1.toFixed(2)} H@3=${summary.hit_at_3.toFixed(2)}; ${results.length} cases, ${totalMs}ms)\n`,
  );
  return 0;
}

export type EvalAskFn = (deps: AskDeps, req: AskRequest) => Promise<AskWithTraceResult>;

export function evalAskModeForDeps(deps: Pick<AskDeps, 'llm'>): 'stream' | 'json' {
  return deps.llm.streamGenerate ? 'stream' : 'json';
}

export async function askWithTraceForEval(
  deps: AskDeps,
  req: AskRequest,
): Promise<AskWithTraceResult> {
  if (evalAskModeForDeps(deps) === 'stream') {
    return askWithTraceStream(deps, req, { onDelta: () => {} });
  }
  return askWithTrace(deps, req);
}

export async function runEvalCaseWithRetries(
  c: GoldenCase,
  deps: AskDeps,
  askOnce: EvalAskFn = askWithTraceForEval,
  opts: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<AskWithTraceResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? EVAL_CASE_ATTEMPTS);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? EVAL_RETRY_DELAY_MS);
  const req = goldenToAskRequest(c);
  for (let attempt = 1; ; attempt++) {
    const traced = await askOnce(deps, req);
    if (attempt >= maxAttempts || !shouldRetryEvalResult(traced.result)) {
      return traced;
    }
    if (retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
  }
}

export function shouldRetryEvalResult(result: AskResult): boolean {
  return result.type === 'error' && (
    result.code === 'llm_failed' ||
    result.code === 'no_citations' ||
    result.code === 'agent_failed' ||
    result.code === 'agent_invalid_citations'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function askDepsForEval(
  runtime: Pick<Runtime, 'db' | 'embedder' | 'llm' | 'config'> & {
    reranker?: Runtime['reranker'];
    intentRouter?: IntentRouter;
  },
): AskDeps {
  return {
    db: runtime.db,
    embedder: runtime.embedder,
    llm: runtime.llm,
    reranker: runtime.reranker ?? null,
    rerankerConfig: runtime.config.reranker,
    retrievalConfig: runtime.config.retrieval,
    promptConfig: runtime.config.prompt,
    intentRouter: runtime.intentRouter,
  };
}

export function askDepsForRetrievalEval(
  runtime: Pick<Runtime, 'db' | 'embedder' | 'config'> &
    Partial<Pick<Runtime, 'llm'>> &
    { reranker?: Runtime['reranker']; intentRouter?: IntentRouter },
  opts: { noRouter?: boolean } = {},
): AskDeps {
  if (opts.noRouter === true) {
    return {
      db: runtime.db,
      embedder: runtime.embedder,
      llm: RETRIEVAL_EVAL_UNUSED_LLM,
      reranker: runtime.reranker ?? null,
      rerankerConfig: runtime.config.reranker,
      retrievalConfig: runtime.config.retrieval,
      promptConfig: runtime.config.prompt,
      intentRouter: RAW_RETRIEVAL_EVAL_ROUTER,
    };
  }
  return askDepsForEval(runtime as Pick<Runtime, 'db' | 'embedder' | 'llm' | 'config'> & {
    reranker?: Runtime['reranker'];
    intentRouter?: IntentRouter;
  });
}

const RAW_RETRIEVAL_EVAL_ROUTER: IntentRouter = {
  async route({ question }) {
    return {
      ...fallbackRoute(question),
      reason: 'retrieval_eval_no_router',
    };
  },
};

const RETRIEVAL_EVAL_UNUSED_LLM: LLM = {
  model: 'retrieval-eval-no-router',
  async generate() {
    throw new Error('retrieval eval --no-router should not call the LLM');
  },
};

function goldenToAskRequest(c: GoldenCase): AskRequest {
  const req: AskRequest = { question: c.query };
  if (c.context_pageId) {
    req.context = { current_page_id: c.context_pageId };
  }
  return req;
}

export function buildEvalCaseTraceRecord(args: {
  c: GoldenCase;
  index: number;
  total: number;
  caseResult: CaseResult;
  traced: AskWithTraceResult | null;
}): EvalCaseTraceRecord {
  const runtimeBuild = readRuntimeBuildMetadata(process.env);
  const result = args.traced?.result ?? {
    type: 'error',
    code: args.caseResult.error_code ?? 'exception',
    message: args.caseResult.error_message ?? 'eval case failed before result',
    detail: args.caseResult.error_detail,
  };
  return {
    schema_version: 2,
    case_id: args.c.id,
    index: args.index,
    total: args.total,
    query: args.c.query,
    lang: args.c.lang,
    request: goldenToAskRequest(args.c),
    expected: args.c.expected,
    score: args.caseResult,
    result,
    trace: args.traced?.trace ?? null,
    diagnostics: buildEvalTraceDiagnostics(args.traced?.trace ?? null),
    runtime_build: hasRuntimeBuildMetadata(runtimeBuild) ? runtimeBuild : null,
    ragas_sample: buildRagasSample(args.c, result, args.traced?.trace ?? null),
  };
}

export function buildRagasSample(
  c: GoldenCase,
  result: AskResult,
  trace: AskTrace | null,
): EvalRagasSample {
  const snapshotContexts = (trace?.input_snapshot?.documents ?? [])
    .map((document) => document.text.trim())
    .filter((text) => text.length > 0);
  const previewContexts = (trace?.selected_context ?? [])
    .map((chunk) => chunk.text_preview.trim())
    .filter((text) => text.length > 0);
  const referenceFacts = (c.expected.reference_facts ?? [])
    .map((fact) => fact.trim())
    .filter((fact) => fact.length > 0);
  const referenceAnswer = c.expected.reference_answer?.trim();
  const reference = referenceAnswer && referenceAnswer.length > 0
    ? referenceAnswer
    : referenceFacts.length > 0
      ? referenceFacts.map((fact) => `- ${fact}`).join('\n')
      : null;

  return {
    user_input: c.query,
    response: result.type === 'answer' ? result.answer_md : null,
    retrieved_contexts: snapshotContexts.length > 0 ? snapshotContexts : previewContexts,
    reference,
    reference_facts: referenceFacts,
    rubric: c.expected.evaluation_rubric ?? {},
    context_source: snapshotContexts.length > 0
      ? 'prompt_snapshot'
      : previewContexts.length > 0
        ? trace?.agent
          ? 'agent_evidence'
          : 'trace_preview'
        : 'none',
  };
}

export function buildRetrievalEvalCaseTraceRecord(args: {
  c: GoldenCase;
  index: number;
  total: number;
  caseResult: RetrievalCaseResult;
  traced: AskRetrievalOnlyResult | null;
}): RetrievalEvalCaseTraceRecord {
  return {
    schema_version: 1,
    case_id: args.c.id,
    index: args.index,
    total: args.total,
    query: args.c.query,
    lang: args.c.lang,
    request: goldenToAskRequest(args.c),
    expected: args.c.expected,
    score: args.caseResult,
    trace: args.traced?.trace ?? null,
    diagnostics: buildEvalTraceDiagnostics(args.traced?.trace ?? null),
  };
}

function buildEvalTraceDiagnostics(trace: AskTrace | null): EvalTraceDiagnostics {
  return {
    route: trace?.intent_route ? buildRouteDiagnostic(trace.intent_route) : null,
    search_question: trace?.search_question ?? trace?.intent_route?.effectiveQuestion ?? null,
    retrieve_question: trace?.retrieve_question ?? null,
    retrieved_top20: (trace?.fused ?? []).slice(0, 20).map((chunk, index) => buildChunkDiagnostic(chunk, index)),
    prompt_context: (trace?.selected_context ?? []).map((chunk, index) => buildChunkDiagnostic(chunk, index)),
  };
}

function buildRouteDiagnostic(route: NonNullable<AskTrace['intent_route']>): EvalTraceRouteDiagnostic {
  return {
    original_question: route.originalQuestion,
    effective_query: route.effectiveQuestion,
    uses_history: route.usesHistory,
    rewritten: route.rewritten,
    intent: route.intent,
    product: route.product,
    api_intent: route.apiIntent,
    signature_auth_intent: route.signatureAuthIntent,
    project_setup_intent: route.projectSetupIntent,
    api_reference_hints: route.apiReferenceHints,
    supplemental_page_ids: route.supplementalPageIds,
    api_reference_version_prefs: route.apiReferenceVersionPrefs,
    reason: route.reason,
  };
}

function buildChunkDiagnostic(
  chunk: AskTrace['fused'][number] | NonNullable<AskTrace['selected_context']>[number],
  index: number,
): EvalTraceChunkDiagnostic {
  const maybeContext = chunk as Partial<NonNullable<AskTrace['selected_context']>[number]>;
  return {
    rank: index + 1,
    chunk_id: chunk.chunk_id,
    page_id: chunk.page_id,
    ...(maybeContext.page_title ? { page_title: maybeContext.page_title } : {}),
    ...(maybeContext.page_url !== undefined ? { page_url: maybeContext.page_url } : {}),
    ...(maybeContext.lang ? { lang: maybeContext.lang } : {}),
    ...(maybeContext.in_page_path ? { in_page_path: maybeContext.in_page_path } : {}),
    ...(maybeContext.text_preview ? { text_preview: maybeContext.text_preview } : {}),
    ...(chunk.identifiers?.length ? { identifiers: chunk.identifiers } : {}),
    final_score: chunk.final_score,
    rrf_score: chunk.rrf_score,
    vec_rank: chunk.vec_rank,
    bm25_rank: chunk.bm25_rank,
    nav_index: chunk.nav_index,
  };
}

// ---------------------------------------------------------------------------
// Baseline + report
// ---------------------------------------------------------------------------

type Baseline = { date: string; summary: EvalSummary } | null;

type LegacyEvalSummary = Partial<EvalSummary> & { r_at_5?: number };

function loadBaseline(stateRoot: string, override: string | undefined): Baseline {
  const path = override ?? findLatestEvalReport(stateRoot);
  if (!path || !existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const m = text.match(/<!--\s*EVAL_SUMMARY\s+(\{.*?\})\s*-->/);
    if (!m) return null;
    const data = JSON.parse(m[1]!) as { date: string; summary: LegacyEvalSummary };
    const summary = normalizeBaselineSummary(data.summary);
    return summary ? { date: data.date, summary } : null;
  } catch {
    return null;
  }
}

function normalizeBaselineSummary(raw: LegacyEvalSummary): EvalSummary | null {
  const hitAt5 = raw.hit_at_5 ?? raw.r_at_5;
  if (
    typeof raw.n !== 'number' ||
    typeof hitAt5 !== 'number' ||
    typeof raw.hit_at_1 !== 'number' ||
    typeof raw.hit_at_3 !== 'number' ||
    typeof raw.mrr !== 'number' ||
    typeof raw.context_precision_at_5 !== 'number' ||
    typeof raw.citation_anchor_pass !== 'number' ||
    typeof raw.unexpected_citation_rate !== 'number' ||
    typeof raw.answer_rule_pass !== 'number' ||
    typeof raw.kind_pass !== 'number' ||
    typeof raw.api_rule_n !== 'number'
  ) {
    return null;
  }
  return {
    n: raw.n,
    hit_at_5: hitAt5,
    hit_at_1: raw.hit_at_1,
    hit_at_3: raw.hit_at_3,
    mrr: raw.mrr,
    context_precision_at_5: raw.context_precision_at_5,
    citation_anchor_pass: raw.citation_anchor_pass,
    unexpected_citation_rate: raw.unexpected_citation_rate,
    answer_rule_pass: raw.answer_rule_pass,
    kind_pass: raw.kind_pass,
    api_rule_n: raw.api_rule_n,
    api_rule_pass: raw.api_rule_pass ?? null,
    retrieval_content_n: raw.retrieval_content_n ?? 0,
    retrieval_content_pass: raw.retrieval_content_pass ?? null,
  };
}

function findLatestEvalReport(stateRoot: string): string | null {
  const dir = join(stateRoot, 'reports');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-eval\.md$/.test(f));
  if (files.length === 0) return null;
  files.sort();
  return join(dir, files[files.length - 1]!);
}

function writeReport(
  stateRoot: string,
  args: {
    summary: EvalSummary;
    results: CaseResult[];
    caseTraces: EvalCaseTraceRecord[];
    totalMs: number;
    baseline: Baseline;
  },
): { reportPath: string; caseTracePath: string } {
  const dir = join(stateRoot, 'reports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = join(dir, `${date}-eval.md`);
  const caseTracePath = join(dir, `${date}-eval.cases.jsonl`);
  const md = renderReport(date, args);
  writeFileSync(reportPath, md, 'utf8');
  writeCaseTraceJsonl(caseTracePath, args.caseTraces);
  return { reportPath, caseTracePath };
}

function writeRetrievalReport(
  stateRoot: string,
  args: {
    summary: RetrievalEvalSummary;
    results: RetrievalCaseResult[];
    caseTraces: RetrievalEvalCaseTraceRecord[];
    totalMs: number;
    noRouter?: boolean;
  },
): { reportPath: string; caseTracePath: string } {
  const dir = join(stateRoot, 'reports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const basename = args.noRouter ? `${date}-retrieval-eval.raw` : `${date}-retrieval-eval`;
  const reportPath = join(dir, `${basename}.md`);
  const caseTracePath = join(dir, `${basename}.cases.jsonl`);
  const md = renderRetrievalReport(date, args);
  writeFileSync(reportPath, md, 'utf8');
  writeCaseTraceJsonl(caseTracePath, args.caseTraces);
  return { reportPath, caseTracePath };
}

export function writeCaseTraceJsonl(
  path: string,
  records: Array<EvalCaseTraceRecord | RetrievalEvalCaseTraceRecord>,
): void {
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '', 'utf8');
}

export function renderRetrievalReport(
  date: string,
  args: {
    summary: RetrievalEvalSummary;
    results: RetrievalCaseResult[];
    caseTraces: RetrievalEvalCaseTraceRecord[];
    totalMs: number;
    noRouter?: boolean;
  },
): string {
  const { summary, results, totalMs } = args;
  const fmt = (x: number): string => x.toFixed(2);
  const fmtOpt = (x: number | null | undefined): string => x === null || x === undefined ? '—' : x.toFixed(2);
  const lines: string[] = [];
  lines.push(`# Retrieval Eval — ${date}`);
  lines.push('');
  lines.push(`Cases: ${summary.n}  Wall time: ${totalMs}ms`);
  lines.push(`Router: ${args.noRouter ? 'disabled (--no-router raw retrieval)' : 'enabled (routed retrieval)'}`);
  lines.push(`Case traces: \`${args.noRouter ? `${date}-retrieval-eval.raw` : `${date}-retrieval-eval`}.cases.jsonl\``);
  lines.push('');
  lines.push('## Core retrieval quality');
  lines.push('');
  lines.push('| metric      | value |');
  lines.push('|-------------|-------|');
  lines.push(`| MRR         | ${fmt(summary.mrr)}  |`);
  lines.push(`| Hit@5       | ${fmt(summary.hit_at_5)}  |`);
  lines.push(`| Context-P@5 | ${fmt(summary.context_precision_at_5)}  |`);
  lines.push(`| Field retrieval | ${fmtOpt(summary.retrieval_content_pass)}  |`);
  if (summary.retrieval_content_n > 0) {
    lines.push('');
    lines.push(`Field-retrieval cases: ${summary.retrieval_content_n}`);
  }
  lines.push('');
  lines.push('## Retrieval diagnostics');
  lines.push('');
  lines.push('| metric      | value |');
  lines.push('|-------------|-------|');
  lines.push(`| Hit@1       | ${fmt(summary.hit_at_1)}  |`);
  lines.push(`| Hit@3       | ${fmt(summary.hit_at_3)}  |`);
  lines.push('');
  lines.push(
    args.noRouter
      ? 'This mode skips the intent router, final answer generation, and citation postprocessing. It measures raw retrieval over the user question.'
      : 'This mode skips final answer generation and citation postprocessing. It still uses the configured intent router, so route/rewrite effects are included in retrieval metrics.',
  );
  lines.push('');

  const recallFails = results.filter((r) => !r.hit_at_5);
  if (recallFails.length > 0) {
    lines.push(`## Retrieval misses (${recallFails.length})`);
    for (const r of recallFails) {
      lines.push(`- ${r.case_id}: ${r.query}`);
      lines.push(`  - top5: ${r.retrieved_pages_top5.join(', ') || '(empty)'}`);
    }
    lines.push('');
  }

  const top1Fails = results.filter((r) => r.hit_at_5 && !r.hit_at_1);
  if (top1Fails.length > 0) {
    lines.push(`## Top-1 misses (${top1Fails.length})`);
    for (const r of top1Fails) {
      lines.push(`- ${r.case_id}: MRR=${r.mrr.toFixed(2)} top5=[${r.retrieved_pages_top5.join(', ')}]`);
    }
    lines.push('');
  }

  const contentFails = results.filter((r) => r.retrieval_content_pass === false);
  if (contentFails.length > 0) {
    lines.push(`## Field retrieval misses (${contentFails.length})`);
    for (const r of contentFails) {
      lines.push(`- ${r.case_id}: missing regex=[${r.missing_must_retrieve_regex.join(', ')}]`);
    }
    lines.push('');
  }

  const embed = JSON.stringify({ date, summary });
  lines.push(`<!-- RETRIEVAL_EVAL_SUMMARY ${embed} -->`);
  lines.push('');
  return lines.join('\n');
}

export function renderReport(
  date: string,
  args: {
    summary: EvalSummary;
    results: CaseResult[];
    caseTraces: EvalCaseTraceRecord[];
    totalMs: number;
    baseline: Baseline;
  },
): string {
  const { summary, results, totalMs, baseline } = args;
  const fmt = (x: number): string => x.toFixed(2);
  const fmtOpt = (x: number | null | undefined): string => x === null || x === undefined ? '—' : x.toFixed(2);
  const delta = (curr: number, base: number | undefined): string =>
    base === undefined ? '—' : `${curr - base >= 0 ? '+' : ''}${(curr - base).toFixed(2)}`;
  const deltaOpt = (curr: number | null, base: number | null | undefined): string =>
    curr === null || base === null || base === undefined ? '—' : `${curr - base >= 0 ? '+' : ''}${(curr - base).toFixed(2)}`;
  const baseRow = baseline?.summary;

  const lines: string[] = [];
  lines.push(`# Eval — ${date}`);
  lines.push('');
  lines.push(`Cases: ${summary.n}  Wall time: ${totalMs}ms`);
  lines.push(`Case traces: \`${date}-eval.cases.jsonl\``);
  if (baseline) {
    lines.push(
      `Baseline: ${baseline.date} (MRR=${fmtOpt(baseRow!.mrr)}, H@5=${fmtOpt(baseRow!.hit_at_5)}, CP@5=${fmtOpt(baseRow!.context_precision_at_5)}, Anchor=${fmtOpt(baseRow!.citation_anchor_pass)}, Kind=${fmtOpt(baseRow!.kind_pass)}, Api=${fmtOpt(baseRow!.api_rule_pass)})`,
    );
  } else {
    lines.push(`Baseline: (none — first run)`);
  }
  lines.push('');
  lines.push('## Core quality');
  lines.push('');
  lines.push('| metric           | value | baseline | Δ     |');
  lines.push('|------------------|-------|----------|-------|');
  lines.push(
    `| MRR              | ${fmt(summary.mrr)}  | ${baseRow ? fmtOpt(baseRow.mrr) : '—   '}    | ${deltaOpt(summary.mrr, baseRow?.mrr)} |`,
  );
  lines.push(
    `| Hit@5            | ${fmt(summary.hit_at_5)}  | ${baseRow ? fmtOpt(baseRow.hit_at_5) : '—   '}    | ${deltaOpt(summary.hit_at_5, baseRow?.hit_at_5)} |`,
  );
  lines.push(
    `| Context-P@5      | ${fmt(summary.context_precision_at_5)}  | ${baseRow ? fmtOpt(baseRow.context_precision_at_5) : '—   '}    | ${deltaOpt(summary.context_precision_at_5, baseRow?.context_precision_at_5)} |`,
  );
  lines.push(
    `| Field-retrieval  | ${fmtOpt(summary.retrieval_content_pass)}  | ${baseRow ? fmtOpt(baseRow.retrieval_content_pass) : '—   '}    | ${deltaOpt(summary.retrieval_content_pass, baseRow?.retrieval_content_pass)} |`,
  );
  lines.push(
    `| Citation-anchor  | ${fmt(summary.citation_anchor_pass)}  | ${baseRow ? fmtOpt(baseRow.citation_anchor_pass) : '—   '}    | ${deltaOpt(summary.citation_anchor_pass, baseRow?.citation_anchor_pass)} |`,
  );
  lines.push(
    `| Kind-pass        | ${fmt(summary.kind_pass)}  | ${baseRow ? fmtOpt(baseRow.kind_pass) : '—   '}    | ${delta(summary.kind_pass, baseRow?.kind_pass)} |`,
  );
  lines.push(
    `| API-rule-pass    | ${fmtOpt(summary.api_rule_pass)}  | ${baseRow ? fmtOpt(baseRow.api_rule_pass) : '—   '}    | ${deltaOpt(summary.api_rule_pass, baseRow?.api_rule_pass)} |`,
  );
  if (summary.api_rule_n > 0) {
    lines.push('');
    lines.push(`API-rule cases: ${summary.api_rule_n}`);
  }
  if (summary.retrieval_content_n > 0) {
    lines.push(`Field-retrieval cases: ${summary.retrieval_content_n}`);
  }
  lines.push('');
  lines.push('## Retrieval diagnostics');
  lines.push('');
  lines.push('| metric      | value | baseline | Δ     |');
  lines.push('|-------------|-------|----------|-------|');
  lines.push(
    `| Hit@1       | ${fmt(summary.hit_at_1)}  | ${baseRow ? fmtOpt(baseRow.hit_at_1) : '—   '}    | ${deltaOpt(summary.hit_at_1, baseRow?.hit_at_1)} |`,
  );
  lines.push(
    `| Hit@3       | ${fmt(summary.hit_at_3)}  | ${baseRow ? fmtOpt(baseRow.hit_at_3) : '—   '}    | ${deltaOpt(summary.hit_at_3, baseRow?.hit_at_3)} |`,
  );
  lines.push('');
  lines.push('Hit@1 and Hit@3 expose rank concentration below the headline Hit@5 reach metric.');
  lines.push('');
  lines.push('## Citation calibration');
  lines.push('');
  lines.push('`Citation-anchor` is the headline signal: at least one citation points at an expected source.');
  lines.push('Use unexpected citation pages to decide whether to expand `allow_cite_pages` or fix retrieval/prompt behavior.');
  lines.push('');
  lines.push('| metric                     | value | baseline | Δ     |');
  lines.push('|----------------------------|-------|----------|-------|');
  lines.push(
    `| Unexpected-citation-rate | ${fmt(summary.unexpected_citation_rate)}  | ${baseRow ? fmtOpt(baseRow.unexpected_citation_rate) : '—   '}    | ${deltaOpt(summary.unexpected_citation_rate, baseRow?.unexpected_citation_rate)} |`,
  );
  const unexpectedCitationCases = results.filter((r) => r.kind === 'answer' && r.unexpected_citation_pages.length > 0);
  if (unexpectedCitationCases.length > 0) {
    lines.push('');
    lines.push(`### Unexpected citation pages (${unexpectedCitationCases.length})`);
    for (const r of unexpectedCitationCases) {
      lines.push(`- ${r.case_id}: unexpected=[${r.unexpected_citation_pages.join(', ')}] cited=[${r.cited_pages.join(', ')}]`);
    }
  }
  lines.push('');
  lines.push('## Answer text diagnostics');
  lines.push('');
  lines.push('`answer_keyword_overlap` is substring/regex matching against the answer:');
  lines.push('brittle to synonyms (false fails) and easily keyword-stuffed (false passes).');
  lines.push('Slated for replacement by an LLM-judge `semantic_pass` in eval Phase 5.');
  lines.push('');
  lines.push('| metric                          | value | baseline | Δ     |');
  lines.push('|---------------------------------|-------|----------|-------|');
  lines.push(
    `| answer_keyword_overlap (brittle)| ${fmt(summary.answer_rule_pass)}  | ${baseRow ? fmt(baseRow.answer_rule_pass) : '—   '}    | ${delta(summary.answer_rule_pass, baseRow?.answer_rule_pass)} |`,
  );
  lines.push('');

  const recallFails = results.filter((r) => !r.hit_at_5);
  if (recallFails.length > 0) {
    lines.push(`## Retrieval misses (${recallFails.length})`);
    for (const r of recallFails) {
      lines.push(`- ${r.case_id}: ${r.query}`);
      lines.push(`  - top5: ${r.retrieved_pages_top5.join(', ') || '(empty)'}`);
    }
    lines.push('');
  }

  const anchorFails = results.filter((r) => r.kind === 'answer' && !r.citation_anchor_pass);
  if (anchorFails.length > 0) {
    lines.push(`## Citation-anchor failures (${anchorFails.length})`);
    for (const r of anchorFails) {
      lines.push(`- ${r.case_id}: cited=[${r.cited_pages.join(', ')}]`);
    }
    lines.push('');
  }

  const retrievalContentFails = results.filter((r) => r.retrieval_content_pass === false);
  if (retrievalContentFails.length > 0) {
    lines.push(`## Field retrieval failures (${retrievalContentFails.length})`);
    for (const r of retrievalContentFails) {
      lines.push(`- ${r.case_id}: missing regex=[${r.missing_must_retrieve_regex.join(', ')}]`);
    }
    lines.push('');
  }

  const ruleFails = results.filter((r) => r.kind === 'answer' && !r.answer_rule_pass);
  if (ruleFails.length > 0) {
    lines.push(`## Keyword-overlap misses (${ruleFails.length}) — diagnostic, not failures`);
    for (const r of ruleFails) {
      const bits: string[] = [];
      if (r.missing_must_contain.length > 0) bits.push(`missing: ${r.missing_must_contain.join(', ')}`);
      if (r.missing_must_contain_regex.length > 0) bits.push(`missing regex: ${r.missing_must_contain_regex.join(', ')}`);
      if (r.hit_forbid_contain.length > 0) bits.push(`forbid hit: ${r.hit_forbid_contain.join(', ')}`);
      if (r.hit_forbid_contain_regex.length > 0) bits.push(`forbid regex hit: ${r.hit_forbid_contain_regex.join(', ')}`);
      lines.push(`- ${r.case_id}: ${bits.join(' | ')}`);
    }
    lines.push('');
  }

  const apiFails = results.filter((r) => r.api_rule_pass === false);
  if (apiFails.length > 0) {
    lines.push(`## API-rule failures (${apiFails.length})`);
    for (const r of apiFails) {
      const bits: string[] = [];
      if (r.missing_must_cite_operations.length > 0) {
        bits.push(`missing operations: ${r.missing_must_cite_operations.join(', ')}`);
      }
      if (r.missing_must_cite_urls.length > 0) {
        bits.push(`missing citation URLs: ${r.missing_must_cite_urls.join(', ')}`);
      }
      lines.push(`- ${r.case_id}: ${bits.join(' | ')}`);
    }
    lines.push('');
  }

  const kindFails = results.filter((r) => !r.kind_pass);
  if (kindFails.length > 0) {
    lines.push(`## Kind failures (${kindFails.length})`);
    for (const r of kindFails) {
      lines.push(`- ${r.case_id}: expected ${r.expected_kind}, got ${r.kind}`);
    }
    lines.push('');
  }

  const offBranch = results.filter((r) => r.kind !== 'answer');
  if (offBranch.length > 0) {
    lines.push(`## Non-answer outcomes (${offBranch.length})`);
    for (const r of offBranch) {
      const diagnostic = [r.error_code, r.error_message, r.error_detail]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .map((part) => oneLine(part))
        .join(' — ');
      lines.push(`- ${r.case_id} → ${r.kind}: ${r.query}${diagnostic ? ` (${diagnostic})` : ''}`);
    }
    lines.push('');
  }

  // Embedded summary for next-run baseline diff.
  const embed = JSON.stringify({ date, summary });
  lines.push(`<!-- EVAL_SUMMARY ${embed} -->`);
  lines.push('');
  return lines.join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 240);
}
