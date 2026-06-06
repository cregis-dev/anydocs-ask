/**
 * `anydocs-ask eval <projectRoot>` — runs the project's approved Golden cases
 * against an in-process Runtime, computes retrieval / citation / answer
 * diagnostics, and
 * writes a Markdown report under `<state>/reports/<YYYY-MM-DD>-eval.md`.
 *
 * Report semantics:
 *   - Core quality: MRR, Hit@1, Context-R@5, citation anchor, Kind, API rule.
 *   - Retrieval diagnostics: Hit@3, Hit@5, Context-P@5.
 *   - Citation calibration: legacy strict Citation-pass and unexpected pages.
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
  schema_version: 1;
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
  final_score: number;
  rrf_score: number;
  vec_rank: number | null;
  bm25_rank: number | null;
  nav_index: number | null;
  nav_index_boost: number;
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
      /** @deprecated kept for old console clients; prefer hit_at_1 / mrr. */
      r_at_5: boolean;
      hit_at_1: boolean;
      hit_at_3: boolean;
      mrr: number;
      context_precision_at_5: number;
      citation_anchor_pass: boolean;
      unexpected_citation_rate: number;
      citation_pass: boolean;
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
  const deps = askDepsForRetrievalEval(runtime, { noRouter: opts.retrievalNoRouter === true });
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
      traced = await runEvalCaseWithRetries(c, deps);
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
      r_at_5: caseResult.r_at_5,
      hit_at_1: caseResult.hit_at_1,
      hit_at_3: caseResult.hit_at_3,
      mrr: caseResult.mrr,
      context_precision_at_5: caseResult.context_precision_at_5,
      citation_anchor_pass: caseResult.citation_anchor_pass,
      unexpected_citation_rate: caseResult.unexpected_citation_rate,
      citation_pass: caseResult.citation_pass,
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
      `  MRR=${summary.mrr.toFixed(2)}  H@1=${summary.hit_at_1.toFixed(2)}  CR@5=${summary.context_recall_at_5 === null ? '—' : summary.context_recall_at_5.toFixed(2)}  Anchor=${summary.citation_anchor_pass.toFixed(2)}  Kind=${summary.kind_pass.toFixed(2)}  Api=${summary.api_rule_pass === null ? '—' : summary.api_rule_pass.toFixed(2)}  (retrieval: H@3=${summary.hit_at_3.toFixed(2)} H@5=${summary.r_at_5.toFixed(2)} CP@5=${summary.context_precision_at_5.toFixed(2)}; citation: legacy=${summary.citation_pass.toFixed(2)} unexpected=${summary.unexpected_citation_rate.toFixed(2)}; ${results.length} cases, ${totalMs}ms)\n`,
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
      `  MRR=${summary.mrr.toFixed(2)}  H@1=${summary.hit_at_1.toFixed(2)}  CR@5=${summary.context_recall_at_5 === null ? '—' : summary.context_recall_at_5.toFixed(2)}  (retrieval: H@3=${summary.hit_at_3.toFixed(2)} H@5=${summary.r_at_5.toFixed(2)} CP@5=${summary.context_precision_at_5.toFixed(2)}; ${results.length} cases, ${totalMs}ms)\n`,
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
  return result.type === 'error' && (result.code === 'llm_failed' || result.code === 'no_citations');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function askDepsForEval(
  runtime: Pick<Runtime, 'db' | 'embedder' | 'llm' | 'config'> & { reranker?: Runtime['reranker'] },
): AskDeps {
  return {
    db: runtime.db,
    embedder: runtime.embedder,
    llm: runtime.llm,
    reranker: runtime.reranker ?? null,
    rerankerConfig: runtime.config.reranker,
    promptConfig: runtime.config.prompt,
  };
}

