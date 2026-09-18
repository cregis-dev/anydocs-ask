import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/index.ts';
import { expandParentContext, selectContextWithParents } from '../src/query/answer.ts';
import type { RerankedChunk } from '../src/query/rerank.ts';

test('parent context: matching children collapse into one bounded structural parent', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
       VALUES ('api-page', 'en', 'published', 'API page', '[]', 1)`,
    ).run();
    const parentId = Number(db.prepare(
      `INSERT INTO chunk_parents
        (page_id, lang, parent_path, heading_path, text, content_hash, token_count, created_at)
       VALUES ('api-page', 'en', 'response-data', '[]', ?, 'parent-hash', 12, 1)`,
    ).run('Parent context with both settlement_fee and actual_settlement_amount.').lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, created_at)
       VALUES ('api-page', 'en', ?, ?, ?, 4, ?, 'api-response-object', 1)`,
    );
    const first = Number(insert.run('response-data/p[1]', 'settlement_fee', 'one', parentId).lastInsertRowid);
    const second = Number(insert.run('response-data/p[2]', 'actual_settlement_amount', 'two', parentId).lastInsertRowid);

    const chunk = (chunk_id: number, text: string): RerankedChunk => ({
      chunk_id,
      page_id: 'api-page',
      lang: 'en',
      in_page_path: 'response-data/p[1]',
      text,
      is_code: 0,
      parent_id: parentId,
      chunk_kind: 'api-response-object',
      object_path: 'data.settlement_details',
      page_title: 'API page',
      page_url: '/en/reference/api/queryOrder',
      subtree_root: 'payment-engine',
      nav_index: 1,
      breadcrumb: [],
      rrf_score: 1,
      final_score: 1,
    });

    const expanded = expandParentContext(db, [chunk(first, 'settlement_fee'), chunk(second, 'actual_settlement_amount')]);
    assert.equal(expanded.length, 1);
    assert.match(expanded[0]!.text, /both settlement_fee and actual_settlement_amount/);
  } finally {
    db.close();
  }
});

test('parent context: collapsed siblings refill the final context from lower-ranked candidates', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
       VALUES ('api-page', 'en', 'published', 'API page', '[]', 1)`,
    ).run();
    const insertParent = db.prepare(
      `INSERT INTO chunk_parents
        (page_id, lang, parent_path, heading_path, text, content_hash, token_count, created_at)
       VALUES ('api-page', 'en', ?, '[]', ?, ?, ?, 1)`,
    );
    const sharedParent = Number(
      insertParent.run('shared', 'complete shared parent', 'parent-shared', 8).lastInsertRowid,
    );
    const secondParent = Number(
      insertParent.run('second', 'second parent', 'parent-second', 3).lastInsertRowid,
    );
    const thirdParent = Number(
      insertParent.run('third', 'third parent', 'parent-third', 3).lastInsertRowid,
    );
    const insertChunk = db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, created_at)
       VALUES ('api-page', 'en', ?, ?, ?, 2, ?, 'api-response-object', 1)`,
    );
    const ids = [
      Number(insertChunk.run('shared/p[1]', 'shared one', 'shared-one', sharedParent).lastInsertRowid),
      Number(insertChunk.run('shared/p[2]', 'shared two', 'shared-two', sharedParent).lastInsertRowid),
      Number(insertChunk.run('shared/p[3]', 'shared three', 'shared-three', sharedParent).lastInsertRowid),
      Number(insertChunk.run('second/p[1]', 'second child', 'second-child', secondParent).lastInsertRowid),
      Number(insertChunk.run('third/p[1]', 'third child', 'third-child', thirdParent).lastInsertRowid),
    ];

    const selected = selectContextWithParents(
      db,
      ids.map((id, index) => fakeChunk(id, index < 3 ? sharedParent : index === 3 ? secondParent : thirdParent)),
      { maxItems: 3, maxTotalTokens: 100, maxParentTokens: 50 },
    );

    assert.equal(selected.length, 3);
    assert.equal(selected[0]?.text, 'complete shared parent');
    assert.deepEqual(selected.slice(1).map((chunk) => chunk.chunk_id), ids.slice(3));
  } finally {
    db.close();
  }
});

