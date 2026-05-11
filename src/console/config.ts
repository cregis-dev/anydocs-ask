/**
 * v1 dev console workspace-level config — ARCH §17.6.
 *
 * Lives at `<workspace>/.console.json` (NOT per-project anydocs.ask.json).
 * The console is a meta layer above projects, so port range / idle policy
 * is workspace-scoped.
 *
 * Loading: file absent → built-in defaults; bad JSON or invalid types →
 * throw with a clear message. CLI flag overrides apply on top in
 * runConsole(), not here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ConsoleConfig = {
  enabled: boolean;
  port: number;
  idleTimeoutMin: number;
  childPortRangeStart: number;
  childPortRangeEnd: number;
  /**
   * How long (ms) we wait for a freshly spawned child to bind its port
   * and respond to /v1/health (200 or 503 both count). Default 30s
   * accommodates dev mode TS strip-types load + first-run reindex; real
   * docs may want to raise it. Lower if you want failures to surface
   * faster.
   */
  childHealthTimeoutMs: number;
};

export const CONSOLE_DEFAULTS: Readonly<ConsoleConfig> = Object.freeze({
  enabled: true,
  port: 4100,
  idleTimeoutMin: 15,
  childPortRangeStart: 4101,
  childPortRangeEnd: 4199,
  childHealthTimeoutMs: 30_000,
});

const CONFIG_FILENAME = '.console.json';

export function consoleConfigPath(workspacePath: string): string {
  return join(workspacePath, CONFIG_FILENAME);
}

export function loadConsoleConfig(workspacePath: string): ConsoleConfig {
  const path = consoleConfigPath(workspacePath);
  if (!existsSync(path)) return { ...CONSOLE_DEFAULTS };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: invalid JSON (${(err as Error).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object`);
  }
  return mergeConfig(raw as Record<string, unknown>, path);
}

function mergeConfig(over: Record<string, unknown>, path: string): ConsoleConfig {
  const out: ConsoleConfig = { ...CONSOLE_DEFAULTS };
  if ('enabled' in over) out.enabled = expectBool(over.enabled, 'enabled', path);
  if ('port' in over) out.port = expectPort(over.port, 'port', path);
  if ('idleTimeoutMin' in over) {
    out.idleTimeoutMin = expectInt(over.idleTimeoutMin, 'idleTimeoutMin', path, 1);
  }
  if ('childPortRangeStart' in over) {
    out.childPortRangeStart = expectPort(over.childPortRangeStart, 'childPortRangeStart', path);
  }
  if ('childPortRangeEnd' in over) {
    out.childPortRangeEnd = expectPort(over.childPortRangeEnd, 'childPortRangeEnd', path);
  }
  if ('childHealthTimeoutMs' in over) {
    out.childHealthTimeoutMs = expectInt(
      over.childHealthTimeoutMs,
      'childHealthTimeoutMs',
      path,
      1000,
    );
  }
  if (out.childPortRangeStart > out.childPortRangeEnd) {
    throw new Error(
      `${path}: childPortRangeStart (${out.childPortRangeStart}) > childPortRangeEnd (${out.childPortRangeEnd})`,
    );
  }
  if (out.port >= out.childPortRangeStart && out.port <= out.childPortRangeEnd) {
    throw new Error(
      `${path}: port ${out.port} is inside childPortRange [${out.childPortRangeStart}, ${out.childPortRangeEnd}]; pick a port outside the child range`,
    );
  }
  return out;
}

function expectBool(v: unknown, name: string, path: string): boolean {
  if (typeof v !== 'boolean') {
    throw new Error(`${path}: ${name} must be a boolean (got ${describe(v)})`);
  }
  return v;
}

function expectInt(v: unknown, name: string, path: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`${path}: ${name} must be an integer (got ${describe(v)})`);
  }
  if (v < min) {
    throw new Error(`${path}: ${name} must be ≥ ${min} (got ${v})`);
  }
  return v;
}

function expectPort(v: unknown, name: string, path: string): number {
  const n = expectInt(v, name, path, 1);
  if (n > 65535) {
    throw new Error(`${path}: ${name} must be ≤ 65535 (got ${n})`);
  }
  return n;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
