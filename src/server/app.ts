import { Hono } from 'hono';

export type AppDeps = {
  projectRoot: string;
};

/**
 * Create the Hono app for an anydocs-ask server.
 *
 * v1 routes (PRD §5):
 *   POST /v1/ask
 *   POST /v1/ask/feedback
 *   GET  /v1/health
 *   GET  /v1/index/status
 *   POST /v1/index/rebuild
 *
 * Stage 1 only stubs /v1/health so the server can boot end-to-end while the
 * data + query pipelines are built out (stages 2-7).
 */
export function createApp(_deps: AppDeps): Hono {
  const app = new Hono();

  // TODO(stage 7): plug in CORS middleware (ARCH §10.1).

  app.get('/v1/health', (c) => {
    // TODO(stage 5): return 503 while embedding model warms up; 200 once warm.
    return c.json({ status: 'ok', warm: true });
  });

  app.notFound((c) => c.json({ type: 'error', code: 'not_found' }, 404));

  return app;
}
