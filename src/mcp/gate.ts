/**
 * RFC 0007 K4 — MCP request gating for `POST /mcp`.
 *
 * Three guards run before a request reaches the MCP transport:
 *
 *   1. **Feature flag** — `mcp.enabled` false → 404 `mcp_disabled` (the
 *      endpoint behaves as if it doesn't exist).
 *   2. **Bearer auth** — when a token is configured (env `ANYDOCS_MCP_TOKEN`),
 *      `Authorization: Bearer <token>` must match (constant-time). 401
 *      `unauthorized` + `WWW-Authenticate: Bearer` otherwise. When no token is
 *      configured the endpoint is open — intended for loopback / trusted-network
 *      deploys, where DNS-rebinding protection (SDK transport) is the guard.
 *   3. **Rate limit** — token bucket keyed by token (or Origin when anonymous)
 *      at `mcp.rateLimitPerMinute`. 429 `rate_limited` when exhausted.
 *
 * DNS-rebinding / Host / Origin validation is NOT done here — it lives on the
 * SDK's WebStandardStreamableHTTPServerTransport (configured in server.ts).
 *
 * Pure module — no Hono / runtime deps. Caller wires it into the request
 * pipeline and turns the outcome into a Response.
 */

import { timingSafeEqual } from 'node:crypto';
import type { McpRateLimiter } from './types.ts';

export type McpGateDeps = {
  /** Slice of `ResolvedConfig.mcp` the gate consumes. */
  enabled: boolean;
  rateLimitPerMinute: number;
  /** Bearer token to require, or null/empty to leave the endpoint open. */
  token: string | null;
  /** Token-bucket impl. Injected so tests can use a deterministic clock. */
  rateLimiter: McpRateLimiter;
};

export type McpGateOutcome =
  | { ok: true }
  | { ok: false; status: 401 | 404 | 429; code: McpGateErrorCode };

export type McpGateErrorCode = 'mcp_disabled' | 'unauthorized' | 'rate_limited';

/** Header accessor — Hono's `c.req.raw.headers` (a `Headers`) satisfies this. */
export type McpGateRequest = {
  get(headerName: string): string | null;
};

export function gateMcpRequest(req: McpGateRequest, deps: McpGateDeps): McpGateOutcome {
  if (!deps.enabled) {
    return { ok: false, status: 404, code: 'mcp_disabled' };
  }

  const token = deps.token?.trim() ?? '';
  if (token.length > 0) {
    const presented = bearerToken(req.get('Authorization'));
    if (!constantTimeEquals(presented, token)) {
      return { ok: false, status: 401, code: 'unauthorized' };
    }
  }

  // Rate-limit dimension: per-token when authenticated, else per-Origin (or a
  // single shared bucket when neither is present — the loopback dev case).
  const rateKey =
    token.length > 0 ? `tok:${token}` : `org:${(req.get('Origin') ?? '').trim() || 'anon'}`;
  if (!deps.rateLimiter.take(rateKey, deps.rateLimitPerMinute)) {
    return { ok: false, status: 429, code: 'rate_limited' };
  }

  return { ok: true };
}

function bearerToken(authHeader: string | null): string {
  if (!authHeader) return '';
  const trimmed = authHeader.trim();
  // Case-insensitive scheme per RFC 7235.
  if (!/^bearer\s+/i.test(trimmed)) return '';
  return trimmed.replace(/^bearer\s+/i, '').trim();
}

/**
 * Constant-time string compare. `timingSafeEqual` throws on length mismatch,
 * so we guard that first — the early return on differing length leaks only the
 * length, which is acceptable for a bearer token.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Resolve the configured MCP bearer token from the environment. */
export function resolveMcpToken(): string | null {
  const token = process.env.ANYDOCS_MCP_TOKEN?.trim();
  return token && token.length > 0 ? token : null;
}
