/**
 * In-process bridge from console routes to the existing CLI business
 * functions (ARCH §17.5: console + CLI share the same code path).
 *
 * We don't fork a shell — runEval / runAnalyzeRuns / runGoldenGenerate
 * are called directly. They write progress to console's stdout (which is
 * the developer's terminal); the route returns a structured result so
 * the UI can link to the resulting report file.
 *
 * Test seam: the runner functions can be swapped via ConsoleOps; tests
 * in console-server.test.ts inject stubs that return canned reportPaths.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runEval, type EvalOptions, type EvalProgressEvent } from '../commands/eval.ts';
import { runAnalyzeRuns, type AnalyzeRunsOptions } from '../commands/analyze.ts';
import { runGoldenGenerate, type GoldenGenerateOptions } from '../commands/golden.ts';

export type OpResult =
  | { ok: true; reportPath?: string; message?: string }
  | { ok: false; error: string };

/**
 * NDJSON events emitted by the streaming variant of golden generate.
 * `log` lines mirror the CLI stdout (newline-terminated, may be multi-line
 * indented). `result` is the final terminator — always exactly one per stream.
 */
export type GoldenGenerateEvent =
  | { type: 'log'; line: string }
  | { type: 'result'; ok: true; message?: string }
  | { type: 'result'; ok: false; error: string };

/**
 * NDJSON events emitted by the streaming variant of eval. `boot` and `warm`
 * frame the warm-up phase, `case-start` / `case-done` straddle each per-case
 * run, and `done` carries the final report path + summary. A `result`
 * terminator follows so the HTTP layer can surface ok / error uniformly with
 * the goldenGenerate stream.
 */
export type EvalStreamEvent =
  | EvalProgressEvent
  | { type: 'result'; ok: true; reportPath?: string }
  | { type: 'result'; ok: false; error: string };

export type ConsoleOps = {
  eval: (opts: EvalOptions) => Promise<OpResult>;
  analyzeRuns: (opts: AnalyzeRunsOptions) => Promise<OpResult>;
  goldenGenerate: (opts: GoldenGenerateOptions) => Promise<OpResult>;
  /**
   * Streaming variant of goldenGenerate. Emits log lines as they happen
   * (project load → templates → per-batch LLM progress → write) and a final
   * `result` event. Promise resolves after the result event is emitted.
   * The HTTP layer wraps each event as one NDJSON line.
   */
  goldenGenerateStream: (
    opts: GoldenGenerateOptions,
    onEvent: (e: GoldenGenerateEvent) => void,
  ) => Promise<void>;
  /**
   * Streaming variant of eval. Forwards runEval's onProgress events plus a
   * final `result` terminator. Promise resolves after `result` is emitted.
   */
  evalStream: (
    opts: EvalOptions,
    onEvent: (e: EvalStreamEvent) => void,
  ) => Promise<void>;
};

export const defaultOps: ConsoleOps = {
  eval: async (opts) => {
    try {
      const code = await runEval(opts);
      if (code !== 0) return { ok: false, error: `eval exited with code ${code}` };
      const reportPath = findLatestReport(opts.stateRoot, 'eval');
      return reportPath
        ? { ok: true, reportPath }
        : { ok: true, message: 'eval completed (no report file found)' };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
  analyzeRuns: async (opts) => {
    try {
      const code = await runAnalyzeRuns(opts);
      if (code !== 0) return { ok: false, error: `analyze exited with code ${code}` };
      const reportPath = findLatestReport(opts.stateRoot, 'analyze');
      return reportPath
        ? { ok: true, reportPath }
        : { ok: true, message: 'analyze completed (no report file found)' };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
  goldenGenerate: async (opts) => {
    try {
      const code = await runGoldenGenerate(opts);
      if (code !== 0) return { ok: false, error: `golden generate exited with code ${code}` };
      // Output is golden/cases.candidate.jsonl; surface that path.
      const candidatePath = join(opts.stateRoot, 'golden', 'cases.candidate.jsonl');
      return existsSync(candidatePath)
        ? { ok: true, message: `wrote ${candidatePath}` }
        : { ok: true, message: 'golden generate completed (no candidate file found)' };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
  goldenGenerateStream: async (opts, onEvent) => {
    // Buffer partial lines so a single multi-line write surfaces as multiple
    // events. The reporter contract is "newline-terminated" but the runner
    // does write multi-line blocks (e.g. the final "wrote N candidates / next: ..."
    // summary), so splitting here keeps the UI log box tidy.
    let pending = '';
    const reporter = (chunk: string) => {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        onEvent({ type: 'log', line });
      }
    };
    try {
      const code = await runGoldenGenerate({ ...opts, reporter });
      if (pending.length > 0) {
        onEvent({ type: 'log', line: pending });
        pending = '';
      }
      if (code !== 0) {
        onEvent({ type: 'result', ok: false, error: `golden generate exited with code ${code}` });
        return;
      }
      const candidatePath = join(opts.stateRoot, 'golden', 'cases.candidate.jsonl');
      onEvent({
        type: 'result',
        ok: true,
        message: existsSync(candidatePath)
          ? `wrote ${candidatePath}`
          : 'golden generate completed (no candidate file found)',
      });
    } catch (err) {
      if (pending.length > 0) onEvent({ type: 'log', line: pending });
      onEvent({ type: 'result', ok: false, error: (err as Error).message });
    }
  },
  evalStream: async (opts, onEvent) => {
    try {
      const code = await runEval({
        ...opts,
        onProgress: (ev) => onEvent(ev),
      });
      if (code !== 0) {
        onEvent({ type: 'result', ok: false, error: `eval exited with code ${code}` });
        return;
      }
      const reportPath = findLatestReport(opts.stateRoot, 'eval');
      onEvent(reportPath ? { type: 'result', ok: true, reportPath } : { type: 'result', ok: true });
    } catch (err) {
      onEvent({ type: 'result', ok: false, error: (err as Error).message });
    }
  },
};

/**
 * Find `<state>/reports/<YYYY-MM-DD>-<kind>.md` with the latest date.
 * Returns absolute path, or null if no matching file.
 */
export function findLatestReport(
  stateRoot: string,
  kind: 'eval' | 'analyze' | 'baseline',
): string | null {
  const dir = join(stateRoot, 'reports');
  if (!existsSync(dir)) return null;
  const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${kind}\\.md$`);
  const files = readdirSync(dir).filter((f) => re.test(f));
  if (files.length === 0) return null;
  files.sort();
  return join(dir, files[files.length - 1]!);
}

const REPORT_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-(eval|analyze|baseline)\.md$/;

/**
 * Validate a report filename for safe rendering (no path traversal,
 * matches the canonical pattern). Caller resolves under
 * `<state>/reports/`.
 */
export function isReportFilename(name: string): boolean {
  return REPORT_FILENAME_RE.test(name);
}

export type ReportListing = {
  filename: string;
  kind: 'eval' | 'analyze' | 'baseline';
  date: string;
  path: string;
  sizeBytes: number;
};

export function listReports(stateRoot: string): ReportListing[] {
  const dir = join(stateRoot, 'reports');
  if (!existsSync(dir)) return [];
  const out: ReportListing[] = [];
  for (const f of readdirSync(dir)) {
    const m = REPORT_FILENAME_RE.exec(f);
    if (!m) continue;
    const path = join(dir, f);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    out.push({
      filename: f,
      kind: m[1] as 'eval' | 'analyze' | 'baseline',
      date: f.slice(0, 10),
      path,
      sizeBytes: size,
    });
  }
  // Newest first.
  out.sort((a, b) => b.filename.localeCompare(a.filename));
  return out;
}
