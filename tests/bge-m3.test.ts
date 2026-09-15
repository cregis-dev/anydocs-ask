import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBgem3Revision } from '../src/embedding/bge-m3.ts';

describe('resolveBgem3Revision', () => {
  it('prefers an explicit revision', () => {
    assert.equal(
      resolveBgem3Revision(' explicit-revision ', { BGE_M3_REVISION: 'env-revision' }),
      'explicit-revision',
    );
  });

  it('falls back to BGE_M3_REVISION', () => {
    assert.equal(resolveBgem3Revision(undefined, { BGE_M3_REVISION: ' env-revision ' }), 'env-revision');
  });

  it('returns undefined when no revision is configured', () => {
    assert.equal(resolveBgem3Revision('  ', {}), undefined);
  });
});