export function askDepsForRetrievalEval(
  runtime: Pick<Runtime, 'db' | 'embedder' | 'config'> &
    Partial<Pick<Runtime, 'llm'>> &
    { reranker?: Runtime['reranker'] },
  opts: { noRouter?: boolean } = {},
): AskDeps {
  if (opts.noRouter === true) {
    return {
      db: runtime.db,
      embedder: runtime.embedder,
      llm: RETRIEVAL_EVAL_UNUSED_LLM,
      reranker: runtime.reranker ?? null,
      rerankerConfig: runtime.config.reranker,
      promptConfig: runtime.config.prompt,
      intentRouter: RAW_RETRIEVAL_EVAL_ROUTER,
    };
  }
  return askDepsForEval(runtime as Pick<Runtime, 'db' | 'embedder' | 'llm' | 'config'> & { reranker?: Runtime['reranker'] });
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
  const result = args.traced?.result ?? {
    type: 'error',
    code: args.caseResult.error_code ?? 'exception',
    message: args.caseResult.error_message ?? 'eval case failed before result',
    detail: args.caseResult.error_detail,
  };
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
    result,
    trace: args.traced?.trace ?? null,
    diagnostics: buildEvalTraceDiagnostics(args.traced?.trace ?? null),
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
    final_score: chunk.final_score,
    rrf_score: chunk.rrf_score,
    vec_rank: chunk.vec_rank,
    bm25_rank: chunk.bm25_rank,
    nav_index: chunk.nav_index,
    nav_index_boost: chunk.nav_index_boost,
  };
}

// ---------------------------------------------------------------------------
// Baseline + report
// ---------------------------------------------------------------------------

type Baseline = { date: string; summary: EvalSummary } | null;

