/**
 * D1 / D2 / D3 — analyze dimensions per ARCH §16.6 (v1 ships 1-3; 4-5 v1.5).
 *
 *   D1 Recall failure
 *     trigger: confidence < confidenceFloor
 *           ∨ citations.length === 0
 *           ∨ same-session re-ask within 30s with edit distance < 5
 *     bucket: cluster by normalized query (see cluster.ts)
 *
 *   D2 Latency anomaly
 *     trigger: latency_ms > latencyP95Threshold
 *     bucket: by query-length range (≤80, 81-160, >160) and fused-count
 *             range (≤8, 9-16, >16) — buckets surface easy-to-act patterns
 *             ("long queries are slow", "many candidates is slow")
 *
 *   D3 Disambiguation cliff
 *     trigger: subtree_ask_triggered === true
 *              and no follow-up in same session within 5min
 *     bucket: by top-fused page (subtree_root proxy — v1 doesn't load pages
 *             DB; the page slug is the user-readable handle, navigation
 *             subtree promotion is a v1.5 enrichment)
 *
 * Inputs are RunRecords pre-filtered to the analysis window. Inputs may be
 * unsorted; this module sorts internally where needed (D1 re-ask scan + D3
 * follow-up scan both want session-grouped chronological order).
 */

import type { RunRecord } from '../runs/types.ts';
import { clusterByQuery, levenshteinAtMost, normalize, type Cluster } from './cluster.ts';

export type DimensionInputs = {
  runs: RunRecord[];
  confidenceFloor: number;
  latencyP95Threshold: number;
};

export type RecallFailureCluster = {
  cluster: Cluster<RunRecord>;
  /** Pages most often returned at top-1 for cluster members; helps the
   *  reader see "the system thinks X but the user expected Y". */
  topPagesAtRank1: { page: string; count: number }[];
  /** Triggers that fired across the cluster (stable order). */
  triggers: ('low-confidence' | 'no-citations' | 'reask-30s')[];
};

export type RecallFindings = {
  count: number;
  clusters: RecallFailureCluster[];
};

export type LatencyBucket = {
  label: string;
  count: number;
  /** Largest latency in this bucket (ms). */
  worst: number;
  /** Sample queries (up to 3, ordered by descending latency). */
  examples: { query: string; latency_ms: number }[];
};

export type LatencyFindings = {
  count: number;
  threshold: number;
  total: number;
  /** Buckets sorted by descending count then label. */
  byQueryLen: LatencyBucket[];
  byFusedCount: LatencyBucket[];
};

export type DisambigBucket = {
  page: string;
  count: number;
  /** How many fired clarify with no in-session follow-up within 5min. */
  unfollowed: number;
  /** Sample queries (up to 3). */
  examples: string[];
};

export type DisambigFindings = {
  total: number;
  unfollowed: number;
  buckets: DisambigBucket[];
};

export type DimensionFindings = {
  recall: RecallFindings;
  latency: LatencyFindings;
  disambig: DisambigFindings;
};

const REASK_WINDOW_MS = 30_000;
const FOLLOWUP_WINDOW_MS = 5 * 60_000;
const REASK_EDIT_DISTANCE = 5;

export function analyzeDimensions(input: DimensionInputs): DimensionFindings {
  return {
    recall: analyzeRecall(input),
    latency: analyzeLatency(input),
    disambig: analyzeDisambig(input),
  };
}

// ---------------------------------------------------------------------------
// D1 — Recall failures
// ---------------------------------------------------------------------------

type RecallTrigger = 'low-confidence' | 'no-citations' | 'reask-30s';

function analyzeRecall(input: DimensionInputs): RecallFindings {
  const triggers = new Map<string, Set<RecallTrigger>>(); // request_id -> triggers
  for (const r of input.runs) {
    const t = new Set<RecallTrigger>();
    if (r.answer.confidence < input.confidenceFloor) t.add('low-confidence');
    if (r.answer.citations.length === 0 && r.answer.kind !== 'error') t.add('no-citations');
    if (t.size > 0) triggers.set(r.request_id, t);
  }

  // Re-ask scan: same session_id, within 30s, edit distance < 5 on the
  // normalized query. Mark the *earlier* run as a recall failure (the user
  // had to re-ask because that run didn't cut it).
  const bySession = groupBySession(input.runs);
  for (const session of bySession.values()) {
    session.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 0; i < session.length - 1; i++) {
      const a = session[i]!;
      const b = session[i + 1]!;
      const dt = Date.parse(b.ts) - Date.parse(a.ts);
      if (dt > REASK_WINDOW_MS) continue;
      const dist = levenshteinAtMost(
        normalize(a.query),
        normalize(b.query),
        REASK_EDIT_DISTANCE,
      );
      if (dist >= REASK_EDIT_DISTANCE) continue;
      // The earlier query is the "failed" one; mark it.
      const t = triggers.get(a.request_id) ?? new Set<RecallTrigger>();
      t.add('reask-30s');
      triggers.set(a.request_id, t);
    }
  }

  const failed = input.runs.filter((r) => triggers.has(r.request_id));
  if (failed.length === 0) {
    return { count: 0, clusters: [] };
  }

  const clusters = clusterByQuery(failed, { queryOf: (r) => r.query });
  const enriched: RecallFailureCluster[] = clusters.map((c) => {
    const pageCounts = new Map<string, number>();
    const trigSet = new Set<RecallTrigger>();
    for (const item of c.items) {
      const top = item.retrieval.fused[0]?.page;
      if (top) pageCounts.set(top, (pageCounts.get(top) ?? 0) + 1);
      const t = triggers.get(item.request_id);
      if (t) for (const tr of t) trigSet.add(tr);
    }
    const topPagesAtRank1 = [...pageCounts.entries()]
      .map(([page, count]) => ({ page, count }))
      .sort((a, b) => b.count - a.count || a.page.localeCompare(b.page))
      .slice(0, 3);
    const triggerOrder: RecallTrigger[] = ['low-confidence', 'no-citations', 'reask-30s'];
    const triggers_ = triggerOrder.filter((t) => trigSet.has(t));
    return { cluster: c, topPagesAtRank1, triggers: triggers_ };
  });
  return { count: failed.length, clusters: enriched };
}

