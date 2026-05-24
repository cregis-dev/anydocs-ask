/**
 * RFC 0004 W3 alpha.1 — Widget endpoint e2e tests.
 *
 * Boots an in-memory Runtime + Hono app, exercises:
 *   - widget.enabled gating (default false → both endpoints 404)
 *   - GET /widget/v1.js content shape (IIFE + protocol stamping)
 *   - GET /widget/chat content shape (HTML page with the chat iframe UI)
 *   - alpha.0 alignment promise: nothing else changes on the request path
 *     when widget is enabled / disabled
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
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-widget-srv-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.writeFile(
    join(root, 'navigation', 'zh.json'),
    JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'p' }] }),
  );
  await fs.writeFile(
    join(root, 'pages', 'zh', 'p.json'),
    JSON.stringify({
      id: 'p',
      lang: 'zh',
      slug: 'p',
      title: '页面',
      status: 'published',
      content: {
        version: 1,
        blocks: [
          { type: 'heading', id: 'h1', level: 1, children: [{ type: 'text', text: '页面' }] },
        ],
      },
    }),
  );
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function setup(widgetEnabled: boolean) {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-widget-state-'));
  const { config } = await loadConfig(root);
  config.runs.enabled = false;
  if (widgetEnabled) config.widget.enabled = true;
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
    cleanup: async () => {
      await runtime.stop();
      await rmTmp();
      await fs.rm(stateRoot, { recursive: true, force: true });
    },
  };
}

test('GET /widget/v1.js — disabled by default → 404 widget_disabled', async () => {
  const { runtime, cleanup } = await setup(false);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/widget/v1.js');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'widget_disabled');
  } finally {
    await cleanup();
  }
});

test('GET /widget/chat — disabled by default → 404 widget_disabled', async () => {
  const { runtime, cleanup } = await setup(false);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/widget/chat');
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('GET /widget/v1.js — enabled returns JS bundle with protocol stamping', async () => {
  const { runtime, cleanup } = await setup(true);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/widget/v1.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/javascript/);
    const body = await res.text();
    // Bundle is an IIFE that installs window.anydocsAsk with the W1 shape.
    assert.match(body, /anydocsAsk/);
    assert.match(body, /protocol: PROTOCOL/);
    assert.match(body, /version: VERSION/);
    assert.match(body, /init: init/);
    // Bubble + iframe styling must be inlined (no external CSS needed).
    assert.match(body, /data-anydocs-widget-bubble/);
    assert.match(body, /data-anydocs-widget-frame/);
  } finally {
    await cleanup();
  }
});

test('GET /widget/chat — enabled returns HTML page wired for postMessage + /v1/ask', async () => {
  const { runtime, cleanup } = await setup(true);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/widget/chat');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Chat page UI scaffolding.
    assert.match(body, /<textarea id="q"/);
    assert.match(body, /<button[^>]+id="send"/);
    // Sends POST /v1/ask with X-Project-Key header.
    assert.match(body, /'\/v1\/ask'/);
    assert.match(body, /'X-Project-Key'/);
    // Emits envelope-stamped messages back to parent.
    assert.match(body, /protocol: PROTOCOL, version: VERSION/);
    // Reads URL params (projectKey + contextSources).
    assert.match(body, /params\.get\('projectKey'\)/);
    assert.match(body, /params\.get\('contextSources'\)/);
  } finally {
    await cleanup();
  }
});

test('Widget endpoints do not leak through /v1/ask routing — POST /widget/v1.js → 404', async () => {
  // Sanity: only the GET on /widget/* paths is exposed. Other methods 404.
  const { runtime, cleanup } = await setup(true);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/widget/v1.js', { method: 'POST' });
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('renderWidgetHostScript: defaultBaseUrl is stringified safely', async () => {
  // Pin: any operator-supplied baseUrl is JSON-encoded into the bundle, so
  // a quote in the URL can't break out of the string literal.
  const { renderWidgetHostScript } = await import('../src/widget/host-sdk.ts');
  const malicious = 'https://evil.example/"\\;alert(1)//';
  const js = renderWidgetHostScript({ defaultBaseUrl: malicious });
  // The literal must round-trip through JSON.parse without yielding control.
  const match = /var DEFAULT_BASE_URL = (".*?");/.exec(js);
  assert.ok(match, 'expected a DEFAULT_BASE_URL literal');
  assert.equal(JSON.parse(match[1]!), malicious);
});
