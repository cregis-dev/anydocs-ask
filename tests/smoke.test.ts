/**
 * Stage 7 server tests — drives the Hono app via app.request() against a
 * Runtime backed by mock embedder + mock LLM + in-memory SQLite + a real
 * tmp project on disk (so the indexer + structure layer get exercised).
 *
 * Coverage:
 *   - /v1/health 503 before start, 200 after
 *   - /v1/ask happy path + invalid_scope
 *   - /v1/ask/feedback writes a feedback row, joins back via answer_id
 *   - /v1/index/status counts match DB
 *   - /v1/index/rebuild runs without errors
 *   - 503 short-circuit on /v1/ask while warming
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { Runtime } from '../src/server/runtime.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';

async function buildProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-srv-'));
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

async function makeRuntime(): Promise<{
  runtime: Runtime;
  cleanup: () => Promise<void>;
  projectRoot: string;
  stateRoot: string;
}> {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-smoke-state-'));
  const { config } = await loadConfig(root);
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

// ---------------------------------------------------------------------------
// Health & warm-up gating
// ---------------------------------------------------------------------------

test('GET /v1/health returns 503 before start(), 200 after', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    const app = createApp({ runtime });

    const cold = await app.request('/v1/health');
    assert.equal(cold.status, 503);
    const coldBody = (await cold.json()) as { warm: boolean; status: string };
    assert.equal(coldBody.warm, false);
    assert.equal(coldBody.status, 'warming');

    await runtime.start();

    const warm = await app.request('/v1/health');
    assert.equal(warm.status, 200);
    const warmBody = (await warm.json()) as { warm: boolean; status: string };
    assert.equal(warmBody.warm, true);
    assert.equal(warmBody.status, 'ok');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask returns 503 while warming', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '鉴权' }),
    });
    assert.equal(res.status, 503);
  } finally {
    await cleanup();
  }
});

test('unknown route returns 404 with structured error', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/does-not-exist');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { type: string; code: string };
    assert.equal(body.type, 'error');
    assert.equal(body.code, 'not_found');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// /v1/ask
// ---------------------------------------------------------------------------

test('POST /v1/ask happy path returns 200 with citations + persists answer', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      type: string;
      answer_id: string;
      citations: unknown[];
      answer_lang: string;
    };
    assert.equal(body.type, 'answer');
    assert.equal(body.answer_lang, 'zh');
    assert.ok(body.citations.length > 0);

    // Audit row exists for feedback to join back.
    const stored = runtime.db
      .prepare(`SELECT 1 AS hit FROM answers WHERE answer_id = ?`)
      .get(body.answer_id);
    assert.ok(stored, 'answers row must be persisted');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask malformed JSON returns 400 invalid_request', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'invalid_request');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask invalid_scope returns 400 with the structured error', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '鉴权', context: { scope_id: 'bogus' } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'invalid_scope');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// /v1/ask/feedback
// ---------------------------------------------------------------------------

test('POST /v1/ask/feedback inserts a feedback row keyed by answer_id', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const askRes = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    const askBody = (await askRes.json()) as { answer_id: string };

    const fbRes = await app.request('/v1/ask/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer_id: askBody.answer_id,
        rating: -1,
        correction: '其实是 session cookie',
        bad_citation_ids: ['cit_2'],
        tags: ['wrong-fact'],
      }),
    });
    assert.equal(fbRes.status, 200);

    const row = runtime.db
      .prepare(`SELECT rating, correction, bad_citation_ids, tags FROM feedback WHERE answer_id = ?`)
      .get(askBody.answer_id) as
      | { rating: number; correction: string; bad_citation_ids: string; tags: string }
      | undefined;
    assert.ok(row, 'feedback row must be inserted');
    assert.equal(row!.rating, -1);
    assert.equal(row!.correction, '其实是 session cookie');
    assert.deepEqual(JSON.parse(row!.bad_citation_ids), ['cit_2']);
    assert.deepEqual(JSON.parse(row!.tags), ['wrong-fact']);
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask/feedback without answer_id returns 400', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 1 }),
    });
    assert.equal(res.status, 400);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// /v1/index/status & /v1/index/rebuild
// ---------------------------------------------------------------------------

test('GET /v1/index/status returns DB counts + config models', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const res = await app.request('/v1/index/status');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      page_count: number;
      chunk_count: number;
      embedding_model: string;
      llm_model: string;
      warm: boolean;
    };
    assert.equal(body.page_count, 1);
    assert.ok(body.chunk_count > 0);
    assert.equal(body.embedding_model, 'bge-m3');
    assert.equal(body.warm, true);
  } finally {
    await cleanup();
  }
});

test('POST /v1/index/rebuild reruns fullReindex with cache hits', async () => {
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const res = await app.request('/v1/index/rebuild', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      stats: { embed: { hits: number; misses: number } };
    };
    assert.equal(body.ok, true);
    // Second pass over same content -> all hashes match -> 0 misses.
    assert.equal(body.stats.embed.misses, 0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// CORS dev mode
// ---------------------------------------------------------------------------

test('CORS dev mode (NODE_ENV != production) allows localhost origins by default', async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const { runtime, cleanup } = await makeRuntime();
  try {
    await runtime.start();
    const app = createApp({ runtime });
    const res = await app.request('/v1/health', {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
  } finally {
    process.env.NODE_ENV = prevEnv;
    await cleanup();
  }
});
