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

  return app;
}

function runningMap(list: RegisteredProcess[]): Map<string, RegisteredProcess> {
  const m = new Map<string, RegisteredProcess>();
  for (const e of list) m.set(e.name, e);
  return m;
}