test('parent context: token budget falls back to one child and preserves room for another parent', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
       VALUES ('api-page', 'en', 'published', 'API page', '[]', 1)`,
    ).run();
    const insertParent = db.prepare(
      `INSERT INTO chunk_parents
        (page_id, lang, parent_path, heading_path, text, content_hash, token_count, created_at)
       VALUES ('api-page', 'en', ?, '[]', ?, ?, ?, 1)`,
    );
    const expensiveParent = Number(
      insertParent.run('expensive', 'expensive complete parent', 'parent-expensive', 100).lastInsertRowid,
    );
    const smallParent = Number(
      insertParent.run('small', 'small parent', 'parent-small', 3).lastInsertRowid,
    );
    const insertChunk = db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, created_at)
       VALUES ('api-page', 'en', ?, ?, ?, 2, ?, 'api-response-object', 1)`,
    );
    const first = Number(
      insertChunk.run('expensive/p[1]', 'best child', 'best-child', expensiveParent).lastInsertRowid,
    );
    const sibling = Number(
      insertChunk.run('expensive/p[2]', 'sibling child', 'sibling-child', expensiveParent).lastInsertRowid,
    );
    const other = Number(
      insertChunk.run('small/p[1]', 'other child', 'other-child', smallParent).lastInsertRowid,
    );

    const selected = selectContextWithParents(
      db,
      [fakeChunk(first, expensiveParent, 'best child'), fakeChunk(sibling, expensiveParent, 'sibling child'), fakeChunk(other, smallParent, 'other child')],
      { maxItems: 2, maxTotalTokens: 20, maxParentTokens: 200 },
    );

    assert.deepEqual(selected.map((chunk) => chunk.chunk_id), [first, other]);
    assert.equal(selected[0]?.text, 'best child');
  } finally {
    db.close();
  }
});

test('parent context: default limit expands page parents through 3300 tokens only', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages (page_id, lang, status, title, breadcrumb, updated_at)
       VALUES ('api-page', 'en', 'published', 'API page', '[]', 1)`,
    ).run();
    const insertParent = db.prepare(
      `INSERT INTO chunk_parents
        (page_id, lang, parent_path, heading_path, text, content_hash, token_count, created_at)
       VALUES ('api-page', 'en', ?, '[]', ?, ?, ?, 1)`,
    );
    const eligibleParent = Number(
      insertParent.run('eligible-page', 'eligible page parent', 'eligible-parent', 3_300).lastInsertRowid,
    );
    const oversizedParent = Number(
      insertParent.run('oversized-page', 'oversized page parent', 'oversized-parent', 3_301).lastInsertRowid,
    );
    const insertChunk = db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, created_at)
       VALUES ('api-page', 'en', ?, ?, ?, 2, ?, 'content', 1)`,
    );
    const eligible = [
      Number(insertChunk.run('eligible/p[1]', 'eligible one', 'eligible-one', eligibleParent).lastInsertRowid),
      Number(insertChunk.run('eligible/p[2]', 'eligible two', 'eligible-two', eligibleParent).lastInsertRowid),
    ];
    const oversized = [
      Number(insertChunk.run('oversized/p[1]', 'oversized one', 'oversized-one', oversizedParent).lastInsertRowid),
      Number(insertChunk.run('oversized/p[2]', 'oversized two', 'oversized-two', oversizedParent).lastInsertRowid),
    ];

    const expanded = selectContextWithParents(
      db,
      eligible.map((id) => fakeChunk(id, eligibleParent)),
      { maxItems: 2, maxTotalTokens: 8_000 },
    );
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0]?.expanded_parent?.parent_id, eligibleParent);
    assert.equal(expanded[0]?.context_token_count, 3_300);

    const childOnly = selectContextWithParents(
      db,
      oversized.map((id) => fakeChunk(id, oversizedParent)),
      { maxItems: 2, maxTotalTokens: 8_000 },
    );
    assert.equal(childOnly.length, 2);
    assert.ok(childOnly.every((chunk) => chunk.expanded_parent === null));
  } finally {
    db.close();
  }
});

test('parent context: total token budget bounds child-only context', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const selected = selectContextWithParents(
      db,
      [
        fakeChunk(1, null, 'a'.repeat(40)),
        fakeChunk(2, null, 'b'.repeat(40)),
        fakeChunk(3, null, 'c'.repeat(40)),
      ],
      { maxItems: 3, maxTotalTokens: 15 },
    );
    assert.deepEqual(selected.map((chunk) => chunk.chunk_id), [1]);
  } finally {
    db.close();
  }
});

function fakeChunk(chunkId: number, parentId: number | null, text = `child ${chunkId}`): RerankedChunk {
  return {
    chunk_id: chunkId,
    page_id: 'api-page',
    lang: 'en',
    in_page_path: `section/p[${chunkId}]`,
    text,
    is_code: 0,
    parent_id: parentId,
    chunk_kind: 'api-response-object',
    object_path: 'data',
    page_title: 'API page',
    page_url: '/en/reference/api',
    subtree_root: 'payment-engine',
    nav_index: chunkId,
    breadcrumb: [],
    rrf_score: 1 / chunkId,
    final_score: 1 / chunkId,
  };
}
