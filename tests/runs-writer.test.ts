/**
 * RunsWriter unit tests — append, truncation, enabled flag, idempotent dir
 * creation, and the read helpers (listRunFiles / tailRuns / iterateRunsSince).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunsWriter,
  iterateRunsSince,
  listRunFiles,
  tailRuns,
} from '../src/runs/writer.ts';
import type { RunRecord } from '../src/runs/types.ts';

/**
 * tmp dir doubles as the stateRoot for these tests — the writer doesn't care
 * whether the parent has a `state/` ancestor, only that it can mkdir runs/
 * underneath. This keeps the tests focused on the writer's contract, not the
 * workspace layout (which has its own dedicated tests in workspace.test.ts).
 */
async function withTmpProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-runs-'));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function fakeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    ts: '2026-05-08T03:14:15.123Z',
    request_id: 'req-1',
    session_id: null,
    query: 'JWT 怎么续期',
    filters: {},
    context_pageId: null,
    retrieval: { fused: [], subtree_ask_triggered: false },
    answer: {
      kind: 'answer',
      answer_id: 'ans_1',
      md: 'Use refresh tokens.',
      citations: [],
      confidence: 0.78,
      latency_ms: 1234,
      tokens_in: null,
      tokens_out: null,
      model: 'mock-llm',
      error_code: null,
    },
    feedback: { beta: null, gamma: null },
    ...overrides,
  };
}

test('RunsWriter.append writes one jsonl line under runs/', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const w = new RunsWriter({
      stateRoot: root,
      enabled: true,
      now: () => new Date(Date.UTC(2026, 4, 8, 12, 0, 0)),
    });
    const path = w.append(fakeRecord());
    assert.ok(path);
    assert.equal(path, join(root, 'runs', '2026-W19.jsonl'));
    assert.ok(existsSync(path));
    const contents = readFileSync(path, 'utf8');
    assert.match(contents, /^\{.*\}\n$/s);
    const parsed = JSON.parse(contents.trim()) as RunRecord;
    assert.equal(parsed.query, 'JWT 怎么续期');
    assert.equal(parsed.answer.confidence, 0.78);
  } finally {
    await cleanup();
  }
});

test('RunsWriter.append: enabled=false returns null and does not create files', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const w = new RunsWriter({ stateRoot: root, enabled: false });
    const path = w.append(fakeRecord());
    assert.equal(path, null);
    assert.equal(existsSync(join(root, 'runs')), false);
    assert.equal(w.isEnabled, false);
  } finally {
    await cleanup();
  }
});

test('RunsWriter: multiple appends share one weekly file', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const w = new RunsWriter({
      stateRoot: root,
      enabled: true,
      now: () => new Date(Date.UTC(2026, 4, 8, 12, 0, 0)),
    });
    w.append(fakeRecord({ request_id: 'req-1' }));
    w.append(fakeRecord({ request_id: 'req-2' }));
    w.append(fakeRecord({ request_id: 'req-3' }));
    const file = join(root, 'runs', '2026-W19.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
    assert.equal((JSON.parse(lines[0]!) as RunRecord).request_id, 'req-1');
    assert.equal((JSON.parse(lines[2]!) as RunRecord).request_id, 'req-3');
  } finally {
    await cleanup();
  }
});

test('RunsWriter: appends across weeks land in different files', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    let now = new Date(Date.UTC(2026, 4, 8, 12, 0, 0)); // 2026-W19
    const w = new RunsWriter({ stateRoot: root, enabled: true, now: () => now });
    w.append(fakeRecord({ request_id: 'wk19' }));
    now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0)); // 2026-W20
    w.append(fakeRecord({ request_id: 'wk20' }));
    const files = listRunFiles({ stateRoot: root }).map((p) => p.split('/').pop());
    assert.deepEqual(files, ['2026-W19.jsonl', '2026-W20.jsonl']);
  } finally {
    await cleanup();
  }
});

test('RunsWriter: truncateQueryChars caps long queries', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const w = new RunsWriter({
      stateRoot: root,
      enabled: true,
      truncateQueryChars: 10,
      now: () => new Date(Date.UTC(2026, 4, 8, 12, 0, 0)),
    });
    const long = 'A'.repeat(50);
    w.append(fakeRecord({ query: long }));
    const file = join(root, 'runs', '2026-W19.jsonl');
    const parsed = JSON.parse(readFileSync(file, 'utf8').trim()) as RunRecord;
    assert.equal(parsed.query, 'AAAAAAAAAA');
    assert.equal(parsed.query.length, 10);
  } finally {
    await cleanup();
  }
});

