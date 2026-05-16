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
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Runtime } from './runtime.ts';
import { buildCorsMiddleware } from './cors.ts';
import { askWithTrace, askWithTraceStream, type AskTrace } from '../query/answer.ts';
import { persistAnswer } from './answer-cache.ts';
import type { AskRequest, AskResult, Citation } from '../query/types.ts';
import type { LLM } from '../llm/types.ts';
import type { RunCitation, RunRecord } from '../runs/types.ts';
import { observeAsk } from '../feedback/gamma.ts';

const SSE_HEARTBEAT_MS = 2_000;
const SSE_INITIAL_PADDING_BYTES = 4_096;
const SSE_FLUSH_PADDING_BYTES = 4_096;

export type AppDeps = {
  runtime: Runtime;
};

type AskRouteOptions = {
  dryRun: boolean;
  source: 'reader' | 'console';
};

type PreparedAskCall =
  | {
      ok: true;
      options: AskRouteOptions;
      req: AskRequest;
      llm: LLM;
      /** session_id the Reader client echoed (null when first ask in session). */
      requestedSessionId: string | null;
    }
  | {
      ok: false;
      status: 400 | 503;
      result: AskResult;
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
    const prepared = await prepareAskCall(runtime, c);
    if (!prepared.ok) {
      return c.json(prepared.result, prepared.status);
    }
    const t0 = performance.now();
    let ask: Awaited<ReturnType<typeof askWithTrace>>;
    try {
      ask = await askWithTrace(
        { db: runtime.db, embedder: runtime.embedder, llm: prepared.llm },
        prepared.req,
      );
    } catch (err) {
      return c.json(
        {
          type: 'error',
          code: 'llm_request_failed',
          message: (err as Error).message,
        },
        502,
      );
    }
    const { result, trace, queryVector } = ask;
    const bodyOut = finalizeAskCall({
      runtime,
      req: prepared.req,
      result,
      trace,
      t0,
      options: prepared.options,
      requestedSessionId: prepared.requestedSessionId,
      queryVector,
    });

    if (result.type === 'error') {
      // llm_failed is an upstream/transient gateway problem — same family as
      // llm_unavailable (503). Everything else is client-side validation (400).
      const status = result.code === 'llm_failed' ? 503 : 400;
      return c.json(bodyOut, status);
    }
    return c.json(bodyOut, 200);
  });

  app.post('/v1/ask/stream', (c) => {
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let writeQueue = Promise.resolve();
      const writeRaw = async (input: string) => {
        if (stream.aborted) return;
        writeQueue = writeQueue
          .then(async () => {
            if (stream.aborted) return;
            await stream.write(input);
          })
          .catch(() => undefined);
        await writeQueue;
      };
      const writeComment = (comment: string) => writeRaw(`:${comment}\n\n`);
      const write = (event: string, data: unknown) =>
        writeRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const writeFlushPadding = () => writeComment(' '.repeat(SSE_FLUSH_PADDING_BYTES));
      const writeFlushed = async (event: string, data: unknown) => {
        await write(event, data);
        await writeFlushPadding();
      };
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let wroteFirstDelta = false;
      const startHeartbeat = () => {
        if (heartbeat) return;
        heartbeat = setInterval(() => {
          void writeFlushed('status', { stage: 'generating', heartbeat: true });
        }, SSE_HEARTBEAT_MS);
      };
      const stopHeartbeat = () => {
        if (!heartbeat) return;
        clearInterval(heartbeat);
        heartbeat = null;
      };

      await writeComment(' '.repeat(SSE_INITIAL_PADDING_BYTES));
      await writeFlushed('status', { stage: 'received' });
      const prepared = await prepareAskCall(runtime, c);
      if (!prepared.ok) {
        await write('result', prepared.result);
        await write('done', { ok: true });
        return;
      }

      const abortController = new AbortController();
      stream.onAbort(() => {
        stopHeartbeat();
        abortController.abort();
      });
      const t0 = performance.now();
      let ask: Awaited<ReturnType<typeof askWithTraceStream>>;
      try {
        ask = await askWithTraceStream(
          { db: runtime.db, embedder: runtime.embedder, llm: prepared.llm },
          prepared.req,
          {
            signal: abortController.signal,
            onStatus: async (stage) => {
              await writeFlushed('status', { stage });
              if (stage === 'generating') {
                startHeartbeat();
              }
            },
            onDelta: async (text) => {
              await write('delta', { text });
              if (!wroteFirstDelta) {
                wroteFirstDelta = true;
                await writeFlushPadding();
              }
            },
          },
        );
      } catch (err) {
        stopHeartbeat();
        if (stream.aborted || abortController.signal.aborted) return;
        await write('result', {
          type: 'error',
          code: 'llm_request_failed',
          message: (err as Error).message,
        });
        await write('done', { ok: true });
        return;
      }
      stopHeartbeat();
      if (stream.aborted || abortController.signal.aborted) return;

      const bodyOut = finalizeAskCall({
        runtime,
        req: prepared.req,
        result: ask.result,
        trace: ask.trace,
        t0,
        options: prepared.options,
        requestedSessionId: prepared.requestedSessionId,
        queryVector: ask.queryVector,
      });
      await write('result', bodyOut);
      await write('done', { ok: true });
    });
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
// Ask route helpers
// ---------------------------------------------------------------------------

