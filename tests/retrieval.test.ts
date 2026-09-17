import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DbHandle } from '../src/db/index.ts';
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

function insertPage(db: DbHandle, pageId: string, lang: 'en' | 'zh', navIndex: number): void {
  db.prepare(
    `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
     VALUES (?, ?, 'published', ?, ?, 'reference', ?, '[]', 1)`,
  ).run(pageId, lang, pageId, `/${lang}/${pageId}`, navIndex);
}

function insertChunk(db: DbHandle, pageId: string, lang: 'en' | 'zh', text: string): number {
  return Number(db.prepare(
    `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
     VALUES (?, ?, ?, ?, 8, 1)`,
  ).run(pageId, lang, text, `${pageId}-${lang}-${text}`).lastInsertRowid);
}

test('retrieveWithTrace: vector and BM25 are fused by configurable RRF', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'vector-page', 'en', 1);
    insertPage(db, 'keyword-page', 'en', 2);
    const vectorChunk = insertChunk(db, 'vector-page', 'en', 'semantic match only');
    const keywordChunk = insertChunk(db, 'keyword-page', 'en', 'signature signature signature');
    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`).run(
      BigInt(vectorChunk),
      f32Bytes(vector(1024, 0)),
    );
    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`).run(
      BigInt(keywordChunk),
      f32Bytes(vector(1024, 1)),
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"signature"',
      scopeId: null,
      perPathK: 2,
      finalK: 2,
      rrfK: 10,
    });

    assert.equal(result.trace.vecRanks.get(vectorChunk), 1);
    assert.equal(result.trace.bm25Ranks.get(keywordChunk), 1);
    assert.equal(result.trace.exactRanks.size, 0);
    assert.equal(result.chunks.length, 2);
    assert.ok(result.chunks.every((chunk) => chunk.rrf_score <= 2 / 11));
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: exact identifiers are a ranked RRF path, not a synthetic boost', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'api-order', 'en', 1);
    const chunkId = insertChunk(db, 'api-order', 'en', 'object field documentation');
    db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, 'settlement_fee', 'settlement_fee', 'field')`,
    ).run(chunkId);

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(1024),
      ftsQuery: null,
      scopeId: null,
      currentPageLang: 'en',
      exactIdentifiers: ['settlement_fee'],
      rrfK: 60,
    });

    assert.equal(result.chunks[0]?.chunk_id, chunkId);
    assert.equal(result.trace.exactRanks.get(chunkId), 1);
    assert.equal(result.chunks[0]?.rrf_score, 1 / 61);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: an exact match gains rank through cross-path agreement', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'api-order', 'en', 1);
    insertPage(db, 'other', 'en', 2);
    const exact = insertChunk(db, 'api-order', 'en', 'settlement_fee response field');
    const semantic = insertChunk(db, 'other', 'en', 'unrelated semantic candidate');
    db.prepare(`INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind) VALUES (?, ?, ?, 'field')`)
      .run(exact, 'settlement_fee', 'settlement_fee');
    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`).run(
      BigInt(exact),
      f32Bytes(vector(1024, 1)),
    );
    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`).run(
      BigInt(semantic),
      f32Bytes(vector(1024, 0)),
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"settlement_fee"',
      exactIdentifiers: ['settlement_fee'],
      currentPageLang: 'en',
      scopeId: null,
      perPathK: 2,
      finalK: 2,
    });

    assert.equal(result.chunks[0]?.chunk_id, exact);
    assert.equal(result.trace.bm25Ranks.get(exact), 1);
    assert.equal(result.trace.exactRanks.get(exact), 1);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: exact identifier prefers the requested language', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'error-codes', 'en', 2);
    insertPage(db, 'error-codes', 'zh', 1);
    const en = insertChunk(db, 'error-codes', 'en', 'A0403 means forbidden');
    const zh = insertChunk(db, 'error-codes', 'zh', 'A0403 表示无权限');
    for (const chunkId of [en, zh]) {
      db.prepare(`INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind) VALUES (?, 'A0403', 'a0403', 'error_code')`)
        .run(chunkId);
    }

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(1024),
      ftsQuery: null,
      exactIdentifiers: ['A0403'],
      currentPageLang: 'zh',
      scopeId: null,
    });

    assert.equal(result.chunks[0]?.chunk_id, zh);
    assert.equal(result.chunks.some((chunk) => chunk.chunk_id === en), false);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: generic exact fields prefer the routed API product', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'api-waas-api-post-api-v1-payout', 'en', 1);
    insertPage(db, 'api-payment-engine-api-post-api-v2-order-info', 'en', 100);
    const waas = insertChunk(db, 'api-waas-api-post-api-v1-payout', 'en', 'WaaS settlement_fee');
    const payment = insertChunk(db, 'api-payment-engine-api-post-api-v2-order-info', 'en', 'Payment settlement_fee');
    for (const chunkId of [waas, payment]) {
      db.prepare(`INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind) VALUES (?, 'settlement_fee', 'settlement_fee', 'field')`)
        .run(chunkId);
    }

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(1024),
      ftsQuery: null,
      exactIdentifiers: ['settlement_fee'],
      currentPageLang: 'en',
      apiReferencePagePrefix: 'api-payment-engine-api-',
      scopeId: null,
    });

    assert.equal(result.chunks[0]?.chunk_id, payment);
    assert.equal(result.chunks.some((chunk) => chunk.chunk_id === waas), false);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: simple exact fields prefer the routed API product', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'api-waas-api-post-api-v1-trade-page', 'zh', 20);
    insertPage(db, 'api-payment-engine-api-post-api-v2-order-info', 'zh', 10);
    const waas = insertChunk(db, 'api-waas-api-post-api-v1-trade-page', 'zh', 'data.rows[].fee 交易费用');
    const payment = insertChunk(db, 'api-payment-engine-api-post-api-v2-order-info', 'zh', 'data.fee 订单费用');
    for (const chunkId of [waas, payment]) {
      db.prepare(`INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind) VALUES (?, 'fee', 'fee', 'field')`)
        .run(chunkId);
    }

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(1024),
      ftsQuery: null,
      exactIdentifiers: ['fee'],
      currentPageLang: 'zh',
      apiReferencePagePrefix: 'api-waas-api-',
      scopeId: null,
    });

    assert.equal(result.chunks[0]?.chunk_id, waas);
    assert.equal(result.chunks.some((chunk) => chunk.chunk_id === payment), false);
  } finally {
    db.close();
  }
});
