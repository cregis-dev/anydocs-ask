/**
 * Hono app for the v1 dev console — ARCH §17.3.
 *
 * Stateless: factory takes the workspace path + ProcessRegistry, produces
 * a Hono app. Routes added incrementally per ARCH §17.3.1 / §17.3.2.
 *
 * v1 scope (this file):
 *   - GET /              SSR project list
 *   - GET /api/projects  JSON project list (fed by scanProjects + registry)
 *
 * Subsequent commits add /p/:name (project page), start/stop, ask proxy,
 * eval/analyze/golden triggers, reports/runs viewers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  loadProjectId,
  resolveStateRoot,
  scanProjects,
  type ProjectListing,
} from '../workspace.ts';
import type { ProcessRegistry, RegisteredProcess } from './registry.ts';
import { defaultOps, isReportFilename, listReports, type ConsoleOps } from './ops.ts';
import { tailRuns } from '../runs/writer.ts';
import { renderHome } from './pages/home.ts';
import { renderProject } from './pages/project.ts';
import { renderReport } from './pages/report.ts';
import { renderRuns } from './pages/runs.ts';
import { getStaticAsset } from './static.ts';
import {
  clearPinnedBaseline,
  loadEvalSnapshot,
  readReportBody,
  writePinnedBaseline,
} from './eval-state.ts';
import { loadIndexSnapshot, type ChildIndexStatus } from './index-state.ts';
import { loadTrafficWindow } from './traffic-state.ts';

export type ConsoleAppDeps = {
  workspacePath: string;
  consolePort: number;
  /** Used by the layout footer/nav; default 15 keeps test surface stable. */
  idleTimeoutMin?: number;
  registry: ProcessRegistry;
  /**
   * fetch implementation used to reverse-proxy ask calls into child
   * processes. Injectable for tests; defaults to globalThis.fetch.
   */
  fetchFn?: typeof globalThis.fetch;
  /**
   * Eval / analyze / golden runners; injectable so unit tests don't drag
   * in real Runtime / sqlite / embedder. Defaults to defaultOps which
   * shares the same code path as the CLI commands (ARCH §17.5).
   */
  ops?: ConsoleOps;
};

export type ProjectStatusJSON = ProjectListing & {
  running: boolean;
  port: number | null;
  pid: number | null;
};

