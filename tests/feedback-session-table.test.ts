/**
 * SessionTable — γ session bookkeeping. Pure data structure tests; the
 * orchestrator that wires it into /v1/ask lives in feedback-gamma.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTable, cosineSimilarity } from '../src/feedback/session-table.ts';

function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

// Unit-normalized vectors so cosine = dot.
function unitVec(values: number[]): Float32Array {
  let n = 0;
  for (const v of values) n += v * v;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  return new Float32Array(values.map((v) => v * inv));
}

test('cosineSimilarity: identical vectors → 1', () => {
  const a = unitVec([1, 2, 3]);
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-6);
});

test('cosineSimilarity: orthogonal vectors → 0', () => {
  assert.ok(Math.abs(cosineSimilarity(unitVec([1, 0]), unitVec([0, 1]))) < 1e-6);
});

test('cosineSimilarity: opposite vectors → -1', () => {
  assert.ok(Math.abs(cosineSimilarity(unitVec([1, 0]), unitVec([-1, 0])) + 1) < 1e-6);
});

test('cosineSimilarity: length mismatch → 0 (defensive)', () => {
  assert.equal(cosineSimilarity(vec([1, 0]), vec([1, 0, 0])), 0);
});

test('getOrCreate: mints fresh id when none requested', () => {
  const t = new SessionTable();
  const id = t.getOrCreate(null);
  assert.match(id, /^s_[a-f0-9]+$/);
  assert.equal(t.size, 1);
});

test('getOrCreate: returns existing id when alive', () => {
  const t = new SessionTable();
  const id1 = t.getOrCreate(null);
  const id2 = t.getOrCreate(id1);
  assert.equal(id2, id1);
  assert.equal(t.size, 1);
});

test('getOrCreate: mints fresh id when requested id is expired (no resurrection)', () => {
  let now = 1_000_000;
  const t = new SessionTable({ sessionTtlMs: 100, now: () => now });
  const id1 = t.getOrCreate(null);
  now += 200; // past TTL
  const id2 = t.getOrCreate(id1);
  assert.notEqual(id2, id1, 'expired session must not be revived');
});

test('record + findSimilarRecent: same session, in-window, high similarity → hit', () => {
  const t = new SessionTable({ now: () => 1_000_000 });
  const session = t.getOrCreate(null);
  const v1 = unitVec([1, 0.01, 0]);
  t.record({
    session_id: session,
    entry: { question: 'q1', embedding: v1, answer_id: 'ans_1', used_chunk_ids: [42], asked_at: 1_000_000, answer_md_summary: '' },
  });
  const v2 = unitVec([1, 0.02, 0]); // ~0.999 cosine with v1
  const hits = t.findSimilarRecent({ session_id: session, embedding: v2, threshold: 0.85 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.entry.answer_id, 'ans_1');
  assert.ok((hits[0]?.similarity ?? 0) > 0.99);
});

test('findSimilarRecent: low similarity → no hit', () => {
  const t = new SessionTable({ now: () => 1_000_000 });
  const session = t.getOrCreate(null);
  t.record({
    session_id: session,
    entry: { question: 'q1', embedding: unitVec([1, 0]), answer_id: 'ans_1', used_chunk_ids: [], asked_at: 1_000_000, answer_md_summary: '' },
  });
  const hits = t.findSimilarRecent({
    session_id: session,
    embedding: unitVec([0, 1]),
    threshold: 0.85,
  });
  assert.deepEqual(hits, []);
});

test('findSimilarRecent: out-of-window (>5min) → no hit even on identical vec', () => {
  let now = 1_000_000;
  const t = new SessionTable({ reaskWindowMs: 60_000, now: () => now });
  const session = t.getOrCreate(null);
  const v = unitVec([1, 0]);
  t.record({
    session_id: session,
    entry: { question: 'q1', embedding: v, answer_id: 'ans_1', used_chunk_ids: [], asked_at: now, answer_md_summary: '' },
  });
  now += 120_000; // past 60s window
  const hits = t.findSimilarRecent({ session_id: session, embedding: v, threshold: 0.85 });
  assert.deepEqual(hits, []);
});

test('findSimilarRecent: unknown session → empty (no throw)', () => {
  const t = new SessionTable();
  const hits = t.findSimilarRecent({
    session_id: 's_does_not_exist',
    embedding: unitVec([1, 0]),
    threshold: 0.85,
  });
  assert.deepEqual(hits, []);
});

test('findSimilarRecent: multiple hits returned sorted by descending similarity', () => {
  const t = new SessionTable({ now: () => 1_000_000 });
  const session = t.getOrCreate(null);
  // Entry A is much closer to target than entry B.
  t.record({
    session_id: session,
    entry: { question: 'a', embedding: unitVec([1, 0.5]), answer_id: 'a_id', used_chunk_ids: [], asked_at: 1_000_000, answer_md_summary: '' },
  });
  t.record({
    session_id: session,
    entry: { question: 'b', embedding: unitVec([1, 0.05]), answer_id: 'b_id', used_chunk_ids: [], asked_at: 1_000_000, answer_md_summary: '' },
  });
  const hits = t.findSimilarRecent({
    session_id: session,
    embedding: unitVec([1, 0.01]),
    threshold: 0.85,
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.entry.answer_id, 'b_id', 'closest must come first');
  assert.equal(hits[1]?.entry.answer_id, 'a_id');
});

test('record: per-session cap evicts oldest beyond N entries', () => {
  const t = new SessionTable({ now: () => 1_000_000 });
  const session = t.getOrCreate(null);
  // Insert 10 entries; only the most recent MAX_ENTRIES_PER_SESSION (8) should survive.
  for (let i = 0; i < 10; i++) {
    t.record({
      session_id: session,
      entry: {
        question: `q${i}`,
        embedding: unitVec([1, 0]),
        answer_id: `ans_${i}`,
        used_chunk_ids: [],
        asked_at: 1_000_000,
        answer_md_summary: '',
      },
    });
  }
  const hits = t.findSimilarRecent({
    session_id: session,
    embedding: unitVec([1, 0]),
    threshold: 0.85,
  });
  assert.equal(hits.length, 8, 'per-session cap = 8');
  // Oldest entries (ans_0, ans_1) should have been evicted.
  const ids = new Set(hits.map((h) => h.entry.answer_id));
  assert.equal(ids.has('ans_0'), false);
  assert.equal(ids.has('ans_1'), false);
  assert.equal(ids.has('ans_9'), true);
});

test('cleanup: removes expired sessions', () => {
  let now = 1_000_000;
  const t = new SessionTable({ sessionTtlMs: 100, now: () => now });
  t.getOrCreate(null);
  t.getOrCreate(null);
  t.getOrCreate(null);
  assert.equal(t.size, 3);
  now += 200;
  const removed = t.cleanup();
  assert.equal(removed, 3);
  assert.equal(t.size, 0);
});

// ---------------------------------------------------------------------------
// getRecentEntries — RFC 0003 M1 multi-turn history-aware retrieve.
// ---------------------------------------------------------------------------

test('getRecentEntries: returns last N entries newest-first', () => {
  const t = new SessionTable({ now: () => 1_000_000 });
  const session = t.getOrCreate(null);
  for (const q of ['q0', 'q1', 'q2', 'q3']) {
    t.record({
      session_id: session,
      entry: {
        question: q,
        embedding: unitVec([1, 0]),
        answer_id: null,
        used_chunk_ids: [],
        asked_at: 1_000_000,
        answer_md_summary: `summary for ${q}`,
      },
    });
  }
  const recent = t.getRecentEntries(session, 3);
  assert.deepEqual(
    recent.map((e) => e.question),
    ['q3', 'q2', 'q1'],
    'newest first, capped at N=3',
  );
});

test('getRecentEntries: n=0 returns empty without throwing', () => {
  const t = new SessionTable();
  const session = t.getOrCreate(null);
  t.record({
    session_id: session,
    entry: { question: 'q', embedding: unitVec([1, 0]), answer_id: null, used_chunk_ids: [], asked_at: Date.now(), answer_md_summary: '' },
  });
  assert.deepEqual(t.getRecentEntries(session, 0), []);
});

test('getRecentEntries: n larger than available returns all (no error)', () => {
  const t = new SessionTable({ now: () => 1_000_000 });
  const session = t.getOrCreate(null);
  t.record({
    session_id: session,
    entry: { question: 'q0', embedding: unitVec([1, 0]), answer_id: null, used_chunk_ids: [], asked_at: 1_000_000, answer_md_summary: '' },
  });
  const recent = t.getRecentEntries(session, 99);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.question, 'q0');
});

test('getRecentEntries: unknown session → empty (no throw)', () => {
  const t = new SessionTable();
  assert.deepEqual(t.getRecentEntries('s_never_existed', 3), []);
});

test('getRecentEntries: expired session → empty (multi-turn falls back to single-turn)', () => {
  let now = 1_000_000;
  const t = new SessionTable({ sessionTtlMs: 100, now: () => now });
  const session = t.getOrCreate(null);
  t.record({
    session_id: session,
    entry: { question: 'q0', embedding: unitVec([1, 0]), answer_id: null, used_chunk_ids: [], asked_at: now, answer_md_summary: '' },
  });
  now += 200; // past TTL
  assert.deepEqual(t.getRecentEntries(session, 3), []);
});

test('record: touching a session refreshes its TTL', () => {
  let now = 1_000_000;
  const t = new SessionTable({ sessionTtlMs: 1_000, now: () => now });
  const session = t.getOrCreate(null);
  now += 800; // not yet expired
  t.record({
    session_id: session,
    entry: { question: 'q', embedding: unitVec([1, 0]), answer_id: 'a', used_chunk_ids: [], asked_at: now, answer_md_summary: '' },
  });
  now += 800; // would expire from t=0 but record refreshed it
  const id2 = t.getOrCreate(session);
  assert.equal(id2, session, 'session should still be alive');
});
