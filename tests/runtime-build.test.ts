import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasRuntimeBuildMetadata,
  readRuntimeBuildMetadata,
} from '../src/runtime-build.ts';

test('readRuntimeBuildMetadata normalizes deployment provenance', () => {
  const build = readRuntimeBuildMetadata({
    ANYDOCS_RELEASE: '  abcdef123456  ',
    ANYDOCS_ENGINE_RELEASE: 'engine987654',
    ANYDOCS_BUILD_TIME: '2026-09-15T08:00:00Z',
    ANYDOCS_RELEASE_URL: 'https://github.com/example/docs/commit/abcdef123456',
  });

  assert.deepEqual(build, {
    release: 'abcdef123456',
    engine_release: 'engine987654',
    built_at: '2026-09-15T08:00:00Z',
    release_url: 'https://github.com/example/docs/commit/abcdef123456',
  });
  assert.equal(hasRuntimeBuildMetadata(build), true);
});

test('readRuntimeBuildMetadata rejects unsafe release URLs', () => {
  const build = readRuntimeBuildMetadata({
    ANYDOCS_RELEASE_URL: 'javascript:alert(1)',
  });

  assert.deepEqual(build, {
    release: null,
    engine_release: null,
    built_at: null,
    release_url: null,
  });
  assert.equal(hasRuntimeBuildMetadata(build), false);
});
