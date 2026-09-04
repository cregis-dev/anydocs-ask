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

test('retrieveWithTrace: ignores current page chunks when vector/BM25 miss them', () => {
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

    assert.ok(!result.chunks.some((c) => c.chunk_id === authChunk));
    assert.equal(result.trace.currentPageInjected.size, 0);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: current page context does not inject matching later chunks', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES ('waas-quickstart-30min', 'zh', 'published', 'WaaS 30 分钟接入实战', '/zh/waas-quickstart-30min', 'waas', 0, '[]', 1)`,
    ).run();

    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES ('waas-quickstart-30min', 'zh', ?, ?, 8, 1)`,
    );
    for (let i = 0; i < 4; i++) {
      insertChunk.run(`页面开头介绍 ${i}`, `intro-${i}`);
    }
    const payoutChunk = Number(
      insertChunk.run('WaaS API 出款流程：发起提币后保存 cid，并通过 callback 回调接收结果。', 'payout')
        .lastInsertRowid,
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"出款" OR "cid" OR "callback"',
      scopeId: null,
      perPathK: 0,
      finalK: 5,
      currentPageId: 'waas-quickstart-30min',
      currentPageLang: 'zh',
    });

    assert.ok(!result.chunks.some((c) => c.chunk_id === payoutChunk));
    assert.equal(result.trace.currentPageInjected.size, 0);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: API hint queries do not inject current page chunks', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES ('waas-quickstart-30min', 'zh', 'published', 'WaaS 30 分钟接入实战', '/zh/waas-quickstart-30min', 'waas', 0, '[]', 1)`,
    ).run();

    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES ('waas-quickstart-30min', 'zh', ?, ?, 8, 1)`,
    );
    for (let i = 0; i < 4; i++) insertChunk.run(`页面开头介绍 ${i}`, `intro-hint-${i}`);
    const payoutChunk = Number(
      insertChunk.run('发起提币后保存 cid，并通过 callback 回调接收结果。', 'payout-hint')
        .lastInsertRowid,
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"WaaS" OR "API" OR "出款最小流程是什么"',
      scopeId: null,
      perPathK: 0,
      finalK: 5,
      currentPageId: 'waas-quickstart-30min',
      currentPageLang: 'zh',
      apiReferenceFtsQueries: ['"api" OR "v1" OR "payout" OR "cid" OR "callback"'],
    });

    assert.ok(!result.chunks.some((c) => c.chunk_id === payoutChunk));
    assert.equal(result.trace.currentPageInjected.size, 0);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: injects API reference chunks for API-intent questions', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const insertPage = db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES (?, 'zh', 'published', ?, ?, ?, ?, '[]', 1)`,
    );
    insertPage.run(
      'payment-engine-quickstart-30min',
      '支付引擎 30 分钟接入实战',
      '/zh/payment-engine-quickstart-30min',
      'payment-engine',
      0,
    );
    insertPage.run(
      'api-payment-engine-api-post-api-v2-checkout',
      'POST /api/v2/checkout — 创建订单',
      '/zh/reference/payment-engine-api/post-api-v2-checkout',
      'api-reference',
      100,
    );

    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES (?, 'zh', ?, ?, 8, 1)`,
    );
    const guideChunk = Number(
      insertChunk.run(
        'payment-engine-quickstart-30min',
        'checkout checkout checkout 创建订单后跳转托管收银台。',
        'guide-hash',
      ).lastInsertRowid,
    );
    const apiChunk = Number(
      insertChunk.run(
        'api-payment-engine-api-post-api-v2-checkout',
        'API reference: Payment Engine API\nHTTP Request\nPOST /api/v2/checkout',
        'api-hash',
      ).lastInsertRowid,
    );

    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`).run(
      BigInt(guideChunk),
      f32Bytes(vector(1024, 0)),
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"checkout"',
      scopeId: null,
      perPathK: 1,
      finalK: 5,
      apiIntent: true,
    });

    assert.ok(
      result.chunks.some((c) => c.chunk_id === apiChunk),
      'API reference chunk should be injected into the candidate pool',
    );
    assert.ok(result.trace.apiReferenceInjected.has(apiChunk));
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: API reference injection honors language and current product family', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const insertPage = db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES (?, ?, 'published', ?, ?, ?, ?, '[]', 1)`,
    );
    insertPage.run(
      'api-payment-engine-api-post-api-v2-order-info',
      'zh',
      'POST /api/v2/order/info — 查询订单信息',
      '/zh/reference/payment-engine-api/post-api-v2-order-info',
      'api-reference',
      100,
    );
    insertPage.run(
      'api-waas-api-post-api-v1-address-update',
      'zh',
      'POST /api/v1/address/update — 更新子地址信息',
      '/zh/reference/waas-api/post-api-v1-address-update',
      'api-reference',
      101,
    );
    insertPage.run(
      'api-payment-engine-api-post-api-v2-order-info',
      'en',
      'POST /api/v2/order/info — Query Order Information',
      '/en/reference/payment-engine-api/post-api-v2-order-info',
      'api-reference',
      102,
    );

    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES (?, ?, ?, ?, 8, 1)`,
    );
    const zhPaymentEngineChunk = Number(
      insertChunk.run(
        'api-payment-engine-api-post-api-v2-order-info',
        'zh',
        'API reference: Payment Engine API HTTP Request POST /api/v2/order/info data.status 查询订单状态',
        'zh-payment-engine',
      ).lastInsertRowid,
    );
    const zhWaasChunk = Number(
      insertChunk.run(
        'api-waas-api-post-api-v1-address-update',
        'zh',
        'API reference: WaaS API HTTP Request POST /api/v1/address/update data.status 查询订单状态',
        'zh-waas',
      ).lastInsertRowid,
    );
    const enPaymentEngineChunk = Number(
      insertChunk.run(
        'api-payment-engine-api-post-api-v2-order-info',
        'en',
        'API reference: Payment Engine API HTTP Request POST /api/v2/order/info data.status query order status',
        'en-payment-engine',
      ).lastInsertRowid,
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"data" OR "status" OR "查询" OR "订单"',
      scopeId: null,
      perPathK: 0,
      finalK: 10,
      apiIntent: true,
      currentPageLang: 'zh',
      apiReferencePagePrefix: 'api-payment-engine-',
    });

    const ids = new Set(result.chunks.map((c) => c.chunk_id));
    assert.ok(ids.has(zhPaymentEngineChunk), 'zh Payment Engine API reference should be injected');
    assert.equal(ids.has(zhWaasChunk), false, 'WaaS API reference should be filtered out');
    assert.equal(ids.has(enPaymentEngineChunk), false, 'English API reference should be filtered out');
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: exact identifier match outranks fuzzy candidates and respects language', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const address = '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3';
    const insertPage = db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES (?, ?, 'published', ?, ?, 'tokens', ?, '[]', 1)`,
    );
    insertPage.run('supported-tokens', 'zh', '支持的网络与代币', '/zh/supported-tokens', 1);
    insertPage.run('supported-tokens', 'en', 'Supported tokens', '/en/supported-tokens', 2);
    insertPage.run('general-guide', 'zh', '常见问题', '/zh/general-guide', 0);

    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES (?, ?, ?, ?, 8, 1)`,
    );
    const exactZh = Number(
      insertChunk.run(
        'supported-tokens',
        'zh',
        `Page: 支持的网络与代币\nSection: 支持列表\ntoken_id: ${address}`,
        'exact-zh',
      ).lastInsertRowid,
    );
    const exactEn = Number(
      insertChunk.run(
        'supported-tokens',
        'en',
        `Page: Supported tokens\nSection: List\ntoken_id: ${address}`,
        'exact-en',
      ).lastInsertRowid,
    );
    const fuzzy = Number(
      insertChunk.run('general-guide', 'zh', 'BEP20 合约地址查询指南', 'fuzzy').lastInsertRowid,
    );
    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`).run(
      BigInt(fuzzy),
      f32Bytes(vector(1024, 0)),
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: '"BEP20" OR "合约地址"',
      exactIdentifiers: [address],
      scopeId: null,
      currentPageLang: 'zh',
      perPathK: 5,
      finalK: 5,
    });

    assert.equal(result.chunks[0]?.chunk_id, exactZh);
    assert.equal(result.chunks.some((chunk) => chunk.chunk_id === exactEn), false);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: exact identifier falls back across languages when needed', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES ('error-codes', 'en', 'published', 'Error codes', '/en/error-codes', 'reference', 1, '[]', 1)`,
    ).run();
    const chunkId = Number(
      db.prepare(
        `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
         VALUES ('error-codes', 'en', 'A0403 means access is forbidden.', 'a0403', 8, 1)`,
      ).run().lastInsertRowid,
    );

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(vector(1024, 0)),
      ftsQuery: null,
      exactIdentifiers: ['A0403'],
      scopeId: null,
      currentPageLang: 'zh',
      perPathK: 0,
      finalK: 5,
    });

    assert.equal(result.chunks[0]?.chunk_id, chunkId);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: dedicated identifier index resolves a field without scanning chunk text', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
       VALUES ('api-order', 'en', 'published', 'Query order', '[]', 1)`,
    ).run();
    const chunkId = Number(db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES ('api-order', 'en', 'object field documentation', 'field-hash', 5, 1)`,
    ).run().lastInsertRowid);
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
    });
    assert.equal(result.chunks[0]?.chunk_id, chunkId);
    assert.equal(result.chunks[0]?.rrf_score, 1);
  } finally {
    db.close();
  }
});

