/**
 * Console-side Traffic tab state helpers — ARCH §17.3.6.
 *
 * Reads a rolling window of runs jsonl (default 7 days) and computes
 * aggregate health metrics + per-day buckets for sparkline rendering.
 *
 * All work is read-only against existing jsonl on disk; no child
 * subprocess interaction needed. Console-origin runs (source="console")
 * are INCLUDED in the aggregates by default but visually flagged so the
 * author can distinguish dogfood from reader traffic — this differs from
 * `analyze runs` which excludes them by default (see ARCH §17.8).
 */

import { iterateRunsSince } from '../runs/writer.ts';
import { isRunRecord, runSource, type RunRecord, type RunsLine } from '../runs/types.ts';

export type TrafficWindow = {
  /** ISO start of the window (sinceMs as ISO date). */
  sinceISO: string;
  /** Window length in days. */
  days: number;
  /** All records in window, oldest → newest. */
  records: RunRecord[];
  totals: TrafficTotals;
  perDay: PerDayBucket[];
};

export type TrafficTotals = {
  count: number;
  countReader: number;
  countConsole: number;
  countMcp: number;
  meanConfidence: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** Fraction of records where answer.kind === 'error'. */
  errorRate: number;
  /** Fraction where kind === 'clarify'. */
  clarifyRate: number;
};

export type PerDayBucket = {
  /** "YYYY-MM-DD" — UTC date. */
  date: string;
  count: number;
  meanConfidence: number | null;
  p95LatencyMs: number | null;
};

const DAY_MS = 86_400_000;

export function loadTrafficWindow(stateRoot: string, days = 7): TrafficWindow {
  const nowMs = Date.now();
  const sinceMs = nowMs - days * DAY_MS;
  const records: RunRecord[] = [];
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if (!isRunRecord(line)) continue;
    records.push(line);
  }
  return {
    sinceISO: new Date(sinceMs).toISOString().slice(0, 10),
    days,
    records,
    totals: computeTotals(records),
    perDay: bucketByDay(records, sinceMs, days),
  };
}

function computeTotals(records: RunRecord[]): TrafficTotals {
  const totals: TrafficTotals = {
    count: records.length,
    countReader: 0,
    countConsole: 0,
    countMcp: 0,
    meanConfidence: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    errorRate: 0,
    clarifyRate: 0,
  };
  if (records.length === 0) return totals;
  const confs: number[] = [];
  const lats: number[] = [];
  let errs = 0;
  let clarifies = 0;
  for (const r of records) {
    const src = runSource(r);
    if (src === 'console') totals.countConsole++;
    else if (src === 'mcp') totals.countMcp++;
    else totals.countReader++;
    if (r.answer.confidence !== null) confs.push(r.answer.confidence);
    lats.push(r.answer.latency_ms);
    if (r.answer.kind === 'error') errs++;
    else if (r.answer.kind === 'clarify') clarifies++;
  }
  totals.meanConfidence = confs.length > 0 ? mean(confs) : null;
  totals.p50LatencyMs = percentile(lats, 50);
  totals.p95LatencyMs = percentile(lats, 95);
  totals.errorRate = errs / records.length;
  totals.clarifyRate = clarifies / records.length;
  return totals;
}

function bucketByDay(records: RunRecord[], sinceMs: number, days: number): PerDayBucket[] {
  const buckets: Map<string, RunRecord[]> = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(sinceMs + i * DAY_MS).toISOString().slice(0, 10);
    buckets.set(d, []);
  }
  for (const r of records) {
    const date = r.ts.slice(0, 10);
    const arr = buckets.get(date);
    if (arr) arr.push(r);
    // out-of-window date → ignore (defensive)
  }
  const out: PerDayBucket[] = [];
  for (const [date, rs] of buckets) {
    const confs = rs.map((r) => r.answer.confidence).filter((c): c is number => c !== null);
    const lats = rs.map((r) => r.answer.latency_ms);
    out.push({
      date,
      count: rs.length,
      meanConfidence: confs.length > 0 ? mean(confs) : null,
      p95LatencyMs: lats.length > 0 ? percentile(lats, 95) : null,
    });
  }
  return out;
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
