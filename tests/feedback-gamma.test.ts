/**
 * γ orchestrator — drives SessionTable + writes implicit-negative rows to
 * the feedback table on same-session re-asks.
 *
 * Uses a real in-memory SQLite (migrations 001 + 002 applied) so the inserts
 * exercise the actual schema. Embedder is unused — we feed pre-built unit
 * vectors directly to observeAsk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.ts';
import { SessionTable } from '../src/feedback/session-table.ts';
import { observeAsk, REASK_SIMILARITY_THRESHOLD } from '../src/feedback/gamma.ts';
import type { ResolvedConfig } from '../src/config.ts';
import type { AskResult } from '../src/query/types.ts';

function unitVec(values: number[]): Float32Array {
  let n = 0;
  for (const v of values) n += v * v;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  return new Float32Array(values.map((v) => v * inv));
}

function makeConfig(over: Partial<ResolvedConfig['feedback']>): ResolvedConfig {
  // Cast is fine — observeAsk only reads `feedback.*`.
  return {
    feedback: { enabled: true, implicitSignals: 'session-only', rerankerWeight: 0.15, ...over },
  } as ResolvedConfig;
}

function answerResult(args: { answer_id: string; chunk_ids: number[] }): AskResult {
  return {
    type: 'answer',
    answer_id: args.answer_id,
    answer_lang: 'en',
    answer_md: 'ans',
    translation_notice: null,
    citations: args.chunk_ids.map((id, i) => ({
      citation_id: `cit_${i + 1}`,
      chunk_id: id,
      page_id: 'p',
      lang: 'en',
      source_lang: null,
      title: 't',
      breadcrumb: [],
      url: null,
      snippet: '',
      in_page_path: '',
    })),
    used_chunks: args.chunk_ids.length,
    model: 'mock',
    latency_ms: 1,
  };
}

test('observeAsk: enabled=false → no rows, session_id minted anyway', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const sessions = new SessionTable();
  try {
    const out = observeAsk({
      db,
      config: makeConfig({ enabled: false }),
      sessionTable: sessions,
      requestedSessionId: null,
      question: 'q1',
      queryVector: unitVec([1, 0]),
      result: answerResult({ answer_id: 'ans_1', chunk_ids: [1] }),
      now: 1_000_000,
    });
    assert.match(out.session_id, /^s_/);
    assert.equal(out.implicit_rows_inserted, 0);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM feedback`).get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    db.close();
  }
});

test("observeAsk: implicitSignals='off' → no rows, session_id minted", () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const sessions = new SessionTable();
  try {
    const out = observeAsk({
      db,
      config: makeConfig({ implicitSignals: 'off' }),
      sessionTable: sessions,
      requestedSessionId: null,
      question: 'q1',
      queryVector: unitVec([1, 0]),
      result: answerResult({ answer_id: 'ans_1', chunk_ids: [1] }),
      now: 1_000_000,
    });
    assert.match(out.session_id, /^s_/);
    assert.equal(out.implicit_rows_inserted, 0);
  } finally {
    db.close();
  }
});

test('observeAsk: first ask records into session, inserts no row', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const sessions = new SessionTable();
  try {
    const out = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: null,
      question: 'how to authenticate',
      queryVector: unitVec([1, 0]),
      result: answerResult({ answer_id: 'ans_1', chunk_ids: [42] }),
      now: 1_000_000,
    });
    assert.equal(out.implicit_rows_inserted, 0);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM feedback`).get() as { n: number };
    assert.equal(rows.n, 0, 'first ask has nothing to compare against');
    assert.equal(sessions.size, 1);
  } finally {
    db.close();
  }
});

test('observeAsk: re-ask within 5min ≥ threshold → 1 implicit-negative row pointing at prior answer', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  // Synthetic clock shared between SessionTable's TTL checks and observeAsk's
  // record/lookup calls — otherwise the entry's asked_at (synthetic) sits
  // outside SessionTable's real-Date.now() window.
  let now = 1_000_000;
  const sessions = new SessionTable({ now: () => now });
  try {
    // First ask seeds the session.
    const first = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: null,
      question: 'how to authenticate',
      queryVector: unitVec([1, 0.01]),
      result: answerResult({ answer_id: 'ans_first', chunk_ids: [42, 43] }),
      now,
    });
    now += 120_000;
    // Second ask — same session, very similar vector, 2min later.
    const second = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: first.session_id,
      question: 'authentication how',
      queryVector: unitVec([1, 0.02]),
      result: answerResult({ answer_id: 'ans_second', chunk_ids: [99] }),
      now,
    });
    assert.equal(second.implicit_rows_inserted, 1);
    assert.equal(second.session_id, first.session_id);

    const row = db
      .prepare(`SELECT * FROM feedback WHERE signal_source = 'implicit' LIMIT 1`)
      .get() as {
      answer_id: string;
      signal_source: string;
      rating: number;
      session_id: string;
      bad_citation_ids: string;
      tags: string;
    };
    assert.equal(row.signal_source, 'implicit');
    assert.equal(row.answer_id, 'ans_first', 'implicit row points at the PRIOR answer');
    assert.equal(row.session_id, first.session_id);
    assert.ok(row.rating < 0);
    const badIds = JSON.parse(row.bad_citation_ids) as string[];
    assert.deepEqual(badIds, ['42', '43'], 'bad_citation_ids = prior answer used chunks');
    const tags = JSON.parse(row.tags) as string[];
    assert.ok(tags.includes('gamma:reask'));
  } finally {
    db.close();
  }
});

test('observeAsk: re-ask BELOW threshold → no row', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  let now = 1_000_000;
  const sessions = new SessionTable({ now: () => now });
  try {
    const first = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: null,
      question: 'how to authenticate',
      queryVector: unitVec([1, 0]),
      result: answerResult({ answer_id: 'ans_1', chunk_ids: [1] }),
      now,
    });
    now += 60_000;
    const second = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: first.session_id,
      question: 'completely different question',
      queryVector: unitVec([0, 1]), // orthogonal → similarity 0
      result: answerResult({ answer_id: 'ans_2', chunk_ids: [2] }),
      now,
    });
    assert.equal(second.implicit_rows_inserted, 0);
  } finally {
    db.close();
  }
});

test('observeAsk: re-ask OUT of 5min window → no row even at perfect similarity', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  let now = 1_000_000;
  const sessions = new SessionTable({ reaskWindowMs: 1_000, now: () => now });
  try {
    const first = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: null,
      question: 'q',
      queryVector: unitVec([1, 0]),
      result: answerResult({ answer_id: 'ans_1', chunk_ids: [1] }),
      now,
    });
    now += 10_000; // past the window
    const second = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: first.session_id,
      question: 'q',
      queryVector: unitVec([1, 0]),
      result: answerResult({ answer_id: 'ans_2', chunk_ids: [2] }),
      now,
    });
    assert.equal(second.implicit_rows_inserted, 0);
  } finally {
    db.close();
  }
});

test('observeAsk: queryVector=null path (early-error) does not crash, no rows', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const sessions = new SessionTable();
  try {
    const out = observeAsk({
      db,
      config: makeConfig({}),
      sessionTable: sessions,
      requestedSessionId: null,
      question: '',
      queryVector: null,
      result: { type: 'error', code: 'invalid_question', message: 'oops' },
      now: 1_000_000,
    });
    assert.equal(out.implicit_rows_inserted, 0);
    assert.match(out.session_id, /^s_/);
  } finally {
    db.close();
  }
});

test('observeAsk: threshold constant matches RFC §7 Q2 (0.85)', () => {
  // Smoke test against accidental constant drift.
  assert.equal(REASK_SIMILARITY_THRESHOLD, 0.85);
});
