import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDimensions } from '../src/analyze/dimensions.ts';
import type { RunRecord } from '../src/runs/types.ts';

function fakeRun(over: {
  request_id: string;
  ts?: string;
  session_id?: string | null;
  query?: string;
  confidence?: number;
  citations?: number;
  latency_ms?: number;
  fused?: { page: string }[];
  subtree_ask?: boolean;
  kind?: 'answer' | 'clarify' | 'error';
}): RunRecord {
  return {
    ts: over.ts ?? '2026-05-09T12:00:00.000Z',
    request_id: over.request_id,
    session_id: over.session_id ?? null,
    query: over.query ?? 'q',
    filters: {},
    context_pageId: null,
    retrieval: {
      fused: (over.fused ?? [{ page: 'home' }]).map((f, i) => ({
        chunk_id: i,
        page: f.page,
        rrf_score: 0.05,
        final_score: 0.05,
        vec_rank: i,
        bm25_rank: i,
        nav_index: i,
        nav_index_boost: 0,
      })),
      subtree_ask_triggered: over.subtree_ask ?? false,
    },
    answer: {
      kind: over.kind ?? 'answer',
      answer_id: 'a',
      md: '...',
      citations: Array.from({ length: over.citations ?? 1 }, (_, i) => ({
        chunk_id: i,
        page: 'home',
        quote: 'q',
      })),
      confidence: over.confidence ?? 0.6,
      latency_ms: over.latency_ms ?? 1000,
      tokens_in: null,
      tokens_out: null,
      model: null,
      error_code: null,
    },
    feedback: { beta: null, gamma: null },
  };
}

// ---------------------------------------------------------------------------
// D1: recall failures
// ---------------------------------------------------------------------------

test('D1: low confidence trips recall', () => {
  const out = analyzeDimensions({
    runs: [fakeRun({ request_id: 'r1', confidence: 0.2 })],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.recall.count, 1);
  assert.deepEqual(out.recall.clusters[0]!.triggers, ['low-confidence']);
});

test('D1: zero citations on answer kind trips recall', () => {
  const out = analyzeDimensions({
    runs: [fakeRun({ request_id: 'r1', confidence: 0.9, citations: 0, kind: 'answer' })],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.recall.count, 1);
  assert.ok(out.recall.clusters[0]!.triggers.includes('no-citations'));
});

test('D1: error kind with empty citations does NOT trip no-citations', () => {
  // Error responses already accounted for; analyze should not double-count.
  const out = analyzeDimensions({
    runs: [fakeRun({ request_id: 'r1', confidence: 0.9, citations: 0, kind: 'error' })],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.recall.count, 0);
});

test('D1: error kind with low confidence does NOT trip recall', () => {
  // Validation / client errors have confidence=0 by definition; they are not
  // retrieval failures and must not pollute the recall-failure report.
  const out = analyzeDimensions({
    runs: [fakeRun({ request_id: 'r1', confidence: 0, citations: 0, kind: 'error' })],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.recall.count, 0);
});

test('D1: re-ask within 30s with small edit distance flags earlier query', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({
        request_id: 'r1',
        session_id: 's1',
        ts: '2026-05-09T12:00:00.000Z',
        query: 'how do I install hermes',
        confidence: 0.9,
        citations: 1,
      }),
      fakeRun({
        request_id: 'r2',
        session_id: 's1',
        ts: '2026-05-09T12:00:15.000Z', // +15s
        query: 'how do i instal hermes', // edit dist 2
        confidence: 0.9,
        citations: 1,
      }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.recall.count, 1);
  // Earlier (r1) is flagged
  assert.equal(out.recall.clusters[0]!.cluster.items[0]!.request_id, 'r1');
  assert.deepEqual(out.recall.clusters[0]!.triggers, ['reask-30s']);
});

test('D1: re-ask outside 30s does not flag', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({
        request_id: 'r1',
        session_id: 's1',
        ts: '2026-05-09T12:00:00.000Z',
        query: 'install',
        confidence: 0.9,
        citations: 1,
      }),
      fakeRun({
        request_id: 'r2',
        session_id: 's1',
        ts: '2026-05-09T12:01:00.000Z', // +60s
        query: 'install',
        confidence: 0.9,
        citations: 1,
      }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.recall.count, 0);
});

test('D1: clusters bucket low-confidence runs with similar queries', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({ request_id: 'a', confidence: 0.1, query: 'how do I install' }),
      fakeRun({ request_id: 'b', confidence: 0.1, query: 'how do i install?' }),
      fakeRun({ request_id: 'c', confidence: 0.1, query: 'completely different question entirely' }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.recall.count, 3);
  assert.equal(out.recall.clusters.length, 2);
});

// ---------------------------------------------------------------------------
// D2: latency anomalies
// ---------------------------------------------------------------------------

test('D2: nothing exceeds threshold -> empty', () => {
  const out = analyzeDimensions({
    runs: [fakeRun({ request_id: 'r1', latency_ms: 100 })],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.latency.count, 0);
  assert.equal(out.latency.byQueryLen.length, 0);
});

test('D2: buckets by query-length range', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({ request_id: 'r1', latency_ms: 5000, query: 'short query' }),
      fakeRun({ request_id: 'r2', latency_ms: 4000, query: 'a'.repeat(200) }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.latency.count, 2);
  // Two distinct buckets, sorted by count desc then label
  assert.equal(out.latency.byQueryLen.length, 2);
  const labels = out.latency.byQueryLen.map((b) => b.label);
  assert.ok(labels.includes('query ≤80 chars'));
  assert.ok(labels.includes('query >160 chars'));
});

test('D2: worst latency surfaced in bucket', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({ request_id: 'r1', latency_ms: 4000, query: 's' }),
      fakeRun({ request_id: 'r2', latency_ms: 7000, query: 's' }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.latency.byQueryLen[0]!.worst, 7000);
});

