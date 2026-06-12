/**
 * RFC 0007 — shared types for the MCP knowledge-base interface.
 */

/**
 * Token-bucket interface the MCP gate consumes. Structurally identical to the
 * widget limiter ({@link import('../widget/server-gate.ts').WidgetRateLimiter})
 * so the production {@link import('../widget/server-gate.ts').InProcessRateLimiter}
 * satisfies both — the MCP path reuses that implementation rather than shipping
 * a second token bucket.
 */
export interface McpRateLimiter {
  /** Consume 1 token; true = allowed, false = bucket empty (respond 429). */
  take(key: string, capacityPerMinute: number): boolean;
}
