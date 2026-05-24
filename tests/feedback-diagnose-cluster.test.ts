/**
 * RFC 0006 A3 alpha.1 — clusterFeedback unit tests + synthetic simulator.
 *
 * Synthetic fixture (`synthesize60()`) builds 60 rows across 4 topics × 15
 * queries with controlled perturbation. Anchor embeddings are mutually
 * orthogonal in a 32-dim space (synthetic; real bge-m3 is 1024-dim but the
 * algorithm doesn't care). Each member = anchor + small gaussian-ish noise
 * — re-normalized to unit length so cosine = dot.
 *
 * Hyperparameter validation: with default threshold 0.65 the simulator
 * should produce exactly 4 clusters of ~15 each. RFC §4.2 阈值推导原文：
 * 同主题不同表述 0.55-0.7 cosine，跨主题 < 0.4。Simulator 阻抗设计：
 * `topic_signal` 占 0.85，`noise` 占 0.15 → 同主题 cosine ≈ 0.85² = 0.72，
 * 跨主题 cosine ≈ 0.85²·0 = 0（orthogonal anchors）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterFeedback,
  cosineSimilarity,
  type FeedbackClusterInput,
} from '../src/feedback/diagnose-cluster.ts';

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

const EMBED_DIM = 32;

/** Seedable LCG so the simulator is deterministic across runs. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mutually orthogonal unit anchors. anchor[k] has 1 at dim k, 0 elsewhere. */
function makeAnchor(topicIdx: number): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  v[topicIdx] = 1;
  return v;
}

function unitize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const inv = 1 / Math.sqrt(n);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

/**
 * Build 4 topics × 15 queries = 60 rows. Each query embedding =
 * anchor(topic) * topicSignal + noise * (1 - topicSignal).
 * topicSignal = 0.85 → same-topic cosine ≈ 0.7+, cross-topic ≈ 0.
 */
