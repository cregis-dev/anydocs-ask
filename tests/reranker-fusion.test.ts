import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RerankerConfig } from '../src/config.ts';
import { applyCrossEncoderRerank } from '../src/query/answer.ts';
import type { RerankedChunk } from '../src/query/rerank.ts';
import type { Reranker } from '../src/reranker/types.ts';

function chunk(chunkId: number, rrfScore: number): RerankedChunk {
  return {
    chunk_id: chunkId,
    page_id: `page-${chunkId}`,
    lang: 'en',
    in_page_path: 'section/p[1]',
    text: `document ${chunkId}`,
    is_code: 0,
    parent_id: null,
    chunk_kind: 'content',
    object_path: null,
    identifiers: [],
    page_title: `Page ${chunkId}`,
    page_url: `/page-${chunkId}`,
    subtree_root: null,
    nav_index: chunkId,
    breadcrumb: [],
    rrf_score: rrfScore,
    final_score: rrfScore,
  };
}

function reverseReranker(): Reranker {
  return {
    model: 'test/reverse',
    ready: true,
    async warmUp() {},
    async rerank(_query, docs) {
      return docs.map((doc, index) => ({ chunk_id: doc.chunk_id, score: index }));
    },
  };
}

function config(overrides: Partial<RerankerConfig>): RerankerConfig {
  return {
    enabled: true,
    provider: 'mock',
    model: 'test/reverse',
    revision: null,
    preferQuantized: true,
    maxLength: 512,
    rerankTopK: 3,
    weight: 0.6,
    ...overrides,
  };
}

test('reranker fusion preserves RRF order when semantic weight is zero', async () => {
  const input = [chunk(1, 0.3), chunk(2, 0.2), chunk(3, 0.1)];
  const output = await applyCrossEncoderRerank(
    reverseReranker(),
    'query',
    input,
    config({ weight: 0 }),
    60,
  );

  assert.deepEqual(output.map((item) => item.chunk_id), [1, 2, 3]);
});

test('reranker fusion follows semantic order when semantic weight is one', async () => {
  const input = [chunk(1, 0.3), chunk(2, 0.2), chunk(3, 0.1)];
  const output = await applyCrossEncoderRerank(
    reverseReranker(),
    'query',
    input,
    config({ weight: 1 }),
    60,
  );

  assert.deepEqual(output.map((item) => item.chunk_id), [3, 2, 1]);
  assert.deepEqual(output.map((item) => item.final_score), [0.3, 0.2, 0.1]);
});

test('reranker fusion leaves candidates outside the configured window in RRF order', async () => {
  const input = [chunk(1, 0.4), chunk(2, 0.3), chunk(3, 0.2), chunk(4, 0.1)];
  const output = await applyCrossEncoderRerank(
    reverseReranker(),
    'query',
    input,
    config({ rerankTopK: 2, weight: 1 }),
    60,
  );

  assert.deepEqual(output.map((item) => item.chunk_id), [2, 1, 3, 4]);
  assert.deepEqual(output.map((item) => item.final_score), [0.4, 0.3, 0.2, 0.1]);
  assert.ok(output.every((item, index) => index === 0 || output[index - 1]!.final_score >= item.final_score));
});