async function prepareAskCall(runtime: Runtime, c: Context): Promise<PreparedAskCall> {
  if (!runtime.warm) {
    return {
      ok: false,
      status: 503,
      result: { type: 'error', code: 'warming', message: 'service is warming up' },
    };
  }

  // dry_run=1 short-circuits both runs.jsonl append and answer-cache persist.
  const dryRun = c.req.query('dry_run') === '1';
  // source=console marks author dogfooding. dry_run still wins later by
  // skipping all persistence.
  const sourceRaw = c.req.query('source');
  let source: 'reader' | 'console' = 'reader';
  if (sourceRaw !== undefined) {
    if (sourceRaw === 'reader' || sourceRaw === 'console') {
      source = sourceRaw;
    } else {
      return {
        ok: false,
        status: 400,
        result: {
          type: 'error',
          code: 'invalid_request',
          message: `unknown source: ${sourceRaw}`,
        },
      };
    }
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      ok: false,
      status: 400,
      result: { type: 'error', code: 'invalid_request', message: 'malformed JSON body' },
    };
  }
  if (typeof body !== 'object' || body === null) {
    return {
      ok: false,
      status: 400,
      result: { type: 'error', code: 'invalid_request', message: 'body must be a JSON object' },
    };
  }

  let llm: LLM;
  try {
    llm = runtime.llm;
  } catch (err) {
    return {
      ok: false,
      status: 503,
      result: {
        type: 'error',
        code: 'llm_unavailable',
        message: (err as Error).message,
      },
    };
  }

  const requestedSessionId =
    typeof (body as Record<string, unknown>).session_id === 'string'
      ? ((body as Record<string, unknown>).session_id as string)
      : null;

  return {
    ok: true,
    options: { dryRun, source },
    req: body as AskRequest,
    llm,
    requestedSessionId,
  };
}

function finalizeAskCall(args: {
  runtime: Runtime;
  req: AskRequest;
  result: AskResult;
  trace: AskTrace;
  t0: number;
  options: AskRouteOptions;
  requestedSessionId: string | null;
  queryVector: Float32Array | null;
}): AskResult & { session_id: string; _dry_run?: true } {
  const { runtime, req, result, trace, t0, options, requestedSessionId, queryVector } = args;

  // Persist + log to runs.jsonl regardless of outcome — analyze needs
  // visibility into errors / clarifies / answers alike. Skipped for dry_run.
  if (!options.dryRun) {
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
      source: options.source,
    });
  }

  // Persist for feedback join (v1 doesn't dedupe; every call is its own row).
  // Skipped for dry_run — answer has no persistent identity in the cache.
  if (!options.dryRun && result.type !== 'error') {
    persistAnswer(runtime.db, result, req.question);
  }

  // γ session observation (ARCH §15.2.2 / RFC 0001 §4.2). Gated internally
  // on config.feedback.{enabled, implicitSignals}. Side effects (implicit-
  // negative feedback row insertion) only happen on warm enabled boots —
  // observeAsk is a no-op identity for the session_id otherwise.
  //
  // dry_run skips γ writes the same way it skips runs.jsonl / answer cache;
  // a dry probe shouldn't leave session-state breadcrumbs in the DB.
  const gamma = observeAsk({
    db: runtime.db,
    config: runtime.config,
    sessionTable: runtime.sessions,
    requestedSessionId,
    question: (req.question ?? '').trim(),
    queryVector: options.dryRun ? null : queryVector,
    result,
    now: Date.now(),
  });

  const withSession = { ...result, session_id: gamma.session_id };
  return options.dryRun ? { ...withSession, _dry_run: true as const } : withSession;
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
    chunk_id: c.chunk_id,
    page: c.page_id,
    quote: c.snippet,
  }));
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
    source: 'reader' | 'console';
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
    source: args.source,
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
      confidence: trace.confidence,
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