export function createConsoleApp(deps: ConsoleAppDeps): Hono {
  const app = new Hono();
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const ops = deps.ops ?? defaultOps;
  const idleTimeoutMin = deps.idleTimeoutMin ?? 15;

  function buildNav(current: string | null): {
    projects: ProjectListing[];
    current: string | null;
    running: Set<string>;
    consolePort: number;
    idleTimeoutMin: number;
  } {
    const projects = scanProjects(deps.workspacePath);
    const liveSet = new Set<string>();
    for (const e of deps.registry.list()) {
      if (!e.exited) liveSet.add(e.name);
    }
    return {
      projects,
      current,
      running: liveSet,
      consolePort: deps.consolePort,
      idleTimeoutMin,
    };
  }

  app.get('/', (c) => {
    const projects = scanProjects(deps.workspacePath);
    const running = runningMap(deps.registry.list());
    return c.html(
      renderHome({
        workspacePath: deps.workspacePath,
        consolePort: deps.consolePort,
        idleTimeoutMin,
        projects,
        running,
      }),
    );
  });

  app.get('/console/static/:name', (c) => {
    const name = c.req.param('name');
    const asset = getStaticAsset(name);
    if (!asset) return c.text(`unknown asset: ${name}`, 404);
    return new Response(asset.body, {
      status: 200,
      headers: {
        'Content-Type': asset.contentType,
        'Cache-Control': 'no-cache',
      },
    });
  });

  app.get('/api/projects', (c) => {
    const projects = scanProjects(deps.workspacePath);
    const running = runningMap(deps.registry.list());
    const payload: ProjectStatusJSON[] = projects.map((p) => {
      const r = running.get(p.name);
      return {
        ...p,
        running: r !== undefined && !r.exited,
        port: r ? r.port : null,
        pid: r ? r.pid : null,
      };
    });
    return c.json(payload);
  });

  // -----------------------------------------------------------------------
  // Per-project page + lifecycle endpoints (ARCH §17.3.1 / §17.3.2)
  // -----------------------------------------------------------------------

  app.get('/p/:name', async (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) {
      return c.text(`unknown project: ${name}`, 404);
    }
    const running = deps.registry.list().find((e) => e.name === name && !e.exited) ?? null;
    const stateRoot = projectStateRoot(deps.workspacePath, project);
    const reports = stateRoot ? listReports(stateRoot) : [];
    const autostart = c.req.query('autostart') === '1';
    const evalSnapshot = stateRoot ? loadEvalSnapshot(stateRoot) : undefined;
    const latestEvalReportBody =
      stateRoot && evalSnapshot?.latest
        ? readReportBody(stateRoot, evalSnapshot.latest.filename)
        : null;
    let indexSnapshot;
    if (project.valid) {
      indexSnapshot = await loadIndexSnapshot(project.path);
      // Best-effort: ask the child for DB-side counts when it's running.
      const port = deps.registry.getPort(name);
      if (port !== null) {
        try {
          const res = await fetchFn(`http://127.0.0.1:${port}/v1/index/status`, {
            signal: AbortSignal.timeout(800),
          });
          if (res.ok) {
            indexSnapshot = {
              ...indexSnapshot,
              dbStatus: (await res.json()) as ChildIndexStatus,
            };
          }
        } catch {
          // child responded 503 (warming) or fetch threw — leave dbStatus null
        }
      }
    }
    const trafficWindow = stateRoot ? loadTrafficWindow(stateRoot, 7) : undefined;
    return c.html(
      renderProject({
        project,
        running,
        reports,
        autostart,
        nav: buildNav(name),
        ...(evalSnapshot ? { evalSnapshot } : {}),
        latestEvalReportBody,
        ...(indexSnapshot ? { indexSnapshot } : {}),
        ...(trafficWindow ? { trafficWindow } : {}),
      }),
    );
  });

  app.get('/p/:name/reports/:file', (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.text(`unknown project: ${name}`, 404);
    if (!isReportFilename(file)) return c.text(`invalid report filename: ${file}`, 400);
    const stateRoot = projectStateRoot(deps.workspacePath, project);
    if (!stateRoot) return c.text(`project '${name}' has no projectId`, 400);
    const path = join(stateRoot, 'reports', file);
    if (!existsSync(path)) return c.text(`not found: ${file}`, 404);
    const body = readFileSync(path, 'utf8');
    return c.html(renderReport({ projectName: name, filename: file, body, nav: buildNav(name) }));
  });

  app.get('/p/:name/runs', (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.text(`unknown project: ${name}`, 404);
    const stateRoot = projectStateRoot(deps.workspacePath, project);
    if (!stateRoot) return c.text(`project '${name}' has no projectId`, 400);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw !== undefined ? Math.max(1, Math.min(500, Number(limitRaw) || 50)) : 50;
    const lines = tailRuns({ stateRoot, count: limit });
    return c.html(renderRuns({ projectName: name, lines, limit, nav: buildNav(name) }));
  });

  app.get('/api/projects/:name/runs', (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    const stateRoot = projectStateRoot(deps.workspacePath, project);
    if (!stateRoot) return c.json({ ok: false, error: 'no projectId' }, 400);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw !== undefined ? Math.max(1, Math.min(500, Number(limitRaw) || 50)) : 50;
    return c.json(tailRuns({ stateRoot, count: limit }));
  });

  app.get('/api/projects/:name/reports', (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    const stateRoot = projectStateRoot(deps.workspacePath, project);
    if (!stateRoot) return c.json([]);
    return c.json(listReports(stateRoot));
  });

  // -----------------------------------------------------------------------
  // Health proxy — surfaces child runtime.warm to the console UI.
  // -----------------------------------------------------------------------
  // Read-only observation; never auto-spawns. Returns 502 if child is not
  // running (page JS should not be polling pre-Start).

  app.get('/api/projects/:name/health', async (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    const port = deps.registry.getPort(name);
    if (port === null) return c.json({ ok: false, error: 'not running' }, 502);
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(800),
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
      });
    } catch (err) {
      return c.json({ ok: false, error: `proxy failed: ${(err as Error).message}` }, 502);
    }
  });

  app.post('/api/projects/:name/start', async (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) {
      return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    }
    if (!project.valid) {
      return c.json(
        { ok: false, error: `project '${name}' invalid (missing: ${project.missing.join(', ')})` },
        400,
      );
    }
    const result = await deps.registry.start(name);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500);
    }
    return c.json({ ok: true, port: result.port, reused: result.reused });
  });

  app.post('/api/projects/:name/stop', (c) => {
    const name = c.req.param('name');
    const stopped = deps.registry.stop(name);
    return c.json({ ok: true, stopped });
  });

  // ---------------------------------------------------------------------
  // Index reindex — reverse-proxy to child /v1/index/rebuild (ARCH §17.3.5)
  // ---------------------------------------------------------------------
  app.post('/api/projects/:name/reindex', async (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    const port = deps.registry.getPort(name);
    if (port === null) {
      return c.json(
        { ok: false, error: 'child not running — start the project first' },
        502,
      );
    }
    deps.registry.touch(name);
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/v1/index/rebuild`, {
        method: 'POST',
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
      });
    } catch (err) {
      return c.json(
        { ok: false, error: `proxy failed: ${(err as Error).message}` },
        502,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Ask 体验台 — reverse proxy with dry_run by default (ARCH §17.3.2 /
  // §17.3.3 / §17.8).
  // -----------------------------------------------------------------------
  //
  // Default forwards POST to child /v1/ask?dry_run=1 (response carries
  // `_dry_run: true`). When the body contains `{ "persist": true }` the
  // proxy instead forwards to `/v1/ask?source=console` — child writes
  // runs jsonl with source="console", which downstream analyze / golden
  // generate exclude by default (--include-console reverses).
  //
  // `persist` is consumed by the proxy and stripped before forwarding so
  // the child's AskRequest schema stays untouched.

  app.post('/api/projects/:name/ask', async (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) {
      return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    }
    if (!project.valid) {
      return c.json(
        { ok: false, error: `project '${name}' invalid (missing: ${project.missing.join(', ')})` },
        400,
      );
    }
    let port = deps.registry.getPort(name);
    if (port === null) {
      const start = await deps.registry.start(name);
      if (!start.ok) {
        return c.json({ ok: false, error: `failed to start child: ${start.error}` }, 500);
      }
      port = start.port;
    }
    deps.registry.touch(name);

    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch (err) {
      return c.json({ ok: false, error: `read body failed: ${(err as Error).message}` }, 400);
    }
    // Parse the incoming JSON to extract `persist`; fall through on failure
    // and let the child surface the malformed-body error.
    let persist = false;
    let forwardBody = rawBody;
    if (rawBody.length > 0) {
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && parsed.persist === true) {
          persist = true;
          const { persist: _drop, ...rest } = parsed;
          void _drop;
          forwardBody = JSON.stringify(rest);
        }
      } catch {
        // ignore — child returns proper invalid_request error on malformed JSON.
      }
    }

    const upstream = persist
      ? `http://127.0.0.1:${port}/v1/ask?source=console`
      : `http://127.0.0.1:${port}/v1/ask?dry_run=1`;
    let res: Response;
    try {
      res = await fetchFn(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: forwardBody,
      });
    } catch (err) {
      return c.json(
        { ok: false, error: `proxy failed: ${(err as Error).message}` },
        502,
      );
    }
    const text = await res.text();
    // When persisting we want the UI to know `_persisted: true` so the
    // toast can confirm "wrote runs row". The child returns the answer
    // object verbatim (no _dry_run, no _persisted), so we splice the
    // flag in here when the body is valid JSON.
    let outBody = text;
    if (persist) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        parsed._persisted = true;
        parsed._source = 'console';
        outBody = JSON.stringify(parsed);
      } catch {
        // leave verbatim if non-JSON
      }
    }
    return new Response(outBody, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
    });
  });

  // -----------------------------------------------------------------------
  // Eval / Analyze / Golden generate triggers (ARCH §17.3.2 / §17.5)
  // -----------------------------------------------------------------------
  // These call the CLI business functions in-process and respond after
  // completion. v1 MVP: blocking request; long jobs (eval/analyze) keep
  // the connection open until the report is written. Async job queue is
  // a v1.5 polish (see PRD §13.8).

  app.post('/api/projects/:name/eval', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    // Optional baseline override. Two sources, in priority order:
    //   1. body.baseline_path (UI dropdown — filename within state/reports/)
    //   2. pinned baseline pointer (state/.../golden/eval-baseline.json)
    //   3. CLI default (latest prior eval report)
    let baselinePath: string | undefined;
    try {
      const body = (await c.req.json().catch(() => null)) as
        | { baseline_path?: string }
        | null;
      if (body && typeof body.baseline_path === 'string' && body.baseline_path.length > 0) {
        // UI passes just the filename; resolve to absolute path within reports/.
        if (!/^\d{4}-\d{2}-\d{2}-eval\.md$/.test(body.baseline_path)) {
          return c.json(
            { ok: false, error: `invalid baseline filename: ${body.baseline_path}` },
            400,
          );
        }
        baselinePath = join(ctx.stateRoot, 'reports', body.baseline_path);
      }
    } catch {
      // ignore — no body or non-JSON; fall through
    }
    if (!baselinePath) {
      // Check pin.
      const snap = loadEvalSnapshot(ctx.stateRoot);
      if (snap.pinned) {
        baselinePath = join(ctx.stateRoot, 'reports', snap.pinned.filename);
      }
    }
    const r = await ops.eval({
      projectRoot: ctx.projectRoot,
      stateRoot: ctx.stateRoot,
      ...(baselinePath ? { baselinePath } : {}),
    });
    return c.json(r, r.ok ? 200 : 500);
  });

  // pin / unpin baseline — ARCH §17.8 baseline 钉固。
  app.post('/api/projects/:name/eval/pin-baseline', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    let body: { filename?: string } | null = null;
    try {
      body = (await c.req.json()) as { filename?: string };
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body.filename !== 'string') {
      return c.json({ ok: false, error: 'body.filename (string) required' }, 400);
    }
    try {
      const pin = writePinnedBaseline(ctx.stateRoot, body.filename);
      return c.json({ ok: true, pinned: pin });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  app.delete('/api/projects/:name/eval/pin-baseline', (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    const cleared = clearPinnedBaseline(ctx.stateRoot);
    return c.json({ ok: true, cleared });
  });

  app.post('/api/projects/:name/analyze', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    const since = c.req.query('since');
    const r = await ops.analyzeRuns({
      projectRoot: ctx.projectRoot,
      stateRoot: ctx.stateRoot,
      ...(since ? { since } : {}),
    });
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post('/api/projects/:name/golden/generate', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    const fromRaw = c.req.query('from') ?? 'structure';
    if (fromRaw !== 'structure' && fromRaw !== 'runs') {
      return c.json({ ok: false, error: 'from must be structure or runs' }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ ok: false, error: 'limit must be a positive integer' }, 400);
    }
    const r = await ops.goldenGenerate({
      projectRoot: ctx.projectRoot,
      stateRoot: ctx.stateRoot,
      from: fromRaw,
      ...(limit !== undefined ? { limit } : {}),
      llmRewrite: false, // console default: no LLM cost; CLI handles --llm-rewrite
      force: false,
    });
    return c.json(r, r.ok ? 200 : 500);
  });

  return app;
}

