/**
 * Production wiring for ProcessRegistry — Node child_process based
 * spawner + HTTP-based health probe. Kept separate from registry.ts so
 * unit tests don't drag in real subprocess machinery.
 *
 * Spawn strategy (ARCH §17.2):
 *   `<execPath> <execArgv...> <process.argv[1]> --workspace <ws>
 *      serve <name> --port <port>`
 *
 * Reusing process.argv[1] lets dev (`pnpm dev console`) and production
 * (`anydocs-ask console` via bin shim) share the same code path —
 * whichever entrypoint started us is the one we re-invoke for children.
 *
 * Stdio is inherited so the developer sees child boot logs / errors in
 * the same terminal as the console; that's appropriate for an internal
 * dev tool.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Spawnable, Spawner, HealthProbe } from './registry.ts';

export function createNodeSpawner(): Spawner {
  return ({ name, port, workspacePath }) => {
    // Order matters: parseArgs in cli.ts treats argv[2] as the command, so
    // `serve` must come before any --flag. Subcommand positional (the
    // project name) immediately follows. Flags can appear in any order
    // after that.
    const args = [
      ...process.execArgv,
      process.argv[1]!,
      'serve',
      name,
      '--port',
      String(port),
      '--workspace',
      workspacePath,
    ];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false,
      // Console-managed children always serve the retrieval MCP so CAWP can
      // mount the project via the console `/mcp/:name` proxy with no
      // per-project config (ADR-038). Auth is enforced once at the console
      // proxy; the child binds loopback and is only reachable through the
      // proxy, so its own MCP token is explicitly cleared (open on loopback)
      // — never inherit the console's ANYDOCS_CONSOLE_MCP_TOKEN here.
      env: {
        ...process.env,
        ANYDOCS_MCP_ENABLED: '1',
        ANYDOCS_MCP_TOOLS: 'search,fetch_page',
        ANYDOCS_MCP_TOKEN: '',
      },
    });
    return wrapChild(child);
  };
}

function wrapChild(child: ChildProcess): Spawnable {
  return {
    get pid(): number {
      return child.pid ?? 0;
    },
    kill: (signal) => child.kill(signal),
    onExit: (listener) => {
      child.once('exit', (code) => listener(code));
    },
  };
}

/**
 * Probe success = HTTP responds with 200 OR 503. /v1/health returns 503
 * while the runtime is warming up; for the registry we only need to know
 * the child is *listening*, not yet warm. The console UI polls health
 * separately to surface warm-up progress.
 */
export function httpHealthProbe(port: number, timeoutMs: number): Promise<boolean> {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}/v1/health`;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(500) });
        if (res.status === 200 || res.status === 503) return true;
        // any other status: keep retrying — child might be flapping
      } catch {
        // connect refused / DNS / timeout — keep retrying
      }
      await sleep(150);
    }
    return false;
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
