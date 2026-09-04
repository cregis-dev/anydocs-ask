/**
 * Console-side Traffic tab state helpers — ARCH §17.3.6.
 *
 * Reads a selected window of runs jsonl (default 7 days) and computes
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

export type TrafficRange = 7 | 30 | 90 | 'all';

export type TrafficViewOptions = {
  range: TrafficRange;
  query: string;
  source: '' | 'reader' | 'console' | 'mcp';
  kind: '' | 'answer' | 'clarify' | 'error';
  page: number;
  pageSize: 25 | 50 | 100;
};

export type TrafficPage = {
  /** Current page records, newest first. */
  records: RunRecord[];
  page: number;
  pageSize: TrafficViewOptions['pageSize'];
  totalRecords: number;
  totalPages: number;
  firstRecord: number;
  lastRecord: number;
};

export type TrafficWindow = {
  /** ISO start of the window (sinceMs as ISO date). */
  sinceISO: string;
  /** Window length in days. */
  days: number;
  /** Selected range. `days` is the observed span when this is `all`. */
  range: TrafficRange;
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
  p95LatencyMs: number | null;
};

const DAY_MS = 86_400_000;

export function parseTrafficViewOptions(input: {
  range?: string;
  query?: string;
  source?: string;
  kind?: string;
  page?: string;
  pageSize?: string;
}): TrafficViewOptions {
  const range: TrafficRange =
    input.range === '30' || input.range === '90' || input.range === 'all'
      ? input.range === 'all' ? 'all' : Number(input.range) as 30 | 90
      : 7;
  const source =
    input.source === 'reader' || input.source === 'console' || input.source === 'mcp'
      ? input.source
      : '';
  const kind =
    input.kind === 'answer' || input.kind === 'clarify' || input.kind === 'error'
      ? input.kind
      : '';
  const rawPage = Number.parseInt(input.page ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawPageSize = Number(input.pageSize);
  const pageSize = rawPageSize === 25 || rawPageSize === 100 ? rawPageSize : 50;
  return {
    range,
    query: (input.query ?? '').trim().slice(0, 200),
    source,
    kind,
    page,
    pageSize,
  };
}

export function loadTrafficWindow(stateRoot: string, range: TrafficRange = 7): TrafficWindow {
  const nowMs = Date.now();
  const sinceMs = range === 'all' ? 0 : nowMs - range * DAY_MS;
  const records: RunRecord[] = [];
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if (!isRunRecord(line)) continue;
    records.push(line);
  }
  const firstRecordMs = records.length > 0 ? Date.parse(records[0]!.ts) : nowMs;
  const days = range === 'all'
    ? Math.max(1, Math.ceil((nowMs - firstRecordMs) / DAY_MS))
    : range;
  return {
    sinceISO: new Date(range === 'all' ? firstRecordMs : sinceMs).toISOString().slice(0, 10),
    days,
    range,
    records,
    totals: computeTotals(records),
    perDay: range === 'all' ? bucketObservedDays(records) : bucketByDay(records, sinceMs, days),
  };
}

export function paginateTrafficRecords(
  records: RunRecord[],
  options: TrafficViewOptions,
): TrafficPage {
  const query = options.query.toLowerCase();
  const filtered = records.filter((record) => {
    if (query && !record.query.toLowerCase().includes(query)) return false;
    if (options.source && runSource(record) !== options.source) return false;
    if (options.kind && record.answer.kind !== options.kind) return false;
    return true;
  });
  const totalRecords = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / options.pageSize));
  const page = Math.min(options.page, totalPages);
  const start = (page - 1) * options.pageSize;
  const pageRecords = filtered.reverse().slice(start, start + options.pageSize);
  return {
    records: pageRecords,
    page,
    pageSize: options.pageSize,
    totalRecords,
    totalPages,
    firstRecord: totalRecords === 0 ? 0 : start + 1,
    lastRecord: Math.min(start + options.pageSize, totalRecords),
  };
}

export function trafficRangeLabel(range: TrafficRange): string {
  return range === 'all' ? 'all time' : `last ${range}d`;
}

function computeTotals(records: RunRecord[]): TrafficTotals {
  const totals: TrafficTotals = {
    count: records.length,
    countReader: 0,
    countConsole: 0,
    countMcp: 0,
    p50LatencyMs: null,
    p95LatencyMs: null,
    errorRate: 0,
    clarifyRate: 0,
  };
  if (records.length === 0) return totals;
  const lats: number[] = [];
  let errs = 0;
  let clarifies = 0;
  for (const r of records) {
    const src = runSource(r);
    if (src === 'console') totals.countConsole++;
    else if (src === 'mcp') totals.countMcp++;
    else totals.countReader++;
    lats.push(r.answer.latency_ms);
    if (r.answer.kind === 'error') errs++;
    else if (r.answer.kind === 'clarify') clarifies++;
  }
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
    const lats = rs.map((r) => r.answer.latency_ms);
    out.push({
      date,
      count: rs.length,
      p95LatencyMs: lats.length > 0 ? percentile(lats, 95) : null,
    });
  }
  return out;
}

function bucketObservedDays(records: RunRecord[]): PerDayBucket[] {
  const buckets = new Map<string, RunRecord[]>();
  for (const record of records) {
    const date = record.ts.slice(0, 10);
    const existing = buckets.get(date);
    if (existing) existing.push(record);
    else buckets.set(date, [record]);
  }
  return [...buckets.entries()].map(([date, dayRecords]) => {
    const latencies = dayRecords.map((record) => record.answer.latency_ms);
    return {
      date,
      count: dayRecords.length,
      p95LatencyMs: latencies.length > 0 ? percentile(latencies, 95) : null,
    };
  });
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
