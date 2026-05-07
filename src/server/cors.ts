/**
 * CORS middleware factory — ARCH §10.1.
 *
 * Two modes:
 *   - production (NODE_ENV === 'production'): only origins listed in
 *     `server.cors.allowedOrigins` are allowed. An empty list allows
 *     nothing (and we warn at startup so the operator notices).
 *   - development (anything else): localhost / 127.0.0.1 on any port is
 *     allowed automatically; the configured allowedOrigins are added on top.
 *
 * Allow-Credentials is hard-coded false (v1 has no cookie / session use).
 */

import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { ServerConfig } from '../config.ts';

const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function buildCorsMiddleware(config: ServerConfig): MiddlewareHandler {
  const isProd = process.env.NODE_ENV === 'production';
  const configured = config.cors.allowedOrigins;

  if (isProd && configured.length === 0) {
    process.stderr.write(
      '[ask] WARNING: NODE_ENV=production but server.cors.allowedOrigins is empty; ' +
        'all cross-origin browser requests will be rejected.\n',
    );
  }

  return cors({
    origin: (origin) => {
      if (!origin) return null; // same-origin / curl — let it through implicitly
      if (configured.includes(origin)) return origin;
      if (!isProd && DEV_ORIGIN_RE.test(origin)) return origin;
      return null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: false,
  });
}
