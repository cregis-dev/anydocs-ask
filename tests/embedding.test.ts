/**
 * Embedder + cache tests.
 *
 * Most importantly: the cache-hit gate that PRD §4.6 depends on. The
 * `MockEmbedder.calls` counter is checked before / after re-runs to assert
 * that re-indexing identical content makes ZERO additional model calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { getOrEmbed } from '../src/embedding/cache.ts';
import { upsertPages } from '../src/structure/upsert.ts';
import { upsertChunksForPage } from '../src/content/upsert.ts';
import { chunkPage } from '../src/content/chunk.ts';
import { projectStructure } from '../src/structure/project.ts';
import { loadProject } from '../src/anydocs/loader.ts';
import { fileURLToPath } from 'node:url';

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/starter-docs/', import.meta.url));

test('MockEmbedder.warmUp + embed produces consistent vectors and increments calls', async () => {
  const e = new MockEmbedder();
  await e.warmUp();
  assert.equal(e.calls, 0);

  const r1 = await e.embed(['hello']);
  assert.equal(e.calls, 1);
  assert.equal(r1[0]!.vector.length, 1024);

  const r2 = await e.embed(['hello']);
  assert.equal(e.calls, 2, 'embedder counts every call (the cache layer is what shields it)');
  // Same input -> identical vector.
  assert.deepEqual(Array.from(r2[0]!.vector), Array.from(r1[0]!.vector));
});

test('getOrEmbed: cache miss -> embed -> cache hit on rerun', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const e = new MockEmbedder();
  try {
    const reqs = [
      { content_hash: 'h1', text: 'first chunk' },
      { content_hash: 'h2', text: 'second chunk' },
    ];

    const round1 = await getOrEmbed(db, e, reqs);
    assert.equal(round1.stats.misses, 2);
    assert.equal(round1.stats.hits, 0);
    assert.equal(e.textsEmbedded, 2);

    const round2 = await getOrEmbed(db, e, reqs);
    assert.equal(round2.stats.misses, 0);
    assert.equal(round2.stats.hits, 2);
    assert.equal(e.textsEmbedded, 2, 'no new embeds on rerun');
  } finally {
    db.close();
  }
});

test('getOrEmbed: dedupes within a single call before hitting the embedder', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const e = new MockEmbedder();
  try {
    const reqs = [
      { content_hash: 'h', text: 'same' },
      { content_hash: 'h', text: 'same' },
      { content_hash: 'h', text: 'same' },
    ];
    const r = await getOrEmbed(db, e, reqs);
    assert.equal(r.stats.misses, 1, 'duplicates within a call are deduped before embed');
    assert.equal(e.textsEmbedded, 1);
  } finally {
    db.close();
  }
});

test('upsertChunksForPage: full pipeline writes chunks + chunks_vec + chunks_fts', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const e = new MockEmbedder();
  try {
    const proj = await loadProject(FIXTURES_ROOT);
    const struct = projectStructure(proj);
    upsertPages(db, struct.rows);

    const zh = proj.pagesByLangAndId.get('zh')!.get('welcome')!;
    const chunks = chunkPage(zh);
    const result = await upsertChunksForPage(db, e, 'welcome', 'zh', chunks);

    assert.equal(result.written, chunks.length);
    assert.equal(result.cache.misses, chunks.length, 'all misses on first pass');

    const inDb = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE page_id='welcome' AND lang='zh'`).get() as { n: number };
    assert.equal(inDb.n, chunks.length);

    // chunks_vec has one row per chunk
    const vecCount = db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number };
    assert.equal(vecCount.n, chunks.length);

    // chunks_fts can MATCH a known token from the page
    const ftsHits = db
      .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`)
      .all('Anydocs') as Array<{ rowid: number }>;
    assert.ok(ftsHits.length > 0, 'FTS index should pick up "Anydocs"');
  } finally {
    db.close();
  }
});

test('PRD §4.6 contract: re-running upsertChunksForPage with identical chunks makes zero embed calls', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const e = new MockEmbedder();
  try {
    const proj = await loadProject(FIXTURES_ROOT);
    const struct = projectStructure(proj);
    upsertPages(db, struct.rows);

    const zh = proj.pagesByLangAndId.get('zh')!.get('welcome')!;
    const chunks1 = chunkPage(zh);

    await upsertChunksForPage(db, e, 'welcome', 'zh', chunks1);
    const callsAfterFirst = e.calls;

    // Same content -> same content_hashes -> all cache hits this round.
    const chunks2 = chunkPage(zh);
    const result = await upsertChunksForPage(db, e, 'welcome', 'zh', chunks2);

    assert.equal(result.cache.misses, 0, 'no misses on rerun with identical content');
    assert.equal(result.cache.hits, chunks2.length);
    assert.equal(
      e.calls,
      callsAfterFirst,
      `MockEmbedder.calls must not move on rerun (was ${callsAfterFirst}, now ${e.calls})`,
    );
  } finally {
    db.close();
  }
});

test('PRD §4.6 contract: cross-lang isolation — embedding cache survives lang re-index', async () => {
  // zh and en pages may share text occasionally (e.g. an English code snippet
  // copied verbatim). When that happens, the cache should serve both.
  const db = openDatabase({ dbPath: ':memory:' });
  const e = new MockEmbedder();
  try {
    const reqs = [{ content_hash: 'shared-hash', text: 'GET /api/v1/users' }];
    await getOrEmbed(db, e, reqs);
    const callsAfterZh = e.calls;
    await getOrEmbed(db, e, reqs);
    assert.equal(e.calls, callsAfterZh, 'shared content across langs hits cache');
  } finally {
    db.close();
  }
});
