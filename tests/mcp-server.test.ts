/**
 * RFC 0007 — MCP endpoint e2e tests.
 *
 * Boots an in-memory Runtime + Hono app and drives `POST /mcp` with raw
 * JSON-RPC (stateless Streamable HTTP, JSON responses), exercising:
 *   - mcp.enabled gating (default off → 404)
 *   - Accept-header negotiation (406 when text/event-stream missing)
 *   - tools/list reflects config.mcp.tools
 *   - tools/call search → grounded hits (LLM-free)
 *   - tools/call ask → synthesized answer (MockLLM)
 *   - tools/call fetch_page → reconstructed page text
 *   - warm-up gate (503 before the index is ready)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { Runtime } from '../src/server/runtime.ts';
import { loadConfig } from '../src/config.ts';
import type { McpToolName } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { loadTrafficWindow } from '../src/console/traffic-state.ts';

async function buildProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-mcp-srv-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'en'), { recursive: true });
  await fs.writeFile(
    join(root, 'navigation', 'zh.json'),
    JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'p' }] }),
  );
  await fs.writeFile(
    join(root, 'navigation', 'en.json'),
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
      url: '/zh/p',
      content: {
        version: 1,
        blocks: [
          { type: 'heading', id: 'h1', level: 1, children: [{ type: 'text', text: '鉴权' }] },
          {
            type: 'paragraph',
            id: 'p1',
            children: [{ type: 'text', text: '使用 JWT bearer token 完成 API 鉴权。' }],
          },
        ],
      },
    }),
  );
  await fs.writeFile(
    join(root, 'pages', 'en', 'p.json'),
    JSON.stringify({
      id: 'p',
      lang: 'en',
      slug: 'p',
      title: 'Authentication',
      status: 'published',
      url: '/en/p',
      content: {
        version: 1,
        blocks: [
          { type: 'heading', id: 'h1', level: 1, children: [{ type: 'text', text: 'Authentication' }] },
          {
            type: 'paragraph',
            id: 'p1',
            children: [{ type: 'text', text: 'Use a JWT bearer token to authenticate API calls.' }],
          },
        ],
      },
    }),
  );
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

type SetupOpts = { enabled?: boolean; tools?: McpToolName[]; start?: boolean; runs?: boolean };

async function setup(opts: SetupOpts = {}) {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-mcp-state-'));
  const { config } = await loadConfig(root);
  config.runs.enabled = opts.runs ?? false;
  config.mcp.enabled = opts.enabled ?? true;
  if (opts.tools) config.mcp.tools = opts.tools;
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
  if (opts.start ?? true) await runtime.start();
  return {
    runtime,
    stateRoot,
    app: createApp({ runtime }),
    cleanup: async () => {
      await runtime.stop();
      await rmTmp();
      await fs.rm(stateRoot, { recursive: true, force: true });
    },
  };
}

const ACCEPT = 'application/json, text/event-stream';

async function rpc(
  app: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body (e.g. 406 text) */
  }
  return { status: res.status, json };
}

function toolCall(name: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

test('mcp: disabled by default → POST /mcp returns 404 mcp_disabled', async () => {
  const { app, cleanup } = await setup({ enabled: false });
  try {
    const { status, json } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(status, 404);
    assert.equal(json.error.message, 'mcp_disabled');
  } finally {
    await cleanup();
  }
});

test('mcp: missing text/event-stream in Accept → 406', async () => {
  const { app, cleanup } = await setup({ enabled: true });
  try {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 406);
  } finally {
    await cleanup();
  }
});

