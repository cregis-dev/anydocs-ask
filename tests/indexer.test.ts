/**
 * Stage 5 e2e suite — the §4.6 hard gate at the index-pipeline level.
 *
 * The content layer already proves that re-running upsertChunksForPage with
 * identical chunks costs zero embed calls (tests/embedding.test.ts). This
 * suite drives the full Indexer end-to-end, building a real project on disk,
 * mutating files, and asserting the gate from above:
 *
 *   1. navigation/L.json reorder           → embedder.calls UNCHANGED
 *   2. page metadata edit (tags)           → embedder.calls UNCHANGED
 *   3. status published → draft → published → embedder.calls UNCHANGED on re-publish
 *   4. page body edit (add a paragraph)    → embedder.calls increases ONLY for the new chunk(s)
 *
 * Plus: fullReindex is idempotent (the §4.6 contract on cold start).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { Indexer, type IndexEvent } from '../src/index/indexer.ts';

// ---------------------------------------------------------------------------
// Project fixture builder — small, in-memory blueprint of a project root.
// We write JSON files to a real tmp dir so loadProject reads them off disk
// just like production. Two-page bilingual project so we can test reorder.
// ---------------------------------------------------------------------------

type PageBlueprint = {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  status?: 'published' | 'draft';
};

async function makeProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-idx-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'en'), { recursive: true });
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function writePage(
  root: string,
  lang: 'zh' | 'en',
  page: PageBlueprint,
): Promise<void> {
  const path = join(root, 'pages', lang, `${page.id}.json`);
  await fs.writeFile(
    path,
    JSON.stringify(
      {
        id: page.id,
        lang,
        slug: page.id,
        title: page.title,
        status: page.status ?? 'published',
        tags: page.tags ?? [],
        content: {
          version: 1,
          blocks: [
            {
              type: 'heading',
              id: 'h1',
              level: 1,
              children: [{ type: 'text', text: page.title }],
            },
            {
              type: 'heading',
              id: 'h2',
              level: 2,
              children: [{ type: 'text', text: 'Section A' }],
            },
            {
              type: 'paragraph',
              id: 'p1',
              children: [{ type: 'text', text: page.body }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
}

async function writeNav(
  root: string,
  lang: 'zh' | 'en',
  pageIds: string[],
): Promise<void> {
  const path = join(root, 'navigation', `${lang}.json`);
  await fs.writeFile(
    path,
    JSON.stringify(
      {
        version: 1,
        items: pageIds.map((id) => ({ type: 'page', pageId: id })),
      },
      null,
      2,
    ),
  );
}

async function setupIndexer(): Promise<{
  root: string;
  db: ReturnType<typeof openDatabase>;
  embedder: MockEmbedder;
  indexer: Indexer;
  cleanup: () => Promise<void>;
}> {
  const { root, cleanup: rmTmp } = await makeProject();
  await writePage(root, 'zh', { id: 'a', title: 'A', body: 'paragraph A content for indexing' });
  await writePage(root, 'zh', { id: 'b', title: 'B', body: 'paragraph B content for indexing' });
  await writeNav(root, 'zh', ['a', 'b']);

  const db = openDatabase({ dbPath: ':memory:' });
  const embedder = new MockEmbedder();
  const indexer = new Indexer({ db, embedder, projectRoot: root });
  return {
    root,
    db,
    embedder,
    indexer,
    cleanup: async () => {
      db.close();
      await rmTmp();
    },
  };
}

function pageEvt(root: string, lang: 'zh' | 'en', id: string, action: IndexEvent['action']): IndexEvent {
  return { action, absPath: join(root, 'pages', lang, `${id}.json`) };
}

function navEvt(root: string, lang: 'zh' | 'en', action: IndexEvent['action']): IndexEvent {
  return { action, absPath: join(root, 'navigation', `${lang}.json`) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Indexer.fullReindex: bootstrap loads + chunks + embeds every published page', async () => {
  const { db, embedder, indexer, cleanup } = await setupIndexer();
  try {
    const stats = await indexer.fullReindex();
    assert.equal(stats.pages.inserted, 2);
    assert.equal(stats.pages.deleted, 0);
    assert.ok(stats.chunks.totalChunks > 0);
    assert.ok(embedder.calls > 0, 'cold start must call the embedder at least once');

    const pageCount = (db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n;
    assert.equal(pageCount, 2);
    const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
    assert.equal(chunkCount, stats.chunks.totalChunks);
    const vecCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n;
    assert.equal(vecCount, stats.chunks.totalChunks);
  } finally {
    await cleanup();
  }
});

test('Indexer.fullReindex: idempotent — second run makes ZERO embed calls', async () => {
  const { embedder, indexer, cleanup } = await setupIndexer();
  try {
    await indexer.fullReindex();
    const callsAfterFirst = embedder.calls;
    assert.ok(callsAfterFirst > 0);

    const stats2 = await indexer.fullReindex();
    assert.equal(
      embedder.calls,
      callsAfterFirst,
      `second fullReindex must not re-embed (was ${callsAfterFirst}, now ${embedder.calls})`,
    );
    assert.equal(stats2.embed.misses, 0);
    // Hash-set compare in decideChunkWrite short-circuits the chunk write too.
    assert.equal(stats2.chunks.writtenPages, 0);
    assert.equal(stats2.chunks.skippedPages, 2);
  } finally {
    await cleanup();
  }
});

test('§4.6 #1 — navigation/L.json reorder triggers ZERO embed calls', async () => {
  const { root, embedder, indexer, cleanup } = await setupIndexer();
  try {
    await indexer.fullReindex();
    const callsBefore = embedder.calls;

    // Swap nav order: ['a','b'] -> ['b','a']
    await writeNav(root, 'zh', ['b', 'a']);
    const stats = await indexer.applyChanges([navEvt(root, 'zh', 'change')]);

    assert.equal(stats.navOnly, true, 'classifier must mark this batch nav-only');
    assert.equal(stats.chunks.writtenPages, 0);
    assert.equal(
      embedder.calls,
      callsBefore,
      `nav reorder must not re-embed (was ${callsBefore}, now ${embedder.calls})`,
    );
  } finally {
    await cleanup();
  }
});

test('§4.6 #2 — page metadata edit (tags) triggers ZERO embed calls', async () => {
  const { root, embedder, indexer, cleanup } = await setupIndexer();
  try {
    await indexer.fullReindex();
    const callsBefore = embedder.calls;

    // Edit tags on page 'a' (DocContentV1 body unchanged).
    await writePage(root, 'zh', {
      id: 'a',
      title: 'A',
      body: 'paragraph A content for indexing',
      tags: ['updated-tag-1', 'updated-tag-2'],
    });
    const stats = await indexer.applyChanges([pageEvt(root, 'zh', 'a', 'change')]);

    assert.equal(stats.navOnly, false);
    assert.equal(
      stats.chunks.writtenPages,
      0,
      'metadata-only edit should hash-set-match and skip chunk writes',
    );
    assert.equal(
      embedder.calls,
      callsBefore,
      `metadata edit must not re-embed (was ${callsBefore}, now ${embedder.calls})`,
    );
  } finally {
    await cleanup();
  }
});

test('§4.6 #3 — status published→draft→published flip triggers ZERO embed calls on re-publish', async () => {
  const { root, db, embedder, indexer, cleanup } = await setupIndexer();
  try {
    await indexer.fullReindex();
    const chunksBefore = (db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE page_id='a'`).get() as { n: number }).n;
    assert.ok(chunksBefore > 0);

    // Flip a -> draft. loadProject's status check filters drafts at the
    // PROJECTION stage (only published rows reach pages table), so a's pages
    // row gets deleted and FK cascade clears its chunks.
    await writePage(root, 'zh', {
      id: 'a',
      title: 'A',
      body: 'paragraph A content for indexing',
      status: 'draft',
    });
    let stats = await indexer.applyChanges([pageEvt(root, 'zh', 'a', 'change')]);
    assert.equal(stats.pages.deleted, 1, 'draft flip removes page row');

    const chunksAfterDraft = (db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE page_id='a'`).get() as { n: number }).n;
    assert.equal(chunksAfterDraft, 0, 'FK cascade clears chunks');

    const callsAfterDraft = embedder.calls;

    // Flip back to published. Cache should still hold every original chunk's
    // content_hash → 0 new embeds. ARCH §7.2 calls this out as the key path
    // for PRD §4.6 acceptance #1.
    await writePage(root, 'zh', {
      id: 'a',
      title: 'A',
      body: 'paragraph A content for indexing',
      status: 'published',
    });
    stats = await indexer.applyChanges([pageEvt(root, 'zh', 'a', 'change')]);
    assert.equal(stats.pages.inserted, 1);
    const chunksAfterRepublish = (db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE page_id='a'`).get() as { n: number }).n;
    assert.equal(chunksAfterRepublish, chunksBefore, 'chunks restored');
    assert.equal(
      embedder.calls,
      callsAfterDraft,
      `re-publish must hit cache for every chunk (was ${callsAfterDraft}, now ${embedder.calls})`,
    );
  } finally {
    await cleanup();
  }
});

test('§4.6 #4 — page body edit re-embeds ONLY the chunks whose hash actually changed', async () => {
  const { root, embedder, indexer, cleanup } = await setupIndexer();
  try {
    await indexer.fullReindex();
    const callsBefore = embedder.calls;

    // Mutate body of 'a' — content_hash for the section-A chunk changes.
    await writePage(root, 'zh', {
      id: 'a',
      title: 'A',
      body: 'paragraph A content for indexing — NOW WITH AN EXTRA SENTENCE.',
    });
    const stats = await indexer.applyChanges([pageEvt(root, 'zh', 'a', 'change')]);

    assert.equal(stats.chunks.writtenPages, 1, 'only page a is rewritten');
    assert.ok(stats.embed.misses >= 1, 'at least one new chunk must be embedded');
    // Stronger: 'b' must not be touched (its hashes are unchanged → skip).
    assert.equal(stats.chunks.skippedPages, 1);
    // The delta in calls equals the new misses (cache served the rest).
    assert.equal(
      embedder.calls - callsBefore,
      stats.embed.misses,
      'embedder.calls delta must match cache misses on this run',
    );
  } finally {
    await cleanup();
  }
});

test('Indexer.applyChanges: unrelated path event is a no-op for chunks', async () => {
  const { root, embedder, indexer, cleanup } = await setupIndexer();
  try {
    await indexer.fullReindex();
    const callsBefore = embedder.calls;

    // README change has no classification — should fall through with no
    // embed work and no nav-only short circuit.
    const stats = await indexer.applyChanges([
      { action: 'change', absPath: join(root, 'README.md') },
    ]);
    assert.equal(stats.chunks.writtenPages, 0);
    assert.equal(embedder.calls, callsBefore);
    // navOnly only fires when there ARE nav events; an unrelated-only batch
    // takes the chunk-walk path with no candidate langs (writes 0).
    assert.equal(stats.navOnly, false);
  } finally {
    await cleanup();
  }
});
