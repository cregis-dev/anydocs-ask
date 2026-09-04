import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/index.ts';
import { expandParentContext } from '../src/query/answer.ts';
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