test('mcp: tools/list reflects config.mcp.tools', async () => {
  const { app, cleanup } = await setup({ tools: ['search', 'ask', 'fetch_page'] });
  try {
    const { status, json } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(status, 200);
    const names = (json.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    // `health` is a contract tool (ADR-038 §2): always present, independent of
    // config.mcp.tools. Filter it out to assert the configured feature set.
    assert.ok(names.includes('health'), 'health contract tool must always be present');
    assert.deepEqual(
      names.filter((n) => n !== 'health'),
      ['ask', 'fetch_page', 'search'],
    );
  } finally {
    await cleanup();
  }
});

test('mcp: tools/list omits disabled tools (search-only)', async () => {
  const { app, cleanup } = await setup({ tools: ['search'] });
  try {
    const { json } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (json.result.tools as Array<{ name: string }>).map((t) => t.name);
    // `health` (contract tool) is always present alongside the configured set.
    assert.deepEqual(names.filter((n) => n !== 'health').sort(), ['search']);
    assert.ok(names.includes('health'));
  } finally {
    await cleanup();
  }
});

test('mcp: tools/call health returns ok (contract tool, always present)', async () => {
  const { app, cleanup } = await setup({ tools: ['search'] });
  try {
    const { status, json } = await rpc(app, toolCall('health', {}));
    assert.equal(status, 200);
    assert.notEqual(json.result.isError, true);
    const body = JSON.parse((json.result.content as Array<{ text: string }>)[0]!.text);
    assert.equal(body.ok, true);
  } finally {
    await cleanup();
  }
});

test('mcp: tools/call search returns grounded hits', async () => {
  const { app, cleanup } = await setup();
  try {
    const { status, json } = await rpc(app, toolCall('search', { query: 'JWT bearer token 鉴权' }));
    assert.equal(status, 200);
    assert.notEqual(json.result.isError, true);
    const payload = JSON.parse(json.result.content[0].text);
    assert.ok(payload.count >= 1, `expected ≥1 hit, got ${payload.count}`);
    assert.equal(payload.hits[0].page_id, 'p');
    // page_id is shared across languages; the hit carries its own lang + URL.
    assert.match(payload.hits[0].url, /^\/(en|zh)\/p$/);
    assert.match(payload.hits[0].lang, /^(en|zh)$/);
  } finally {
    await cleanup();
  }
});

test('mcp: search rejects bad scope_id with a tool error', async () => {
  const { app, cleanup } = await setup();
  try {
    const { json } = await rpc(app, toolCall('search', { query: 'x', scope_id: 'does-not-exist' }));
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /invalid_scope/);
  } finally {
    await cleanup();
  }
});

test('mcp: ask writes a runs record tagged source=mcp (Studio Traffic)', async () => {
  const { app, stateRoot, cleanup } = await setup({ runs: true });
  try {
    const { status } = await rpc(app, toolCall('ask', { question: '如何鉴权？' }));
    assert.equal(status, 200);
    const win = loadTrafficWindow(stateRoot, 7);
    assert.equal(win.totals.countMcp, 1, 'expected one mcp-sourced run');
    assert.equal(win.totals.countReader, 0);
    assert.equal(win.totals.countConsole, 0);
    const mcpRows = win.records.filter((r) => r.source === 'mcp');
    assert.equal(mcpRows.length, 1);
    assert.equal(mcpRows[0]!.query, '如何鉴权？');
    assert.equal(mcpRows[0]!.session_id, null); // stateless → no session
  } finally {
    await cleanup();
  }
});

test('mcp: search does NOT write a run (LLM-free retrieval, not a Q&A turn)', async () => {
  const { app, stateRoot, cleanup } = await setup({ runs: true, tools: ['search'] });
  try {
    await rpc(app, toolCall('search', { query: 'JWT bearer token' }));
    const win = loadTrafficWindow(stateRoot, 7);
    assert.equal(win.totals.count, 0, 'search must not produce runs');
  } finally {
    await cleanup();
  }
});

test('mcp: tools/call ask returns a synthesized answer', async () => {
  const { app, cleanup } = await setup();
  try {
    const { status, json } = await rpc(app, toolCall('ask', { question: '如何鉴权？' }));
    assert.equal(status, 200);
    assert.notEqual(json.result.isError, true);
    const txt = json.result.content[0].text as string;
    assert.ok(txt.length > 0);
  } finally {
    await cleanup();
  }
});

