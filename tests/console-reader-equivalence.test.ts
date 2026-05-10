/**
 * PRD §13.7 acceptance criterion 8: console Ask 体验台 should return the
 * same fused / answer / citations as a direct Reader hit, modulo the
 * `_dry_run: true` field.
 *
 * Strategy: boot a real Runtime + ask Hono app, hit /v1/ask twice on the
 * same query — once direct (no dry_run), once with ?dry_run=1 — and
 * assert the response bodies are identical after stripping _dry_run.
 *
 * This test does NOT involve the console process or reverse proxy — the
 * proxy is a verbatim relay tested elsewhere; equivalence is a property
 * of the dry_run code path itself.
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
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-equiv-'));
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
          {
            type: 'paragraph',
            id: 'p1',
            children: [{ type: 'text', text: '使用 JWT bearer token 完成鉴权。' }],
          },
        ],
      },
    }),
  );
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function setup(): Promise<{
  runtime: Runtime;
  cleanup: () => Promise<void>;
  stateRoot: string;
}> {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-equiv-state-'));
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
  await runtime.start();
  return {
    runtime,
    stateRoot,
    cleanup: async () => {
      await runtime.stop();
      await rmTmp();
      await fs.rm(stateRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Strip fields that are inherently call-specific (timestamps, ids, latency)
 * before comparing. These are deterministic only within a single call,
 * not across two requests sent in sequence.
 */
function normalize(body: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  // Drop fields that are intrinsically per-call (not deterministic across
  // two requests issued in sequence): the dry_run marker, the per-call
  // answer id, and timing.
  delete clone._dry_run;
  delete clone.answer_id;
  delete clone.latency_ms;
  return clone;
}

test('PRD §13.7 #8: dry_run response = direct response (modulo _dry_run/answer_id)', async () => {
  const { runtime, cleanup } = await setup();
  try {
    const app = createApp({ runtime });
    const directRes = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(directRes.status, 200);
    const directBody = (await directRes.json()) as Record<string, unknown>;

    const dryRes = await app.request('/v1/ask?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(dryRes.status, 200);
    const dryBody = (await dryRes.json()) as Record<string, unknown>;

    // dry_run carries the marker
    assert.equal(dryBody._dry_run, true);
    assert.equal(directBody._dry_run, undefined);

    // After normalization, the two should be逐字段一致
    assert.deepEqual(normalize(dryBody), normalize(directBody));
  } finally {
    await cleanup();
  }
});

test('PRD §13.7 #8: dry_run preserves citations + retrieval ordering', async () => {
  const { runtime, cleanup } = await setup();
  try {
    const app = createApp({ runtime });
    const direct = (await (
      await app.request('/v1/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: '如何鉴权？' }),
      })
    ).json()) as { citations: Array<{ page_id: string; chunk_id: number }> };
    const dry = (await (
      await app.request('/v1/ask?dry_run=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: '如何鉴权？' }),
      })
    ).json()) as { citations: Array<{ page_id: string; chunk_id: number }> };

    // Same number of citations, same pages in the same order
    assert.equal(dry.citations.length, direct.citations.length);
    for (let i = 0; i < direct.citations.length; i++) {
      assert.equal(dry.citations[i]!.page_id, direct.citations[i]!.page_id);
      assert.equal(dry.citations[i]!.chunk_id, direct.citations[i]!.chunk_id);
    }
  } finally {
    await cleanup();
  }
});
