/**
 * Public library entry for `@anydocs/ask`.
 *
 * Stage 1 surface is intentionally minimal — embedders / tests can import the
 * Hono app factory directly. Public API will widen as stages 2-7 land.
 */

export { createApp } from './server/app.ts';
export type { AppDeps } from './server/app.ts';
