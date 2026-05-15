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
import { addToProjectRegistry } from '../src/workspace.ts';

async function withTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await fs.mkdtemp(join(tmpdir(), 'anydocs-console-srv-'));
  return { path, cleanup: () => fs.rm(path, { recursive: true, force: true }) };
}

async function makeWorkspaceWithProjects(ws: string, names: string[]): Promise<void> {
  await fs.mkdir(join(ws, 'state'), { recursive: true });
  for (const name of names) {
    const p = join(ws, 'projects', name);
    await fs.mkdir(join(p, 'pages'), { recursive: true });
    await fs.mkdir(join(p, 'navigation'), { recursive: true });
    await fs.writeFile(
      join(p, 'anydocs.config.json'),
      JSON.stringify({ version: 1, projectId: name }),
    );
    addToProjectRegistry(ws, p, name);
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
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /projects/);
    assert.match(body, /还没有注册任何项目|workspace add/);
  } finally {
    await cleanup();
  }
});

test('GET /: lists valid + invalid projects with status tags', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // Add an invalid one (missing navigation/) — must also register it
    const brokenPath = join(ws, 'projects', 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');
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
    // valid card vs invalid card distinguishable
    assert.match(body, /class="card proj-card"[\s\S]*docs-zh/);
    assert.match(body, /class="card proj-card invalid"[\s\S]*broken/);
    assert.match(body, /missing:[^<]*navigation/);
    // idle pill on stopped project
    assert.match(body, /pill[^>]*>[\s\S]*?idle/);
    // open link only for valid project (autostart variant or live variant)
    assert.match(body, /href="\/p\/docs-zh(\?autostart=1)?"/);
    assert.equal(body.includes('href="/p/broken"'), false);
    assert.equal(body.includes('href="/p/broken?autostart=1"'), false);
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
    // Redesign 2026-05-11: project name lives in the breadcrumb .here cell,
    // not a separate h1.
    assert.match(body, /class="here[^"]*"[^>]*>docs-zh</);
    assert.match(body, /id="btn-start"(?![^>]*disabled)/);
    assert.match(body, /id="btn-stop"[^>]*disabled/);
    assert.match(body, /tag[^>]*>stopped/);
    // Stopped-state Ask gate heading must be English to match the English
    // body + button copy in the same card (dogfood 2026-05-14 F5 — the IA
    // cleanup left "项目未启动" next to English copy). The console redesign
    // reworded the gate heading; it stays English.
    assert.match(body, />Start this project to begin</);
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
    // pagehead pill carries the live status text
    assert.match(body, /pill[^>]*>[\s\S]*?running · :4101/);
    // status card shows port + pid
    assert.match(body, /tag run[^>]*>:4101</);
    assert.match(body, /pid [0-9]/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: project tabs (Ask/Index/Eval/Traffic) + scoped JS handler so they do not collide with Ask sub-tabs', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    const body = await res.text();
    // four project tabs present
    assert.match(body, /data-project-tab="ask"/);
    assert.match(body, /data-project-tab="index"/);
    assert.match(body, /data-project-tab="eval"/);
    assert.match(body, /data-project-tab="traffic"/);
    // Ask sub-tab handler MUST be scoped to #ask-result so it can't
    // accidentally hide outer project panels when user clicks them.
    // (Regression: previous build used unscoped `document.querySelectorAll
    // ('[role=tab]')` which collided with the outer tabs.)
    assert.match(body, /askResultEl\.querySelectorAll/);
    assert.equal(
      /document\.querySelectorAll\('\[role=tab\]'\)/.test(body),
      false,
      'unscoped [role=tab] selector would re-introduce the cross-talk bug',
    );
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: bootstrap <script type=module> parses + carries citeSectionLabel helper', async () => {
  // The project page emits BOOTSTRAP_SCRIPT inside a TS template literal.
  // PR #16 shipped a syntax error there (a stray real newline from an
  // unescaped \n) that killed every button. This guards the whole script
  // parses, and that the F4 same-page-citation disambiguator is wired in.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    const body = await res.text();

    // The page emits more than one <script type="module"> (traffic tab has
    // its own). Validate every one parses, then pin the F4 helper to the
    // bootstrap script (the one with window.__CONSOLE__).
    const blocks = [...body.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(
      (mm) => mm[1]!,
    );
    assert.ok(blocks.length > 0, 'expected at least one <script type="module"> block');
    for (const script of blocks) {
      // strip ESM import/export lines — new Function() can't parse module
      // syntax, but the rest of the body must still be syntactically valid.
      const stripped = script
        .split('\n')
        .filter((l) => !/^\s*(import|export)\s/.test(l))
        .join('\n');
      assert.doesNotThrow(
        () => new Function(stripped),
        'every module <script> body must be syntactically valid JS',
      );
    }
    const bootstrap = blocks.find((s) => s.includes('window.__CONSOLE__'));
    assert.ok(bootstrap, 'expected the bootstrap script (window.__CONSOLE__)');
    assert.match(bootstrap!, /function citeSectionLabel/);
    assert.match(bootstrap!, /lastIndexOf\('\/p\['\)/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: invalid project hides action buttons', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const brokenPath = join(ws, 'projects', 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');
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
    const brokenPath = join(ws, 'projects', 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');
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

test('GET /api/projects/:name/health: 502 when not running', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/health');
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /not running/);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/health: mirrors child 503 warming response', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 503,
      body: { status: 'warming', warm: false },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/health');
    assert.equal(res.status, 503);
    const body = (await res.json()) as { warm: boolean };
    assert.equal(body.warm, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/health');
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/health: mirrors child 200 warm response', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const fetchFn = makeStubFetch([], () => ({
      status: 200,
      body: { status: 'ok', warm: true, booted_at: 0 },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/health');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { warm: boolean };
    assert.equal(body.warm, true);
  } finally {
    await cleanup();
  }
});

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

test('POST /api/projects/:name/ask: persist:true forwards to ?source=console (no dry_run)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', answer_md: 'A.', citations: [] },
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
      body: JSON.stringify({ question: 'real Q', persist: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; _persisted?: boolean; _source?: string };
    assert.equal(body.type, 'answer');
    assert.equal(body._persisted, true);
    assert.equal(body._source, 'console');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?source=console');
    // persist field is stripped from the forwarded body so child's AskRequest
    // schema isn't extended.
    const fwd = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    assert.equal(fwd.question, 'real Q');
    assert.equal(fwd.persist, undefined);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: persist:false (or missing) keeps dry_run default', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q', persist: false }),
    });
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?dry_run=1');
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

