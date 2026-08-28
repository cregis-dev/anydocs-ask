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
import {
  AttachedProcessRegistry,
  ProcessRegistry,
  type ConsoleProcessRegistry,
} from '../console/registry.ts';
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

  const consoleHost = process.env.ANYDOCS_CONSOLE_HOST?.trim() || '127.0.0.1';
  const authToken = process.env.ANYDOCS_CONSOLE_AUTH_TOKEN?.trim() || null;
  if (!isLoopbackHost(consoleHost) && authToken === null) {
    process.stderr.write(
      'error: ANYDOCS_CONSOLE_AUTH_TOKEN is required when Console listens outside loopback\n',
    );
    return 2;
  }
  if (authToken !== null && authToken.length < 16) {
    process.stderr.write('error: ANYDOCS_CONSOLE_AUTH_TOKEN must contain at least 16 characters\n');
    return 2;
  }

  let registry: ConsoleProcessRegistry;
  const attachedName = process.env.ANYDOCS_CONSOLE_ATTACHED_PROJECT?.trim();
  const attachedPortRaw = process.env.ANYDOCS_CONSOLE_ATTACHED_PORT?.trim();
  if ((attachedName && !attachedPortRaw) || (!attachedName && attachedPortRaw)) {
    process.stderr.write(
      'error: ANYDOCS_CONSOLE_ATTACHED_PROJECT and ANYDOCS_CONSOLE_ATTACHED_PORT must be configured together\n',
    );
    return 2;
  }
  if (attachedName && attachedPortRaw) {
    const attachedPort = Number(attachedPortRaw);
    if (!Number.isInteger(attachedPort) || attachedPort < 1 || attachedPort > 65535) {
      process.stderr.write('error: ANYDOCS_CONSOLE_ATTACHED_PORT must be a valid TCP port\n');
      return 2;
    }
    registry = new AttachedProcessRegistry(attachedName, attachedPort);
  } else {
    registry = new ProcessRegistry({
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
  }

  // Workspace-level MCP bearer token for the `/mcp/:name` proxy (CAWP mount,
  // ADR-038). Optional: unset = open proxy (loopback / trusted-network).
  const mcpToken = process.env.ANYDOCS_CONSOLE_MCP_TOKEN?.trim() || null;

  const app = createConsoleApp({
    workspacePath: workspace.path,
    consolePort: config.port,
    idleTimeoutMin: config.idleTimeoutMin,
    registry,
    mcpToken,
    authToken,
    publicRootPath: process.env.ANYDOCS_CONSOLE_PUBLIC_ROOT,
  });

  let httpResolve!: (code: number) => void;
  const httpDone = new Promise<number>((r) => {
    httpResolve = r;
  });

  const server = nodeServe(
    { fetch: app.fetch, hostname: consoleHost, port: config.port },
    (info) => {
      process.stdout.write(
        `anydocs-ask console listening on http://${info.address}:${info.port}\n` +
          `  workspace · ${workspace.path}\n` +
          `  bind · ${consoleHost}\n` +
          `  auth · ${authToken ? 'token' : 'loopback only'}\n` +
          (attachedName ? `  attached · ${attachedName}:${attachedPortRaw}\n` : '') +
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

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
