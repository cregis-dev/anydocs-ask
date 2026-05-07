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

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Hono } from 'hono';
import type { Runtime } from './runtime.ts';
import { buildCorsMiddleware } from './cors.ts';
import { askWithTrace, type AskTrace } from '../query/answer.ts';
import { persistAnswer } from './answer-cache.ts';
import type { AskRequest, AskResult, Citation } from '../query/types.ts';
import type { RunCitation, RunRecord } from '../runs/types.ts';

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
    const t0 = performance.now();
    const { result, trace } = await askWithTrace(
      { db: runtime.db, embedder: runtime.embedder, llm },
      req,
    );

    // Persist + log to runs.jsonl regardless of outcome — analyze needs
    // visibility into errors / clarifies / answers alike.
    const requestId = randomUUID();
    const latencyMs =
      result.type === 'answer' ? result.latency_ms : Math.round(performance.now() - t0);
    appendRun(runtime, {
      requestId,
      query: req.question ?? '',
      filters: extractFilters(req),
      contextPageId: req.context?.current_page_id ?? null,
      result,
      trace,
      latencyMs,
    });

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

// ---------------------------------------------------------------------------
// Runs jsonl helpers (ARCH §16.4)
// ---------------------------------------------------------------------------

function extractFilters(req: AskRequest): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (req.context?.scope_id !== undefined && req.context.scope_id !== null) {
    filters.scope_id = req.context.scope_id;
  }
  if (req.options?.max_chunks !== undefined) {
    filters.max_chunks = req.options.max_chunks;
  }
  if (req.options?.model !== undefined && req.options.model !== null) {
    filters.model_override = req.options.model;
  }
  return filters;
}

function citationsForRun(citations: Citation[]): RunCitation[] {
  return citations.map((c) => ({
    chunk_id: chunkIdFromCitationId(c.citation_id),
    page: c.page_id,
    quote: c.snippet,
  }));
}

/**
 * Citation ids are formatted "c<chunk_id>:..." in v1 — see postprocess.ts.
 * We pull the numeric chunk id back out so runs records match the trace.
 * Returns null on any unexpected shape (forward-compat).
 */
function chunkIdFromCitationId(citationId: string): number | null {
  const m = /^c(\d+)/.exec(citationId);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function appendRun(
  runtime: Runtime,
  args: {
    requestId: string;
    query: string;
    filters: Record<string, unknown>;
    contextPageId: string | null;
    result: AskResult;
    trace: AskTrace;
    latencyMs: number;
  },
): void {
  if (!runtime.runs.isEnabled) return;
  const { result, trace } = args;
  let kind: RunRecord['answer']['kind'];
  let answerId: string | null = null;
  let md: string | null = null;
  let citations: RunCitation[] = [];
  let model: string | null = null;
  let errorCode: string | null = null;
  if (result.type === 'answer') {
    kind = 'answer';
    answerId = result.answer_id;
    md = result.answer_md;
    citations = citationsForRun(result.citations);
    model = result.model;
  } else if (result.type === 'clarify') {
    kind = 'clarify';
    answerId = result.answer_id;
    md = result.message;
  } else {
    kind = 'error';
    errorCode = result.code;
    md = result.message;
  }
  const record: RunRecord = {
    ts: new Date().toISOString(),
    request_id: args.requestId,
    session_id: null,
    query: args.query,
    filters: args.filters,
    context_pageId: args.contextPageId,
    retrieval: {
      fused: trace.fused.map((f) => ({
        chunk_id: f.chunk_id,
        page: f.page_id,
        rrf_score: f.rrf_score,
        final_score: f.final_score,
        vec_rank: f.vec_rank,
        bm25_rank: f.bm25_rank,
        nav_index: f.nav_index,
        nav_index_boost: f.nav_index_boost,
      })),
      subtree_ask_triggered: trace.subtree_ask_triggered,
    },
    answer: {
      kind,
      answer_id: answerId,
      md,
      citations,
      confidence: trace.top_final_score,
      latency_ms: args.latencyMs,
      tokens_in: trace.tokens_in,
      tokens_out: trace.tokens_out,
      model,
      error_code: errorCode,
    },
    feedback: { beta: null, gamma: null },
  };
  runtime.runs.append(record);
}
