/**
 * RFC 0007 — `fetch_page` language selection (pickPageLang).
 *
 * A page_id can exist in several published languages; `search` hits carry their
 * own lang. These cover: honoring a passed lang, a deterministic default when
 * lang is omitted (sorted, not row-order), dedup, and the empty case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPageLang } from '../src/mcp/tools.ts';

test('pickPageLang: honors a preferred lang that exists', () => {
  assert.deepEqual(pickPageLang(['en', 'zh'], 'zh'), { lang: 'zh', available: ['en', 'zh'] });
});

test('pickPageLang: omitted lang → first in sorted order (deterministic, not row order)', () => {
  // Row order is zh-then-en; sorted default is 'en'.
  assert.deepEqual(pickPageLang(['zh', 'en'], null), { lang: 'en', available: ['en', 'zh'] });
});

test('pickPageLang: unknown preferred lang falls back to the sorted default', () => {
  assert.deepEqual(pickPageLang(['zh', 'en'], 'fr'), { lang: 'en', available: ['en', 'zh'] });
});

test('pickPageLang: single language', () => {
  assert.deepEqual(pickPageLang(['zh'], null), { lang: 'zh', available: ['zh'] });
  assert.deepEqual(pickPageLang(['zh'], 'zh'), { lang: 'zh', available: ['zh'] });
});

test('pickPageLang: dedups repeated langs', () => {
  assert.deepEqual(pickPageLang(['en', 'en', 'zh'], null), { lang: 'en', available: ['en', 'zh'] });
});

test('pickPageLang: no rows → null', () => {
  assert.equal(pickPageLang([], null), null);
  assert.equal(pickPageLang([], 'en'), null);
});
