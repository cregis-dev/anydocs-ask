/**
 * cluster_id generation — must be deterministic and filename-safe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterIdFor, slugify } from '../src/feedback/cluster-id.ts';

test('clusterIdFor: shape is YYYY-WII-NNN-<slug>', () => {
  // 2026-05-16 is a Saturday → ISO week 2026-W20.
  const ms = Date.UTC(2026, 4, 16, 10, 24, 0);
  const id = clusterIdFor({ feedback_id: 7, created_at_ms: ms, question: 'how to authenticate via JWT' });
  assert.match(id, /^2026-W20-007-how-to-authenticate-via-jwt$/);
});

test('clusterIdFor: pads feedback_id to ≥3 digits but does not truncate', () => {
  const ms = Date.UTC(2026, 4, 16);
  assert.match(clusterIdFor({ feedback_id: 5, created_at_ms: ms, question: 'q' }), /-005-q$/);
  assert.match(clusterIdFor({ feedback_id: 12345, created_at_ms: ms, question: 'q' }), /-12345-q$/);
});

test('clusterIdFor: same args → same id (deterministic, no entropy)', () => {
  const args = { feedback_id: 3, created_at_ms: Date.UTC(2026, 4, 16), question: 'foo bar' };
  assert.equal(clusterIdFor(args), clusterIdFor(args));
});

test('slugify: ASCII alphanumeric lowercased, spaces → hyphens, punctuation dropped', () => {
  assert.equal(slugify('Hello, World! 123'), 'hello-world-123');
  assert.equal(slugify('snake_case_phrase'), 'snake-case-phrase');
  assert.equal(slugify('---trim---'), 'trim');
});

test('slugify: truncates to 32 chars and strips trailing hyphen', () => {
  const out = slugify('a'.repeat(40));
  assert.equal(out.length, 32);
  assert.equal(out, 'a'.repeat(32));
});

test('slugify: CJK characters preserved (BMP range)', () => {
  // Chinese characters are part of the slug — translit would erase semantics.
  assert.equal(slugify('如何鉴权'), '如何鉴权');
  assert.equal(slugify('登录 失败 怎么办?'), '登录-失败-怎么办');
});

test('slugify: empty or all-punctuation input yields fallback "query"', () => {
  assert.equal(slugify(''), 'query');
  assert.equal(slugify('!!!'), 'query');
  assert.equal(slugify('   '), 'query');
});