function loadBaseline(stateRoot: string, override: string | undefined): Baseline {
  const path = override ?? findLatestEvalReport(stateRoot);
  if (!path || !existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const m = text.match(/<!--\s*EVAL_SUMMARY\s+(\{.*?\})\s*-->/);
    if (!m) return null;
    const data = JSON.parse(m[1]!) as { date: string; summary: EvalSummary };
    return { date: data.date, summary: data.summary };
  } catch {
    return null;
  }
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
  lines.push(`| Hit@1       | ${fmt(summary.hit_at_1)}  |`);
  lines.push(`| Context-R@5 | ${fmtOpt(summary.context_recall_at_5)}  |`);
  if (summary.context_recall_n > 0) {
    lines.push('');
    lines.push(`Context-R@5 cases: ${summary.context_recall_n}`);
  }
  lines.push('');
  lines.push('## Retrieval diagnostics');
  lines.push('');
  lines.push('| metric      | value |');
  lines.push('|-------------|-------|');
  lines.push(`| Hit@3       | ${fmt(summary.hit_at_3)}  |`);
  lines.push(`| Hit@5       | ${fmt(summary.r_at_5)}  |`);
  lines.push(`| Context-P@5 | ${fmt(summary.context_precision_at_5)}  |`);
  lines.push('');
  lines.push(
    args.noRouter
      ? 'This mode skips the intent router, final answer generation, and citation postprocessing. It measures raw retrieval over the user question.'
      : 'This mode skips final answer generation and citation postprocessing. It still uses the configured intent router, so route/rewrite effects are included in retrieval metrics.',
  );
  lines.push('');

  const recallFails = results.filter((r) => !r.r_at_5);
  if (recallFails.length > 0) {
    lines.push(`## Retrieval misses (${recallFails.length})`);
    for (const r of recallFails) {
      lines.push(`- ${r.case_id}: ${r.query}`);
      lines.push(`  - top5: ${r.retrieved_pages_top5.join(', ') || '(empty)'}`);
    }
    lines.push('');
  }

  const top1Fails = results.filter((r) => r.r_at_5 && !r.hit_at_1);
  if (top1Fails.length > 0) {
    lines.push(`## Top-1 misses (${top1Fails.length})`);
    for (const r of top1Fails) {
      lines.push(`- ${r.case_id}: MRR=${r.mrr.toFixed(2)} top5=[${r.retrieved_pages_top5.join(', ')}]`);
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
      `Baseline: ${baseline.date} (MRR=${fmtOpt(baseRow!.mrr)}, H@1=${fmtOpt(baseRow!.hit_at_1)}, CR@5=${fmtOpt(baseRow!.context_recall_at_5)}, Anchor=${fmtOpt(baseRow!.citation_anchor_pass)}, Kind=${fmtOpt(baseRow!.kind_pass)}, Api=${fmtOpt(baseRow!.api_rule_pass)})`,
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
    `| Hit@1            | ${fmt(summary.hit_at_1)}  | ${baseRow ? fmtOpt(baseRow.hit_at_1) : '—   '}    | ${deltaOpt(summary.hit_at_1, baseRow?.hit_at_1)} |`,
  );
  lines.push(
    `| Context-R@5      | ${fmtOpt(summary.context_recall_at_5)}  | ${baseRow ? fmtOpt(baseRow.context_recall_at_5) : '—   '}    | ${deltaOpt(summary.context_recall_at_5, baseRow?.context_recall_at_5)} |`,
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
  if (summary.api_rule_n > 0 || summary.context_recall_n > 0) {
    lines.push('');
    if (summary.api_rule_n > 0) lines.push(`API-rule cases: ${summary.api_rule_n}`);
    if (summary.context_recall_n > 0) lines.push(`Context-R@5 cases: ${summary.context_recall_n}`);
  }
  lines.push('');
  lines.push('## Retrieval diagnostics');
  lines.push('');
  lines.push('| metric      | value | baseline | Δ     |');
  lines.push('|-------------|-------|----------|-------|');
  lines.push(
    `| Hit@3       | ${fmt(summary.hit_at_3)}  | ${baseRow ? fmtOpt(baseRow.hit_at_3) : '—   '}    | ${deltaOpt(summary.hit_at_3, baseRow?.hit_at_3)} |`,
  );
  lines.push(
    `| Hit@5       | ${fmt(summary.r_at_5)}  | ${baseRow ? fmt(baseRow.r_at_5) : '—   '}    | ${delta(summary.r_at_5, baseRow?.r_at_5)} |`,
  );
  lines.push(
    `| Context-P@5 | ${fmt(summary.context_precision_at_5)}  | ${baseRow ? fmtOpt(baseRow.context_precision_at_5) : '—   '}    | ${deltaOpt(summary.context_precision_at_5, baseRow?.context_precision_at_5)} |`,
  );
  lines.push('');
  lines.push('Hit@3 / Hit@5 expose retrieval reach, while Context-P@5 exposes top-K noise.');
  lines.push('These are diagnostics, not final answer quality gates.');
  lines.push('');
  lines.push('## Citation calibration');
  lines.push('');
  lines.push('`Citation-anchor` is the headline signal: at least one citation points at an expected source.');
  lines.push('`legacy Citation-pass` is stricter: every cited page must already be in the Golden must/allow list.');
  lines.push('Use unexpected citation pages to decide whether to expand `allow_cite_pages` or fix retrieval/prompt behavior.');
  lines.push('');
  lines.push('| metric                   | value | baseline | Δ     |');
  lines.push('|--------------------------|-------|----------|-------|');
  lines.push(
    `| legacy Citation-pass     | ${fmt(summary.citation_pass)}  | ${baseRow ? fmt(baseRow.citation_pass) : '—   '}    | ${delta(summary.citation_pass, baseRow?.citation_pass)} |`,
  );
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

  const recallFails = results.filter((r) => !r.r_at_5);
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

  const citFails = results.filter((r) => r.kind === 'answer' && !r.citation_pass);
  if (citFails.length > 0) {
    lines.push(`## Legacy strict citation failures (${citFails.length})`);
    for (const r of citFails) {
      lines.push(`- ${r.case_id}: cited=[${r.cited_pages.join(', ')}]`);
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