// ---------------------------------------------------------------------------
// Eval / Analyze / Golden + reports + runs (ARCH §17.3.1 / §17.3.2 / §17.5)
// ---------------------------------------------------------------------------

import type { ConsoleOps, OpResult } from '../src/console/ops.ts';
import type { RunRecord } from '../src/runs/types.ts';

function makeStubOps(overrides: Partial<ConsoleOps> = {}): {
  ops: ConsoleOps;
  calls: { eval: number; analyzeRuns: number; goldenGenerate: number };
} {
  const calls = { eval: 0, analyzeRuns: 0, goldenGenerate: 0 };
  const ok: OpResult = { ok: true, message: 'stub' };
  const ops: ConsoleOps = {
    eval: overrides.eval ??
      (async () => {
        calls.eval += 1;
        return ok;
      }),
    analyzeRuns: overrides.analyzeRuns ??
      (async () => {
        calls.analyzeRuns += 1;
        return ok;
      }),
    goldenGenerate: overrides.goldenGenerate ??
      (async () => {
        calls.goldenGenerate += 1;
        return ok;
      }),
    goldenGenerateStream: overrides.goldenGenerateStream ??
      (async (_opts, onEvent) => {
        calls.goldenGenerate += 1;
        onEvent({ type: 'log', line: 'stub log' });
        onEvent({ type: 'result', ok: true, message: 'stub' });
      }),
  };
  return { ops, calls };
}

