/**
 * Frontmatter parser/emitter — constrained YAML subset only.
 *
 * The point of these tests: round-trip safety + sharp errors on malformed
 * input. The parser is the authoring surface for inbox/*.md so users will
 * eventually trip every edge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitFrontmatter,
  parseFrontmatter,
  FrontmatterParseError,
} from '../src/feedback/frontmatter.ts';

test('parse: scalar strings, numbers, booleans, null', () => {
  const r = parseFrontmatter(
    [
      `id: abc-123`,
      `count: 42`,
      `ratio: 0.5`,
      `negative: -3`,
      `ok: true`,
      `bad: false`,
      `missing: null`,
      `tilde: ~`,
    ].join('\n'),
  );
  assert.equal(r.id, 'abc-123');
  assert.equal(r.count, 42);
  assert.equal(r.ratio, 0.5);
  assert.equal(r.negative, -3);
  assert.equal(r.ok, true);
  assert.equal(r.bad, false);
  assert.equal(r.missing, null);
  assert.equal(r.tilde, null);
});

test('parse: quoted strings with escapes', () => {
  const r = parseFrontmatter(
    [
      `s: "hello world"`,
      `with_colon: "key: value"`,
      `with_hash: "has # hash"`,
      `escaped: "line1\\nline2"`,
      `single: 'single quotes'`,
    ].join('\n'),
  );
  assert.equal(r.s, 'hello world');
  assert.equal(r.with_colon, 'key: value');
  assert.equal(r.with_hash, 'has # hash');
  assert.equal(r.escaped, 'line1\nline2');
  assert.equal(r.single, 'single quotes');
});

test('parse: empty string and missing value', () => {
  const r = parseFrontmatter(['empty: ""', 'omitted:'].join('\n'));
  assert.equal(r.empty, '');
  assert.equal(r.omitted, '');
});

test('parse: inline arrays — strings, numbers, mixed', () => {
  const r = parseFrontmatter(
    [
      `ids: ["a", "b", "c"]`,
      `nums: [1, 2, 3]`,
      `bare: [foo, bar]`,
      `mixed: ["a", 1, true]`,
      `empty: []`,
    ].join('\n'),
  );
  assert.deepEqual(r.ids, ['a', 'b', 'c']);
  assert.deepEqual(r.nums, [1, 2, 3]);
  assert.deepEqual(r.bare, ['foo', 'bar']);
  assert.deepEqual(r.mixed, ['a', 1, true]);
  assert.deepEqual(r.empty, []);
});

test('parse: inline array preserves commas inside quoted items', () => {
  const r = parseFrontmatter(`q: ["hello, world", "again"]`);
  assert.deepEqual(r.q, ['hello, world', 'again']);
});

test('parse: trailing comment stripped, but # inside quotes preserved', () => {
  const r = parseFrontmatter(
    [`a: foo # this is a comment`, `b: "has # hash" # comment`].join('\n'),
  );
  assert.equal(r.a, 'foo');
  assert.equal(r.b, 'has # hash');
});

test('parse: blank lines and full-line comments are skipped', () => {
  const r = parseFrontmatter(
    [`# top comment`, ``, `id: 1`, `  # indented comment`, `name: x`].join('\n'),
  );
  assert.equal(r.id, 1);
  assert.equal(r.name, 'x');
});

test('parse: malformed line throws FrontmatterParseError with line number', () => {
  assert.throws(
    () => parseFrontmatter([`id: 1`, `not a colon line`].join('\n')),
    (err: unknown) => {
      assert.ok(err instanceof FrontmatterParseError);
      assert.match((err as Error).message, /line 2/);
      return true;
    },
  );
});

test('parse: unterminated inline array throws', () => {
  assert.throws(() => parseFrontmatter(`q: [a, b`), /unterminated inline array/);
});

test('emit: scalars round-trip identity', () => {
  const obj = {
    id: 'abc-123',
    count: 42,
    ok: true,
    notes: '',
  };
  const out = emitFrontmatter(obj);
  const back = parseFrontmatter(out);
  assert.deepEqual(back, obj);
});

test('emit: quote strings that look like other scalar types', () => {
  const obj = { decision: 'true', tag: '42', maybe: 'null' };
  const out = emitFrontmatter(obj);
  // Quoting prevents the parser from coercing back to bool/number/null.
  const back = parseFrontmatter(out);
  assert.equal(back.decision, 'true');
  assert.equal(back.tag, '42');
  assert.equal(back.maybe, 'null');
});

test('emit: quote strings with structural chars', () => {
  const obj = { with_colon: 'key: value', empty: '' };
  const out = emitFrontmatter(obj);
  assert.match(out, /with_colon: "key: value"/);
  assert.match(out, /empty: ""/);
  assert.deepEqual(parseFrontmatter(out), obj);
});

test('emit: inline arrays of strings round-trip', () => {
  const obj = { ids: ['a', 'b, c', 'd'] };
  const out = emitFrontmatter(obj);
  assert.deepEqual(parseFrontmatter(out), obj);
});

test('emit: null and boolean round-trip', () => {
  const obj = { current: null, enabled: true };
  const back = parseFrontmatter(emitFrontmatter(obj));
  assert.equal(back.current, null);
  assert.equal(back.enabled, true);
});
