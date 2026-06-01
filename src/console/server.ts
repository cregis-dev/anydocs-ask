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

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import {
  addToProjectRegistry,
  assertProjectRoot,
  isBareName,
  loadProjectId,
  readProjectRegistry,
  removeFromProjectRegistry,
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
  listAnalyzeReports,
  loadEvalSnapshot,
  readAnalyzeReportBody,
  readReportBody,
  writePinnedBaseline,
} from './eval-state.ts';
import {
  loadFeedbackRowDetail,
  loadFeedbackTabSnapshot,
  parseFeedbackFilter,
} from './feedback-state.ts';
import { loadIndexSnapshot, type ChildIndexStatus } from './index-state.ts';
import { loadTrafficWindow } from './traffic-state.ts';
import { loadProjectHomeStats, summarizeWorkspace } from './home-state.ts';
import { loadAskConfigForView } from './ask-config-state.ts';
import { parseAndValidateAskConfig } from '../config.ts';
import {
  createCandidateFromRun,
  decideCandidate,
  flushApproved,
  loadCandidates,
  updateCandidate,
  type CandidateUpdate,
  type CreateFromRunInput,
} from './golden-workshop-state.ts';

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
    const projectStats = new Map<string, ReturnType<typeof loadProjectHomeStats>>();
    for (const p of projects) {
      projectStats.set(p.name, loadProjectHomeStats(deps.workspacePath, p));
    }
    const runningSet = new Set<string>();
    for (const [n, r] of running) if (!r.exited) runningSet.add(n);
    const workspaceSummary = summarizeWorkspace(
      deps.workspacePath,
      projects,
      runningSet,
      projectStats,
    );
    return c.html(
      renderHome({
        consolePort: deps.consolePort,
        idleTimeoutMin,
        projects,
        running,
        projectStats,
        workspaceSummary,
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
  // Project registry management
  // -----------------------------------------------------------------------

  app.post('/api/projects/add', async (c) => {
    let body: { path?: unknown; name?: unknown } | null = null;
    try {
      body = (await c.req.json()) as { path?: unknown; name?: unknown };
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body.path !== 'string' || body.path.trim().length === 0) {
      return c.json({ ok: false, error: 'body.path (string) required' }, 400);
    }

    const rawPath = body.path.trim();
    const expandedPath =
      rawPath === '~'
        ? homedir()
        : rawPath.startsWith('~/')
          ? join(homedir(), rawPath.slice(2))
          : resolve(rawPath);

    try {
      assertProjectRoot(expandedPath);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }

    const name =
      typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim()
        : basename(expandedPath);

    if (!isBareName(name)) {
      return c.json(
        { ok: false, error: `invalid project name '${name}' (must match [A-Za-z0-9_][A-Za-z0-9_.-]*)` },
        400,
      );
    }

    const existing = readProjectRegistry(deps.workspacePath);
    if (name in existing && existing[name] !== expandedPath) {
      return c.json(
        { ok: false, error: `name '${name}' already registered at ${existing[name]}` },
        409,
      );
    }

    addToProjectRegistry(deps.workspacePath, expandedPath, name);
    return c.json({ ok: true, name, path: expandedPath });
  });

  // DELETE /api/projects/:name?purge_state=true&force_stop=true
  //   purge_state (default true): also rm -rf the per-project state dir
  //     (<workspace>/state/<projectId>/) — index DB, eval reports, runs.
  //     Source markdown files at the project's path are NEVER touched.
  //   force_stop (default false): if the child runtime is live, send SIGTERM
  //     and continue. Without this flag, removing a running project returns
  //     409 so the UI can prompt the user before terminating live traffic.
  app.delete('/api/projects/:name', (c) => {
    const name = c.req.param('name');
    const purgeState = c.req.query('purge_state') !== 'false'; // default true
    const forceStop = c.req.query('force_stop') === 'true';

    // Capture the projectId BEFORE removing the registry entry — once it's
    // gone we can't resolve the state root (registry holds the path; state
    // root is derived from <projectRoot>/anydocs.config.json's projectId).
    const projects = scanProjects(deps.workspacePath);
    const project = projects.find((p) => p.name === name) ?? null;
    const port = deps.registry.getPort(name);
    const wasRunning = port !== null;

    if (wasRunning && !forceStop) {
      return c.json(
        {
          ok: false,
          error: `'${name}' is running on :${port}; pass force_stop=true to terminate first`,
          running: true,
          port,
        },
        409,
      );
    }

    if (wasRunning) {
      deps.registry.stop(name);
    }

    const removed = removeFromProjectRegistry(deps.workspacePath, name);
    if (!removed) {
      return c.json({ ok: false, error: `'${name}' not found in registry` }, 404);
    }

    let stateRemoved = false;
    let stateRoot: string | null = null;
    if (purgeState && project?.valid && project.projectId) {
      stateRoot = resolveStateRoot(deps.workspacePath, project.projectId);
      if (existsSync(stateRoot)) {
        try {
          rmSync(stateRoot, { recursive: true, force: true });
          stateRemoved = true;
        } catch (err) {
          // Registry entry is already gone; surface the partial failure but
          // don't 500 — the user's intent ("remove from console") succeeded.
          return c.json(
            {
              ok: true,
              name,
              registryRemoved: true,
              stateRemoved: false,
              stoppedFirst: wasRunning,
              warn: `state dir kept (could not delete ${stateRoot}: ${(err as Error).message})`,
            },
            200,
          );
        }
      }
    }

    return c.json({
      ok: true,
      name,
      registryRemoved: true,
      stateRemoved,
      stateRoot,
      stoppedFirst: wasRunning,
      purgeRequested: purgeState,
    });
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
      indexSnapshot = await loadIndexSnapshot(project.path, {
        ...(stateRoot ? { stateRoot } : {}),
      });
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
    const candidates = stateRoot ? loadCandidates(stateRoot) : undefined;
    const analyzeHistory = stateRoot ? listAnalyzeReports(stateRoot) : [];
    const latestAnalyzeBody =
      stateRoot && analyzeHistory[0]
        ? readAnalyzeReportBody(stateRoot, analyzeHistory[0].filename)
        : null;
    const askConfig = project.valid ? loadAskConfigForView(project.path) : undefined;
    const feedbackSnapshot = project.valid && askConfig
      ? loadFeedbackTabSnapshot(stateRoot, {
          feedback: { enabled: readFeedbackEnabled(askConfig.raw) },
        })
      : undefined;
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
        ...(feedbackSnapshot ? { feedbackSnapshot } : {}),
        ...(candidates ? { candidates } : {}),
        analyzeHistory,
        latestAnalyzeBody,
        askConfig,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Project-level anydocs.ask.json (full file) — read/write for the
  // Settings tab. POST writes the whole file (the Settings form
  // serializes every section), so there's no per-section endpoint.
  // -----------------------------------------------------------------------
  app.get('/api/projects/:name/ask-config', (c) => {
    const project = findProject(deps.workspacePath, c.req.param('name'));
    if (!project) {
      return c.json({ ok: false, error: `unknown project: ${c.req.param('name')}` }, 404);
    }
    if (!project.valid) {
      return c.json(
        { ok: false, error: `project '${project.name}' invalid (missing: ${project.missing.join(', ')})` },
        400,
      );
    }
    const path = join(project.path, 'anydocs.ask.json');
    if (!existsSync(path)) {
      return c.json({
        ok: true,
        path,
        exists: false,
        rawText: null,
        mtimeISO: null,
        warnings: [],
        parseError: null,
      });
    }
    let rawText: string;
    try {
      rawText = readFileSync(path, 'utf8');
    } catch (err) {
      return c.json({ ok: false, error: `read failed: ${(err as Error).message}` }, 500);
    }
    const mtimeISO = new Date(statSync(path).mtimeMs).toISOString();
    let warnings: string[] = [];
    let parseError: string | null = null;
    try {
      const result = parseAndValidateAskConfig(rawText);
      warnings = result.warnings;
    } catch (err) {
      parseError = (err as Error).message;
    }
    return c.json({ ok: true, path, exists: true, rawText, mtimeISO, warnings, parseError });
  });

  app.post('/api/projects/:name/ask-config', async (c) => {
    const project = findProject(deps.workspacePath, c.req.param('name'));
    if (!project) {
      return c.json({ ok: false, error: `unknown project: ${c.req.param('name')}` }, 404);
    }
    if (!project.valid) {
      return c.json(
        { ok: false, error: `project '${project.name}' invalid (missing: ${project.missing.join(', ')})` },
        400,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ ok: false, error: 'body must be a JSON object' }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.rawText !== 'string') {
      return c.json({ ok: false, error: 'rawText (string) is required' }, 400);
    }
    const path = join(project.path, 'anydocs.ask.json');
    // mtime guard — when the client passes the mtime it read, refuse to
    // overwrite a file that changed on disk meanwhile (another tab, CLI
    // edit, etc.). Clients can opt out by omitting the field.
    if (typeof obj.expectedMtimeISO === 'string' && existsSync(path)) {
      const currentMtime = new Date(statSync(path).mtimeMs).toISOString();
      if (currentMtime !== obj.expectedMtimeISO) {
        return c.json(
          {
            ok: false,
            error: 'file changed on disk since last load — refresh and retry',
            currentMtimeISO: currentMtime,
          },
          409,
        );
      }
    }
    let warnings: string[] = [];
    try {
      const result = parseAndValidateAskConfig(obj.rawText);
      warnings = result.warnings;
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    const text = obj.rawText.endsWith('\n') ? obj.rawText : `${obj.rawText}\n`;
    try {
      writeFileSync(path, text, 'utf8');
    } catch (err) {
      return c.json({ ok: false, error: `write failed: ${(err as Error).message}` }, 500);
    }
    const mtimeISO = new Date(statSync(path).mtimeMs).toISOString();
    return c.json({ ok: true, path, mtimeISO, warnings });
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

  // Feedback list — RFC 0002 T1-b. Drives the middle-list chip switcher.
  // KPI numbers + window aggregates do NOT change with filter (the chip is
  // a list cursor, not a KPI scope), so the response only carries the per-
  // filter row page + the updated `filterCounts` for chip badges.
  app.get('/api/projects/:name/feedback', (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    if (!project.valid) {
      return c.json(
        { ok: false, error: `project '${name}' invalid (missing: ${project.missing.join(', ')})` },
        400,
      );
    }
    const stateRoot = projectStateRoot(deps.workspacePath, project);
    if (!stateRoot) return c.json({ ok: false, error: 'no projectId' }, 400);
    const askConfig = loadAskConfigForView(project.path);
    const enabled = readFeedbackEnabled(askConfig.raw);
    const filter = parseFeedbackFilter(c.req.query('filter'));
    const limitRaw = c.req.query('limit');
    const limit = limitRaw !== undefined ? Number(limitRaw) || 50 : 50;
    const snapshot = loadFeedbackTabSnapshot(
      stateRoot,
      { feedback: { enabled } },
      { filter, limit },
    );
    return c.json({
      ok: true,
      enabled: snapshot.enabled,
      filter: snapshot.filter,
      rows: snapshot.rows,
      filterCounts: snapshot.filterCounts,
      hasMore: snapshot.hasMore,
      // RFC 0005 V5 — surface KPI so client-side filter swaps don't need to
      // re-render the SSR strip from scratch. Only the V5 tile reads this so
      // far; future KPI animations can pick up the full object.
      kpi: snapshot.kpi,
    });
  });

  // Per-row feedback detail — RFC 0002 T1-d. Drives the right-side drawer.
  // Returns the feedback row + linked run record (retrieval trace + answer
  // markdown + citations). Reuses the same loader stack as the list, plus
  // an additional runs.jsonl scan to recover the full RunRecord.
  app.get('/api/projects/:name/feedback/:id', (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) return c.json({ ok: false, error: `unknown project: ${name}` }, 404);
    if (!project.valid) {
      return c.json(
        { ok: false, error: `project '${name}' invalid (missing: ${project.missing.join(', ')})` },
        400,
      );
    }
    const stateRoot = projectStateRoot(deps.workspacePath, project);
    if (!stateRoot) return c.json({ ok: false, error: 'no projectId' }, 400);
    const idRaw = c.req.param('id');
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(id) || id <= 0 || String(id) !== idRaw) {
      return c.json({ ok: false, error: `invalid feedback id: ${idRaw}` }, 400);
    }
    const detail = loadFeedbackRowDetail(stateRoot, id);
    if (!detail) return c.json({ ok: false, error: `feedback row not found: ${id}` }, 404);
    return c.json({ ok: true, detail });
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
  // Ask feedback proxy — forwards 👍/👎 from the console Ask UI to the
  // child's /v1/ask/feedback. Requires a running child (no auto-spawn —
  // an answer_id only exists if an ask just happened, which means the
  // child is already up).
  // -----------------------------------------------------------------------
  app.post('/api/projects/:name/feedback', async (c) => {
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
    const port = deps.registry.getPort(name);
    if (port === null) {
      return c.json({ ok: false, error: 'project not running' }, 502);
    }
    deps.registry.touch(name);

    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch (err) {
      return c.json({ ok: false, error: `read body failed: ${(err as Error).message}` }, 400);
    }
    let res: Response;
    try {
      res = await fetchFn(`http://127.0.0.1:${port}/v1/ask/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      });
    } catch (err) {
      return c.json({ ok: false, error: `proxy failed: ${(err as Error).message}` }, 502);
    }
    const text = await res.text();
    return new Response(text, {
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

  // Streaming variant: NDJSON, one event per line. Lets the Eval-tab UI
  // show a real progress bar + "case N of M" while the loop runs, instead
  // of waiting 10–30s for the single /eval fetch to come back. Body shape
  // matches /eval (optional { baseline_path }).
  app.post('/api/projects/:name/eval/stream', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    let baselinePath: string | undefined;
    try {
      const body = (await c.req.json().catch(() => null)) as { baseline_path?: string } | null;
      if (body && typeof body.baseline_path === 'string' && body.baseline_path.length > 0) {
        if (!isReportFilename(body.baseline_path)) {
          return c.json({ ok: false, error: 'invalid baseline filename' }, 400);
        }
        baselinePath = join(ctx.stateRoot, 'reports', body.baseline_path);
      }
    } catch {
      // ignore — proceed with default baseline
    }
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return stream(c, async (s) => {
      await ops.evalStream(
        {
          projectRoot: ctx.projectRoot,
          stateRoot: ctx.stateRoot,
          ...(baselinePath ? { baselinePath } : {}),
        },
        (ev) => {
          void s.write(JSON.stringify(ev) + '\n');
        },
      );
    });
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
    let includeConsole = c.req.query('include_console') === '1';
    try {
      const body = (await c.req.json().catch(() => null)) as
        | { include_console?: boolean }
        | null;
      if (body && body.include_console === true) includeConsole = true;
    } catch {
      // ignore — no body or non-JSON
    }
    const r = await ops.analyzeRuns({
      projectRoot: ctx.projectRoot,
      stateRoot: ctx.stateRoot,
      ...(since ? { since } : {}),
      ...(includeConsole ? { includeConsole: true } : {}),
    });
    return c.json(r, r.ok ? 200 : 500);
  });

  // --- Golden Workshop: candidate decide + flush (PRD §13.6 #4 lock
  //     broken 2026-05-12: console writes decision field into the
  //     candidate jsonl, then flush == golden review CLI equivalent).
  app.post('/api/projects/:name/golden/decide', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    let body: { id?: unknown; decision?: unknown } | null = null;
    try {
      body = (await c.req.json()) as { id?: unknown; decision?: unknown };
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body.id !== 'string') {
      return c.json({ ok: false, error: 'body.id (string) required' }, 400);
    }
    const d = body.decision;
    if (d !== null && d !== 'approved' && d !== 'rejected') {
      return c.json({ ok: false, error: 'body.decision must be null|approved|rejected' }, 400);
    }
    const r = decideCandidate(ctx.stateRoot, body.id, d);
    if (!r.ok) return c.json({ ok: false, error: r.error }, 404);
    return c.json({ ok: true, before: r.before, after: r.after });
  });

  // Console-only edit: mutate non-provenance fields of one candidate row.
  // CLI counterpart would be hand-editing cases.candidate.jsonl; this
  // endpoint validates the patch then atomically rewrites the file.
  app.post('/api/projects/:name/golden/candidate/update', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    let body: { id?: unknown; patch?: unknown } | null = null;
    try {
      body = (await c.req.json()) as { id?: unknown; patch?: unknown };
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body.id !== 'string') {
      return c.json({ ok: false, error: 'body.id (string) required' }, 400);
    }
    if (!body.patch || typeof body.patch !== 'object') {
      return c.json({ ok: false, error: 'body.patch (object) required' }, 400);
    }
    const r = updateCandidate(ctx.stateRoot, body.id, body.patch as CandidateUpdate);
    if (!r.ok) {
      const code = /not found/.test(r.error) ? 404 : 400;
      return c.json({ ok: false, error: r.error }, code);
    }
    return c.json({ ok: true, updated: r.updated });
  });

  // RFC 0002 T2 cross-journey jump: promote one Traffic run into a pending
  // Golden candidate. Idempotent on normalized query — clicking twice on the
  // same run returns isNew=false instead of duplicating the row. Author still
  // reviews via existing approve/reject flow (PRD §11.2 decision ③ unbroken).
  app.post('/api/projects/:name/golden/candidate/create-from-run', async (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    let body: Partial<CreateFromRunInput> | null = null;
    try {
      body = (await c.req.json()) as Partial<CreateFromRunInput>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body.query !== 'string' || body.query.trim().length === 0) {
      return c.json({ ok: false, error: 'body.query (non-empty string) required' }, 400);
    }
    const r = createCandidateFromRun(ctx.stateRoot, body as CreateFromRunInput);
    if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
    return c.json({ ok: true, created: r.created, isNew: r.isNew });
  });

  app.post('/api/projects/:name/golden/flush', (c) => {
    const ctx = resolveOpContext(deps.workspacePath, c.req.param('name'));
    if ('error' in ctx) return c.json({ ok: false, error: ctx.error }, ctx.status);
    try {
      const summary = flushApproved(ctx.stateRoot, 'console');
      return c.json({ ok: true, summary });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // Blocking variant — the UI now uses the streaming endpoint below, but this
  // route stays for external API callers and CI scripts that want a single
  // request/response without parsing NDJSON. Same defaults, same result shape;
  // long-running rewrites just hold the connection open until completion.
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
      // Console default: LLM rewrite on for higher-quality candidates, but
      // auto-degrade to template-only when creds are missing or the call
      // fails. The CLI keeps strict "report don't fudge" semantics — see
      // commands/golden.ts fallbackOnLlmError docstring.
      llmRewrite: true,
      fallbackOnLlmError: true,
      force: false,
    });
    return c.json(r, r.ok ? 200 : 500);
  });

  // Streaming variant: NDJSON, one event per line. The UI uses this so the
  // user can watch project-load → templates → per-batch LLM progress unfold
  // (especially for big projects where the LLM rewrite phase can be 30-60s).
  app.post('/api/projects/:name/golden/generate/stream', async (c) => {
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
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Disable any intermediate buffering — proxies/CDNs sometimes hold
    // chunked responses; the dev console is local so we still set this for
    // correctness if someone proxies through nginx.
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return stream(c, async (s) => {
      await ops.goldenGenerateStream(
        {
          projectRoot: ctx.projectRoot,
          stateRoot: ctx.stateRoot,
          from: fromRaw,
          ...(limit !== undefined ? { limit } : {}),
          llmRewrite: true,
          fallbackOnLlmError: true,
          force: false,
        },
        (ev) => {
          // Fire-and-forget; Hono buffers and flushes per write. The await
          // returns a promise that resolves when the chunk is pushed to the
          // underlying socket — we don't need to block per-event.
          void s.write(JSON.stringify(ev) + '\n');
        },
      );
    });
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

/**
 * Read `feedback.enabled` from the raw anydocs.ask.json object. Returns
 * false (PRD §11.4 #6 default) when the file is missing/malformed or the
 * field is absent / not a boolean. Trusts only `=== true` so any junk
 * value falls back to "off".
 */
function readFeedbackEnabled(raw: Record<string, unknown> | null): boolean {
  if (!raw) return false;
  const fb = raw['feedback'];
  if (typeof fb !== 'object' || fb === null) return false;
  return (fb as Record<string, unknown>)['enabled'] === true;
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
