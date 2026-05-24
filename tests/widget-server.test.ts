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

test('GET /widget/chat — enabled returns HTML page with SSE + β feedback + history (alpha.2b)', async () => {
  const { runtime, cleanup } = await setup(true);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/widget/chat');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Chat page UI scaffolding.
    assert.match(body, /<textarea id="q"/);
    assert.match(body, /<button[^>]+id="send"/);
    // alpha.2b: streams from /v1/ask/stream (NOT /v1/ask non-stream).
    assert.match(body, /'\/v1\/ask\/stream'/);
    // alpha.2b: NOT sending X-Project-Key (gate is for direct cross-origin
    // mode; iframe self-traffic is same-origin and would 403 otherwise).
    assert.doesNotMatch(body, /'X-Project-Key'/);
    // SSE frame parser present.
    assert.match(body, /function parseSseFrame/);
    assert.match(body, /event === 'delta'/);
    assert.match(body, /event === 'result'/);
    // β feedback bar rendered + POSTs to /v1/ask/feedback.
    assert.match(body, /function appendFeedbackBar/);
    assert.match(body, /'\/v1\/ask\/feedback'/);
    assert.match(body, /👍 helpful/);
    assert.match(body, /👎 not helpful/);
    assert.match(body, /answered wrong/);
    // History persistence uses widget-namespaced key (NOT Reader's namespace).
    assert.match(body, /anydocs-ask:widget:history:v1/);
    assert.doesNotMatch(body, /'anydocs-ask:history:v1'/); // Reader key
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

// ---------------------------------------------------------------------------
// alpha.2 W4 — widget gate e2e
// ---------------------------------------------------------------------------

async function setupWithAllowed(origin: string) {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-widget-state-'));
  const { config } = await loadConfig(root);
  config.runs.enabled = false;
  config.widget.enabled = true;
  config.widget.allowedOrigins = [origin];
  // Generous default for the happy-path test; the rate-limit test uses
  // a smaller config inline.
  config.widget.rateLimitPerMinute = 60;
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

test('POST /v1/ask with X-Project-Key + allowed Origin → 200 (widget happy path)', async () => {
  const origin = 'https://app.example.com';
  const { runtime, cleanup } = await setupWithAllowed(origin);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': 'pk_test_1',
        Origin: origin,
      },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 200);
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask with X-Project-Key but disallowed Origin → 403 origin_not_allowed', async () => {
  const { runtime, cleanup } = await setupWithAllowed('https://app.example.com');
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': 'pk_test_1',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'origin_not_allowed');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask with X-Project-Key empty → 400 invalid_project_key', async () => {
  const origin = 'https://app.example.com';
  const { runtime, cleanup } = await setupWithAllowed(origin);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': '',
        Origin: origin,
      },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'invalid_project_key');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask without X-Project-Key bypasses widget gate (Reader / Console unchanged)', async () => {
  // alpha.0 promise: no X-Project-Key = no gate. Even disallowed Origin
  // here is fine because the regular CORS layer would have rejected it
  // at preflight if it were truly a browser call.
  const { runtime, cleanup } = await setupWithAllowed('https://app.example.com');
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 200, 'non-widget path is untouched');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask widget calls share a rate limiter — second call beyond cap → 429', async () => {
  const origin = 'https://app.example.com';
  const { runtime, cleanup } = await setupWithAllowed(origin);
  try {
    // Tighten to 1/min so the second call exhausts. Setting the config in
    // place is fine because the gate reads it per-request.
    runtime.config.widget.rateLimitPerMinute = 1;
    const app = createApp({ runtime });
    const headers = {
      'Content-Type': 'application/json',
      'X-Project-Key': 'pk_test_1',
      Origin: origin,
    };
    const body = JSON.stringify({ question: 'q' });
    const first = await app.request('/v1/ask', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    const second = await app.request('/v1/ask', { method: 'POST', headers, body });
    assert.equal(second.status, 429);
    const parsed = (await second.json()) as { code: string };
    assert.equal(parsed.code, 'rate_limited');
  } finally {
    await cleanup();
  }
});

test('OPTIONS /v1/ask widget preflight allows X-Project-Key + the widget Origin', async () => {
  // Browsers send an OPTIONS preflight when a cross-origin POST carries
  // non-simple headers (X-Project-Key is non-simple). The CORS layer must
  // reflect the widget origin + advertise the custom header.
  const origin = 'https://app.example.com';
  const { runtime, cleanup } = await setupWithAllowed(origin);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'X-Project-Key, Content-Type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    assert.match(allowHeaders, /x-project-key/);
  } finally {
    await cleanup();
  }
});

test('widget.enabled=false plus X-Project-Key → 404 widget_disabled on /v1/ask too', async () => {
  // Belt-and-braces: even if a sneak header gets past CORS, the gate
  // returns the same 404 widget_disabled the static endpoints serve.
  const { runtime, cleanup } = await setup(false);
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': 'pk_x',
        Origin: 'https://app.example.com',
      },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'widget_disabled');
  } finally {
    await cleanup();
  }
});
