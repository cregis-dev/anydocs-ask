import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTrafficWindow,
  paginateTrafficRecords,
  parseTrafficViewOptions,
} from '../src/console/traffic-state.ts';
import { RunsWriter } from '../src/runs/writer.ts';
import type { RunRecord, RunSource } from '../src/runs/types.ts';

function run(args: {
  index: number;
  ts?: string;
  source?: RunSource;
  kind?: 'answer' | 'clarify' | 'error';
}): RunRecord {
  return {
    ts: args.ts ?? new Date().toISOString(),
    request_id: `req-${args.index}`,
    session_id: null,
    query: `question ${args.index}`,
    filters: {},
    context_pageId: null,
    source: args.source ?? 'reader',
    retrieval: { fused: [], subtree_ask_triggered: false },
    answer: {
      kind: args.kind ?? 'answer',
      answer_id: `answer-${args.index}`,
      md: 'answer',
      citations: [],
      latency_ms: 100,
      tokens_in: null,
      tokens_out: null,
      model: 'mock',
      error_code: null,
    },
    feedback: { beta: null, gamma: null },
  };
}

test('traffic view options parse supported filters and fall back safely', () => {
  assert.deepEqual(
    parseTrafficViewOptions({
      range: 'all',
      query: '  signature error  ',
      source: 'mcp',
      kind: 'error',
      page: '3',
      pageSize: '100',
    }),
    {
      range: 'all',
      query: 'signature error',
      source: 'mcp',
      kind: 'error',
      page: 3,
      pageSize: 100,
    },
  );

  assert.deepEqual(parseTrafficViewOptions({ range: '365', page: '-2', pageSize: '999' }), {
    range: 7,
    query: '',
    source: '',
    kind: '',
    page: 1,
    pageSize: 50,
  });
});

test('traffic pagination applies filters before slicing pages', () => {
  const records = Array.from({ length: 60 }, (_, index) => run({
    index,
    kind: index % 2 === 0 ? 'error' : 'answer',
  }));
  const options = parseTrafficViewOptions({ kind: 'error', page: '2', pageSize: '25' });
  const page = paginateTrafficRecords(records, options);

  assert.equal(page.totalRecords, 30);
  assert.equal(page.totalPages, 2);
  assert.equal(page.firstRecord, 26);
  assert.equal(page.lastRecord, 30);
  assert.equal(page.records.length, 5);
  assert.ok(page.records.every((record) => record.answer.kind === 'error'));
  assert.equal(page.records[0]!.query, 'question 8');
});

test('all-time traffic range includes records older than seven days', async () => {
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-traffic-state-'));
  try {
    const oldDate = new Date(Date.now() - 60 * 86_400_000);
    const recentDate = new Date();
    new RunsWriter({ stateRoot, enabled: true, now: () => oldDate }).append(
      run({ index: 1, ts: oldDate.toISOString() }),
    );
    new RunsWriter({ stateRoot, enabled: true, now: () => recentDate }).append(
      run({ index: 2, ts: recentDate.toISOString() }),
    );

    assert.equal(loadTrafficWindow(stateRoot, 7).records.length, 1);
    const all = loadTrafficWindow(stateRoot, 'all');
    assert.equal(all.records.length, 2);
    assert.equal(all.range, 'all');
    assert.equal(all.sinceISO, oldDate.toISOString().slice(0, 10));
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
