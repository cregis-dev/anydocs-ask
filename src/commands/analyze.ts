/**
 * `anydocs-ask analyze runs <projectRoot> [--since 7d]` — ARCH §16.6.
 *
 * Reads `<state>/runs/*.jsonl`, filters to the requested window, runs the
 * three v1 dimensions (D1 recall failures / D2 latency anomalies / D3
 * disambiguation cliffs), writes `<state>/reports/<YYYY-MM-DD>-analyze.md`.
 *
 * Default `--since` window is `analyze.lookbackDays` from anydocs.ask.json
 * (default 7 days). Same parser as `runs export` accepts ISO date or
 * duration like `48h`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { iterateRunsSince } from '../runs/writer.ts';
import { parseSince } from './runs.ts';
import { loadProjectId } from '../workspace.ts';
import { analyzeDimensions } from '../analyze/dimensions.ts';
import { renderAnalyzeReport } from '../analyze/report.ts';
import { runSource, type RunRecord, type RunsLine } from '../runs/types.ts';

export type AnalyzeRunsOptions = {
  projectRoot: string;
  stateRoot: string;
  /** Raw --since flag (e.g. "7d", "2026-04-01"). Falls back to config window. */
  since?: string;
  /**
   * Include `source=console` runs in analysis. Defaults to false — console
   * dogfood queries skew confidence / latency distributions and would lie
   * to the author about real reader health. ARCH §17.8.
   */
  includeConsole?: boolean;
};

export async function runAnalyzeRuns(opts: AnalyzeRunsOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const { config, source } = await loadConfig(projectRoot);
  if (source) process.stdout.write(`anydocs-ask analyze: loaded config from ${source}\n`);

  const lookbackDays = config.analyze.lookbackDays;
  const sinceArg = opts.since ?? `${lookbackDays}d`;
  const sinceMs = parseSince(sinceArg);
  if (sinceMs === null) {
    process.stderr.write(
      `invalid --since '${sinceArg}'; expected ISO date (2026-04-01), ISO datetime, or duration (7d / 48h / 30m).\n`,
    );
    return 2;
  }

  // Collect run records; drop feedback-update tails (v1.5 only). By default
  // exclude console-origin runs so author dogfood doesn't pollute reader
  // health metrics (PRD §13.6 / ARCH §17.8). --include-console reverses.
  const records: RunRecord[] = [];
  let consoleSkipped = 0;
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if ('type' in line && line.type === 'feedback-update') continue;
    const r = line as RunRecord;
    if (!opts.includeConsole && runSource(r) === 'console') {
      consoleSkipped++;
      continue;
    }
    records.push(r);
  }
  if (records.length === 0) {
    process.stderr.write(
      `no runs since ${sinceArg} at ${join(stateRoot, 'runs')}/.\n` +
        (consoleSkipped > 0
          ? `       (skipped ${consoleSkipped} console runs; pass --include-console to include them)\n`
          : '') +
        `       serve the project and answer ≥1 query first, or widen --since.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `anydocs-ask analyze: ${records.length} runs since ${sinceArg}` +
      (consoleSkipped > 0 ? ` (excluded ${consoleSkipped} console-origin)` : '') +
      `\n`,
  );

  const findings = analyzeDimensions({
    runs: records,
    confidenceFloor: config.analyze.confidenceFloor,
    latencyP95Threshold: config.analyze.latencyP95Threshold,
  });

  const date = new Date().toISOString().slice(0, 10);
  const sinceISO = new Date(sinceMs).toISOString().slice(0, 10);
  const windowDays = Math.max(1, Math.round((Date.now() - sinceMs) / 86_400_000));
  const projectId = loadProjectId(projectRoot);
  const md = renderAnalyzeReport({
    projectId,
    sinceISO,
    date,
    totalRuns: records.length,
    windowDays,
    findings,
  });

  const reportsDir = join(stateRoot, 'reports');
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
  const path = join(reportsDir, `${date}-analyze.md`);
  writeFileSync(path, md, 'utf8');

  process.stdout.write(
    `anydocs-ask analyze: wrote ${path}\n` +
      `  recall_fail=${findings.recall.count}  latency_anom=${findings.latency.count}  ` +
      `clarify=${findings.disambig.total} (unfollowed=${findings.disambig.unfollowed})\n`,
  );
  return 0;
}
