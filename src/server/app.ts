/**
 * Hono app for the Ask HTTP API. Routes mirror PRD §5 / ARCH §5.
 *
 * The app holds no state of its own — everything lives on the Runtime that
 * is passed in. That keeps tests easy: build a Runtime backed by mock
 * embedder / mock LLM / in-memory DB, hit `app.fetch(req)`, assert on the
 * response.
 *
 * Warm-up gating: /v1/health switches between 503 and 200 based on
 * runtime.warm. The query and index endpoints additionally short-circuit
 * to 503 while warm-up is in flight, so a panicky client polling /v1/ask
 * during boot doesn't tie up resources.
 */

import { Hono } from 'hono';
import type { Runtime } from './runtime.ts';
import { buildCorsMiddleware } from './cors.ts';
import { ask } from '../query/answer.ts';
import { persistAnswer } from './answer-cache.ts';
import type { AskRequest } from '../query/types.ts';

export type AppDeps = {
  runtime: Runtime;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { runtime } = deps;

  app.use('*', buildCorsMiddleware(runtime.config.server));

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------
  app.get('/v1/health', (c) => {
    if (!runtime.warm) {
      return c.json({ status: 'warming', warm: false }, 503);
    }
    return c.json({
      status: 'ok',
      warm: true,
      booted_at: runtime.bootedAtMs,
    });
  });

  // -----------------------------------------------------------------------
  // Ask
  // -----------------------------------------------------------------------
  app.post('/v1/ask', async (c) => {
    if (!runtime.warm) {
      return c.json({ type: 'error', code: 'warming', message: 'service is warming up' }, 503);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { type: 'error', code: 'invalid_request', message: 'malformed JSON body' },
        400,
      );
    }
    if (typeof body !== 'object' || body === null) {
      return c.json(
        { type: 'error', code: 'invalid_request', message: 'body must be a JSON object' },
        400,
      );
    }
    const req = body as AskRequest;
    let llm;
    try {
      llm = runtime.llm;
    } catch (err) {
      return c.json(
        {
          type: 'error',
          code: 'llm_unavailable',
          message: (err as Error).message,
        },
        503,
      );
    }
    const result = await ask(
      { db: runtime.db, embedder: runtime.embedder, llm },
      req,
    );

    if (result.type === 'error') {
      const status = result.code === 'invalid_scope' ? 400 : 400;
      return c.json(result, status);
    }
    // Persist for feedback join (v1 doesn't dedupe; every call is its own row).
    persistAnswer(runtime.db, result, req.question);
    return c.json(result, 200);
  });

  // -----------------------------------------------------------------------
  // Feedback
  // -----------------------------------------------------------------------
  app.post('/v1/ask/feedback', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ type: 'error', code: 'invalid_request' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ type: 'error', code: 'invalid_request' }, 400);
    }
    const obj = body as Record<string, unknown>;
    const answer_id = typeof obj.answer_id === 'string' ? obj.answer_id : null;
    if (!answer_id) {
      return c.json(
        { type: 'error', code: 'invalid_request', message: 'answer_id is required' },
        400,
      );
    }

    // Look up the original answer for current_page_id / retrieved snapshot,
    // then write a feedback row. We don't fail-hard when answer_id isn't
    // found in answers table (might have aged out past 24h TTL).
    const original = runtime.db
      .prepare(`SELECT payload FROM answers WHERE answer_id = ?`)
      .get(answer_id) as { payload: string } | undefined;
    let question = '';
    let model = '';
    let retrieved: unknown = null;
    if (original) {
      try {
        const parsed = JSON.parse(original.payload) as {
          answer_md?: string;
          model?: string;
          citations?: unknown;
        };
        retrieved = parsed.citations ?? null;
        model = parsed.model ?? '';
      } catch {
        // ignore — partial feedback is still useful.
      }
    }

    runtime.db
      .prepare(
        `INSERT INTO feedback (
           answer_id, question, current_page_id, retrieved, generated, rating,
           correction, bad_citation_ids, tags, model_used, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        answer_id,
        question,
        typeof obj.current_page_id === 'string' ? obj.current_page_id : null,
        retrieved !== null ? JSON.stringify(retrieved) : null,
        typeof obj.generated === 'string' ? obj.generated : '',
        typeof obj.rating === 'number' ? obj.rating : null,
        typeof obj.correction === 'string' ? obj.correction : null,
        Array.isArray(obj.bad_citation_ids)
          ? JSON.stringify(obj.bad_citation_ids.filter((x) => typeof x === 'string'))
          : null,
        Array.isArray(obj.tags)
          ? JSON.stringify(obj.tags.filter((x) => typeof x === 'string'))
          : null,
        model,
        Date.now(),
      );

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Index status / rebuild
  // -----------------------------------------------------------------------
  app.get('/v1/index/status', (c) => {
    const counts = runtime.db
      .prepare(`SELECT
                  (SELECT COUNT(*) FROM pages) AS page_count,
                  (SELECT COUNT(*) FROM chunks) AS chunk_count,
                  (SELECT COUNT(*) FROM embedding_cache) AS embedding_cache_size`)
      .get() as { page_count: number; chunk_count: number; embedding_cache_size: number };
    return c.json({
      project_root: runtime.projectRoot,
      page_count: counts.page_count,
      chunk_count: counts.chunk_count,
      embedding_cache_size: counts.embedding_cache_size,
      embedding_model: runtime.config.embedding.model,
      llm_model: runtime.config.llm.model,
      warm: runtime.warm,
      last_indexed_at: runtime.lastIndexedAtMs,
    });
  });

  app.post('/v1/index/rebuild', async (c) => {
    if (!runtime.warm) {
      return c.json({ type: 'error', code: 'warming', message: 'service is warming up' }, 503);
    }
    const stats = await runtime.forceReindex();
    return c.json({ ok: true, stats });
  });

  app.notFound((c) => c.json({ type: 'error', code: 'not_found' }, 404));
  return app;
}
