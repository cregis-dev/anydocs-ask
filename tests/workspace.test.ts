/**
 * workspace.ts unit tests — resolution order, bare-name detection,
 * ensureWorkspace idempotence, assertProjectRoot validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_SUBDIRS,
  addToProjectRegistry,
  assertProjectRoot,
  ensureStateRoot,
  ensureWorkspace,
  isBareName,
  loadProjectId,
  readProjectRegistry,
  removeFromProjectRegistry,
  resolveProjectRoot,
  resolveStateRoot,
  resolveWorkspace,
  scanProjects,
} from '../src/workspace.ts';

async function withTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await fs.mkdtemp(join(tmpdir(), 'anydocs-ws-'));
  return { path, cleanup: () => fs.rm(path, { recursive: true, force: true }) };
}

async function makeValidProject(root: string): Promise<void> {
  await fs.mkdir(join(root, 'pages'), { recursive: true });
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
}

test('resolveWorkspace: --workspace flag wins over env and default', () => {
  const r = resolveWorkspace('/tmp/explicit', { ANYDOCS_ASK_WORKSPACE: '/tmp/from-env' });
  assert.equal(r.source, 'flag');
  assert.equal(r.path, '/tmp/explicit');
});

test('resolveWorkspace: env wins over default when no flag', () => {
  const r = resolveWorkspace(undefined, { ANYDOCS_ASK_WORKSPACE: '/tmp/from-env' });
  assert.equal(r.source, 'env');
  assert.equal(r.path, '/tmp/from-env');
});

test('resolveWorkspace: default falls back to ~/anydocs-ask-runtime', () => {
  const r = resolveWorkspace(undefined, {});
  assert.equal(r.source, 'default');
  assert.match(r.path, /anydocs-ask-runtime$/);
});

test('resolveWorkspace: empty string flag falls through to env', () => {
  const r = resolveWorkspace('', { ANYDOCS_ASK_WORKSPACE: '/tmp/from-env' });
  assert.equal(r.source, 'env');
});

test('isBareName: typical bare names', () => {
  assert.equal(isBareName('docs-zh'), true);
  assert.equal(isBareName('docs_en'), true);
  assert.equal(isBareName('starter-demo'), true);
  assert.equal(isBareName('a'), true);
  assert.equal(isBareName('v1.5-docs'), true);
});

test('isBareName: paths and weird names rejected', () => {
  assert.equal(isBareName('./docs'), false);
  assert.equal(isBareName('docs/zh'), false);
  assert.equal(isBareName('/abs/path'), false);
  assert.equal(isBareName('.hidden'), false);
  assert.equal(isBareName('..'), false);
  assert.equal(isBareName(''), false);
  assert.equal(isBareName('docs zh'), false); // space
  assert.equal(isBareName('docs\\zh'), false);
});

test('resolveProjectRoot: bare name not in registry falls back to <ws>/projects/<name>', () => {
  // No registry at /ws → falls back to legacy path for a friendly error message
  const r = resolveProjectRoot('docs-zh', '/ws');
  assert.equal(r.source, 'workspace');
  assert.equal(r.bareName, 'docs-zh');
  assert.equal(r.path, '/ws/projects/docs-zh');
});

test('resolveProjectRoot: bare name registered -> uses registry path', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    addToProjectRegistry(ws, '/some/other/path/docs-zh', 'docs-zh');
    const r = resolveProjectRoot('docs-zh', ws);
    assert.equal(r.source, 'workspace');
    assert.equal(r.bareName, 'docs-zh');
    assert.equal(r.path, '/some/other/path/docs-zh');
  } finally {
    await cleanup();
  }
});

test('resolveProjectRoot: path-like arg resolved against cwd', () => {
  const r = resolveProjectRoot('./fixtures/x', '/ws');
  assert.equal(r.source, 'path');
  assert.equal(r.bareName, null);
  // resolve(./fixtures/x) is cwd-dependent; just check it's absolute
  assert.ok(r.path.startsWith('/'));
  assert.match(r.path, /fixtures\/x$/);
});

test('resolveProjectRoot: absolute path passes through', () => {
  const r = resolveProjectRoot('/abs/project', '/ws');
  assert.equal(r.source, 'path');
  assert.equal(r.path, '/abs/project');
});

test('ensureWorkspace: creates root + state/ subdir on first run', async () => {
  const { path: parent, cleanup } = await withTmpDir();
  try {
    const ws = join(parent, 'fresh-ws');
    const r = ensureWorkspace(ws);
    assert.equal(r.rootCreated, true);
    assert.deepEqual(r.subdirsCreated.sort(), [...WORKSPACE_SUBDIRS].sort());
    for (const sub of WORKSPACE_SUBDIRS) {
      assert.ok(existsSync(join(ws, sub)), `expected ${sub}/ to exist`);
    }
    // workspace top-level is intentionally minimal
    assert.equal(existsSync(join(ws, 'golden')), false);
    assert.equal(existsSync(join(ws, 'runs')), false);
    assert.equal(existsSync(join(ws, 'feedback')), false);
    assert.equal(existsSync(join(ws, 'reports')), false);
  } finally {
    await cleanup();
  }
});

test('ensureWorkspace: idempotent on second run', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const first = ensureWorkspace(ws);
    assert.equal(first.rootCreated, false); // tmpdir already exists
    // Subdirs may all be created on first call
    const second = ensureWorkspace(ws);
    assert.equal(second.rootCreated, false);
    assert.deepEqual(second.subdirsCreated, []);
  } finally {
    await cleanup();
  }
});

test('ensureWorkspace: existing state/ -> nothing created', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'state'), { recursive: true });
    const r = ensureWorkspace(ws);
    assert.equal(r.rootCreated, false);
    assert.deepEqual(r.subdirsCreated, []);
  } finally {
    await cleanup();
  }
});

test('assertProjectRoot: passes for valid project (pages/ + navigation/)', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    await makeValidProject(root);
    assert.doesNotThrow(() => assertProjectRoot(root));
  } finally {
    await cleanup();
  }
});

test('assertProjectRoot: throws when directory does not exist', () => {
  assert.throws(() => assertProjectRoot('/nope/not-a-thing'), /does not exist/);
});

test('assertProjectRoot: throws when pages/ missing', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(root, 'navigation'), { recursive: true });
    assert.throws(() => assertProjectRoot(root), /pages\//);
  } finally {
    await cleanup();
  }
});

test('assertProjectRoot: throws when navigation/ missing', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(root, 'pages'), { recursive: true });
    assert.throws(() => assertProjectRoot(root), /navigation\//);
  } finally {
    await cleanup();
  }
});

test('assertProjectRoot: lists both missing dirs in error message', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    assert.throws(
      () => assertProjectRoot(root),
      (err: Error) => err.message.includes('pages/') && err.message.includes('navigation/'),
    );
  } finally {
    await cleanup();
  }
});

test('end-to-end: workspace + registry add + bare-name resolution + assertProjectRoot', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    const projDir = join(ws, 'projects', 'docs-zh');
    await makeValidProject(projDir);
    addToProjectRegistry(ws, projDir, 'docs-zh');

    const wsResolution = resolveWorkspace(ws, {});
    assert.equal(wsResolution.path, ws);

    const projResolution = resolveProjectRoot('docs-zh', wsResolution.path);
    assert.equal(projResolution.source, 'workspace');
    assert.equal(projResolution.path, projDir);

    assert.doesNotThrow(() => assertProjectRoot(projResolution.path));
  } finally {
    await cleanup();
  }
});

test('resolveStateRoot: <ws>/state/<projectId>', () => {
  assert.equal(resolveStateRoot('/ws', 'hermes-docs'), '/ws/state/hermes-docs');
});

test('loadProjectId: reads projectId from anydocs.config.json', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    await fs.writeFile(
      join(root, 'anydocs.config.json'),
      JSON.stringify({ version: 1, projectId: 'hermes-docs', name: 'Hermes' }),
    );
    assert.equal(loadProjectId(root), 'hermes-docs');
  } finally {
    await cleanup();
  }
});

test('loadProjectId: throws when config missing', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    assert.throws(() => loadProjectId(root), /anydocs\.config\.json not found/);
  } finally {
    await cleanup();
  }
});

test('loadProjectId: throws when projectId missing or empty', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    await fs.writeFile(join(root, 'anydocs.config.json'), JSON.stringify({ version: 1 }));
    assert.throws(() => loadProjectId(root), /projectId/);
  } finally {
    await cleanup();
  }
});

test('loadProjectId: rejects path-traversal-shaped ids', async () => {
  const { path: root, cleanup } = await withTmpDir();
  try {
    await fs.writeFile(
      join(root, 'anydocs.config.json'),
      JSON.stringify({ version: 1, projectId: '../../etc' }),
    );
    assert.throws(() => loadProjectId(root), /must match/);
  } finally {
    await cleanup();
  }
});

test('ensureStateRoot: creates state/<id>/ idempotently', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    const stateRoot = ensureStateRoot(ws, 'hermes-docs');
    assert.equal(stateRoot, join(ws, 'state', 'hermes-docs'));
    assert.ok(existsSync(stateRoot));
    // second call is a no-op
    const again = ensureStateRoot(ws, 'hermes-docs');
    assert.equal(again, stateRoot);
  } finally {
    await cleanup();
  }
});

test('scanProjects: returns [] when projects.json absent', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    assert.deepEqual(scanProjects(ws), []);
  } finally {
    await cleanup();
  }
});

test('scanProjects: empty workspace lists nothing', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    assert.deepEqual(scanProjects(ws), []);
  } finally {
    await cleanup();
  }
});

test('scanProjects: surfaces valid / invalid / id / indexed', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);

    // (a) valid project with config.projectId === registered name, not yet indexed
    const docsPath = join(ws, 'docs-zh');
    await makeValidProject(docsPath);
    await fs.writeFile(
      join(docsPath, 'anydocs.config.json'),
      JSON.stringify({ version: 1, projectId: 'docs-zh' }),
    );
    addToProjectRegistry(ws, docsPath, 'docs-zh');

    // (b) valid project with id-rename + indexed (touch index.db)
    const hermesPath = join(ws, 'hermes-docs');
    await makeValidProject(hermesPath);
    await fs.writeFile(
      join(hermesPath, 'anydocs.config.json'),
      JSON.stringify({ version: 1, projectId: 'hermes-canonical' }),
    );
    await fs.mkdir(join(ws, 'state', 'hermes-canonical'), { recursive: true });
    await fs.writeFile(join(ws, 'state', 'hermes-canonical', 'index.db'), '');
    addToProjectRegistry(ws, hermesPath, 'hermes-docs');

    // (c) invalid project (missing navigation/)
    const brokenPath = join(ws, 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');

    const out = scanProjects(ws);
    assert.equal(out.length, 3);
    // Sorted by name: broken, docs-zh, hermes-docs
    assert.deepEqual(
      out.map((p) => p.name),
      ['broken', 'docs-zh', 'hermes-docs'],
    );

    const broken = out[0]!;
    assert.equal(broken.valid, false);
    assert.deepEqual(broken.missing, ['navigation/']);
    assert.equal(broken.projectId, null);
    assert.equal(broken.indexed, false);

    const docs = out[1]!;
    assert.equal(docs.valid, true);
    assert.equal(docs.projectId, 'docs-zh');
    assert.equal(docs.indexed, false);
    assert.equal(docs.path, docsPath);

    const hermes = out[2]!;
    assert.equal(hermes.valid, true);
    assert.equal(hermes.projectId, 'hermes-canonical');
    assert.equal(hermes.indexed, true);
  } finally {
    await cleanup();
  }
});

test('scanProjects: stale registry entry (path gone) shows valid=false', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    addToProjectRegistry(ws, '/nonexistent/path/docs', 'ghost');
    const out = scanProjects(ws);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.name, 'ghost');
    assert.equal(out[0]!.valid, false);
    assert.deepEqual(out[0]!.missing, ['path not found']);
  } finally {
    await cleanup();
  }
});

test('scanProjects: no anydocs.config.json -> projectId null, valid true', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    const orphanPath = join(ws, 'orphan');
    await makeValidProject(orphanPath);
    addToProjectRegistry(ws, orphanPath, 'orphan');

    const out = scanProjects(ws);
    assert.equal(out.length, 1);
    const p = out[0]!;
    assert.equal(p.name, 'orphan');
    assert.equal(p.valid, true);
    assert.equal(p.projectId, null);
    assert.equal(p.indexed, false);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Project registry tests
// ---------------------------------------------------------------------------

test('addToProjectRegistry / readProjectRegistry: round-trip', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    addToProjectRegistry(ws, '/path/to/docs', 'my-docs');
    addToProjectRegistry(ws, '/path/to/other', 'other');
    const reg = readProjectRegistry(ws);
    assert.equal(reg['my-docs'], '/path/to/docs');
    assert.equal(reg['other'], '/path/to/other');
    assert.equal(Object.keys(reg).length, 2);
  } finally {
    await cleanup();
  }
});

test('addToProjectRegistry: overwrites same name', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    addToProjectRegistry(ws, '/old/path', 'docs');
    addToProjectRegistry(ws, '/new/path', 'docs');
    assert.equal(readProjectRegistry(ws)['docs'], '/new/path');
  } finally {
    await cleanup();
  }
});

test('addToProjectRegistry: infers name from basename when not provided', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    const name = addToProjectRegistry(ws, '/some/path/my-project');
    assert.equal(name, 'my-project');
    assert.equal(readProjectRegistry(ws)['my-project'], '/some/path/my-project');
  } finally {
    await cleanup();
  }
});

test('removeFromProjectRegistry: removes existing entry', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    addToProjectRegistry(ws, '/path', 'to-remove');
    const removed = removeFromProjectRegistry(ws, 'to-remove');
    assert.equal(removed, true);
    assert.equal('to-remove' in readProjectRegistry(ws), false);
  } finally {
    await cleanup();
  }
});

test('removeFromProjectRegistry: returns false for unknown name', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    ensureWorkspace(ws);
    const removed = removeFromProjectRegistry(ws, 'ghost');
    assert.equal(removed, false);
  } finally {
    await cleanup();
  }
});

test('readProjectRegistry: returns {} for malformed JSON', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.writeFile(join(ws, 'projects.json'), 'not json', 'utf8');
    assert.deepEqual(readProjectRegistry(ws), {});
  } finally {
    await cleanup();
  }
});
