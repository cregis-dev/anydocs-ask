/**
 * Stage 2 data layer tests — verify the SQLite + sqlite-vec + FTS5 setup
 * matches ARCHITECTURE §4 (multilingual revision).
 *
 * Strategy:
 *   - In-memory DBs for speed.
 *   - One file-backed test to confirm migration idempotency across re-opens.
 *   - One test per "non-obvious schema feature" that, if broken, would silently
 *     undermine the §4.6 drag-zero-reembed guarantee or the multilingual story.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  runMigrations,
  vecVersion,
  resolveDbPath,
} from '../src/db/index.ts';

function f32Bytes(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

test('resolveDbPath puts index.db inside the state root', () => {
  const p = resolveDbPath('/tmp/state/myproj');
  assert.equal(p, '/tmp/state/myproj/index.db');
});

test('openDatabase creates schema, loads sqlite-vec, sets user_version=1', () => {
  const db = openDatabase({ dbPath: ':memory:' });

  assert.match(vecVersion(db), /^v?\d/);

  const version = db.pragma('user_version', { simple: true });
  assert.equal(version, 1);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all()
    .map((r: any) => r.name as string);

  // Real tables we authored — virtual tables and their shadow tables are
  // checked separately below to keep this assertion stable across sqlite-vec
  // versions (which can rename internal shadow tables).
  for (const t of ['pages', 'chunks', 'embedding_cache', 'feedback', 'answers']) {
    assert.ok(tables.includes(t), `expected table ${t} to exist; got ${tables.join(',')}`);
  }

  // Virtual tables exist even if sqlite_master lists them differently.
  const fts = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").get();
  assert.ok(fts, 'chunks_fts virtual table missing');
  const vec = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_vec'").get();
  assert.ok(vec, 'chunks_vec virtual table missing');

  db.close();
});

test('runMigrations is idempotent — second run applies nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anydocs-ask-test-'));
  try {
    const dbPath = join(dir, 'index.db');
    const first = openDatabase({ dbPath });
    first.close();

    const second = openDatabase({ dbPath, skipMigrations: true });
    const result = runMigrations(second);
    assert.deepEqual(result.applied, [], 'second open should apply zero migrations');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pages enforces composite (page_id, lang) primary key', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const insert = db.prepare(
    `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
     VALUES (?, ?, 'published', ?, '[]', ?)`,
  );

  insert.run('welcome', 'zh', 'Welcome', 1);
  insert.run('welcome', 'en', 'Welcome', 1);

  // Duplicate (page_id, lang) must fail.
  assert.throws(() => insert.run('welcome', 'zh', 'Welcome (dup)', 1), /UNIQUE|PRIMARY KEY/);

  const count = db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number };
  assert.equal(count.n, 2);
  db.close();
});

test('chunks composite FK cascades when its page is deleted', () => {
  const db = openDatabase({ dbPath: ':memory:' });

  db.prepare(
    `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
     VALUES ('welcome', 'zh', 'published', 'Welcome', '[]', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
     VALUES ('welcome', 'en', 'published', 'Welcome', '[]', 1)`,
  ).run();

  const insertChunk = db.prepare(
    `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertChunk.run('welcome', 'zh', 'hello', 'h1', 1, 1);
  insertChunk.run('welcome', 'en', 'hi',    'h2', 1, 1);

  const before = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
  assert.equal(before.n, 2);

  // Delete the zh row only — en chunks must remain (proves the cascade is
  // bound by the composite key, not page_id alone; multilingual correctness).
  db.prepare(`DELETE FROM pages WHERE page_id='welcome' AND lang='zh'`).run();

  const remaining = db
    .prepare('SELECT page_id, lang FROM chunks ORDER BY chunk_id')
    .all() as Array<{ page_id: string; lang: string }>;
  assert.deepEqual(remaining, [{ page_id: 'welcome', lang: 'en' }]);

  db.close();
});

test('FTS5 trigger keeps chunks_fts in sync with chunks (insert + delete)', () => {
  const db = openDatabase({ dbPath: ':memory:' });

  db.prepare(
    `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
     VALUES ('p1', 'en', 'published', 'P1', '[]', 1)`,
  ).run();
  const insertResult = db.prepare(
    `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
     VALUES ('p1', 'en', 'how to authenticate via JWT bearer token', 'h1', 8, 1)`,
  ).run();
  const chunkId = Number(insertResult.lastInsertRowid);

  // FTS5 external-content tables expose `rowid` (not the underlying column
  // name), since they only carry indexed columns.
  const hit = db
    .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`)
    .all('authenticate') as Array<{ rowid: number }>;
  assert.equal(hit.length, 1, 'FTS5 should index the inserted chunk');
  assert.equal(hit[0]?.rowid, chunkId);

  db.prepare(`DELETE FROM chunks WHERE chunk_id = ?`).run(chunkId);
  const hit2 = db
    .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`)
    .all('authenticate');
  assert.equal(hit2.length, 0, 'FTS5 should drop the row on delete trigger');

  db.close();
});

test('chunks_vec accepts 1024-d float vectors and ranks by L2 distance', () => {
  const db = openDatabase({ dbPath: ':memory:' });

  // sqlite-vec quirk: vec0 primary keys are strict INTEGER. better-sqlite3
  // sends plain JS numbers as REAL by default — bind via BigInt to land them
  // as INTEGER. Production code never hits this path because we propagate
  // chunk_id from `chunks.lastInsertRowid` (already a BigInt) when we mirror
  // a row into chunks_vec.
  const v1 = new Array<number>(1024).fill(0); v1[0] = 1;
  const v2 = new Array<number>(1024).fill(0); v2[1] = 1;
  const v3 = new Array<number>(1024).fill(0); v3[0] = 0.5; v3[1] = 0.5;

  const insert = db.prepare(
    `INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`,
  );
  insert.run(BigInt(1), f32Bytes(v1));
  insert.run(BigInt(2), f32Bytes(v2));
  insert.run(BigInt(3), f32Bytes(v3));

  const query = new Array<number>(1024).fill(0); query[0] = 1;
  const ranked = db
    .prepare(
      `SELECT chunk_id, distance
         FROM chunks_vec
         WHERE embedding MATCH ? AND k = 3`,
    )
    .all(f32Bytes(query)) as Array<{ chunk_id: number; distance: number }>;

  assert.equal(ranked.length, 3, 'should return 3 nearest neighbours');
  assert.equal(ranked[0]?.chunk_id, 1, 'chunk 1 should be the closest match');
  assert.equal(ranked[2]?.chunk_id, 2, 'chunk 2 should be the farthest');
  // The distance metric (L2 vs cosine) is decided by query code in stage 6;
  // here we only assert relative ordering, which is consistent under both.

  db.close();
});

test('embedding_cache preserves multiple vectors per content_hash across models', () => {
  const db = openDatabase({ dbPath: ':memory:' });

  const buf = (n: number) => f32Bytes(new Array(4).fill(n));
  const insert = db.prepare(
    `INSERT INTO embedding_cache (content_hash, model, embedding, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  insert.run('abc', 'bge-m3', buf(0.1), 1);
  insert.run('abc', 'bge-small-zh', buf(0.2), 1);

  const rows = db
    .prepare(`SELECT model FROM embedding_cache WHERE content_hash='abc' ORDER BY model`)
    .all() as Array<{ model: string }>;
  assert.deepEqual(rows.map((r) => r.model), ['bge-m3', 'bge-small-zh']);

  // Same (hash, model) collides as expected.
  assert.throws(
    () => insert.run('abc', 'bge-m3', buf(0.3), 1),
    /UNIQUE|PRIMARY KEY/,
  );

  db.close();
});
