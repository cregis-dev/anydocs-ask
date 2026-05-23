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
import type { RunCitation, RunCitationCheckUpdate, RunRecord } from '../runs/types.ts';
import { observeAsk } from '../feedback/gamma.ts';
import { renderAskPage, getMarkedScript } from './web-ask.ts';
import { extractClaimChunkPairs } from '../query/claim-extractor.ts';
import { validateCitations } from '../query/citation-validator.ts';

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
  // Web Ask reader — minimal end-user HTML at GET /ask. Designed so the
  // operator can hand an internal/early user the URL to try the project's
  // answering quality, and so the same page can be embedded later (no
  // cookies, no auth). The page POSTs to /v1/ask/stream for live streaming.
  // -----------------------------------------------------------------------
  app.get('/ask', (c) => {
    const html = renderAskPage({ prompt: runtime.config.prompt });
    return c.html(html);
  });
  app.get('/ask/marked.esm.js', (c) => {
    const asset = getMarkedScript();
    c.header('Content-Type', asset.contentType);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(asset.body);
  });

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
    injectMultiTurnHistory(runtime, prepared.req, prepared.requestedSessionId);
    const t0 = performance.now();
    let ask: Awaited<ReturnType<typeof askWithTrace>>;
    try {
      ask = await askWithTrace(
        { db: runtime.db, embedder: runtime.embedder, llm: prepared.llm, promptConfig: runtime.config.prompt },
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
      injectMultiTurnHistory(runtime, prepared.req, prepared.requestedSessionId);

      const abortController = new AbortController();
      stream.onAbort(() => {
        stopHeartbeat();
        abortController.abort();
      });
      const t0 = performance.now();
      let ask: Awaited<ReturnType<typeof askWithTraceStream>>;
      try {
        ask = await askWithTraceStream(
          { db: runtime.db, embedder: runtime.embedder, llm: prepared.llm, promptConfig: runtime.config.prompt },
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

    // Look up the original answer for question / retrieved / model snapshot,
    // then write a feedback row. We don't fail-hard when answer_id isn't
    // found in answers table (might have aged out past 24h TTL).
    //
    // Bug history: 0.1.0–0.2.0-alpha.1 selected only `payload` here and let
    // `question` stay at its `''` init value, so the column was always
    // empty in production even though the answers table has it. The
    // Feedback tab list (RFC 0002 T1-b) needs question text per row, so
    // we now read the `question` column directly and only fall back to
    // request body or empty string when the answers row is gone.
    const original = runtime.db
      .prepare(`SELECT question, payload FROM answers WHERE answer_id = ?`)
      .get(answer_id) as { question: string; payload: string } | undefined;
    let question = '';
    let model = '';
    let retrieved: unknown = null;
    let generated = '';
    if (original) {
      question = original.question;
      try {
        const parsed = JSON.parse(original.payload) as {
          answer_md?: string;
          model?: string;
          citations?: unknown;
        };
        retrieved = parsed.citations ?? null;
        model = parsed.model ?? '';
        // F7 (dogfood 2026-05-23): backfill answer_md into feedback.generated so
        // the Console drawer's ANSWER section has body to render. Pre-fix the
        // column was always '' because the handler never plumbed it through —
        // Reader / curl callers do not send `generated` in the request body.
        // Parallel to the `question` backfill above; same trade-off (24h TTL
        // race covered by body override below).
        if (typeof parsed.answer_md === 'string') generated = parsed.answer_md;
      } catch {
        // ignore — partial feedback is still useful.
      }
    } else if (typeof obj.question === 'string' && obj.question.length > 0) {
      // Forward-compat: Reader MAY include `question` in the request body
      // to guard against the 24h TTL race (answer aged out before user
      // clicked 👍/👎). v0.1.0–0.2.0-alpha.1 didn't read this — adding
      // it now is safe because feedback.question is non-NULL with default
      // empty string, and callers that don't send it keep their existing
      // behaviour.
      question = obj.question;
    }
    // Explicit body `generated` always wins (e.g. when client edited the
    // answer locally before reporting feedback). The check is on TYPE only,
    // NOT length: pre-F7 the handler stored whatever the client sent —
    // including an empty string used as an explicit "clear stored answer"
    // opt-out — so the F7 backfill must not eat that signal. Caller
    // omitting the key entirely (undefined) is the only path that falls
    // through to the answers.payload backfill.
    if (typeof obj.generated === 'string') {
      generated = obj.generated;
    }

    // RFC 0003 M6 follow-up: persist the client's session_id on the β row
    // so Console grouping doesn't depend on the runs.jsonl JOIN for long
    // dialogues. γ + curated paths have always written this column (see
    // gamma.ts and store.ts). Reader / Widget clients echo session_id in
    // every /v1/ask request (RFC 0001 §4.1) and the same value belongs on
    // any feedback row that follows. Accept the `sessionId` camelCase alias
    // for symmetry with other Reader payload fields.
    const sessionIdRaw =
      typeof obj.session_id === 'string'
        ? obj.session_id
        : typeof obj.sessionId === 'string'
          ? obj.sessionId
          : null;
    const sessionId = sessionIdRaw && sessionIdRaw.length > 0 ? sessionIdRaw : null;

    runtime.db
      .prepare(
        `INSERT INTO feedback (
           answer_id, question, current_page_id, retrieved, generated, rating,
           correction, bad_citation_ids, tags, model_used, created_at, session_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        answer_id,
        question,
        typeof obj.current_page_id === 'string' ? obj.current_page_id : null,
        retrieved !== null ? JSON.stringify(retrieved) : null,
        generated,
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
        sessionId,
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

/**
 * Multi-turn history injection (RFC 0003 M1). When `multiTurn.enabled` and
 * the caller passed a `session_id` that the session table still knows about,
 * pull the most recent `historyTurns` prior question strings and stuff them
 * into `req.context.history`. The query pipeline ([src/query/answer.ts])
 * then splices them into the embedding query.
 *
 * Order: chronological (oldest → newest, current question implicit at the
 * tail). `getRecentEntries` hands back newest-first, so we reverse here.
 *
 * No-ops on:
 *   - multiTurn.enabled === false (default; byte-equivalent to 0.1.x)
 *   - no requested session_id (first ask in a session)
 *   - unknown / expired session_id (treated as a fresh session)
 *   - empty entry list (session minted but no prior `record()` yet)
 *
 * Mutates `req.context` in place — the caller passed us a `body as AskRequest`
 * we parsed from JSON, so a direct mutation is safe and avoids a copy on the
 * hot path.
 */
function injectMultiTurnHistory(
  runtime: Runtime,
  req: AskRequest,
  requestedSessionId: string | null,
): void {
  if (!runtime.config.multiTurn.enabled) return;
  if (!requestedSessionId) return;
  const entries = runtime.sessions.getRecentEntries(
    requestedSessionId,
    runtime.config.multiTurn.historyTurns,
  );
  if (entries.length === 0) return;
  // getRecentEntries returns newest → oldest; reverse for chronological order
  // so embedding splice + prompt history block both see the dialogue as it
  // actually happened (oldest → newest, current question implicit at the
  // tail). Both consumers in the query pipeline assume this ordering.
  const turns = entries
    .map((e) => ({ question: e.question, answer_summary: e.answer_md_summary }))
    .reverse();
  req.context = { ...(req.context ?? {}), history: turns };
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

  // Resolve session_id once up front so both runs.jsonl (audit log) and
  // /v1/ask response carry the SAME id. Dogfood 2026-05-22 caught the bug:
  // runs.jsonl had session_id=null on every row even when multi-turn was
  // clearly running, because appendRun used to hardcode null while gamma
  // resolved its own id later. We now mint once and thread the id through
  // both writes — observeAsk receives it via preResolvedSessionId to skip
  // calling getOrCreate a second time (which would mint a different id
  // when requestedSessionId is null).
  const sessionId = runtime.sessions.getOrCreate(requestedSessionId);

  // Persist + log to runs.jsonl regardless of outcome — analyze needs
  // visibility into errors / clarifies / answers alike. Skipped for dry_run.
  // requestId is minted up here (vs. inside appendRun) so the V3
  // citation-check-update tail below can reference the SAME id — otherwise
  // the update line couldn't be joined back to its source row.
  const requestId = randomUUID();
  if (!options.dryRun) {
    const latencyMs =
      result.type === 'answer' ? result.latency_ms : Math.round(performance.now() - t0);
    appendRun(runtime, {
      requestId,
      sessionId,
      query: req.question ?? '',
      filters: extractFilters(req),
      contextPageId: req.context?.current_page_id ?? null,
      result,
      trace,
      latencyMs,
      source: options.source,
    });
  }

  // RFC 0005 V3 alpha.2 — citation semantic check (shadow mode).
  // Fire-and-forget AFTER the RunRecord is written: the resulting tail line
  // joins back via request_id, so we need the original row on disk first.
  // Gating (RFC §4.6):
  //   - citationSemanticCheck.enabled === true (config off → entire feature
  //     never touches the LLM, zero extra calls — alpha.0 promise)
  //   - !options.dryRun (probes shouldn't add LLM cost or pollute the audit
  //     log; mirrors how dry_run already skips runs append + answer cache)
  //   - result.type === 'answer' && result.citations.length > 0 (nothing to
  //     check on clarify / error / cit-less answers)
  //   - runtime.runs.isEnabled (no point firing if the tail can't land)
  // Errors are fully swallowed inside validateCitations — but we wrap the
  // whole tail in a try/catch anyway so the unawaited Promise never throws
  // an UnhandledPromiseRejection on truly unexpected paths (e.g. claim
  // extractor regex blowing up on adversarial markdown).
  if (
    !options.dryRun &&
    result.type === 'answer' &&
    result.citations.length > 0 &&
    runtime.config.citationSemanticCheck.enabled &&
    runtime.runs.isEnabled
  ) {
    const task = runCitationCheckTail({
      runtime,
      requestId,
      answerMd: result.answer_md,
      citations: result.citations,
    }).catch((err: unknown) => {
      process.stderr.write(
        `[ask] citation-check tail crashed: ${(err as Error)?.message ?? String(err)}\n`,
      );
    });
    runtime.trackBackgroundTask(task);
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
    preResolvedSessionId: sessionId,
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
    // RFC 0005 V4: surface citation_id so the V3 citation-check-update tail
    // can join verdicts back without depending on positional order. Cheap and
    // additive; readers that don't care simply ignore the field.
    citation_id: c.citation_id,
  }));
}

function appendRun(
  runtime: Runtime,
  args: {
    requestId: string;
    /** Resolved by finalizeAskCall via sessionTable.getOrCreate — same id
     *  echoed back in the /v1/ask response. Always non-null on the live
     *  request path. RunRecord.session_id allows analyze/Studio to fold
     *  per-dialogue runs (RFC 0003 M6 fallback for feedback rows whose
     *  column is null — pre-PR #61 β rows). */
    sessionId: string;
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
    // Prefer internal `detail` for runs analysis (e.g. upstream LLM error
    // text on `llm_failed`); fall back to the user-facing message.
    md = result.detail ?? result.message;
  }
  const record: RunRecord = {
    ts: new Date().toISOString(),
    request_id: args.requestId,
    session_id: args.sessionId,
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
      ...(trace.history_window !== undefined ? { history_window: trace.history_window } : {}),
    },
    feedback: { beta: null, gamma: null },
  };
  runtime.runs.append(record);
}

// ---------------------------------------------------------------------------
// RFC 0005 V3 — citation semantic check tail
// ---------------------------------------------------------------------------

/**
 * Build claim/chunk pairs from the just-returned answer, batch-validate via
 * the main LLM, and append one `citation-check-update` line to runs.jsonl
 * keyed by the original request_id.
 *
 * Caller already gated on enabled / dry_run / has-citations / runs-enabled
 * (see finalizeAskCall). All errors are non-throwing here — validateCitations
 * itself swallows LLM / parse failures (RFC §4.6), so the only way to reach
 * the outer catch is a programmer error (e.g. snippet-less Citation shape).
 * Even that case logs to stderr and exits cleanly.
 *
 * Empty verdict array → no tail written. Same shape as the
 * `enabled=false` path so downstream readers can't tell them apart, which
 * is the §4.6 design.
 */
async function runCitationCheckTail(args: {
  runtime: Runtime;
  requestId: string;
  answerMd: string;
  citations: Citation[];
}): Promise<void> {
  const { runtime, requestId, answerMd, citations } = args;
  const pairs = extractClaimChunkPairs({ answerMd, citations });
  if (pairs.length === 0) return;

  let llm: LLM;
  try {
    llm = runtime.llm;
  } catch {
    // LLM provider unavailable — same swallow semantics as runtime.llm
    // throwing from the main request path; we just skip the tail.
    return;
  }

  const verdicts = await validateCitations({ llm, pairs });
  if (verdicts.length === 0) return;

  const update: RunCitationCheckUpdate = {
    type: 'citation-check-update',
    ts: new Date().toISOString(),
    request_id: requestId,
    citations: verdicts.map((v) => ({
      citation_id: v.citationId,
      semantic_check: {
        verdict: v.verdict,
        reason: v.reason,
        model: v.model,
        checked_at: v.checkedAt,
        latency_ms: v.latencyMs,
      },
    })),
  };
  runtime.runs.appendUpdate(update);
}