test('POST /api/projects/:name/eval: invokes ops.eval with state path', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawStateRoot: string | null = null;
    const { ops } = makeStubOps({
      eval: async (opts) => {
        sawStateRoot = opts.stateRoot;
        return { ok: true, reportPath: '/tmp/fake/reports/2026-05-10-eval.md' };
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/eval', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; reportPath: string };
    assert.equal(body.ok, true);
    assert.match(body.reportPath, /2026-05-10-eval\.md$/);
    assert.equal(sawStateRoot, join(ws, 'state', 'docs-zh'));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: body.baseline_path resolved to absolute report path', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // Write a baseline report so the pointer can resolve.
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# baseline\n');
    let receivedBaseline: string | undefined;
    const fakeOps = {
      eval: async (opts: { projectRoot: string; stateRoot: string; baselinePath?: string }) => {
        receivedBaseline = opts.baselinePath;
        return { ok: true as const, message: 'ok' };
      },
      analyzeRuns: async () => ({ ok: true as const, message: 'ok' }),
      goldenGenerate: async () => ({ ok: true as const, message: 'ok' }),
    };
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops: fakeOps,
    });
    const res = await app.request('/api/projects/docs-zh/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseline_path: '2026-05-08-eval.md' }),
    });
    assert.equal(res.status, 200);
    assert.ok(receivedBaseline);
    assert.ok(receivedBaseline.endsWith('state/docs-zh/reports/2026-05-08-eval.md'));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: invalid baseline filename rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseline_path: '../../etc/passwd' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /invalid baseline/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: pinned baseline used when body omits baseline_path', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const stateRoot = join(ws, 'state', 'docs-zh');
    const reportsDir = join(stateRoot, 'reports');
    const goldenDir = join(stateRoot, 'golden');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.mkdir(goldenDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# pinned baseline\n');
    await fs.writeFile(
      join(goldenDir, 'eval-baseline.json'),
      JSON.stringify({ filename: '2026-05-08-eval.md', pinnedAt: '2026-05-09T00:00:00.000Z' }),
    );
    let receivedBaseline: string | undefined;
    const fakeOps = {
      eval: async (opts: { projectRoot: string; stateRoot: string; baselinePath?: string }) => {
        receivedBaseline = opts.baselinePath;
        return { ok: true as const, message: 'ok' };
      },
      analyzeRuns: async () => ({ ok: true as const, message: 'ok' }),
      goldenGenerate: async () => ({ ok: true as const, message: 'ok' }),
    };
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops: fakeOps,
    });
    const res = await app.request('/api/projects/docs-zh/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.ok(receivedBaseline?.endsWith('reports/2026-05-08-eval.md'));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval/pin-baseline: writes pointer to state/golden/eval-baseline.json', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# r\n');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval/pin-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '2026-05-08-eval.md' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; pinned: { filename: string } };
    assert.equal(body.ok, true);
    assert.equal(body.pinned.filename, '2026-05-08-eval.md');
    // file actually exists
    const pinFile = join(ws, 'state', 'docs-zh', 'golden', 'eval-baseline.json');
    const content = JSON.parse(await fs.readFile(pinFile, 'utf8')) as { filename: string };
    assert.equal(content.filename, '2026-05-08-eval.md');
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval/pin-baseline: missing report → 400', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval/pin-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '2099-12-31-eval.md' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /report not found/);
  } finally {
    await cleanup();
  }
});

