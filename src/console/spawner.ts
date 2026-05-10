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
    const args = [
      ...process.execArgv,
      process.argv[1]!,
      '--workspace',
      workspacePath,
      'serve',
      name,
      '--port',
      String(port),
    ];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false,
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

export const __tests = { sleep, wrapChild };