test('mcp: tools/call fetch_page reconstructs page text in the requested lang', async () => {
  const { app, cleanup } = await setup({ tools: ['search', 'fetch_page'] });
  try {
    const { status, json } = await rpc(app, toolCall('fetch_page', { page_id: 'p', lang: 'zh' }));
    assert.equal(status, 200);
    assert.notEqual(json.result.isError, true);
    const txt = json.result.content[0].text as string;
    assert.match(txt, /# 鉴权/);
    assert.match(txt, /JWT bearer token/);
    assert.match(txt, /Language: zh/);
    // Surfaces the other published language so the agent can switch.
    assert.match(txt, /Also available in: en/);
  } finally {
    await cleanup();
  }
});

test('mcp: fetch_page without lang returns a deterministic default + lists alternatives', async () => {
  const { app, cleanup } = await setup({ tools: ['fetch_page'] });
  try {
    const { json } = await rpc(app, toolCall('fetch_page', { page_id: 'p' }));
    const txt = json.result.content[0].text as string;
    // Default is the first language in sorted order ('en' < 'zh'), regardless
    // of SQLite row order — stable across calls.
    assert.match(txt, /Language: en/);
    assert.match(txt, /# Authentication/);
    assert.match(txt, /Also available in: zh/);
  } finally {
    await cleanup();
  }
});

test('mcp: fetch_page tolerates a non-array breadcrumb (DB corruption) without crashing', async () => {
  const { app, runtime, cleanup } = await setup({ tools: ['fetch_page'] });
  try {
    // Corrupt the stored breadcrumb to a JSON object (not an array). A naive
    // `JSON.parse(...) as BreadcrumbNode[]` would later blow up `breadcrumbPath`'s
    // `.map`; the Array.isArray guard must degrade it to an empty path instead.
    runtime.db.prepare(`UPDATE pages SET breadcrumb = '{}' WHERE page_id = 'p'`).run();
    const { status, json } = await rpc(app, toolCall('fetch_page', { page_id: 'p' }));
    assert.equal(status, 200);
    assert.notEqual(json.result.isError, true);
    const txt = json.result.content[0].text as string;
    assert.match(txt, /# Authentication/);
    // Breadcrumb degraded to empty → no `Path:` line emitted.
    assert.doesNotMatch(txt, /^Path:/m);
  } finally {
    await cleanup();
  }
});

test('mcp: fetch_page unknown page_id → tool error', async () => {
  const { app, cleanup } = await setup({ tools: ['fetch_page'] });
  try {
    const { json } = await rpc(app, toolCall('fetch_page', { page_id: 'nope' }));
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /not_found/);
  } finally {
    await cleanup();
  }
});

test('mcp: disabled tool not callable even if requested', async () => {
  const { app, cleanup } = await setup({ tools: ['search'] });
  try {
    // ask is disabled → tools/call ask should be a JSON-RPC error (unknown tool).
    const { json } = await rpc(app, toolCall('ask', { question: 'x' }));
    assert.ok(json.error || json.result?.isError, JSON.stringify(json));
  } finally {
    await cleanup();
  }
});

test('mcp: present non-loopback Host header → 403 (DNS-rebinding guard)', async () => {
  const { app, cleanup } = await setup();
  try {
    const { status, json } = await rpc(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { host: 'evil.example.com' },
    );
    assert.equal(status, 403);
    assert.equal(json.error.message, 'forbidden_host');
  } finally {
    await cleanup();
  }
});

test('mcp: loopback Host with a non-config port is allowed (port-agnostic)', async () => {
  const { app, cleanup } = await setup();
  try {
    const { status } = await rpc(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { host: '127.0.0.1:9999' },
    );
    assert.equal(status, 200);
  } finally {
    await cleanup();
  }
});

test('mcp: 503 while warm-up is in flight', async () => {
  const { app, cleanup } = await setup({ start: false });
  try {
    const { status, json } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(status, 503);
    assert.equal(json.error.message, 'warming_up');
  } finally {
    await cleanup();
  }
});
