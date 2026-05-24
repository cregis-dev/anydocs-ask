/**
 * RFC 0004 W4 alpha.2 — Widget gate unit tests.
 *
 * Pure-module tests. The three guards (origin allowlist / project-key shape
 * / rate limit) + the token-bucket implementation are exercised here
 * directly; server e2e is in tests/widget-server.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateWidgetRequest,
  InProcessRateLimiter,
  isWidgetRequest,
  type WidgetGateDeps,
  type WidgetGateRequest,
} from '../src/widget/server-gate.ts';

function mkReq(headers: Record<string, string>): WidgetGateRequest {
  return {
    get(name: string) {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) return v;
      }
      return null;
    },
  };
}

function mkDeps(overrides: Partial<WidgetGateDeps> = {}): WidgetGateDeps {
  return {
    enabled: true,
    allowedOrigins: ['https://app.example.com'],
    rateLimitPerMinute: 60,
    rateLimiter: new InProcessRateLimiter(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isWidgetRequest
// ---------------------------------------------------------------------------

test('isWidgetRequest: true when X-Project-Key header present', () => {
  assert.equal(isWidgetRequest(mkReq({ 'X-Project-Key': 'pk_test_1' })), true);
});

test('isWidgetRequest: false when header absent', () => {
  assert.equal(isWidgetRequest(mkReq({ 'Content-Type': 'application/json' })), false);
});

test('isWidgetRequest: empty-string key still counts as widget (gate later rejects shape)', () => {
  // The widget bundle would never send empty, but we want the gate to do
  // the rejection — not the detection — so the response carries
  // `invalid_project_key` instead of a silent pass-through.
  assert.equal(isWidgetRequest(mkReq({ 'X-Project-Key': '' })), true);
});

// ---------------------------------------------------------------------------
// gateWidgetRequest — three guards
// ---------------------------------------------------------------------------

test('gateWidgetRequest: happy path → ok + meta', () => {
  const out = gateWidgetRequest(
    mkReq({ 'X-Project-Key': 'pk_test_x', Origin: 'https://app.example.com' }),
    mkDeps(),
  );
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.meta.projectKey, 'pk_test_x');
    assert.equal(out.meta.origin, 'https://app.example.com');
  }
});

test('gateWidgetRequest: widget.enabled=false → 404 widget_disabled', () => {
  const out = gateWidgetRequest(
    mkReq({ 'X-Project-Key': 'pk_x', Origin: 'https://app.example.com' }),
    mkDeps({ enabled: false }),
  );
  assert.deepEqual(out, { ok: false, status: 404, code: 'widget_disabled' });
});

test('gateWidgetRequest: missing X-Project-Key → 400 invalid_project_key', () => {
  // The shape guard catches both "header absent" and "header empty" (caller
  // got here via `isWidgetRequest=true` on an empty header).
  const out = gateWidgetRequest(
    mkReq({ Origin: 'https://app.example.com' }),
    mkDeps(),
  );
  assert.deepEqual(out, { ok: false, status: 400, code: 'invalid_project_key' });
});

test('gateWidgetRequest: whitespace-only project key → 400 invalid_project_key', () => {
  const out = gateWidgetRequest(
    mkReq({ 'X-Project-Key': '   ', Origin: 'https://app.example.com' }),
    mkDeps(),
  );
  assert.deepEqual(out, { ok: false, status: 400, code: 'invalid_project_key' });
});

test('gateWidgetRequest: Origin not in allowlist → 403 origin_not_allowed', () => {
  const out = gateWidgetRequest(
    mkReq({ 'X-Project-Key': 'pk_x', Origin: 'https://evil.example.com' }),
    mkDeps(),
  );
  assert.deepEqual(out, { ok: false, status: 403, code: 'origin_not_allowed' });
});

test('gateWidgetRequest: missing Origin (server-flavoured curl) → 403 origin_not_allowed', () => {
  // alpha.2: widget calls MUST carry a real browser Origin. Server-to-
  // server callers go around the gate by NOT sending X-Project-Key.
  const out = gateWidgetRequest(
    mkReq({ 'X-Project-Key': 'pk_x' }),
    mkDeps(),
  );
  assert.deepEqual(out, { ok: false, status: 403, code: 'origin_not_allowed' });
});

test('gateWidgetRequest: rate-limit exhaustion → 429 rate_limited', () => {
  // Force a tiny bucket so the first call passes and the second 429s.
  const limiter = new InProcessRateLimiter({ now: () => 1_000_000 });
  const deps = mkDeps({ rateLimitPerMinute: 1, rateLimiter: limiter });
  const req = mkReq({ 'X-Project-Key': 'pk_x', Origin: 'https://app.example.com' });
  assert.equal(gateWidgetRequest(req, deps).ok, true);
  const denied = gateWidgetRequest(req, deps);
  assert.deepEqual(denied, { ok: false, status: 429, code: 'rate_limited' });
});

test('gateWidgetRequest: rate-limit per (key, origin) is isolated', () => {
  const limiter = new InProcessRateLimiter({ now: () => 1_000_000 });
  const deps = mkDeps({ rateLimitPerMinute: 1, rateLimiter: limiter });
  const a = mkReq({ 'X-Project-Key': 'pk_a', Origin: 'https://app.example.com' });
  const b = mkReq({ 'X-Project-Key': 'pk_b', Origin: 'https://app.example.com' });
  assert.equal(gateWidgetRequest(a, deps).ok, true);
  assert.equal(gateWidgetRequest(b, deps).ok, true, 'different key gets its own bucket');
  assert.equal(gateWidgetRequest(a, deps).ok, false, 'pk_a is now exhausted');
  assert.equal(gateWidgetRequest(b, deps).ok, false, 'pk_b is now exhausted');
});

// ---------------------------------------------------------------------------
// InProcessRateLimiter — token-bucket internals
// ---------------------------------------------------------------------------

test('InProcessRateLimiter: take returns true until bucket exhausted', () => {
  const limiter = new InProcessRateLimiter({ now: () => 1_000_000 });
  // capacity = 3, first 3 take() pass, 4th fails.
  assert.equal(limiter.take('k', 3), true);
  assert.equal(limiter.take('k', 3), true);
  assert.equal(limiter.take('k', 3), true);
  assert.equal(limiter.take('k', 3), false);
});

test('InProcessRateLimiter: refill linear over 60 seconds', () => {
  let now = 1_000_000;
  const limiter = new InProcessRateLimiter({ now: () => now });
  // Drain bucket (capacity = 60).
  for (let i = 0; i < 60; i++) {
    assert.equal(limiter.take('k', 60), true);
  }
  assert.equal(limiter.take('k', 60), false);
  // Advance 1 second → 1 token refilled.
  now += 1_000;
  assert.equal(limiter.take('k', 60), true, '1 token refilled after 1s');
  assert.equal(limiter.take('k', 60), false, 'and only 1 (60 / 60 = 1/s)');
  // Advance 30 seconds → 30 tokens refilled.
  now += 30_000;
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (limiter.take('k', 60)) allowed++;
  assert.equal(allowed, 30);
});

test('InProcessRateLimiter: capacity change between takes applies immediately', () => {
  // Operator flips rateLimitPerMinute mid-flight; the limiter caps at the
  // new value without rebuild.
  let now = 1_000_000;
  const limiter = new InProcessRateLimiter({ now: () => now });
  assert.equal(limiter.take('k', 5), true); // tokens: 4
  // Drain to 0 with capacity 5.
  for (let i = 0; i < 4; i++) limiter.take('k', 5);
  assert.equal(limiter.take('k', 5), false);
  // Bump capacity to 10. Refill 1 minute → 10 tokens credited (full bucket).
  now += 60_000;
  let allowed = 0;
  for (let i = 0; i < 11; i++) if (limiter.take('k', 10)) allowed++;
  assert.equal(allowed, 10);
});

test('InProcessRateLimiter: keys evicted after 10 min of inactivity', () => {
  let now = 1_000_000;
  const limiter = new InProcessRateLimiter({ now: () => now });
  limiter.take('cold', 60);
  limiter.take('warm', 60);
  assert.equal(limiter.size, 2);
  // Jump 11 minutes forward; sweep runs on next take.
  now += 11 * 60_000;
  limiter.take('warm', 60); // touch the warm key just before sweep evicts
  // Now sweep will run since lastSweep is stale. Trigger via another take.
  now += 60_001;
  limiter.take('warm', 60);
  // cold should be gone; warm survives.
  assert.equal(limiter.size, 1);
});