test('DELETE /api/projects/:name/eval/pin-baseline: removes pointer file', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    await fs.mkdir(goldenDir, { recursive: true });
    await fs.writeFile(
      join(goldenDir, 'eval-baseline.json'),
      JSON.stringify({ filename: '2026-05-08-eval.md', pinnedAt: '2026-05-09' }),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval/pin-baseline', {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.cleared, true);
    // file gone
    const stillExists = await fs
      .stat(join(goldenDir, 'eval-baseline.json'))
      .then(() => true)
      .catch(() => false);
    assert.equal(stillExists, false);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/decide: writes decision into candidate jsonl', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    await fs.mkdir(goldenDir, { recursive: true });
    const candidate = {
      id: 'cand-001',
      query: 'JWT 续期',
      filters: {},
      context_pageId: null,
      expected: { must_cite_pages: ['jwt'], must_contain: [], forbid_contain: [] },
      tags: [],
      created_by: 'structure',
      reviewed_at: null,
      reviewer: null,
      lang: 'zh',
      decision: null,
      template_id: 'definition',
    };
    await fs.writeFile(
      join(goldenDir, 'cases.candidate.jsonl'),
      JSON.stringify(candidate) + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/golden/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'cand-001', decision: 'approved' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; after: string };
    assert.equal(body.ok, true);
    assert.equal(body.after, 'approved');
    // file actually contains the update
    const content = await fs.readFile(join(goldenDir, 'cases.candidate.jsonl'), 'utf8');
    const parsed = JSON.parse(content.trim()) as { decision: string };
    assert.equal(parsed.decision, 'approved');
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/decide: unknown id → 404', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/golden/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'nope', decision: 'approved' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not found/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/flush: moves approved → cases.jsonl, leaves rejected behind', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    await fs.mkdir(goldenDir, { recursive: true });
    const make = (id: string, decision: string | null) => ({
      id,
      query: 'q-' + id,
      filters: {},
      context_pageId: null,
      expected: { must_cite_pages: ['p'], must_contain: [], forbid_contain: [] },
      tags: [],
      created_by: 'structure',
      reviewed_at: null,
      reviewer: null,
      lang: 'zh',
      decision,
      template_id: 'definition',
    });
    await fs.writeFile(
      join(goldenDir, 'cases.candidate.jsonl'),
      [make('a', 'approved'), make('b', 'rejected'), make('c', null)]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/golden/flush', {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      summary: { approved: number; rejected: number; pending: number };
    };
    assert.equal(body.summary.approved, 1);
    assert.equal(body.summary.rejected, 1);
    assert.equal(body.summary.pending, 1);
    // cases.jsonl contains the approved row only
    const cases = (await fs.readFile(join(goldenDir, 'cases.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(cases.length, 1);
    const approved = JSON.parse(cases[0]!) as { id: string; reviewer: string };
    assert.equal(approved.id, 'a');
    assert.equal(approved.reviewer, 'console');
    // candidate file keeps only the pending row
    const remaining = (await fs.readFile(join(goldenDir, 'cases.candidate.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(remaining.length, 1);
    assert.equal((JSON.parse(remaining[0]!) as { id: string }).id, 'c');
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: 500 with op error on failure', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps({
      eval: async () => ({ ok: false, error: 'no golden cases' }),
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/eval', { method: 'POST' });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /no golden cases/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/analyze: forwards ?since to ops.analyzeRuns', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawSince: string | undefined;
    const { ops } = makeStubOps({
      analyzeRuns: async (opts) => {
        sawSince = opts.since;
        return { ok: true };
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    await app.request('/api/projects/docs-zh/analyze?since=14d', { method: 'POST' });
    assert.equal(sawSince, '14d');
    // Without query param, since should be undefined
    await app.request('/api/projects/docs-zh/analyze', { method: 'POST' });
    assert.equal(sawSince, undefined);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate: from=structure default, llmRewrite=true with auto-fallback', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawOpts: {
      from: string;
      llmRewrite: boolean;
      fallbackOnLlmError?: boolean;
      limit?: number;
    } | null = null;
    const { ops } = makeStubOps({
      goldenGenerate: async (opts) => {
        sawOpts = {
          from: opts.from,
          llmRewrite: opts.llmRewrite,
          ...(opts.fallbackOnLlmError !== undefined
            ? { fallbackOnLlmError: opts.fallbackOnLlmError }
            : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        };
        return { ok: true, message: 'wrote candidates' };
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    await app.request('/api/projects/docs-zh/golden/generate', { method: 'POST' });
    assert.equal(sawOpts!.from, 'structure');
    assert.equal(sawOpts!.llmRewrite, true);
    assert.equal(sawOpts!.fallbackOnLlmError, true);
    assert.equal(sawOpts!.limit, undefined);

    await app.request('/api/projects/docs-zh/golden/generate?from=runs&limit=20', {
      method: 'POST',
    });
    assert.equal(sawOpts!.from, 'runs');
    assert.equal(sawOpts!.limit, 20);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate/stream: multi-line reporter writes split into separate log events', async () => {
  // The reporter contract is "newline-terminated", but runGoldenGenerate
  // does emit multi-line blocks (e.g. the final wrote/next summary). The
  // streaming wrapper must split those into one log event per line, otherwise
  // the UI log box gets one giant blob.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps({
      goldenGenerateStream: async (_opts, onEvent) => {
        // Mirror what defaultOps.goldenGenerateStream does: callers may write
        // a single chunk containing multiple newlines, and each line should
        // become its own event.
        const chunk = 'line one\nline two\nline three\n';
        let pending = '';
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf('\n')) !== -1) {
          onEvent({ type: 'log', line: pending.slice(0, nl) });
          pending = pending.slice(nl + 1);
        }
        onEvent({ type: 'result', ok: true });
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate/stream', {
      method: 'POST',
    });
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; line?: string });
    const logLines = events.filter((e) => e.type === 'log').map((e) => e.line);
    assert.deepEqual(logLines, ['line one', 'line two', 'line three']);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate/stream: error from runner surfaces as log event before result', async () => {
  // Regression: when runGoldenGenerate fails on an actionable check (file
  // already exists, no runs, etc.), the streaming UI must see the helpful
  // message — not just "exited with code 1". The runner emits the message
  // through reporter (= log event), then returns non-zero (= result.ok=false).
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps({
      goldenGenerateStream: async (_opts, onEvent) => {
        onEvent({
          type: 'log',
          line: 'error: cases.candidate.jsonl already exists. Run golden review first.',
        });
        onEvent({ type: 'result', ok: false, error: 'golden generate exited with code 1' });
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate/stream', {
      method: 'POST',
    });
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; line?: string; ok?: boolean });
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'log');
    assert.match(events[0]!.line!, /already exists/);
    assert.equal(events[1]!.type, 'result');
    assert.equal(events[1]!.ok, false);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate/stream: NDJSON log + result events', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawOpts: { from: string; llmRewrite: boolean; fallbackOnLlmError?: boolean } | null = null;
    const { ops } = makeStubOps({
      goldenGenerateStream: async (opts, onEvent) => {
        sawOpts = {
          from: opts.from,
          llmRewrite: opts.llmRewrite,
          ...(opts.fallbackOnLlmError !== undefined
            ? { fallbackOnLlmError: opts.fallbackOnLlmError }
            : {}),
        };
        onEvent({ type: 'log', line: 'loading project...' });
        onEvent({ type: 'log', line: '  rewrite batch 1/2 (50 items)...' });
        onEvent({ type: 'log', line: '    ok in 1234ms' });
        onEvent({ type: 'result', ok: true, message: 'wrote /tmp/cases.candidate.jsonl' });
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate/stream', {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);
    const body = await res.text();
    const lines = body.split('\n').filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    assert.equal(events.length, 4);
    assert.equal(events[0]!.type, 'log');
    assert.equal(events[3]!.type, 'result');
    assert.equal((events[3] as { ok: boolean }).ok, true);
    assert.equal(sawOpts!.from, 'structure');
    assert.equal(sawOpts!.llmRewrite, true);
    assert.equal(sawOpts!.fallbackOnLlmError, true);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate: rejects invalid from', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate?from=inbox', {
      method: 'POST',
    });
    assert.equal(res.status, 400);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/reports: returns the listing newest first', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-01-eval.md'), 'A');
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), 'B');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/reports');
    const body = (await res.json()) as Array<{ filename: string }>;
    assert.deepEqual(
      body.map((r) => r.filename),
      ['2026-05-08-eval.md', '2026-05-01-eval.md'],
    );
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/reports/:file: renders report inside <pre>', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# Eval\n\nR@5=0.78');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/reports/2026-05-08-eval.md');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<pre[^>]*>[^<]*# Eval/);
    assert.match(body, /R@5=0\.78/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/reports/:file: 400 on bad filename (path traversal)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    // Note: hono decodes %2e%2e, but our route's filename validator rejects
    // anything not matching the canonical pattern.
    const res = await app.request('/p/docs-zh/reports/etc-passwd.md');
    assert.equal(res.status, 400);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/reports/:file: 404 when filename valid but file missing', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/reports/2030-01-01-eval.md');
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/runs: returns recent jsonl entries', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const runsDir = join(ws, 'state', 'docs-zh', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const rec = (q: string): RunRecord => ({
      ts: '2026-05-10T03:14:15.123Z',
      request_id: '01HXX',
      session_id: null,
      query: q,
      filters: {},
      context_pageId: null,
      retrieval: { fused: [], subtree_ask_triggered: false },
      answer: {
        kind: 'answer',
        answer_id: 'ans',
        md: 'A.',
        citations: [],
        confidence: 0.8,
        latency_ms: 100,
        tokens_in: null,
        tokens_out: null,
        model: 'mock',
        error_code: null,
      },
      feedback: { beta: null, gamma: null },
    });
    await fs.writeFile(
      join(runsDir, '2026-W19.jsonl'),
      JSON.stringify(rec('Q1')) + '\n' + JSON.stringify(rec('Q2')) + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/runs?limit=5');
    const body = (await res.json()) as RunRecord[];
    assert.equal(body.length, 2);
    assert.deepEqual(
      body.map((r) => r.query),
      ['Q1', 'Q2'],
    );
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/runs: renders runs table with newest first', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const runsDir = join(ws, 'state', 'docs-zh', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      join(runsDir, '2026-W19.jsonl'),
      JSON.stringify({
        ts: '2026-05-10T03:14:15.123Z',
        request_id: '01HXY',
        session_id: null,
        query: 'JWT 续期',
        filters: {},
        context_pageId: null,
        retrieval: { fused: [], subtree_ask_triggered: false },
        answer: {
          kind: 'answer',
          answer_id: 'a1',
          md: 'use refresh token',
          citations: [{ chunk_id: 1, page: 'security/jwt', quote: '' }],
          confidence: 0.78,
          latency_ms: 1234,
          tokens_in: null,
          tokens_out: null,
          model: 'mock',
          error_code: null,
        },
        feedback: { beta: null, gamma: null },
      }) + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/runs');
    const body = await res.text();
    assert.match(body, /JWT 续期/);
    assert.match(body, /security\/jwt/);
    assert.match(body, /1234ms/);
    assert.match(body, /tag ok[^>]*>answer/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/runs: empty state shows hint', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/runs');
    const body = await res.text();
    assert.match(body, /尚无 runs/);
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
