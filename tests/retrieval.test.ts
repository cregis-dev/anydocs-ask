import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.ts';
import { retrieveWithTrace } from '../src/query/retrieval.ts';

function f32Bytes(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function vector(dim: number, idx: number): number[] {
  const out = new Array<number>(dim).fill(0);
  out[idx] = 1;
  return out;
}

test('retrieveWithTrace: injects current page chunks even when vector/BM25 miss them', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const insertPage = db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES (?, 'zh', 'published', ?, ?, 'get-started', ?, '[]', 1)`,
    );
    insertPage.run('authentication', '认证与签名', '/zh/authentication', 0);
    insertPage.run('webhook-mechanism', 'Webhook 回调机制', '/zh/webhook-mechanism', 1);

    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES (?, 'zh', ?, ?, 8, 1)`,
    );
    const authChunk = Number(
      insertChunk.run('authentication', '签名规则：sign 字段不参与签名。', 'auth-hash').lastInsertRowid,
    );
    const webhookChunk = Number(
      insertChunk.run('webhook-mechanism', 'webhook callback callback callback', 'webhook-hash')
        .lastInsertRowid,
    );

    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`).run(
      BigInt(webhookChunk),
      f32Bytes(vector(1024, 0)),
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"webhook"',
      scopeId: null,
      finalK: 5,
      currentPageId: 'authentication',
      currentPageLang: 'zh',
    });

    assert.ok(
      result.chunks.some((c) => c.chunk_id === authChunk),
      'current page chunk should be injected into the candidate pool',
    );
  } finally {
    db.close();
  }
});
