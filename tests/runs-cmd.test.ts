/**
 * `anydocs-ask runs tail|export` command tests — exercise parseSince and the
 * CSV/jsonl output paths against a hand-rolled runs/ dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSince, runRunsExport, runRunsTail } from '../src/commands/runs.ts';
import type { RunRecord } from '../src/runs/types.ts';

async function withTmpProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-runs-cmd-'));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function rec(overrides: Partial<RunRecord> = {}): RunRecord {
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

async function seedRuns(root: string, recs: RunRecord[], file = '2026-W19.jsonl'): Promise<void> {
  const dir = join(root, 'runs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, file), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function captureStdout<T>(fn: () => T): { value: T; out: string; err: string } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = fn();
    return { value, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test('parseSince: 7d / 48h / 30m duration forms', () => {
  const t0 = Date.now();
  const sevenD = parseSince('7d')!;
  assert.ok(sevenD < t0 && sevenD >= t0 - 7 * 86_400_000 - 1000);
  const fortyEightH = parseSince('48h')!;
  assert.ok(fortyEightH < t0 && fortyEightH >= t0 - 48 * 3_600_000 - 1000);
  const thirtyM = parseSince('30m')!;
  assert.ok(thirtyM < t0 && thirtyM >= t0 - 30 * 60_000 - 1000);
});

test('parseSince: ISO date and ISO datetime', () => {
  const date = parseSince('2026-04-01');
  assert.ok(date !== null);
  assert.equal(new Date(date!).toISOString(), '2026-04-01T00:00:00.000Z');
  const dt = parseSince('2026-04-01T12:34:56Z');
  assert.equal(new Date(dt!).toISOString(), '2026-04-01T12:34:56.000Z');
});

test('parseSince: rejects nonsense and zero/negative durations', () => {
  assert.equal(parseSince('hello'), null);
  assert.equal(parseSince('0d'), null);
  assert.equal(parseSince('-7d'), null);
  assert.equal(parseSince('7'), null); // missing unit
});

test('runs tail: prints "(no runs in latest week file)" for empty file', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    await seedRuns(root, []);
    const { value, out } = captureStdout(() => runRunsTail({ projectRoot: root, stateRoot: root, count: 50 }));
    assert.equal(value, 0);
    assert.match(out, /no runs in latest week file/);
  } finally {
    await cleanup();
  }
});

test('runs tail: returns 1 with stderr hint when runs/ dir missing', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const { value, err } = captureStdout(() => runRunsTail({ projectRoot: root, stateRoot: root, count: 10 }));
    assert.equal(value, 1);
    assert.match(err, /no runs at/);
  } finally {
    await cleanup();
  }
});

test('runs tail: prints last N records', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const recs = [
      rec({ request_id: 'a' }),
      rec({ request_id: 'b' }),
      rec({ request_id: 'c' }),
    ];
    await seedRuns(root, recs);
    const { out } = captureStdout(() => runRunsTail({ projectRoot: root, stateRoot: root, count: 2 }));
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /JWT/);
  } finally {
    await cleanup();
  }
});

test('runs export: jsonl format includes only since-window records', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    await seedRuns(root, [
      rec({ ts: '2026-04-01T00:00:00Z', request_id: 'old' }),
      rec({ ts: '2026-05-08T00:00:00Z', request_id: 'mid' }),
    ]);
    const { value, out } = captureStdout(() =>
      runRunsExport({ projectRoot: root, stateRoot: root, since: '2026-05-01', format: 'jsonl' }),
    );
    assert.equal(value, 0);
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as RunRecord;
    assert.equal(parsed.request_id, 'mid');
  } finally {
    await cleanup();
  }
});

test('runs export: csv format includes header + escaped fields', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    await seedRuns(root, [rec({ query: 'has, comma' })]);
    const { value, out } = captureStdout(() =>
      runRunsExport({ projectRoot: root, stateRoot: root, since: '2026-01-01', format: 'csv' }),
    );
    assert.equal(value, 0);
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^ts,request_id,kind,confidence,latency_ms,model,query$/);
    assert.match(lines[1]!, /"has, comma"$/);
  } finally {
    await cleanup();
  }
});

test('runs export: bad --since returns 2 with hint', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    await seedRuns(root, [rec()]);
    const { value, err } = captureStdout(() =>
      runRunsExport({ projectRoot: root, stateRoot: root, since: 'banana', format: 'jsonl' }),
    );
    assert.equal(value, 2);
    assert.match(err, /invalid --since/);
  } finally {
    await cleanup();
  }
});
