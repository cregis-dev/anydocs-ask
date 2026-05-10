/**
 * Console Hono app smoke tests — GET / and GET /api/projects.
 * Uses scanProjects against a tmp workspace + a minimal fake registry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleApp, type ProjectStatusJSON } from '../src/console/server.ts';
import {
  ProcessRegistry,
  type RegistryConfig,
  type Spawnable,
} from '../src/console/registry.ts';

async function withTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await fs.mkdtemp(join(tmpdir(), 'anydocs-console-srv-'));
  return { path, cleanup: () => fs.rm(path, { recursive: true, force: true }) };
}

async function makeWorkspaceWithProjects(ws: string, names: string[]): Promise<void> {
  await fs.mkdir(join(ws, 'projects'), { recursive: true });
  await fs.mkdir(join(ws, 'state'), { recursive: true });
  for (const name of names) {
    const p = join(ws, 'projects', name);
    await fs.mkdir(join(p, 'pages'), { recursive: true });
    await fs.mkdir(join(p, 'navigation'), { recursive: true });
    await fs.writeFile(
      join(p, 'anydocs.config.json'),
      JSON.stringify({ version: 1, projectId: name }),
    );
  }
}

class FakeChild implements Spawnable {
  pid = 1234;
  kill(): boolean {
    return true;
  }
  onExit(): void {
    /* never fires in these tests */
  }
}

function makeRegistry(): ProcessRegistry {
  const config: RegistryConfig = {
    childPortRangeStart: 4101,
    childPortRangeEnd: 4199,
    idleTimeoutMin: 15,
    healthTimeoutMs: 10,
  };
  return new ProcessRegistry({
    spawner: () => new FakeChild(),
    healthProbe: async () => true,
    config,
    workspacePath: '/tmp/fake',
  });
}

test('GET /: empty workspace shows guidance, not crash', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /projects/);
    assert.match(body, /projects\/<\/code>\s+目录为空|目录为空/);
    // workspace path appears in the header block
    assert.ok(body.includes(ws));
  } finally {
    await cleanup();
  }
});

test('GET /: lists valid + invalid projects with status tags', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // Add an invalid one (missing navigation/)
    await fs.mkdir(join(ws, 'projects', 'broken', 'pages'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /docs-zh/);
    assert.match(body, /broken/);
    // valid + stopped tags present
    assert.match(body, /tag ok[^>]*>valid/);
    assert.match(body, /tag err[^>]*>invalid/);
    assert.match(body, /tag[^>]*>stopped/);
    // open link only for valid project
    assert.match(body, /href="\/p\/docs-zh"/);
    assert.equal(body.includes('href="/p/broken"'), false);
  } finally {
    await cleanup();
  }
});

test('GET /: running registry entry surfaces port + run tag', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh'); // 4101
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
    });
    const res = await app.request('/');
    const body = await res.text();
    assert.match(body, /running · :4101/);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects: empty workspace returns []', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects');
    assert.equal(res.status, 200);
    const body = (await res.json()) as ProjectStatusJSON[];
    assert.deepEqual(body, []);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects: returns ProjectStatusJSON with running/port/pid', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['a', 'b']);
    const registry = makeRegistry();
    await registry.start('a'); // running
    // b not started
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
    });
    const res = await app.request('/api/projects');
    const body = (await res.json()) as ProjectStatusJSON[];
    assert.equal(body.length, 2);
    const a = body.find((p) => p.name === 'a')!;
    const b = body.find((p) => p.name === 'b')!;
    assert.equal(a.running, true);
    assert.equal(a.port, 4101);
    assert.equal(typeof a.pid, 'number');
    assert.equal(a.valid, true);
    assert.equal(a.projectId, 'a');
    assert.equal(b.running, false);
    assert.equal(b.port, null);
    assert.equal(b.pid, null);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: 404 on unknown project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/nope');
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: stopped project shows start button enabled, stop disabled', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<h1>docs-zh<\/h1>/);
    assert.match(body, /id="btn-start"(?![^>]*disabled)/);
    assert.match(body, /id="btn-stop"[^>]*disabled/);
    assert.match(body, /tag[^>]*>stopped/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: running project disables start, enables stop, shows pid+port', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
    });
    const res = await app.request('/p/docs-zh');
    const body = await res.text();
    assert.match(body, /id="btn-start"[^>]*disabled/);
    assert.match(body, /id="btn-stop"(?![^>]*disabled)/);
    assert.match(body, /port=4101/);
    assert.match(body, /tag run[^>]*>running/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: invalid project hides action buttons', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects', 'broken', 'pages'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/broken');
    const body = await res.text();
    assert.equal(body.includes('id="btn-start"'), false);
    assert.match(body, /missing.*navigation/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: spawns child + returns port', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; port: number; reused: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.port, 4101);
    assert.equal(body.reused, false);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: second call returns reused=true with same port', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    const r2 = await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    const body = (await r2.json()) as { ok: boolean; port: number; reused: boolean };
    assert.equal(body.reused, true);
    assert.equal(body.port, 4101);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: 404 on unknown project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/nope/start', { method: 'POST' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown project/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: 400 on invalid project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects', 'broken', 'pages'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/broken/start', { method: 'POST' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.match(body.error, /invalid.*navigation/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/stop: stops running child', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    const res = await app.request('/api/projects/docs-zh/stop', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; stopped: boolean };
    assert.deepEqual(body, { ok: true, stopped: true });
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/stop: returns stopped=false when not running', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/stop', { method: 'POST' });
    const body = (await res.json()) as { ok: boolean; stopped: boolean };
    assert.deepEqual(body, { ok: true, stopped: false });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ask 体验台 reverse proxy (ARCH §17.3.2 / §17.3.3)
// ---------------------------------------------------------------------------

type ProxyCall = { url: string; method: string; body: string };

function makeStubFetch(
  capture: ProxyCall[],
  respond: (call: ProxyCall) => { status: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: ProxyCall = {
      url: typeof input === 'string' ? input : (input as URL).toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    };
    capture.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

test('POST /api/projects/:name/ask: lazy-spawns + proxies with dry_run=1', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', answer_md: 'A.', citations: [], _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'JWT 续期' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; _dry_run: boolean };
    assert.equal(body.type, 'answer');
    assert.equal(body._dry_run, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?dry_run=1');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.body, JSON.stringify({ question: 'JWT 续期' }));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: reuses already-running child without re-spawn', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh'); // already running on 4101
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q' }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?dry_run=1');
    // still only one running entry; no extra spawn
    assert.equal(registry.list().length, 1);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: 404 unknown project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn: makeStubFetch([], () => ({ status: 200, body: {} })),
    });
    const res = await app.request('/api/projects/nope/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: mirrors child error status (400) + body', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 400,
      body: { type: 'error', code: 'invalid_scope', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; _dry_run: boolean };
    assert.equal(body.code, 'invalid_scope');
    assert.equal(body._dry_run, true);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: 502 when proxy fetch throws', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const fetchFn = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /proxy failed/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: touches lastUsedAt to defer reap', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    // simulate baseline lastUsedAt by reading list
    const before = registry.list()[0]!.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    const fetchFn = makeStubFetch([], () => ({
      status: 200,
      body: { type: 'answer', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const after = registry.list()[0]!.lastUsedAt;
    assert.ok(after > before, `expected lastUsedAt to advance: before=${before} after=${after}`);
  } finally {
    await cleanup();
  }
});