// ---------------------------------------------------------------------------
// D3: disambiguation cliffs
// ---------------------------------------------------------------------------

test('D3: clarify with no follow-up counted as unfollowed', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({
        request_id: 'r1',
        session_id: 's1',
        subtree_ask: true,
        fused: [{ page: 'security' }],
      }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.disambig.total, 1);
  assert.equal(out.disambig.unfollowed, 1);
  assert.equal(out.disambig.buckets[0]!.page, 'security');
});

test('D3: clarify followed within 5min not counted as unfollowed', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({
        request_id: 'r1',
        session_id: 's1',
        ts: '2026-05-09T12:00:00.000Z',
        subtree_ask: true,
        fused: [{ page: 'billing' }],
      }),
      fakeRun({
        request_id: 'r2',
        session_id: 's1',
        ts: '2026-05-09T12:02:00.000Z',
        subtree_ask: false,
      }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.disambig.total, 1);
  assert.equal(out.disambig.unfollowed, 0);
});

test('D3: null session_id -> always unfollowed (cant link)', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({ request_id: 'r1', session_id: null, subtree_ask: true }),
      fakeRun({ request_id: 'r2', session_id: null, subtree_ask: false }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.disambig.unfollowed, 1);
});

test('D3: bucketed by top-fused page', () => {
  const out = analyzeDimensions({
    runs: [
      fakeRun({ request_id: 'r1', subtree_ask: true, fused: [{ page: 'A' }] }),
      fakeRun({ request_id: 'r2', subtree_ask: true, fused: [{ page: 'A' }] }),
      fakeRun({ request_id: 'r3', subtree_ask: true, fused: [{ page: 'B' }] }),
    ],
    confidenceFloor: 0.4,
    latencyP95Threshold: 3000,
  });
  assert.equal(out.disambig.buckets.length, 2);
  // Sorted by unfollowed desc -> A (×2) before B (×1)
  assert.equal(out.disambig.buckets[0]!.page, 'A');
  assert.equal(out.disambig.buckets[0]!.count, 2);
});
