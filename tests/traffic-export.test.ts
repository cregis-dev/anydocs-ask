import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  iterateTrafficExportChunks,
  parseTrafficExportOptions,
  trafficExportFilename,
  type TrafficExportOptions,
} from '../src/console/traffic-export.ts';
import { RunsWriter } from '../src/runs/writer.ts';
import type { RunRecord } from '../src/runs/types.ts';

const NOW = Date.parse('2026-09-15T08:00:00Z');

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    ts: '2026-09-15T07:00:00Z',
    request_id: 'req-1',
    session_id: 'session-1',
    query: '=SUM(1,2) api_key=top-secret',
    filters: { scope: 'waas' },
    context_pageId: 'introduction',
    source: 'reader',
    runtime_build: {
      release: 'docs123456',
      engine_release: 'engine123456',
      built_at: '2026-09-15T06:00:00Z',
      release_url: 'https://example.com/commit/docs123456',
    },
    retrieval: {
      fused: [{
        chunk_id: 1,
        page: 'introduction',
        text_preview: 'Authorization: Bearer secret',
        rrf_score: 0.02,
        final_score: 0.02,
        vec_rank: 1,
        bm25_rank: null,
        nav_index: 1,
      }],
      subtree_ask_triggered: false,
      router_strategy: 'fast_path',
    },
    answer: {
      kind: 'answer',
      answer_id: 'answer-1',
      md: 'Use x-api-key: secret-value',
      citations: [{ chunk_id: 1, page: 'introduction', quote: 'api_key=secret' }],
      latency_ms: 1250,
      tokens_in: 100,
      tokens_out: 50,
      model: 'mock-model',
      error_code: null,
    },
    feedback: { beta: 'positive', gamma: null },
    ...overrides,
  };
}

async function withState(run: (stateRoot: string) => Promise<void>): Promise<void> {
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-traffic-export-'));
  try {
    await run(stateRoot);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
}

function options(overrides: Partial<TrafficExportOptions> = {}): TrafficExportOptions {
  return {
    range: 7,
    query: '',
    source: '',
    kind: '',
    format: 'csv',
    groupBy: 'run',
    includeContent: false,
    ...overrides,
  };
}

test('traffic export options default safely and reject unsupported values', () => {
  assert.deepEqual(parseTrafficExportOptions({}), { ok: true, value: options() });
  assert.deepEqual(parseTrafficExportOptions({ format: 'xml' }), {
    ok: false,
    error: 'format must be csv or jsonl',
  });
  assert.deepEqual(parseTrafficExportOptions({ groupBy: 'day' }), {
    ok: false,
    error: 'group_by must be run or session',
  });
});

test('CSV run export omits content by default and includes formula-safe redacted content on request', async () => {
  await withState(async (stateRoot) => {
    new RunsWriter({ stateRoot, enabled: true, now: () => new Date(NOW) }).append(record());
    const summary = [...iterateTrafficExportChunks({
      stateRoot,
      projectName: 'docs',
      options: options(),
      nowMs: NOW,
      exportedAt: '2026-09-15T08:00:00Z',
    })].join('');
    assert.match(summary, /^\uFEFFschema_version,/);
    assert.doesNotMatch(summary, /top-secret|secret-value|SUM\(1,2\)/);
    assert.match(summary, /docs123456/);

    const content = [...iterateTrafficExportChunks({
      stateRoot,
      projectName: 'docs',
      options: options({ includeContent: true }),
      nowMs: NOW,
      exportedAt: '2026-09-15T08:00:00Z',
    })].join('');
    assert.match(content, /query,answer/);
    assert.match(content, /'\=SUM\(1,2\) api_key=\[REDACTED\]/);
    assert.match(content, /x-api-key: \[REDACTED\]/);
    assert.doesNotMatch(content, /top-secret|secret-value/);
  });
});

test('JSONL session export keeps all in-range turns when any turn matches the filters', async () => {
  await withState(async (stateRoot) => {
    const writer = new RunsWriter({ stateRoot, enabled: true, now: () => new Date(NOW) });
    writer.append(record({ request_id: 'req-1', query: 'first turn', ts: '2026-09-15T06:00:00Z' }));
    writer.append(record({
      request_id: 'req-2',
      query: 'second turn failed',
      ts: '2026-09-15T07:00:00Z',
      answer: { ...record().answer, kind: 'error', md: null, error_code: 'llm_failed' },
    }));
    writer.append(record({ request_id: 'other', session_id: 'session-2', query: 'unrelated' }));

    const lines = [...iterateTrafficExportChunks({
      stateRoot,
      projectName: 'docs',
      options: options({ format: 'jsonl', groupBy: 'session', kind: 'error' }),
      nowMs: NOW,
      exportedAt: '2026-09-15T08:00:00Z',
    })].join('').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(lines[0]!.type, 'manifest');
    assert.equal(lines.length, 2);
    assert.equal(lines[1]!.type, 'session');
    assert.equal(lines[1]!.run_count, 2);
    assert.equal(lines[1]!.error_count, 1);
    assert.equal((lines[1]!.runs as unknown[]).length, 2);
    assert.doesNotMatch(JSON.stringify(lines[1]), /first turn|second turn failed/);
  });
});

test('traffic export filename is stable and filesystem-safe', () => {
  assert.equal(
    trafficExportFilename('docs / prod', options({ format: 'jsonl', groupBy: 'session' }), '2026-09-15T08:12:13.000Z'),
    'docs-prod-traffic-7d-session-20260915T081213Z.jsonl',
  );
});
