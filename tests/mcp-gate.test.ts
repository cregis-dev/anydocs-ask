/**
 * RFC 0007 K4 — MCP gate: feature flag, bearer auth, rate limit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateMcpRequest, type McpGateDeps } from '../src/mcp/gate.ts';
import { InProcessRateLimiter } from '../src/widget/server-gate.ts';

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const h = new Headers(map);
  return { get: (name: string) => h.get(name) };
}

function deps(over: Partial<McpGateDeps> = {}): McpGateDeps {
  return {
    enabled: true,
    rateLimitPerMinute: 60,
    token: null,
    rateLimiter: new InProcessRateLimiter(),
    ...over,
  };
}

test('gate: disabled → 404 mcp_disabled', () => {
  const out = gateMcpRequest(headers({}), deps({ enabled: false }));
  assert.deepEqual(out, { ok: false, status: 404, code: 'mcp_disabled' });
});

test('gate: no token configured → open (passes without Authorization)', () => {
  const out = gateMcpRequest(headers({}), deps({ token: null }));
  assert.deepEqual(out, { ok: true });
});

test('gate: token configured, missing Authorization → 401', () => {
  const out = gateMcpRequest(headers({}), deps({ token: 'secret' }));
  assert.deepEqual(out, { ok: false, status: 401, code: 'unauthorized' });
});

test('gate: token configured, wrong token → 401', () => {
  const out = gateMcpRequest(
    headers({ Authorization: 'Bearer nope' }),
    deps({ token: 'secret' }),
  );
  assert.deepEqual(out, { ok: false, status: 401, code: 'unauthorized' });
});

test('gate: token configured, correct token → ok (case-insensitive scheme)', () => {
  const out = gateMcpRequest(
    headers({ Authorization: 'bearer secret' }),
    deps({ token: 'secret' }),
  );
  assert.deepEqual(out, { ok: true });
});

test('gate: rate limit exhausts after capacity, keyed per token', () => {
  const rateLimiter = new InProcessRateLimiter();
  const d = deps({ token: 'k', rateLimitPerMinute: 2, rateLimiter });
  const h = headers({ Authorization: 'Bearer k' });
  assert.equal(gateMcpRequest(h, d).ok, true);
  assert.equal(gateMcpRequest(h, d).ok, true);
  const third = gateMcpRequest(h, d);
  assert.deepEqual(third, { ok: false, status: 429, code: 'rate_limited' });
});

test('gate: anonymous rate limit keyed per Origin (distinct buckets)', () => {
  const rateLimiter = new InProcessRateLimiter();
  const d = deps({ token: null, rateLimitPerMinute: 1, rateLimiter });
  const a = headers({ Origin: 'https://a.example.com' });
  const b = headers({ Origin: 'https://b.example.com' });
  assert.equal(gateMcpRequest(a, d).ok, true);
  assert.equal(gateMcpRequest(a, d).ok, false); // a exhausted
  assert.equal(gateMcpRequest(b, d).ok, true); // b has its own bucket
});
