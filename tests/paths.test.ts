/**
 * classifyPath unit tests. The indexer uses this to decide whether an event
 * is a page event, a navigation event, or unrelated noise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPath } from '../src/index/paths.ts';

const ROOT = '/projects/my-docs';

test('classifyPath: navigation/<lang>.json -> navigation event', () => {
  assert.deepEqual(classifyPath(`${ROOT}/navigation/zh.json`, ROOT), {
    kind: 'navigation',
    lang: 'zh',
  });
  assert.deepEqual(classifyPath(`${ROOT}/navigation/en.json`, ROOT), {
    kind: 'navigation',
    lang: 'en',
  });
});

test('classifyPath: pages/<lang>/X.json -> page event (any depth)', () => {
  assert.deepEqual(classifyPath(`${ROOT}/pages/zh/welcome.json`, ROOT), {
    kind: 'page',
    lang: 'zh',
  });
  assert.deepEqual(classifyPath(`${ROOT}/pages/en/guides/auth.json`, ROOT), {
    kind: 'page',
    lang: 'en',
  });
});

test('classifyPath: unrecognized lang in navigation/ -> unrelated', () => {
  assert.deepEqual(classifyPath(`${ROOT}/navigation/fr.json`, ROOT), {
    kind: 'unrelated',
  });
});

test('classifyPath: unrecognized lang in pages/ -> unrelated', () => {
  assert.deepEqual(classifyPath(`${ROOT}/pages/de/foo.json`, ROOT), {
    kind: 'unrelated',
  });
});

test('classifyPath: outside the project root -> unrelated', () => {
  assert.deepEqual(classifyPath(`/elsewhere/pages/zh/x.json`, ROOT), {
    kind: 'unrelated',
  });
});

test('classifyPath: non-JSON files -> unrelated', () => {
  assert.deepEqual(classifyPath(`${ROOT}/pages/zh/x.md`, ROOT), { kind: 'unrelated' });
  assert.deepEqual(classifyPath(`${ROOT}/navigation/zh.yaml`, ROOT), { kind: 'unrelated' });
});

test('classifyPath: navigation directory itself is not a navigation file', () => {
  assert.deepEqual(classifyPath(`${ROOT}/navigation`, ROOT), { kind: 'unrelated' });
});

test('classifyPath: top-level project files -> unrelated', () => {
  assert.deepEqual(classifyPath(`${ROOT}/anydocs.config.json`, ROOT), {
    kind: 'unrelated',
  });
  assert.deepEqual(classifyPath(`${ROOT}/README.md`, ROOT), { kind: 'unrelated' });
});
