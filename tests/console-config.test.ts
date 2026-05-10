/**
 * Console config loader unit tests — defaults, overrides, validation,
 * range invariants. ARCH §17.6.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSOLE_DEFAULTS,
  consoleConfigPath,
  loadConsoleConfig,
} from '../src/console/config.ts';

async function withTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await fs.mkdtemp(join(tmpdir(), 'anydocs-console-cfg-'));
  return { path, cleanup: () => fs.rm(path, { recursive: true, force: true }) };
}

async function writeConfig(ws: string, body: unknown): Promise<void> {
  await fs.writeFile(consoleConfigPath(ws), JSON.stringify(body));
}

test('loadConsoleConfig: missing file → built-in defaults', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const cfg = loadConsoleConfig(ws);
    assert.deepEqual(cfg, { ...CONSOLE_DEFAULTS });
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: defaults are 4100 / 4101–4199 / 15min / 30s health / enabled', () => {
  assert.equal(CONSOLE_DEFAULTS.enabled, true);
  assert.equal(CONSOLE_DEFAULTS.port, 4100);
  assert.equal(CONSOLE_DEFAULTS.idleTimeoutMin, 15);
  assert.equal(CONSOLE_DEFAULTS.childPortRangeStart, 4101);
  assert.equal(CONSOLE_DEFAULTS.childPortRangeEnd, 4199);
  assert.equal(CONSOLE_DEFAULTS.childHealthTimeoutMs, 30_000);
});

test('loadConsoleConfig: partial override merges with defaults', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, { idleTimeoutMin: 5 });
    const cfg = loadConsoleConfig(ws);
    assert.equal(cfg.idleTimeoutMin, 5);
    assert.equal(cfg.port, 4100); // unchanged
    assert.equal(cfg.childPortRangeEnd, 4199); // unchanged
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: malformed JSON throws with path + cause', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.writeFile(consoleConfigPath(ws), '{ not json');
    assert.throws(() => loadConsoleConfig(ws), /\.console\.json: invalid JSON/);
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: top-level array rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, []);
    assert.throws(() => loadConsoleConfig(ws), /must be a JSON object/);
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: wrong type for boolean field', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, { enabled: 'yes' });
    assert.throws(() => loadConsoleConfig(ws), /enabled must be a boolean/);
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: non-integer port rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, { port: 4100.5 });
    assert.throws(() => loadConsoleConfig(ws), /port must be an integer/);
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: port > 65535 rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, { port: 70000 });
    assert.throws(() => loadConsoleConfig(ws), /port must be ≤ 65535/);
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: idleTimeoutMin < 1 rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, { idleTimeoutMin: 0 });
    assert.throws(() => loadConsoleConfig(ws), /idleTimeoutMin must be ≥ 1/);
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: childPortRangeStart > childPortRangeEnd rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, { childPortRangeStart: 4200, childPortRangeEnd: 4150 });
    assert.throws(() => loadConsoleConfig(ws), /childPortRangeStart .* > childPortRangeEnd/);
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: console port inside child range rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    // 4150 falls within default 4101–4199
    await writeConfig(ws, { port: 4150 });
    assert.throws(
      () => loadConsoleConfig(ws),
      /port 4150 is inside childPortRange/,
    );
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: full custom config with non-overlapping range', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, {
      enabled: false,
      port: 5000,
      idleTimeoutMin: 30,
      childPortRangeStart: 5100,
      childPortRangeEnd: 5199,
      childHealthTimeoutMs: 60_000,
    });
    const cfg = loadConsoleConfig(ws);
    assert.deepEqual(cfg, {
      enabled: false,
      port: 5000,
      idleTimeoutMin: 30,
      childPortRangeStart: 5100,
      childPortRangeEnd: 5199,
      childHealthTimeoutMs: 60_000,
    });
  } finally {
    await cleanup();
  }
});

test('loadConsoleConfig: childHealthTimeoutMs < 1000 rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await writeConfig(ws, { childHealthTimeoutMs: 500 });
    assert.throws(() => loadConsoleConfig(ws), /childHealthTimeoutMs must be ≥ 1000/);
  } finally {
    await cleanup();
  }
});
