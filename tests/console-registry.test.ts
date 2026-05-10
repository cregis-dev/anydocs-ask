/**
 * ProcessRegistry unit tests — port allocation, idle reap, dedupe,
 * shutdown semantics. Spawner + healthProbe are stubbed; this file does
 * NOT spawn real processes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProcessRegistry,
  type Spawnable,
  type SpawnArgs,
  type RegistryConfig,
} from '../src/console/registry.ts';

class FakeChild implements Spawnable {
  pid: number;
  killed = false;
  killSignal: NodeJS.Signals | undefined;
  private exitListener: ((code: number | null) => void) | null = null;
  exited = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }

  /** Simulate child exiting from outside (e.g. crash). */
  fireExit(code: number | null): void {
    this.exited = true;
    if (this.exitListener) this.exitListener(code);
  }
}

type Harness = {
  registry: ProcessRegistry;
  spawned: Array<{ args: SpawnArgs; child: FakeChild }>;
  setHealth: (ok: boolean) => void;
  advanceTimeMs: (delta: number) => void;
  warnings: string[];
};

function makeHarness(overrides: Partial<RegistryConfig> = {}): Harness {
  const config: RegistryConfig = {
    childPortRangeStart: 4101,
    childPortRangeEnd: 4103, // tiny range to test exhaustion easily
    idleTimeoutMin: 15,
    healthTimeoutMs: 100,
    ...overrides,
  };
  const spawned: Array<{ args: SpawnArgs; child: FakeChild }> = [];
  let nextPid = 1000;
  let healthOk = true;
  const warnings: string[] = [];
  let nowMs = 1_000_000;
  const registry = new ProcessRegistry({
    config,
    workspacePath: '/tmp/fake-ws',
    spawner: (args) => {
      const child = new FakeChild(nextPid++);
      spawned.push({ args, child });
      return child;
    },
    healthProbe: async () => healthOk,
    now: () => nowMs,
    warn: (m) => warnings.push(m),
  });
  return {
    registry,
    spawned,
    setHealth: (ok) => {
      healthOk = ok;
    },
    advanceTimeMs: (d) => {
      nowMs += d;
    },
    warnings,
  };
}

test('start: first call spawns, allocates lowest free port', async () => {
  const h = makeHarness();
  const r = await h.registry.start('docs-zh');
  assert.deepEqual(r, { ok: true, port: 4101, reused: false });
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0]!.args.name, 'docs-zh');
  assert.equal(h.spawned[0]!.args.port, 4101);
});

test('start: same name twice → reused, no new spawn, lastUsedAt updated', async () => {
  const h = makeHarness();
  await h.registry.start('docs-zh');
  h.advanceTimeMs(1000);
  const r = await h.registry.start('docs-zh');
  assert.deepEqual(r, { ok: true, port: 4101, reused: true });
  assert.equal(h.spawned.length, 1);
  // touched: lastUsedAt should reflect the second call
  const list = h.registry.list();
  assert.equal(list.length, 1);
  assert.ok(list[0]!.lastUsedAt > list[0]!.startedAt);
});

test('start: different names get different ports in order', async () => {
  const h = makeHarness();
  const a = await h.registry.start('a');
  const b = await h.registry.start('b');
  const c = await h.registry.start('c');
  assert.equal(a.ok && a.port, 4101);
  assert.equal(b.ok && b.port, 4102);
  assert.equal(c.ok && c.port, 4103);
});

test('start: range exhausted returns error without spawning', async () => {
  const h = makeHarness();
  await h.registry.start('a');
  await h.registry.start('b');
  await h.registry.start('c');
  const fourth = await h.registry.start('d');
  assert.equal(fourth.ok, false);
  assert.equal(h.spawned.length, 3);
  if (!fourth.ok) {
    assert.match(fourth.error, /no free child port/);
  }
});

test('start: failed health probe kills child and frees port', async () => {
  const h = makeHarness();
  h.setHealth(false);
  const r = await h.registry.start('a');
  assert.equal(r.ok, false);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0]!.child.killed, true);
  assert.equal(h.spawned[0]!.child.killSignal, 'SIGTERM');
  // Port 4101 should be reusable now.
  h.setHealth(true);
  const r2 = await h.registry.start('a');
  assert.equal(r2.ok && r2.port, 4101);
});

