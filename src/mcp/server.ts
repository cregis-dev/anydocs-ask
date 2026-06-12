/**
 * RFC 0007 K1 — MCP server wiring for `POST /mcp`.
 *
 * Stateless Streamable HTTP: a fresh McpServer + transport per request
 * (`sessionIdGenerator: undefined`), so there's no server-side session state —
 * each tool call is independent, matching the read-only knowledge-base shape
 * and the existing `/v1/ask` (history is caller-managed). On loopback binds a
 * port-agnostic Host guard (below) rejects a present non-loopback Host so a
 * browser page can't drive the local endpoint; the SDK transport additionally
 * enforces the Origin allowlist when one is configured.
 *
 * The gate (auth + rate limit) runs before the transport. Its rate limiter is
 * created once by the caller (app.ts) and lives with the Hono app instance.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpConfig } from '../config.ts';
import { gateMcpRequest, type McpGateErrorCode } from './gate.ts';
import { registerMcpTools, type McpToolDeps } from './tools.ts';
import type { McpRateLimiter } from './types.ts';

export const MCP_SERVER_NAME = 'anydocs-ask';
/** MCP interface version — independent of the package version; bumped when the
 *  tool surface changes in a client-visible way. */
export const MCP_SERVER_VERSION = '0.1.0';

export function buildMcpServer(toolDeps: McpToolDeps, tools: McpConfig['tools']): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  registerMcpTools(server, toolDeps, { enabledTools: tools });
  return server;
}

export type McpHandlerDeps = {
  config: McpConfig;
  /** Server bind host — when loopback, the request Host must also be loopback. */
  serverHost: string;
  /** Bearer token to require, or null to leave the endpoint open. */
  token: string | null;
  /** Persistent token-bucket limiter (shared across requests). */
  rateLimiter: McpRateLimiter;
  /** What the tools call into (db / embedder / reranker / lazy llm). */
  toolDeps: McpToolDeps;
};

/**
 * Handle a single `POST /mcp` request: gate, then hand the raw web-standard
 * Request to a fresh stateless transport and return its Response.
 */
export async function handleMcpRequest(request: Request, deps: McpHandlerDeps): Promise<Response> {
  const gate = gateMcpRequest(request.headers, {
    enabled: deps.config.enabled,
    rateLimitPerMinute: deps.config.rateLimitPerMinute,
    token: deps.token,
    rateLimiter: deps.rateLimiter,
  });
  if (!gate.ok) {
    return gateErrorResponse(gate.status, gate.code);
  }

  // DNS-rebinding protection on loopback binds: a page on evil.com that
  // resolves to 127.0.0.1 would send `Host: evil.com`. Reject a present,
  // non-loopback Host so a browser page can't drive the local endpoint.
  // Port-agnostic on purpose — the serving port can differ from config (e.g.
  // `serve --port`), and the threat is the hostname, not the port. DNS
  // rebinding is browser-only and browsers always send Host, so an absent
  // Host (curl / agent clients) is allowed through.
  if (isLoopback(deps.serverHost) && !requestHostAllowed(request)) {
    return gateErrorResponse(403, 'forbidden_host');
  }

  const server = buildMcpServer(deps.toolDeps, deps.config.tools);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Return a single JSON response per request instead of opening an SSE
    // stream. Our tools are request/response (no server-initiated
    // notifications), so JSON is simpler for clients and avoids a dangling
    // stream per call. Stateless servers process tool calls without a prior
    // `initialize` (verified), so each POST is self-contained.
    enableJsonResponse: true,
    // Origin allowlist (when configured) is enforced by the SDK transport;
    // the Host guard above covers DNS rebinding regardless.
    enableDnsRebindingProtection: deps.config.allowedOrigins.length > 0,
    ...(deps.config.allowedOrigins.length > 0
      ? { allowedOrigins: deps.config.allowedOrigins }
      : {}),
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * True when the request's `Host` header is absent (non-browser client) or
 * names a loopback hostname (any port). A present, non-loopback Host is the
 * DNS-rebinding signal and returns false.
 */
function requestHostAllowed(request: Request): boolean {
  const hostHeader = request.headers.get('host');
  if (!hostHeader) return true;
  const hostname = hostHeader
    .replace(/:\d+$/, '') // strip :port
    .replace(/^\[|\]$/g, '') // strip IPv6 brackets
    .toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function gateErrorResponse(
  status: 401 | 403 | 404 | 429,
  code: McpGateErrorCode | 'forbidden_host',
): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32001, message: code },
    id: null,
  });
  return new Response(body, { status, headers });
}