function synthesize60(): FeedbackClusterInput[] {
  const rand = mulberry32(2026_05_24);
  const rows: FeedbackClusterInput[] = [];
  const topics = ['provider', 'wallet', 'tools', 'memory'];
  const topicSignal = 0.85;
  let fid = 1;
  for (let t = 0; t < topics.length; t++) {
    const anchor = makeAnchor(t);
    for (let i = 0; i < 15; i++) {
      const v = new Float32Array(EMBED_DIM);
      for (let d = 0; d < EMBED_DIM; d++) {
        const noise = (rand() - 0.5) * 2; // [-1, 1]
        v[d] = anchor[d]! * topicSignal + noise * (1 - topicSignal);
      }
      rows.push({
        feedback_id: fid++,
        answer_id: 'ans_' + t + '_' + i,
        question: topics[t] + ' query #' + i,
        embedding: unitize(v),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// cosineSimilarity sanity
// ---------------------------------------------------------------------------

test('cosineSimilarity: same vector → 1', () => {
  const v = unitize(new Float32Array([1, 2, 3, 4]));
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
});

test('cosineSimilarity: orthogonal → 0', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test('cosineSimilarity: opposite → -1', () => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([-1, 0]);
  assert.ok(Math.abs(cosineSimilarity(a, b) + 1) < 1e-6);
});

test('cosineSimilarity: zero-norm input → 0 (no NaN)', () => {
  const a = new Float32Array([0, 0]);
  const b = new Float32Array([1, 0]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test('cosineSimilarity: length mismatch throws', () => {
  assert.throws(
    () => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0])),
    /length mismatch/,
  );
});

// ---------------------------------------------------------------------------
// clusterFeedback — basic cases
// ---------------------------------------------------------------------------

test('clusterFeedback: empty input → empty array', () => {
  assert.deepEqual(clusterFeedback([]), []);
});

test('clusterFeedback: single row → empty (below minClusterSize)', () => {
  const rows = synthesize60().slice(0, 1);
  assert.deepEqual(clusterFeedback(rows), []);
});

test('clusterFeedback: 2-row identical → 1 cluster of size 2', () => {
  const anchor = unitize(makeAnchor(0));
  const rows: FeedbackClusterInput[] = [
    { feedback_id: 1, answer_id: 'a', question: 'q1', embedding: anchor },
    { feedback_id: 2, answer_id: 'b', question: 'q2', embedding: anchor },
  ];
  const out = clusterFeedback(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.size, 2);
  assert.deepEqual(out[0]!.members, [1, 2]);
  assert.ok(Math.abs(out[0]!.density - 1) < 1e-6);
});

test('clusterFeedback: 2-row orthogonal → 0 clusters (both filtered as singletons)', () => {
  const rows: FeedbackClusterInput[] = [
    { feedback_id: 1, answer_id: 'a', question: 'q1', embedding: unitize(makeAnchor(0)) },
    { feedback_id: 2, answer_id: 'b', question: 'q2', embedding: unitize(makeAnchor(1)) },
  ];
  assert.deepEqual(clusterFeedback(rows), []);
});

// ---------------------------------------------------------------------------
// clusterFeedback — RFC §4.2 simulator
// ---------------------------------------------------------------------------

test('clusterFeedback: synthetic 60 rows × 4 topics → exactly 4 clusters at threshold 0.65', () => {
  // RFC §4.2 calibration: same-topic cosine ≈ 0.72, cross-topic ≈ 0.
  // Threshold 0.65 should partition exactly into the 4 known topics.
  const rows = synthesize60();
  const clusters = clusterFeedback(rows);
  assert.equal(clusters.length, 4, `expected 4 clusters; got ${clusters.length}`);
  // Each cluster size in [13, 15] — allow noise to flip 1-2 rows.
  for (const c of clusters) {
    assert.ok(c.size >= 13 && c.size <= 15, `cluster size ${c.size} out of range`);
  }
  // Total members across clusters = 60 (no row left behind).
  const total = clusters.reduce((sum, c) => sum + c.size, 0);
  assert.equal(total, 60);
});

test('clusterFeedback: threshold sweep — extremes collapse to predictable states', () => {
  // Two anchor cases pin the algorithm's response curve:
  //   - threshold 0.0: every pair unions → 1 giant cluster of 60
  //   - threshold 1.0: no pair unions (no two normalized noisy vectors hit
  //     exact 1.0) → all singletons → 0 clusters after minSize filter
  // Mid-range (default 0.65) gets us the 4 we want; that's the other test.
  const rows = synthesize60();
  const everything = clusterFeedback(rows, { threshold: 0 });
  assert.equal(everything.length, 1);
  assert.equal(everything[0]!.size, 60);

  const nothing = clusterFeedback(rows, { threshold: 1 });
  assert.equal(nothing.length, 0);
});

test('clusterFeedback: cluster_id stable across reruns with same input', () => {
  const rows = synthesize60();
  const a = clusterFeedback(rows);
  const b = clusterFeedback(rows);
  assert.deepEqual(
    a.map((c) => c.cluster_id),
    b.map((c) => c.cluster_id),
  );
});

test('clusterFeedback: cluster_id derived from center question (rerun with permuted input is stable)', () => {
  // Permuting input order shouldn't change cluster_id (which is hash of
  // center question, not member ordering). Members may permute but the id
  // should be invariant.
  const original = synthesize60();
  const permuted = [...original].reverse();
  const a = clusterFeedback(original);
  const b = clusterFeedback(permuted);
  const idsA = new Set(a.map((c) => c.cluster_id));
  const idsB = new Set(b.map((c) => c.cluster_id));
  assert.deepEqual(idsA, idsB);
});

test('clusterFeedback: center_question always belongs to the cluster', () => {
  const rows = synthesize60();
  for (const c of clusterFeedback(rows)) {
    assert.ok(c.member_questions.includes(c.center_question));
    assert.ok(c.members.includes(c.center_feedback_id));
  }
});

test('clusterFeedback: minClusterSize=3 drops 2-element clusters', () => {
  // Three pairs of identical-pair queries — each pair is its own group of 2.
  const anchor0 = unitize(makeAnchor(0));
  const anchor1 = unitize(makeAnchor(1));
  const anchor2 = unitize(makeAnchor(2));
  const rows: FeedbackClusterInput[] = [
    { feedback_id: 1, answer_id: 'a', question: 'q1', embedding: anchor0 },
    { feedback_id: 2, answer_id: 'b', question: 'q2', embedding: anchor0 },
    { feedback_id: 3, answer_id: 'c', question: 'q3', embedding: anchor1 },
    { feedback_id: 4, answer_id: 'd', question: 'q4', embedding: anchor1 },
    { feedback_id: 5, answer_id: 'e', question: 'q5', embedding: anchor2 },
    { feedback_id: 6, answer_id: 'f', question: 'q6', embedding: anchor2 },
  ];
  // Default minClusterSize=2 → 3 clusters
  assert.equal(clusterFeedback(rows).length, 3);
  // Override minClusterSize=3 → 0 clusters
  assert.equal(clusterFeedback(rows, { minClusterSize: 3 }).length, 0);
});

test('clusterFeedback: output ordered by size DESC then density DESC', () => {
  // Build 2 clusters: big (5 members) + small (3 members). big should come first.
  const a = unitize(makeAnchor(0));
  const b = unitize(makeAnchor(1));
  const rows: FeedbackClusterInput[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push({ feedback_id: 100 + i, answer_id: 'A' + i, question: 'a' + i, embedding: a });
  }
  for (let i = 0; i < 3; i++) {
    rows.push({ feedback_id: 200 + i, answer_id: 'B' + i, question: 'b' + i, embedding: b });
  }
  const clusters = clusterFeedback(rows);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0]!.size, 5);
  assert.equal(clusters[1]!.size, 3);
});

test('clusterFeedback: density reflects intra-cluster cosine spread', () => {
  // Cluster A: all identical → density 1.
  // Cluster B: mixed near-anchor with noise → density < 1.
  const anchor = unitize(makeAnchor(0));
  const tight: FeedbackClusterInput[] = [
    { feedback_id: 1, answer_id: 'a', question: 'q1', embedding: anchor },
    { feedback_id: 2, answer_id: 'b', question: 'q2', embedding: anchor },
    { feedback_id: 3, answer_id: 'c', question: 'q3', embedding: anchor },
  ];
  const tightCluster = clusterFeedback(tight)[0]!;
  assert.ok(Math.abs(tightCluster.density - 1) < 1e-6);

  // Synthetic 60 → first cluster's density should be 0.6-0.8 ish.
  const noisy = clusterFeedback(synthesize60())[0]!;
  assert.ok(noisy.density > 0.5 && noisy.density < 1, `expected density in (0.5, 1); got ${noisy.density}`);
});
