/**
 * `anydocs-ask eval <projectRoot>` — runs the project's approved Golden cases
 * against an in-process Runtime, computes ARCH §16.3.2 three metrics, and
 * writes a Markdown report under `<state>/reports/<YYYY-MM-DD>-eval.md`.
 *
 * Metric semantics (locked 2026-05-08, mirrors ARCH §16.3.2):
 *   - R@5             = mean over cases of [ retrieved top-5 pages ∩ expected.must_cite_pages ≠ ∅ ]
 *                       Computed from the trace (always available).
 *   - Citation-pass   = mean over cases of [ kind=='answer' ∧ {answer.citations.pages} ⊆ expected.must_cite_pages ]
 *                       clarify / error responses count as fail (no citations to validate).
 *   - Answer-rule-pass= mean over cases of [ kind=='answer' ∧ all(must_contain) ∧ none(forbid_contain) ]
 *                       clarify / error responses count as fail. Substring matching is
 *                       case-insensitive ASCII-folded; CJK is byte-substring.
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
import { askWithTrace, askWithTraceStream, type AskDeps, type AskWithTraceResult } from '../query/answer.ts';
import { readApproved } from '../golden/store.ts';
import {
  failedCase,
  scoreCase,
  summarizeResults,
  type CaseResult,
  type EvalSummary,
} from '../eval/scoring.ts';
import type { GoldenCase } from '../golden/types.ts';
import type { AskRequest, AskResult } from '../query/types.ts';

export type EvalOptions = {
  projectRoot: string;
  stateRoot: string;
  /** Compare against this baseline file path. Defaults to most recent prior eval report. */
  baselinePath?: string;
  /**
   * Optional per-phase progress callback. Receives lifecycle + per-case
   * events as the loop advances. CLI users don't set this (output goes via
   * process.stdout as before); the console wraps it with the streaming
   * NDJSON endpoint so the Eval-tab UI can render a real progress bar.
   */
  onProgress?: (event: EvalProgressEvent) => void;
};

export type EvalProgressEvent =
  | { type: 'boot'; totalCases: number }
  | { type: 'warm'; bootMs: number; chunks: number }
  | { type: 'case-start'; i: number; total: number; caseId: string; query: string; lang: string }
  | { type: 'case-done'; i: number; total: number; caseId: string; latencyMs: number; kind: CaseResult['kind']; r_at_5: boolean; citation_pass: boolean; answer_rule_pass: boolean }
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
  const deps = askDepsForEval(runtime);
  const results: CaseResult[] = [];
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
    opts.onProgress?.({
      type: 'case-done',
      i, total: cases.length,
      caseId: c.id,
      latencyMs: caseResult.latency_ms,
      kind: caseResult.kind,
      r_at_5: caseResult.r_at_5,
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
  const reportPath = writeReport(stateRoot, { summary, results, totalMs, baseline });
  process.stdout.write(
    `anydocs-ask eval: wrote ${reportPath}\n` +
      `  R@5=${summary.r_at_5.toFixed(2)}  Cit=${summary.citation_pass.toFixed(2)}  Ans=${summary.answer_rule_pass.toFixed(2)}  Kind=${summary.kind_pass.toFixed(2)}  Api=${summary.api_rule_pass === null ? '—' : summary.api_rule_pass.toFixed(2)}  (${results.length} cases, ${totalMs}ms)\n`,
  );
  opts.onProgress?.({ type: 'done', reportPath, totalMs, summary });
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
  runtime: Pick<Runtime, 'db' | 'embedder' | 'llm' | 'config'>,
): AskDeps {
  return {
    db: runtime.db,
    embedder: runtime.embedder,
    llm: runtime.llm,
    promptConfig: runtime.config.prompt,
  };
}

function goldenToAskRequest(c: GoldenCase): AskRequest {
  const req: AskRequest = { question: c.query };
  if (c.context_pageId) {
    req.context = { current_page_id: c.context_pageId };
  }
  return req;
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
    totalMs: number;
    baseline: Baseline;
  },
): string {
  const dir = join(stateRoot, 'reports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${date}-eval.md`);
  const md = renderReport(date, args);
  writeFileSync(path, md, 'utf8');
  return path;
}

function renderReport(
  date: string,
  args: { summary: EvalSummary; results: CaseResult[]; totalMs: number; baseline: Baseline },
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
  if (baseline) {
    lines.push(
      `Baseline: ${baseline.date} (R@5=${fmt(baseRow!.r_at_5)}, Cit=${fmt(baseRow!.citation_pass)}, Ans=${fmt(baseRow!.answer_rule_pass)}, Kind=${fmtOpt(baseRow!.kind_pass)}, Api=${fmtOpt(baseRow!.api_rule_pass)})`,
    );
  } else {
    lines.push(`Baseline: (none — first run)`);
  }
  lines.push('');
  lines.push('| metric           | value | baseline | Δ     |');
  lines.push('|------------------|-------|----------|-------|');
  lines.push(
    `| R@5              | ${fmt(summary.r_at_5)}  | ${baseRow ? fmt(baseRow.r_at_5) : '—   '}    | ${delta(summary.r_at_5, baseRow?.r_at_5)} |`,
  );
  lines.push(
    `| Citation-pass    | ${fmt(summary.citation_pass)}  | ${baseRow ? fmt(baseRow.citation_pass) : '—   '}    | ${delta(summary.citation_pass, baseRow?.citation_pass)} |`,
  );
  lines.push(
    `| Answer-rule-pass | ${fmt(summary.answer_rule_pass)}  | ${baseRow ? fmt(baseRow.answer_rule_pass) : '—   '}    | ${delta(summary.answer_rule_pass, baseRow?.answer_rule_pass)} |`,
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
  lines.push('');

  const recallFails = results.filter((r) => !r.r_at_5);
  if (recallFails.length > 0) {
    lines.push(`## R@5 failures (${recallFails.length})`);
    for (const r of recallFails) {
      lines.push(`- ${r.case_id}: ${r.query}`);
      lines.push(`  - top5: ${r.retrieved_pages_top5.join(', ') || '(empty)'}`);
    }
    lines.push('');
  }

  const citFails = results.filter((r) => r.kind === 'answer' && !r.citation_pass);
  if (citFails.length > 0) {
    lines.push(`## Citation-pass failures (${citFails.length})`);
    for (const r of citFails) {
      lines.push(`- ${r.case_id}: cited=[${r.cited_pages.join(', ')}]`);
    }
    lines.push('');
  }

  const ruleFails = results.filter((r) => r.kind === 'answer' && !r.answer_rule_pass);
  if (ruleFails.length > 0) {
    lines.push(`## Answer-rule-pass failures (${ruleFails.length})`);
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
