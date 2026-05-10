/**
 * /v1/ask runs jsonl integration — verifies that the server appends one
 * record per call with the right shape, including for clarify / error
 * outcomes, and that runs.enabled=false short-circuits the writer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { Runtime } from '../src/server/runtime.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { RunRecord } from '../src/runs/types.ts';

async function buildProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-runs-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.writeFile(
    join(root, 'navigation', 'zh.json'),
    JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'auth' }] }),
  );
  await fs.writeFile(
    join(root, 'pages', 'zh', 'auth.json'),
    JSON.stringify({
      id: 'auth',
      lang: 'zh',
      slug: 'auth',
      title: '鉴权',
      status: 'published',
      content: {
        version: 1,
        blocks: [
          { type: 'heading', id: 'h1', level: 1, children: [{ type: 'text', text: '鉴权' }] },
          { type: 'paragraph', id: 'p1', children: [{ type: 'text', text: '使用 JWT bearer token 完成鉴权。' }] },
        ],
      },
    }),
  );
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function setup(opts: { runsEnabled: boolean }): Promise<{
  runtime: Runtime;
  cleanup: () => Promise<void>;
  projectRoot: string;
  stateRoot: string;
}> {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-state-'));
  const { config } = await loadConfig(root);
  config.runs.enabled = opts.runsEnabled;
  const db = openDatabase({ dbPath: ':memory:' });
  const runtime = new Runtime({
    projectRoot: root,
    stateRoot,
    config,
    db,
    embedder: new MockEmbedder(),
    llm: new MockLLM({ model: 'mock-llm' }),
    skipWatcher: true,
  });
  await runtime.start();
  return {
    runtime,
    projectRoot: root,
    stateRoot,
    cleanup: async () => {
      await runtime.stop();
      await rmTmp();
      await fs.rm(stateRoot, { recursive: true, force: true });
    },
  };
}

function findRunsFile(stateRoot: string): string | null {
  const dir = join(stateRoot, 'runs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-W\d{2}\.jsonl$/.test(f));
  return files[0] ? join(dir, files[0]) : null;
}

test('/v1/ask happy path appends one RunRecord with retrieval trace + answer fields', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 200);

    const file = findRunsFile(stateRoot);
    assert.ok(file, 'expected a runs file under runs/');
    const lines = readFileSync(file!, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);

    const r = JSON.parse(lines[0]!) as RunRecord;
    assert.equal(r.answer.kind, 'answer');
    assert.equal(r.query, '如何鉴权？');
    assert.equal(r.answer.model, 'mock-llm');
    assert.ok(r.answer.latency_ms >= 0);
    assert.equal(typeof r.answer.confidence, 'number');
    assert.equal(r.answer.tokens_in, null);
    assert.equal(r.answer.tokens_out, null);
    assert.equal(r.feedback.beta, null);
    assert.equal(r.retrieval.subtree_ask_triggered, false);
    assert.ok(Array.isArray(r.retrieval.fused));
    // request_id is uuid-shaped
    assert.match(r.request_id, /^[0-9a-f-]{36}$/i);
  } finally {
    await cleanup();
  }
});

test('/v1/ask invalid_scope appends one RunRecord with kind=error', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '鉴权', context: { scope_id: 'bogus' } }),
    });
    assert.equal(res.status, 400);

    const file = findRunsFile(stateRoot);
    assert.ok(file);
    const r = JSON.parse(readFileSync(file!, 'utf8').trim()) as RunRecord;
    assert.equal(r.answer.kind, 'error');
    assert.equal(r.answer.error_code, 'invalid_scope');
    assert.equal(r.answer.model, null);
    assert.deepEqual(r.retrieval.fused, []);
  } finally {
    await cleanup();
  }
});

test('runs.enabled=false: /v1/ask does NOT create the runs/ directory', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: false });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 200);
    assert.equal(existsSync(join(stateRoot, 'runs')), false);
  } finally {
    await cleanup();
  }
});

test('two /v1/ask calls produce two lines in the same week file', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    for (const q of ['Q1', 'Q2']) {
      await app.request('/v1/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
    }
    const file = findRunsFile(stateRoot);
    assert.ok(file);
    const lines = readFileSync(file!, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const queries = lines.map((l) => (JSON.parse(l) as RunRecord).query);
    assert.deepEqual(queries, ['Q1', 'Q2']);
  } finally {
    await cleanup();
  }
});

test('/v1/ask?dry_run=1: response carries _dry_run, runs/ never created', async () => {
  // ARCH §17.3.3: dev console default. Skips RunsWriter + answer-cache.
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; _dry_run?: boolean };
    assert.equal(body.type, 'answer');
    assert.equal(body._dry_run, true);

    // No runs file — RunsWriter was never invoked, so the dir isn't created.
    assert.equal(existsSync(join(stateRoot, 'runs')), false);
  } finally {
    await cleanup();
  }
});

test('/v1/ask?dry_run=1: error response also carries _dry_run, no runs', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '鉴权', context: { scope_id: 'bogus' } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { type: string; code?: string; _dry_run?: boolean };
    assert.equal(body.type, 'error');
    assert.equal(body.code, 'invalid_scope');
    assert.equal(body._dry_run, true);
    assert.equal(existsSync(join(stateRoot, 'runs')), false);
  } finally {
    await cleanup();
  }
});

test('/v1/ask without dry_run still appends; mixing dry+real keeps only the real one', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    // dry-run: must not write
    await app.request('/v1/ask?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'dry-Q' }),
    });
    // real: must write
    await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'real-Q' }),
    });
    const file = findRunsFile(stateRoot);
    assert.ok(file);
    const lines = readFileSync(file!, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]!) as RunRecord).query, 'real-Q');
  } finally {
    await cleanup();
  }
});

test('/v1/ask without source: writes source=reader (default)', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q1' }),
    });
    const file = findRunsFile(stateRoot);
    assert.ok(file);
    const lines = readFileSync(file!, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[0]!) as RunRecord;
    assert.equal(rec.source, 'reader');
  } finally {
    await cleanup();
  }
});

test('/v1/ask?source=console: writes source=console (ARCH §17.8 persist path)', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    await app.request('/v1/ask?source=console', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'console-Q' }),
    });
    const file = findRunsFile(stateRoot);
    assert.ok(file);
    const lines = readFileSync(file!, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[0]!) as RunRecord;
    assert.equal(rec.source, 'console');
    assert.equal(rec.query, 'console-Q');
  } finally {
    await cleanup();
  }
});

test('/v1/ask?dry_run=1&source=console: dry_run wins, no run is written', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask?dry_run=1&source=console', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q' }),
    });
    const body = (await res.json()) as { _dry_run?: boolean };
    assert.equal(body._dry_run, true);
    assert.equal(existsSync(join(stateRoot, 'runs')), false);
  } finally {
    await cleanup();
  }
});

test('/v1/ask?source=garbage: 400 invalid_request', async () => {
  const { runtime, cleanup } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask?source=tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'invalid_request');
    assert.match(body.message, /unknown source/);
  } finally {
    await cleanup();
  }
});

test('/v1/ask?dry_run=0 (or absent value) is NOT treated as dry-run', async () => {
  // We accept exactly '1'; everything else is a regular call.
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask?dry_run=0', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { _dry_run?: boolean };
    assert.equal(body._dry_run, undefined);
    const file = findRunsFile(stateRoot);
    assert.ok(file, 'expected runs file');
  } finally {
    await cleanup();
  }
});
