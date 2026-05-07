/**
 * RunsWriter — appends one jsonl line per /v1/ask call.
 *
 * Design (ARCH §16.4):
 *   - One file per ISO week: `<stateRoot>/runs/<YYYY-Www>.jsonl` where
 *     stateRoot is `<workspace>/state/<projectId>/` (双根分离, §16.1).
 *   - Sync `appendFileSync` per line. /v1/ask is already async-bound by
 *     SQLite + LLM I/O; the runs append is microseconds compared to those.
 *     Using sync I/O keeps ordering simple and avoids a queue.
 *   - Failures are caught and logged to stderr only — never propagate to
 *     /v1/ask. Disk full / EROFS / etc. should not poison the response path.
 *   - `enabled=false` makes append() a no-op (and skips dir creation).
 *
 * Truncation: `truncateQueryChars` / `truncateAnswerChars` cap the persisted
 * `query` / `answer.md` lengths if set. v1 default is no truncation; ops
 * can opt-in for projects with very long pasted queries.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toIsoWeek } from './iso-week.ts';
import type { RunRecord, RunsLine } from './types.ts';

export type RunsWriterOptions = {
  stateRoot: string;
  enabled: boolean;
  truncateQueryChars?: number | null;
  truncateAnswerChars?: number | null;
  /** Override clock — tests inject a fixed date for deterministic week names. */
  now?: () => Date;
};

export class RunsWriter {
  private readonly runsDir: string;
  private readonly enabled: boolean;
  private readonly truncateQuery: number | null;
  private readonly truncateAnswer: number | null;
  private readonly now: () => Date;
  private dirEnsured = false;

  constructor(opts: RunsWriterOptions) {
    this.runsDir = join(opts.stateRoot, 'runs');
    this.enabled = opts.enabled;
    this.truncateQuery = opts.truncateQueryChars ?? null;
    this.truncateAnswer = opts.truncateAnswerChars ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  /** True when persistence is on. Useful for callers that want to skip
   *  building the trace object entirely on hot paths. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Append a single run. Best-effort, never throws.
   *
   * Returns the path written (or null when disabled / on failure).
   */
  append(record: RunRecord): string | null {
    if (!this.enabled) return null;
    try {
      this.ensureDir();
      const truncated = this.applyTruncation(record);
      const path = this.fileFor(this.now());
      appendFileSync(path, JSON.stringify(truncated) + '\n', 'utf8');
      return path;
    } catch (err) {
      process.stderr.write(`[ask] runs append failed: ${(err as Error).message}\n`);
      return null;
    }
  }

  /** Path for a given timestamp; exposed for tests / the export command. */
  fileFor(date: Date): string {
    return join(this.runsDir, `${toIsoWeek(date)}.jsonl`);
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true });
    }
    this.dirEnsured = true;
  }

  private applyTruncation(record: RunRecord): RunRecord {
    const q = this.truncateQuery;
    const a = this.truncateAnswer;
    if (q === null && a === null) return record;
    return {
      ...record,
      ...(q !== null && record.query.length > q ? { query: record.query.slice(0, q) } : {}),
      answer: {
        ...record.answer,
        ...(a !== null && record.answer.md && record.answer.md.length > a
          ? { md: record.answer.md.slice(0, a) }
          : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Read helpers — used by `runs tail|export` commands and analyze.
// ---------------------------------------------------------------------------

export type ReadRunsOptions = {
  stateRoot: string;
};

/**
 * Returns absolute paths to all `<YYYY-Www>.jsonl` files for a project,
 * sorted ascending by ISO label (which is also chronological). Missing
 * runs dir => empty array.
 */
export function listRunFiles(opts: ReadRunsOptions): string[] {
  const dir = join(opts.stateRoot, 'runs');
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const ent of readdirSync(dir)) {
    if (!/^\d{4}-W\d{2}\.jsonl$/.test(ent)) continue;
    files.push(join(dir, ent));
  }
  return files.sort();
}

/**
 * Read the most recent N lines from the latest week file, parsing each as
 * jsonl. Used by `runs tail`. Skips malformed lines silently — runs files
 * are append-only but can be partially written if the process crashed.
 */
export function tailRuns(
  opts: ReadRunsOptions & { count: number },
): RunsLine[] {
  const files = listRunFiles(opts);
  if (files.length === 0) return [];
  const latest = files[files.length - 1]!;
  const lines = readFileSync(latest, 'utf8').split('\n').filter((l) => l.length > 0);
  const slice = lines.slice(-opts.count);
  const out: RunsLine[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as RunsLine);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Iterate all run lines from sinceMs (inclusive) to nowMs (exclusive),
 * across week files, in chronological order. Skips malformed lines.
 */
export function* iterateRunsSince(
  opts: ReadRunsOptions & { sinceMs: number },
): Generator<RunsLine> {
  const files = listRunFiles(opts);
  for (const f of files) {
    // Skip files older than sinceMs by mtime as a fast path; this is not
    // strictly correct (a record with an older ts could land in a newer
    // file), but the ts filter below is the source of truth.
    try {
      const st = statSync(f);
      if (st.mtimeMs < opts.sinceMs - 14 * 24 * 60 * 60 * 1000) continue;
    } catch {
      continue;
    }
    const content = readFileSync(f, 'utf8');
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      let parsed: RunsLine;
      try {
        parsed = JSON.parse(line) as RunsLine;
      } catch {
        continue;
      }
      if (Date.parse(parsed.ts) >= opts.sinceMs) {
        yield parsed;
      }
    }
  }
}
