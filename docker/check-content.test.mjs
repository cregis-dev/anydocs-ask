import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('only accept the requested project and complete release', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-content-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sha = 'a'.repeat(40);
  const guard = fileURLToPath(new URL('./check-content.mjs', import.meta.url));
  const check = (project, release) => spawnSync(process.execPath, [guard, dir, project, release]).status;
  writeFileSync(join(dir, 'anydocs.config.json'), JSON.stringify({ projectId: 'site-a' }));
  for (const entry of ['pages', 'navigation']) mkdirSync(join(dir, entry));
  assert.notEqual(check('site-a', sha), 0);
  writeFileSync(join(dir, '.content-release'), sha + '\n');
  assert.equal(check('site-a', sha), 0);
  assert.notEqual(check('site-b', sha), 0);
  assert.notEqual(check('site-a', 'b'.repeat(40)), 0);
  assert.notEqual(check('site-a', 'latest'), 0);
  rmSync(join(dir, 'pages'), { recursive: true });
  assert.notEqual(check('site-a', sha), 0);
});
