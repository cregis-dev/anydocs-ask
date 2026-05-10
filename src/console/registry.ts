/**
 * ProcessRegistry — manages `anydocs-ask serve <name>` child processes
 * for the v1 dev console (ARCH §17.2).
 *
 * Strategy: lazy spawn on first request, idle reap after N minutes.
 * Each project gets a port from `[childPortRangeStart, childPortRangeEnd]`.
 *
 * Spawner + healthProbe are injected so unit tests can drive the registry
 * without booting real ask processes. The production wiring lives in
 * `createNodeSpawner` / `httpHealthProbe` (used by runConsole; not
 * exercised in unit tests — that's an integration concern).
 *
 * Design notes:
 *   - Per ARCH §17.2.3 the registry deliberately does NOT import ask
 *     modules in-process. Each child is its own OS process.
 *   - reapIdle() is the workhorse for idle eviction. The owner schedules
 *     it (e.g. setInterval(60s)) — the registry has no timer of its own
 *     so tests stay deterministic.
 *   - Ports are tracked internally; we don't probe the OS. If the
 *     operator manually starts a server in 4101–4199 the spawn will fail
 *     at child startup; that's loud and acceptable.
 */

export type SpawnArgs = {
  name: string;
  port: number;
  workspacePath: string;
};

export type Spawnable = {
  pid: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  /**
   * Subscribe to child exit. The listener fires once with the exit code
   * (or null if killed by a signal). After exit, the registry treats the
   * entry as dead.
   */
  onExit: (listener: (code: number | null) => void) => void;
};

export type Spawner = (args: SpawnArgs) => Spawnable;
export type HealthProbe = (port: number, timeoutMs: number) => Promise<boolean>;

export type RegisteredProcess = {
  name: string;
  pid: number;
  port: number;
  startedAt: number;
  lastUsedAt: number;
  exited: boolean;
};

export type RegistryConfig = {
  childPortRangeStart: number;
  childPortRangeEnd: number;
  idleTimeoutMin: number;
  /** Health probe deadline after spawn; defaults to 5s. */
  healthTimeoutMs?: number;
};

export type RegistryDeps = {
  spawner: Spawner;
  healthProbe: HealthProbe;
  config: RegistryConfig;
  workspacePath: string;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** stderr sink for non-fatal diagnostics; defaults to process.stderr. */
  warn?: (msg: string) => void;
};

export type StartResult =
  | { ok: true; port: number; reused: boolean }
  | { ok: false; error: string };

type Entry = {
  name: string;
  port: number;
  child: Spawnable;
  startedAt: number;
  lastUsedAt: number;
  exited: boolean;
};

export class ProcessRegistry {
  private byName = new Map<string, Entry>();
  private now: () => number;
  private warn: (msg: string) => void;
  private deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((m) => process.stderr.write(m));
  }

  /**
   * Start a project's serve subprocess. Idempotent: if already running and
   * not exited, returns the existing port and updates lastUsedAt.
   */
  async start(name: string): Promise<StartResult> {
    const existing = this.byName.get(name);
    if (existing && !existing.exited) {
      existing.lastUsedAt = this.now();
      return { ok: true, port: existing.port, reused: true };
    }
    if (existing && existing.exited) {
      // Stale entry from a previous spawn that died. Drop it before
      // re-allocating so the port goes back to the pool.
      this.byName.delete(name);
    }

    const port = this.allocatePort();
    if (port === null) {
      return {
        ok: false,
        error: `no free child port in [${this.deps.config.childPortRangeStart}, ${this.deps.config.childPortRangeEnd}]`,
      };
    }

    let child: Spawnable;
    try {
      child = this.deps.spawner({ name, port, workspacePath: this.deps.workspacePath });
    } catch (err) {
      return { ok: false, error: `spawn failed: ${(err as Error).message}` };
    }

    const entry: Entry = {
      name,
      port,
      child,
      startedAt: this.now(),
      lastUsedAt: this.now(),
      exited: false,
    };
    this.byName.set(name, entry);

    child.onExit((code) => {
      entry.exited = true;
      if (code !== 0 && code !== null) {
        this.warn(`[console] child '${name}' exited with code ${code}\n`);
      }
    });

    const healthy = await this.deps.healthProbe(
      port,
      this.deps.config.healthTimeoutMs ?? 5000,
    );
    if (!healthy) {
      // Child failed to come up. Kill it and remove from registry so the
      // port is freed.
      try {
        child.kill('SIGTERM');
      } catch {
        // child may already be dead
      }
      this.byName.delete(name);
      return { ok: false, error: `child '${name}' did not become healthy within deadline` };
    }

    return { ok: true, port, reused: false };
  }

  /**
   * Stop a named child. Sends SIGTERM and removes the entry. No-op if the
   * child is unknown or already exited.
   */
  stop(name: string): boolean {
    const entry = this.byName.get(name);
    if (!entry) return false;
    if (!entry.exited) {
      try {
        entry.child.kill('SIGTERM');
      } catch {
        // Already gone — accept.
      }
    }
    this.byName.delete(name);
    return true;
  }

  /**
   * Touch lastUsedAt so reapIdle() defers eviction. Caller is expected to
   * touch on every proxy hit (ask, eval trigger, etc).
   */
  touch(name: string): void {
    const entry = this.byName.get(name);
    if (entry && !entry.exited) {
      entry.lastUsedAt = this.now();
    }
  }

  getPort(name: string): number | null {
    const entry = this.byName.get(name);
    if (!entry || entry.exited) return null;
    return entry.port;
  }

  list(): RegisteredProcess[] {
    const out: RegisteredProcess[] = [];
    for (const e of this.byName.values()) {
      out.push({
        name: e.name,
        pid: e.child.pid,
        port: e.port,
        startedAt: e.startedAt,
        lastUsedAt: e.lastUsedAt,
        exited: e.exited,
      });
    }
    return out;
  }

  /**
   * Sweep idle entries. Returns the names that were reaped. Caller is
   * expected to schedule periodic invocation (e.g. setInterval 60s in
   * runConsole).
   */
  reapIdle(): string[] {
    const idleMs = this.deps.config.idleTimeoutMin * 60_000;
    const now = this.now();
    const reaped: string[] = [];
    for (const [name, entry] of this.byName) {
      if (entry.exited) {
        // Drop already-dead entries opportunistically.
        this.byName.delete(name);
        reaped.push(name);
        continue;
      }
      if (now - entry.lastUsedAt > idleMs) {
        try {
          entry.child.kill('SIGTERM');
        } catch {
          // accept
        }
        this.byName.delete(name);
        reaped.push(name);
      }
    }
    return reaped;
  }

  /**
   * Send SIGTERM to all children and clear the registry. Called from
   * runConsole's SIGINT/SIGTERM handler. Does not await child exit;
   * caller can give them a brief grace period before forcing.
   */
  shutdownAll(): string[] {
    const names: string[] = [];
    for (const [name, entry] of this.byName) {
      if (!entry.exited) {
        try {
          entry.child.kill('SIGTERM');
        } catch {
          // accept
        }
      }
      names.push(name);
    }
    this.byName.clear();
    return names;
  }

  private allocatePort(): number | null {
    const used = new Set<number>();
    for (const e of this.byName.values()) {
      if (!e.exited) used.add(e.port);
    }
    const { childPortRangeStart, childPortRangeEnd } = this.deps.config;
    for (let p = childPortRangeStart; p <= childPortRangeEnd; p++) {
      if (!used.has(p)) return p;
    }
    return null;
  }
}