test('RunsWriter: truncateAnswerChars caps long answer.md', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const w = new RunsWriter({
      stateRoot: root,
      enabled: true,
      truncateAnswerChars: 5,
      now: () => new Date(Date.UTC(2026, 4, 8, 12, 0, 0)),
    });
    const longAnswer = 'B'.repeat(40);
    w.append(
      fakeRecord({
        answer: {
          kind: 'answer',
          answer_id: 'a',
          md: longAnswer,
          citations: [],
          confidence: 1,
          latency_ms: 1,
          tokens_in: null,
          tokens_out: null,
          model: 'm',
          error_code: null,
        },
      }),
    );
    const file = join(root, 'runs', '2026-W19.jsonl');
    const parsed = JSON.parse(readFileSync(file, 'utf8').trim()) as RunRecord;
    assert.equal(parsed.answer.md, 'BBBBB');
  } finally {
    await cleanup();
  }
});

test('listRunFiles: empty when no runs/ dir', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    assert.deepEqual(listRunFiles({ stateRoot: root }), []);
  } finally {
    await cleanup();
  }
});

test('listRunFiles: ignores non-conforming filenames', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const dir = join(root, 'runs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, '2026-W01.jsonl'), '');
    await fs.writeFile(join(dir, 'not-a-runs-file.txt'), '');
    await fs.writeFile(join(dir, '2026-W01.json'), ''); // wrong ext
    const files = listRunFiles({ stateRoot: root }).map((p) => p.split('/').pop());
    assert.deepEqual(files, ['2026-W01.jsonl']);
  } finally {
    await cleanup();
  }
});

test('tailRuns: returns last N from latest week', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    let now = new Date(Date.UTC(2026, 4, 8, 12, 0, 0));
    const w = new RunsWriter({ stateRoot: root, enabled: true, now: () => now });
    for (let i = 0; i < 5; i++) w.append(fakeRecord({ request_id: `r-${i}` }));
    now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
    for (let i = 0; i < 3; i++) w.append(fakeRecord({ request_id: `s-${i}` }));
    const tail = tailRuns({ stateRoot: root, count: 2 });
    assert.equal(tail.length, 2);
    // tail picks from the LATEST file only (2026-W20 has 3 records → last 2).
    const reqs = tail.map((l) => (l as RunRecord).request_id);
    assert.deepEqual(reqs, ['s-1', 's-2']);
  } finally {
    await cleanup();
  }
});

test('iterateRunsSince: filters by ts across weeks', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    let now = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
    const w = new RunsWriter({ stateRoot: root, enabled: true, now: () => now });
    w.append(fakeRecord({ ts: '2026-05-01T00:00:00Z', request_id: 'old' }));
    now = new Date(Date.UTC(2026, 4, 8, 0, 0, 0));
    w.append(fakeRecord({ ts: '2026-05-08T00:00:00Z', request_id: 'mid' }));
    now = new Date(Date.UTC(2026, 4, 15, 0, 0, 0));
    w.append(fakeRecord({ ts: '2026-05-15T00:00:00Z', request_id: 'new' }));

    const sinceMs = Date.parse('2026-05-07T00:00:00Z');
    const out = [...iterateRunsSince({ stateRoot: root, sinceMs })] as RunRecord[];
    const ids = out.map((r) => r.request_id);
    assert.deepEqual(ids, ['mid', 'new']);
  } finally {
    await cleanup();
  }
});

test('tailRuns: skips malformed lines silently', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const dir = join(root, 'runs');
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, '2026-W19.jsonl');
    const valid = JSON.stringify(fakeRecord({ request_id: 'good' }));
    await fs.writeFile(file, `garbage line\n${valid}\nanother{broken\n`);
    const tail = tailRuns({ stateRoot: root, count: 10 });
    assert.equal(tail.length, 1);
    assert.equal((tail[0] as RunRecord).request_id, 'good');
  } finally {
    await cleanup();
  }
});
