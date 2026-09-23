import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BGE_RERANKER_V2_M3_MODEL,
  BGE_RERANKER_V2_M3_REVISION,
  BgeCrossEncoder,
  DEFAULT_BGE_RERANKER_REVISION,
  resolveBgeRerankerRevision,
} from '../src/reranker/bge-cross-encoder.ts';

describe('resolveBgeRerankerRevision', () => {
  it('prefers an explicit revision', () => {
    assert.equal(
      resolveBgeRerankerRevision(' explicit-revision ', {
        BGE_RERANKER_REVISION: 'env-revision',
      }),
      'explicit-revision',
    );
  });

  it('falls back to BGE_RERANKER_REVISION', () => {
    assert.equal(
      resolveBgeRerankerRevision(undefined, {
        BGE_RERANKER_REVISION: ' env-revision ',
      }),
      'env-revision',
    );
  });

  it('returns undefined when no revision is configured', () => {
    assert.equal(resolveBgeRerankerRevision('  ', {}), undefined);
  });
});

describe('BgeCrossEncoder model identity', () => {
  it('pins the built-in model revision', () => {
    const reranker = new BgeCrossEncoder();
    assert.match(reranker.model, new RegExp(`@${DEFAULT_BGE_RERANKER_REVISION}`));
  });

  it('pins the supported v2-m3 alternative', () => {
    const reranker = new BgeCrossEncoder({ model: BGE_RERANKER_V2_M3_MODEL });
    assert.match(reranker.model, new RegExp(`@${BGE_RERANKER_V2_M3_REVISION}`));
  });

  it('does not apply the built-in revision to a custom model', () => {
    const reranker = new BgeCrossEncoder({ model: 'example/custom-reranker' });
    assert.equal(reranker.model, 'example/custom-reranker:q8');
  });
});
