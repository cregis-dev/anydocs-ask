/**
 * `anydocs-ask runs tail|export <projectRoot>` — read-only views over
 * <workspace>/state/<projectId>/runs/<YYYY-Www>.jsonl (ARCH §16.4).
 *
 *   runs tail   <projectRoot> [-n 50]            print last N records
 *   runs export <projectRoot> --since <when>     stream all records since
 *               [--format jsonl|csv]             a date (default jsonl)
 *
 * `--since` accepts an ISO date (`2026-04-01`), an ISO datetime, or a
 * relative duration (`7d` / `48h` / `30m`). The export goes to stdout so
 * it can be piped into jq/awk/etc.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { iterateRunsSince, listRunFiles, tailRuns } from '../runs/writer.ts';
import type { RunRecord, RunsLine } from '../runs/types.ts';

export type RunsTailOptions = {
  projectRoot: string;
  stateRoot: string;
  count?: number;
};

export function runRunsTail(opts: RunsTailOptions): number {
  const stateRoot = resolve(opts.stateRoot);
  const runsDir = join(stateRoot, 'runs');
  if (!existsSync(runsDir)) {
    process.stderr.write(
      `no runs at ${runsDir}; serve must run with runs.enabled=true (default) and have answered ≥1 /v1/ask.\n`,
    );
    return 1;
  }
  const lines = tailRuns({ stateRoot, count: opts.count ?? 50 });
  if (lines.length === 0) {
    process.stdout.write(`(no runs in latest week file)\n`);
    return 0;
  }
  for (const line of lines) {
    process.stdout.write(formatTailLine(line) + '\n');
  }
  return 0;
}

function formatTailLine(line: RunsLine): string {
  if ('type' in line && line.type === 'feedback-update') {
    return `${line.ts} feedback ${line.request_id} ${JSON.stringify(line.feedback)}`;
  }
  const r = line as RunRecord;
  const kind = r.answer.kind.padEnd(7);
  const conf = r.answer.confidence.toFixed(3);
  const lat = `${r.answer.latency_ms}ms`.padStart(7);
  const q = r.query.length > 60 ? `${r.query.slice(0, 57)}...` : r.query;
  return `${r.ts} ${kind} conf=${conf} ${lat} ${JSON.stringify(q)}`;
}

export type RunsExportOptions = {
  projectRoot: string;
  stateRoot: string;
  since: string;
  format: 'jsonl' | 'csv';
};

export function runRunsExport(opts: RunsExportOptions): number {
  const stateRoot = resolve(opts.stateRoot);
  const sinceMs = parseSince(opts.since);
  if (sinceMs === null) {
    process.stderr.write(
      `invalid --since '${opts.since}'; expected ISO date (2026-04-01), ISO datetime, or duration (7d / 48h / 30m).\n`,
    );
    return 2;
  }
  const files = listRunFiles({ stateRoot });
  if (files.length === 0) {
    process.stderr.write(`no runs files under ${join(stateRoot, 'runs')}/\n`);
    return 1;
  }

  if (opts.format === 'csv') {
    process.stdout.write(
      ['ts', 'request_id', 'kind', 'confidence', 'latency_ms', 'model', 'query'].join(',') + '\n',
    );
  }
  let count = 0;
  for (const line of iterateRunsSince({ stateRoot, sinceMs })) {
    if ('type' in line && line.type === 'feedback-update') continue; // export is record-only
    const r = line as RunRecord;
    if (opts.format === 'jsonl') {
      process.stdout.write(JSON.stringify(r) + '\n');
    } else {
      process.stdout.write(toCsvRow(r) + '\n');
    }
    count++;
  }
  process.stderr.write(`(${count} record${count === 1 ? '' : 's'} since ${opts.since})\n`);
  return 0;
}

function toCsvRow(r: RunRecord): string {
  const escape = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  return [
    escape(r.ts),
    escape(r.request_id),
    escape(r.answer.kind),
    escape(r.answer.confidence.toFixed(4)),
    escape(r.answer.latency_ms),
    escape(r.answer.model),
    escape(r.query),
  ].join(',');
}

const DURATION_RE = /^(\d+)(m|h|d)$/;

/**
 * Parse `--since` argument. Returns ms-since-epoch, or null on parse failure.
 *
 * Accepted forms:
 *   - `7d` / `48h` / `30m`        relative duration
 *   - `2026-04-01`                ISO date (UTC midnight)
 *   - `2026-04-01T00:00:00Z`      ISO datetime
 */
export function parseSince(input: string): number | null {
  const dur = DURATION_RE.exec(input);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2];
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * ms;
  }
  // Require ISO-shaped input (must contain `-`) to reject loose Date.parse
  // hits like `'7'` -> year 7.
  if (!/^\d{4}-\d{2}-\d{2}/.test(input)) return null;
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : null;
}

// Re-export for tests / callers that want the file paths directly.
export { listRunFiles };

/** Read a single jsonl file as an array of parsed lines. Used by tests. */
export function readRunsFile(path: string): RunsLine[] {
  const out: RunsLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as RunsLine);
    } catch {
      // skip malformed
    }
  }
  return out;
}
