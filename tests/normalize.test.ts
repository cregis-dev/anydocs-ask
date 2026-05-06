/**
 * normalize() unit tests — one per step of the algorithm in ARCH §7.1.2.
 * If any of these break, the embedding cache invalidates and §4.6
 * "drag-zero-reembed" silently regresses on real projects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, contentHash } from '../src/content/normalize.ts';

test('NFKC: fullwidth ASCII collapses to halfwidth', () => {
  assert.equal(normalizeText('ＡＢＣ１２３'), 'ABC123');
});

test('NFKC: compatibility forms fold (e.g. ligature ﬁ -> fi)', () => {
  assert.equal(normalizeText('ﬁle'), 'file');
});

test('line endings: CRLF and CR both become LF', () => {
  assert.equal(normalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('zero-width: ZWSP / ZWNJ / ZWJ / BOM stripped', () => {
  assert.equal(normalizeText('a​b‌c‍d﻿e'), 'abcde');
});

test('per-line: collapse runs of spaces / tabs', () => {
  assert.equal(normalizeText('foo  \t bar'), 'foo bar');
});

test('per-line: trailing spaces / tabs trimmed but newlines kept', () => {
  assert.equal(normalizeText('foo   \nbar'), 'foo\nbar');
});

test('outer trim: leading and trailing whitespace removed', () => {
  assert.equal(normalizeText('\n  foo\nbar  \n'), 'foo\nbar');
});

test('NO case folding: getUserById vs getuserbyid stay distinct', () => {
  assert.notEqual(contentHash('getUserById()'), contentHash('getuserbyid()'));
});

test('determinism: same input -> same hash across calls', () => {
  const text = 'API name uses non-breaking space';
  assert.equal(contentHash(text), contentHash(text));
});

test('whitespace-only differences collapse to the same hash', () => {
  // Same logical content, just messy whitespace and CRLF.
  const a = 'hello   world';
  const b = 'hello　world'; // U+3000 is ideographic space, NFKC → ' '
  const c = 'hello world\r\n';
  assert.equal(contentHash(a), contentHash(b));
  assert.equal(contentHash(a), contentHash(c));
});

test('content-bearing differences change the hash', () => {
  assert.notEqual(contentHash('hello'), contentHash('hello!'));
  assert.notEqual(contentHash('SDK'), contentHash('SDKs'));
});
