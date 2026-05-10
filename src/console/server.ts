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

import { Hono } from 'hono';
import { scanProjects, type ProjectListing } from '../workspace.ts';
import type { ProcessRegistry, RegisteredProcess } from './registry.ts';
import { renderHome } from './pages/home.ts';
import { renderProject } from './pages/project.ts';

export type ConsoleAppDeps = {
  workspacePath: string;
  consolePort: number;
  registry: ProcessRegistry;
};

export type ProjectStatusJSON = ProjectListing & {
  running: boolean;
  port: number | null;
  pid: number | null;
};

export function createConsoleApp(deps: ConsoleAppDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const projects = scanProjects(deps.workspacePath);
    const running = runningMap(deps.registry.list());
    return c.html(
      renderHome({
        workspacePath: deps.workspacePath,
        consolePort: deps.consolePort,
        projects,
        running,
      }),
    );
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

  app.get('/p/:name', (c) => {
    const name = c.req.param('name');
    const project = findProject(deps.workspacePath, name);
    if (!project) {
      return c.text(`unknown project: ${name}`, 404);
    }
    const running = deps.registry.list().find((e) => e.name === name && !e.exited) ?? null;
    return c.html(renderProject({ project, running }));
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

  return app;
}

function findProject(workspacePath: string, name: string): ProjectListing | null {
  const projects = scanProjects(workspacePath);
  return projects.find((p) => p.name === name) ?? null;
}

function runningMap(list: RegisteredProcess[]): Map<string, RegisteredProcess> {
  const m = new Map<string, RegisteredProcess>();
  for (const e of list) m.set(e.name, e);
  return m;
}