test('retrieveWithTrace: generic exact fields stay inside the routed API product when available', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const insertPage = db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES (?, 'en', 'published', ?, 'reference', ?, '[]', 1)`,
    );
    insertPage.run('api-waas-api-post-api-v1-payout', 'WaaS payout', 1);
    insertPage.run('api-payment-engine-api-post-api-v2-order-info', 'Payment Engine order', 100);
    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES (?, 'en', ?, ?, 5, 1)`,
    );
    const waas = Number(
      insertChunk.run('api-waas-api-post-api-v1-payout', 'WaaS settlement_fee', 'waas-field').lastInsertRowid,
    );
    const payment = Number(
      insertChunk.run('api-payment-engine-api-post-api-v2-order-info', 'Payment settlement_fee', 'payment-field').lastInsertRowid,
    );
    const insertIdentifier = db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, 'settlement_fee', 'settlement_fee', 'field')`,
    );
    insertIdentifier.run(waas);
    insertIdentifier.run(payment);

    const result = retrieveWithTrace(db, {
      queryVector: new Float32Array(1024),
      ftsQuery: null,
      scopeId: null,
      currentPageLang: 'en',
      apiReferencePagePrefix: 'api-payment-engine-api-',
      exactIdentifiers: ['settlement_fee'],
    });

    assert.equal(result.chunks[0]?.chunk_id, payment);
    assert.equal(result.chunks.some((chunk) => chunk.chunk_id === waas), false);
  } finally {
    db.close();
  }
});