// ---------------------------------------------------------------------------
// D2 — Latency anomalies
// ---------------------------------------------------------------------------

function analyzeLatency(input: DimensionInputs): LatencyFindings {
  const slow = input.runs.filter((r) => r.answer.latency_ms > input.latencyP95Threshold);
  if (slow.length === 0) {
    return { count: 0, threshold: input.latencyP95Threshold, total: input.runs.length, byQueryLen: [], byFusedCount: [] };
  }
  return {
    count: slow.length,
    threshold: input.latencyP95Threshold,
    total: input.runs.length,
    byQueryLen: bucketize(slow, queryLenBucket),
    byFusedCount: bucketize(slow, fusedCountBucket),
  };
}

function queryLenBucket(r: RunRecord): string {
  const n = r.query.length;
  if (n <= 80) return 'query ≤80 chars';
  if (n <= 160) return 'query 81–160 chars';
  return 'query >160 chars';
}

function fusedCountBucket(r: RunRecord): string {
  const n = r.retrieval.fused.length;
  if (n <= 8) return 'fused ≤8 chunks';
  if (n <= 16) return 'fused 9–16 chunks';
  return 'fused >16 chunks';
}

function bucketize(runs: RunRecord[], keyer: (r: RunRecord) => string): LatencyBucket[] {
  const buckets = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = keyer(r);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }
  return [...buckets.entries()]
    .map(([label, items]) => {
      items.sort((a, b) => b.answer.latency_ms - a.answer.latency_ms);
      return {
        label,
        count: items.length,
        worst: items[0]!.answer.latency_ms,
        examples: items.slice(0, 3).map((r) => ({
          query: r.query,
          latency_ms: r.answer.latency_ms,
        })),
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// D3 — Disambiguation cliffs
// ---------------------------------------------------------------------------

function analyzeDisambig(input: DimensionInputs): DisambigFindings {
  const clarifies = input.runs.filter((r) => r.retrieval.subtree_ask_triggered);
  if (clarifies.length === 0) {
    return { total: 0, unfollowed: 0, buckets: [] };
  }
  const followed = detectFollowups(input.runs);

  const byPage = new Map<string, { count: number; unfollowed: number; examples: string[] }>();
  for (const r of clarifies) {
    const page = r.retrieval.fused[0]?.page ?? '(no fused chunks)';
    const slot = byPage.get(page) ?? { count: 0, unfollowed: 0, examples: [] };
    slot.count++;
    if (!followed.has(r.request_id)) slot.unfollowed++;
    if (slot.examples.length < 3) slot.examples.push(r.query);
    byPage.set(page, slot);
  }

  const buckets: DisambigBucket[] = [...byPage.entries()]
    .map(([page, slot]) => ({ page, ...slot }))
    .sort((a, b) => b.unfollowed - a.unfollowed || b.count - a.count || a.page.localeCompare(b.page));
  const totalUnfollowed = buckets.reduce((s, b) => s + b.unfollowed, 0);
  return { total: clarifies.length, unfollowed: totalUnfollowed, buckets };
}

/**
 * Returns the set of request_ids that had a follow-up ask in the same
 * session within FOLLOWUP_WINDOW_MS. Runs with null session_id can never
 * be marked followed (no way to link conversations) — they always count
 * as unfollowed in D3.
 */
function detectFollowups(runs: RunRecord[]): Set<string> {
  const followed = new Set<string>();
  const bySession = groupBySession(runs);
  for (const session of bySession.values()) {
    session.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 0; i < session.length - 1; i++) {
      const a = session[i]!;
      const b = session[i + 1]!;
      if (Date.parse(b.ts) - Date.parse(a.ts) <= FOLLOWUP_WINDOW_MS) {
        followed.add(a.request_id);
      }
    }
  }
  return followed;
}

function groupBySession(runs: RunRecord[]): Map<string, RunRecord[]> {
  const out = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (!r.session_id) continue; // null session: can't link, skip
    const arr = out.get(r.session_id) ?? [];
    arr.push(r);
    out.set(r.session_id, arr);
  }
  return out;
}