function findProject(workspacePath: string, name: string): ProjectListing | null {
  const projects = scanProjects(workspacePath);
  return projects.find((p) => p.name === name) ?? null;
}

/** Resolve `<workspace>/state/<projectId>/` for a project listing. */
function projectStateRoot(workspacePath: string, project: ProjectListing): string | null {
  if (!project.projectId) return null;
  return resolveStateRoot(workspacePath, project.projectId);
}

type OpContext =
  | { projectRoot: string; stateRoot: string }
  | { error: string; status: 404 | 400 };

function resolveOpContext(workspacePath: string, name: string): OpContext {
  const project = findProject(workspacePath, name);
  if (!project) return { error: `unknown project: ${name}`, status: 404 };
  if (!project.valid) {
    return {
      error: `project '${name}' invalid (missing: ${project.missing.join(', ')})`,
      status: 400,
    };
  }
  let projectId: string;
  try {
    projectId = loadProjectId(project.path);
  } catch (err) {
    return { error: (err as Error).message, status: 400 };
  }
  return {
    projectRoot: project.path,
    stateRoot: resolveStateRoot(workspacePath, projectId),
  };
}

function runningMap(list: RegisteredProcess[]): Map<string, RegisteredProcess> {
  const m = new Map<string, RegisteredProcess>();
  for (const e of list) m.set(e.name, e);
  return m;
}