test('start: stale exited entry is replaced', async () => {
  const h = makeHarness();
  await h.registry.start('a');
  h.spawned[0]!.child.fireExit(1);
  // After crash, registry still holds the entry until next interaction.
  // start('a') again should detect exited + replace.
  const r = await h.registry.start('a');
  assert.equal(r.ok && r.port, 4101); // port reused after stale drop
  assert.equal(h.spawned.length, 2);
  // crash warning surfaced
  assert.ok(h.warnings.some((w) => /exited with code 1/.test(w)));
});

test('stop: sends SIGTERM, frees port', async () => {
  const h = makeHarness();
  await h.registry.start('a');
  const ok = h.registry.stop('a');
  assert.equal(ok, true);
  assert.equal(h.spawned[0]!.child.killSignal, 'SIGTERM');
  assert.equal(h.registry.getPort('a'), null);
  // Port reusable after stop
  const r = await h.registry.start('b');
  assert.equal(r.ok && r.port, 4101);
});

test('stop: unknown name returns false', () => {
  const h = makeHarness();
  assert.equal(h.registry.stop('nope'), false);
});

test('touch: defers idle reap', async () => {
  const h = makeHarness({ idleTimeoutMin: 1 }); // 60_000 ms
  await h.registry.start('a');
  h.advanceTimeMs(50_000); // not yet idle
  h.registry.touch('a');
  h.advanceTimeMs(50_000); // total since start = 100s but since touch = 50s
  assert.deepEqual(h.registry.reapIdle(), []);
});

test('reapIdle: kills entries idle past threshold', async () => {
  const h = makeHarness({ idleTimeoutMin: 1 });
  await h.registry.start('a');
  await h.registry.start('b');
  h.advanceTimeMs(50_000);
  h.registry.touch('b'); // b stays fresh
  h.advanceTimeMs(20_000); // a now 70s idle, b 20s
  const reaped = h.registry.reapIdle();
  assert.deepEqual(reaped, ['a']);
  assert.equal(h.spawned.find((s) => s.args.name === 'a')!.child.killSignal, 'SIGTERM');
  assert.equal(h.registry.getPort('a'), null);
  assert.equal(h.registry.getPort('b'), 4102);
});

test('reapIdle: drops already-exited entries without killing', async () => {
  const h = makeHarness();
  await h.registry.start('a');
  h.spawned[0]!.child.fireExit(0);
  h.spawned[0]!.child.killed = false; // reset to detect any spurious kill
  const reaped = h.registry.reapIdle();
  assert.deepEqual(reaped, ['a']);
  assert.equal(h.spawned[0]!.child.killed, false); // already dead, no kill
});

test('list: snapshots all entries with pid/port/timestamps', async () => {
  const h = makeHarness();
  await h.registry.start('a');
  await h.registry.start('b');
  const list = h.registry.list();
  assert.equal(list.length, 2);
  const names = list.map((e) => e.name).sort();
  assert.deepEqual(names, ['a', 'b']);
  for (const e of list) {
    assert.ok(e.pid >= 1000);
    assert.ok(e.startedAt > 0);
    assert.ok(e.port >= 4101 && e.port <= 4103);
    assert.equal(e.exited, false);
  }
});

test('shutdownAll: kills every live child and clears registry', async () => {
  const h = makeHarness();
  await h.registry.start('a');
  await h.registry.start('b');
  const names = h.registry.shutdownAll();
  assert.deepEqual(names.sort(), ['a', 'b']);
  assert.equal(h.spawned[0]!.child.killSignal, 'SIGTERM');
  assert.equal(h.spawned[1]!.child.killSignal, 'SIGTERM');
  assert.deepEqual(h.registry.list(), []);
});

test('shutdownAll: skips kill on already-exited entries', async () => {
  const h = makeHarness();
  await h.registry.start('a');
  h.spawned[0]!.child.fireExit(0);
  h.spawned[0]!.child.killed = false;
  h.registry.shutdownAll();
  assert.equal(h.spawned[0]!.child.killed, false);
});
