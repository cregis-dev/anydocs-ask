import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterByQuery, levenshteinAtMost, normalize } from '../src/analyze/cluster.ts';

test('normalize: case + punct + whitespace', () => {
  assert.equal(normalize('  How DO  I, install? '), 'how do i install');
});

test('normalize: NFKC + CJK preserved', () => {
  assert.equal(normalize('如何 安装  Hermes  ？'), '如何 安装 hermes');
});

test('levenshtein: identical strings -> 0', () => {
  assert.equal(levenshteinAtMost('hello', 'hello', 5), 0);
});

test('levenshtein: distance 2', () => {
  assert.equal(levenshteinAtMost('kitten', 'sitten', 5), 1);
  assert.equal(levenshteinAtMost('kitten', 'sittin', 5), 2);
});

test('levenshtein: early-exit when length diff exceeds max', () => {
  // length diff = 6, max = 5 -> 6 returned
  assert.equal(levenshteinAtMost('abc', 'abcdefghi', 5), 6);
});

test('levenshtein: early-exit on row min > max', () => {
  // Wildly different strings; expect max+1 (=6).
  assert.equal(levenshteinAtMost('aaaaaaaa', 'zzzzzzzz', 5), 6);
});

test('cluster: exact-normalized buckets merge', () => {
  const items = [
    { id: 'a', q: 'How do I install?' },
    { id: 'b', q: 'how do i  install' },
    { id: 'c', q: 'something else entirely' },
  ];
  const out = clusterByQuery(items, { queryOf: (i) => i.q });
  assert.equal(out.length, 2);
  // Larger cluster sorted first
  assert.equal(out[0]!.items.length, 2);
  assert.equal(out[1]!.items.length, 1);
});

test('cluster: near-duplicate union by edit distance', () => {
  // Differ by 1 char after normalize ("install" vs "instal") -> within 5
  const items = [
    { q: 'how do I install hermes' },
    { q: 'how do i instal hermes' },
    { q: 'how do i install hermes!' }, // punctuation drops out -> exact dup of #1
  ];
  const out = clusterByQuery(items, { queryOf: (i) => i.q });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.items.length, 3);
  // Variants record raw (un-normalized) form
  assert.equal(out[0]!.variants.length, 3);
});

test('cluster: too-far queries stay separate', () => {
  const items = [
    { q: 'how do I install hermes' },
    { q: 'what is the recommended deployment strategy for production' },
  ];
  const out = clusterByQuery(items, { queryOf: (i) => i.q });
  assert.equal(out.length, 2);
});
