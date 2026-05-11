/**
 * `anydocs-ask console` — the v1 internal dev console.
 *
 * Boots a Hono app on 127.0.0.1:<configPort>, spawns project serve
 * subprocesses lazily on demand, reaps idle children. Per ARCH §17.1
 * binding is hardcoded to loopback; there is no --host flag.
 */

import { serve as nodeServe } from '@hono/node-server';
import { join } from 'node:path';
import { loadConsoleConfig, type ConsoleConfig } from '../console/config.ts';
import { ProcessRegistry } from '../console/registry.ts';
import { createNodeSpawner, httpHealthProbe } from '../console/spawner.ts';
import { createConsoleApp } from '../console/server.ts';
import { ensureWorkspace, type WorkspaceResolution } from '../workspace.ts';

export type ConsoleOptions = {
  workspace: WorkspaceResolution;
  /** CLI flag override; undefined = use config / default. */
  port?: number;
  /** CLI flag override (minutes). */
  idleTimeoutMin?: number;
};

const REAP_INTERVAL_MS = 60_000;

export async function runConsole(opts: ConsoleOptions): Promise<number> {
  const { workspace } = opts;
  ensureWorkspace(workspace.path);

  let config: ConsoleConfig;
  try {
    config = loadConsoleConfig(workspace.path);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  if (!config.enabled) {
    process.stderr.write(
      `error: console disabled in ${join(workspace.path, '.console.json')} (enabled: false)\n` +
        `       remove the file or set "enabled": true to use 'anydocs-ask console'.\n`,
    );
    return 2;
  }

  if (opts.port !== undefined) config.port = opts.port;
  if (opts.idleTimeoutMin !== undefined) config.idleTimeoutMin = opts.idleTimeoutMin;
  if (config.port >= config.childPortRangeStart && config.port <= config.childPortRangeEnd) {
    process.stderr.write(
      `error: --port ${config.port} falls inside child range [${config.childPortRangeStart}, ${config.childPortRangeEnd}]; pick a port outside the child range\n`,
    );
    return 2;
  }

  const registry = new ProcessRegistry({
    spawner: createNodeSpawner(),
    healthProbe: httpHealthProbe,
    config: {
      childPortRangeStart: config.childPortRangeStart,
      childPortRangeEnd: config.childPortRangeEnd,
      idleTimeoutMin: config.idleTimeoutMin,
      healthTimeoutMs: config.childHealthTimeoutMs,
    },
    workspacePath: workspace.path,
  });

  const app = createConsoleApp({
    workspacePath: workspace.path,
    consolePort: config.port,
    idleTimeoutMin: config.idleTimeoutMin,
    registry,
  });

  let httpResolve!: (code: number) => void;
  const httpDone = new Promise<number>((r) => {
    httpResolve = r;
  });

  const server = nodeServe(
    { fetch: app.fetch, hostname: '127.0.0.1', port: config.port },
    (info) => {
      process.stdout.write(
        `anydocs-ask console listening on http://${info.address}:${info.port}\n` +
          `  workspace · ${workspace.path}\n` +
          `  child range · ${config.childPortRangeStart}–${config.childPortRangeEnd}\n` +
          `  idle reap · ${config.idleTimeoutMin}min\n`,
      );
    },
  );

  const reapTimer = setInterval(() => {
    const reaped = registry.reapIdle();
    for (const name of reaped) {
      process.stdout.write(`[console] reaped idle child '${name}'\n`);
    }
  }, REAP_INTERVAL_MS);
  // Don't keep the event loop alive on this timer alone.
  reapTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nreceived ${signal}, shutting down children...\n`);
    clearInterval(reapTimer);
    const names = registry.shutdownAll();
    if (names.length > 0) {
      process.stdout.write(`  killed: ${names.join(', ')}\n`);
    }
    server.close(() => {
      httpResolve(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return await httpDone;
}
