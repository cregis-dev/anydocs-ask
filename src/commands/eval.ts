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
import { askWithTrace, type AskTrace } from '../query/answer.ts';
import { readApproved } from '../golden/store.ts';
import type { GoldenCase } from '../golden/types.ts';
import type { AskRequest, AskResult } from '../query/types.ts';

export type EvalOptions = {
  projectRoot: string;
  stateRoot: string;
  /** Compare against this baseline file path. Defaults to most recent prior eval report. */
  baselinePath?: string;
};

export type CaseResult = {
  case_id: string;
  query: string;
  kind: 'answer' | 'clarify' | 'error';
  r_at_5: boolean;
  citation_pass: boolean;
  answer_rule_pass: boolean;
  retrieved_pages_top5: string[];
  cited_pages: string[];
  missing_must_contain: string[];
  hit_forbid_contain: string[];
  latency_ms: number;
};

export type EvalSummary = {
  n: number;
  r_at_5: number;
  citation_pass: number;
  answer_rule_pass: number;
};

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

  // 2. Boot Runtime (no HTTP). skipWatcher avoids chokidar reindex churn during eval.
  const runtime = new Runtime({ projectRoot, stateRoot, config, skipWatcher: true });
  const t0 = performance.now();
  const start = await runtime.start();
  process.stdout.write(
    `anydocs-ask eval: warm in ${start.boot_ms}ms — chunks=${start.initialIndex.chunks.totalChunks}\n`,
  );

  // 3. Run cases.
  const deps = { db: runtime.db, embedder: runtime.embedder, llm: runtime.llm };
  const results: CaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const req = goldenToAskRequest(c);
    const t1 = performance.now();
    let traced;
    try {
      traced = await askWithTrace(deps, req);
    } catch (err) {
      process.stderr.write(`[ask] eval: case ${c.id} threw: ${(err as Error).message}\n`);
      results.push(failedCase(c, performance.now() - t1));
      continue;
    }
    const r = scoreCase(c, traced.result, traced.trace);
    r.latency_ms = Math.round(performance.now() - t1);
    results.push(r);
    if ((i + 1) % 5 === 0 || i === cases.length - 1) {
      process.stdout.write(`  ${i + 1}/${cases.length} cases done\n`);
    }
  }
  await runtime.stop();
  const totalMs = Math.round(performance.now() - t0);

  // 4. Aggregate.
  const summary: EvalSummary = {
    n: results.length,
    r_at_5: mean(results.map((r) => (r.r_at_5 ? 1 : 0))),
    citation_pass: mean(results.map((r) => (r.citation_pass ? 1 : 0))),
    answer_rule_pass: mean(results.map((r) => (r.answer_rule_pass ? 1 : 0))),
  };

  // 5. Diff against baseline (last prior eval report if not specified).
  const baseline = loadBaseline(stateRoot, opts.baselinePath);

  // 6. Write report.
  const reportPath = writeReport(stateRoot, { summary, results, totalMs, baseline });
  process.stdout.write(
    `anydocs-ask eval: wrote ${reportPath}\n` +
      `  R@5=${summary.r_at_5.toFixed(2)}  Cit=${summary.citation_pass.toFixed(2)}  Ans=${summary.answer_rule_pass.toFixed(2)}  (${results.length} cases, ${totalMs}ms)\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Per-case scoring
// ---------------------------------------------------------------------------

function goldenToAskRequest(c: GoldenCase): AskRequest {
  const req: AskRequest = { question: c.query };
  if (c.context_pageId) {
    req.context = { current_page_id: c.context_pageId };
  }
  return req;
}

function scoreCase(c: GoldenCase, result: AskResult, trace: AskTrace): CaseResult {
  const must = new Set(c.expected.must_cite_pages);

  // R@5: page-level OR-set intersection on top-5 retrieved chunks.
  const top5Pages = uniqueOrdered(trace.fused.slice(0, 5).map((f) => f.page_id));
  const r_at_5 = top5Pages.some((p) => must.has(p));

  // Default fail for clarify / error.
  let kind: CaseResult['kind'] = 'error';
  let cited_pages: string[] = [];
  let citation_pass = false;
  let answer_rule_pass = false;
  let missing_must_contain: string[] = [];
  let hit_forbid_contain: string[] = [];

  if (result.type === 'answer') {
    kind = 'answer';
    cited_pages = uniqueOrdered(result.citations.map((cit) => cit.page_id));
    // Citation-pass: every cited page must be in must_cite_pages (subset).
    // Empty cited list still passes the subset check; require ≥1 citation
    // for a meaningful pass (matches ARCH §6 "至少 1 条引用" rule).
    citation_pass = cited_pages.length > 0 && cited_pages.every((p) => must.has(p));

    const md = result.answer_md;
    missing_must_contain = c.expected.must_contain.filter((s) => !substringHit(md, s));
    hit_forbid_contain = c.expected.forbid_contain.filter((s) => substringHit(md, s));
    answer_rule_pass = missing_must_contain.length === 0 && hit_forbid_contain.length === 0;
  } else if (result.type === 'clarify') {
    kind = 'clarify';
  }

  return {
    case_id: c.id,
    query: c.query,
    kind,
    r_at_5,
    citation_pass,
    answer_rule_pass,
    retrieved_pages_top5: top5Pages,
    cited_pages,
    missing_must_contain,
    hit_forbid_contain,
    latency_ms: 0,
  };
}

function failedCase(c: GoldenCase, latencyMs: number): CaseResult {
  return {
    case_id: c.id,
    query: c.query,
    kind: 'error',
    r_at_5: false,
    citation_pass: false,
    answer_rule_pass: false,
    retrieved_pages_top5: [],
    cited_pages: [],
    missing_must_contain: c.expected.must_contain,
    hit_forbid_contain: [],
    latency_ms: Math.round(latencyMs),
  };
}

function substringHit(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

function uniqueOrdered<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
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
  const delta = (curr: number, base: number | undefined): string =>
    base === undefined ? '—' : `${curr - base >= 0 ? '+' : ''}${(curr - base).toFixed(2)}`;
  const baseRow = baseline?.summary;

  const lines: string[] = [];
  lines.push(`# Eval — ${date}`);
  lines.push('');
  lines.push(`Cases: ${summary.n}  Wall time: ${totalMs}ms`);
  if (baseline) {
    lines.push(
      `Baseline: ${baseline.date} (R@5=${fmt(baseRow!.r_at_5)}, Cit=${fmt(baseRow!.citation_pass)}, Ans=${fmt(baseRow!.answer_rule_pass)})`,
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
      if (r.hit_forbid_contain.length > 0) bits.push(`forbid hit: ${r.hit_forbid_contain.join(', ')}`);
      lines.push(`- ${r.case_id}: ${bits.join(' | ')}`);
    }
    lines.push('');
  }

  const offBranch = results.filter((r) => r.kind !== 'answer');
  if (offBranch.length > 0) {
    lines.push(`## Non-answer outcomes (${offBranch.length})`);
    for (const r of offBranch) {
      lines.push(`- ${r.case_id} → ${r.kind}: ${r.query}`);
    }
    lines.push('');
  }

  // Embedded summary for next-run baseline diff.
  const embed = JSON.stringify({ date, summary });
  lines.push(`<!-- EVAL_SUMMARY ${embed} -->`);
  lines.push('');
  return lines.join('\n');
}
