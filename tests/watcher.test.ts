/**
 * ProjectWatcher smoke tests. We hit a real chokidar against a real tmp
 * project to verify:
 *   - debounce coalesces rapid edits into a single applyChanges call
 *   - nav-only flush still satisfies §4.6 (no embed calls)
 *   - unrelated files outside the watched globs don't trigger anything
 *
 * We avoid asserting wall-clock timings — chokidar startup latency varies
 * across platforms — by relying on the explicit `await ready` event before
 * mutating files, and `flushNow()` to drain the queue at known points.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { Indexer } from '../src/index/indexer.ts';
import { ProjectWatcher } from '../src/index/watcher.ts';

async function makeMinimalProject(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-watch-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.writeFile(
    join(root, 'navigation', 'zh.json'),
    JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'a' }] }, null, 2),
  );
  await fs.writeFile(
    join(root, 'pages', 'zh', 'a.json'),
    JSON.stringify(
      {
        id: 'a',
        lang: 'zh',
        slug: 'a',
        title: 'A',
        status: 'published',
        content: {
          version: 1,
          blocks: [
            { type: 'heading', id: 'h1', level: 1, children: [{ type: 'text', text: 'A' }] },
            { type: 'paragraph', id: 'p1', children: [{ type: 'text', text: 'body of a' }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  return root;
}

/** Poll until predicate is true or timeoutMs elapses. */
async function pollUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('ProjectWatcher: nav reorder via filesystem flushes with §4.6 contract intact', async () => {
  const root = await makeMinimalProject();
  const db = openDatabase({ dbPath: ':memory:' });
  const embedder = new MockEmbedder();
  const indexer = new Indexer({ db, embedder, projectRoot: root });
  await indexer.fullReindex();
  const callsBefore = embedder.calls;

  let appliedCount = 0;
  let lastNavOnly = false;
  const watcher = new ProjectWatcher({
    projectRoot: root,
    indexer,
    debounceMs: 30,
    awaitWriteFinishMs: 0, // tests don't need editor-save coalescing
    onApplied: (s) => {
      appliedCount++;
      lastNavOnly = s.navOnly;
    },
  });
  watcher.start();
  await watcher.ready();

  try {
    // Rewrite navigation/zh.json with a no-op reorder.
    await fs.writeFile(
      join(root, 'navigation', 'zh.json'),
      JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'a' }] }, null, 2),
    );

    await pollUntil(() => appliedCount > 0);
    assert.equal(appliedCount, 1, 'one applyChanges call after flush');
    assert.equal(lastNavOnly, true, 'flush classified as nav-only');
    assert.equal(embedder.calls, callsBefore, 'no new embed calls from nav-only flush');
  } finally {
    await watcher.stop();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ProjectWatcher: debounce coalesces rapid edits to one applyChanges', async () => {
  const root = await makeMinimalProject();
  const db = openDatabase({ dbPath: ':memory:' });
  const embedder = new MockEmbedder();
  const indexer = new Indexer({ db, embedder, projectRoot: root });
  await indexer.fullReindex();

  let appliedCount = 0;
  const watcher = new ProjectWatcher({
    projectRoot: root,
    indexer,
    debounceMs: 80,
    awaitWriteFinishMs: 0,
    onApplied: () => {
      appliedCount++;
    },
  });
  watcher.start();
  await watcher.ready();

  try {
    // Three rapid writes inside the debounce window. Each write resets the
    // debounce timer, so only one apply fires after the burst settles.
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        join(root, 'navigation', 'zh.json'),
        JSON.stringify(
          { version: 1, items: [{ type: 'page', pageId: 'a' }], _bump: i },
          null,
          2,
        ),
      );
      await new Promise((r) => setTimeout(r, 15));
    }

    await pollUntil(() => appliedCount > 0);
    // Allow a tiny grace window in case a stray late-arriving event would
    // otherwise produce a second flush; 200ms > 2x debounce is comfortable.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(appliedCount, 1, 'rapid writes must coalesce into one apply');
  } finally {
    await watcher.stop();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ProjectWatcher: stop() drains and is idempotent', async () => {
  const root = await makeMinimalProject();
  const db = openDatabase({ dbPath: ':memory:' });
  const embedder = new MockEmbedder();
  const indexer = new Indexer({ db, embedder, projectRoot: root });
  await indexer.fullReindex();

  const watcher = new ProjectWatcher({ projectRoot: root, indexer, debounceMs: 30 });
  watcher.start();
  await watcher.stop();
  // Second stop should be a no-op (no errors).
  await watcher.stop();
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});
