/**
 * γ orchestrator — the server-side implicit signal pipeline.
 *
 * One observation per /v1/ask:
 *   1. Resolve the session_id (echo client's if alive, else mint new).
 *   2. If `implicitSignals` enabled AND the session has prior asks within
 *      the re-ask window AND the previous question is ≥0.85 cosine-similar
 *      to the current one → write an implicit-negative `feedback` row
 *      pointing back at the previous answer.
 *   3. Record the current ask into the session table for next time.
 *
 * The 0.85 threshold is hard-coded per RFC 0001 §7 Q2 (decision locked
 * 2026-05-16). Changing it needs a follow-up RFC, not a config knob.
 *
 * γ is "best-effort, no-throw": embedder hiccup / unparseable answer_id /
 * malformed used_chunks should never bubble up and fail the user's /v1/ask
 * request. Any error here is swallowed with a stderr warning.
 */

import type { DbHandle } from '../db/index.ts';
import type { AskResult } from '../query/types.ts';
import type { ResolvedConfig } from '../config.ts';
import { SessionTable, type SessionEntry } from './session-table.ts';

/** Decision locked in RFC 0001 §7 Q2 (2026-05-16). */
export const REASK_SIMILARITY_THRESHOLD = 0.85;

/** Score written to `feedback.rating` for a γ same-session re-ask hit. */
export const REASK_NEGATIVE_RATING = -1;

export type ObserveAskArgs = {
  db: DbHandle;
  config: ResolvedConfig;
  sessionTable: SessionTable;
  /** session_id sent by the client (may be unknown / expired / undefined). */
  requestedSessionId: string | null | undefined;
  /** The user's current question, post-trim (pipeline already trimmed). */
  question: string;
  /** Embedding of `question` from the bge-m3 (or mock) embedder. null when
   *  the pipeline short-circuited on validation/scope errors before
   *  embedding ever ran — in that case we still hand out a session_id but
   *  skip the similarity check. */
  queryVector: Float32Array | null;
  /** The pipeline's final result. We extract answer_id + used chunk ids
   *  from this to record into the session for next time. */
  result: AskResult;
  /** ms-epoch the ask completed. */
  now: number;
  /** When the server already resolved the session id earlier in the request
   *  (e.g. to stamp runs.jsonl before γ observation), pass it here so
   *  observeAsk reuses the same id instead of calling sessionTable.getOrCreate
   *  a second time. Calling getOrCreate twice with `null` would mint two
   *  different ids and split the run+response identity. */
  preResolvedSessionId?: string;
};

export type ObserveAskOutcome = {
  /** session_id to send back to the client. Always present. */
  session_id: string;
  /** Number of implicit-negative feedback rows inserted (≥0). */
  implicit_rows_inserted: number;
};

export function observeAsk(args: ObserveAskArgs): ObserveAskOutcome {
  const session_id =
    args.preResolvedSessionId ?? args.sessionTable.getOrCreate(args.requestedSessionId);

  // Gate everything behind both knobs (PRD §11.4 #6 + ARCH §15.7).
  // 'off' → just mint/refresh the session_id and bail. We still issue an id
  // so clients can begin establishing one ahead of the operator flipping
  // the switch later.
  if (!args.config.feedback.enabled || args.config.feedback.implicitSignals === 'off') {
    return { session_id, implicit_rows_inserted: 0 };
  }

  let implicit_rows_inserted = 0;
  if (args.queryVector !== null) {
    try {
      implicit_rows_inserted = detectAndRecordReasks({
        db: args.db,
        sessionTable: args.sessionTable,
        session_id,
        question: args.question,
        queryVector: args.queryVector,
        now: args.now,
      });
    } catch (err) {
      // γ is best-effort. Don't poison the response.
      process.stderr.write(`[ask/gamma] reask detection failed: ${(err as Error).message}\n`);
    }

    try {
      recordCurrentAsk({
        sessionTable: args.sessionTable,
        session_id,
        question: args.question,
        queryVector: args.queryVector,
        result: args.result,
        now: args.now,
      });
    } catch (err) {
      process.stderr.write(`[ask/gamma] session record failed: ${(err as Error).message}\n`);
    }
  }

  return { session_id, implicit_rows_inserted };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function detectAndRecordReasks(args: {
  db: DbHandle;
  sessionTable: SessionTable;
  session_id: string;
  question: string;
  queryVector: Float32Array;
  now: number;
}): number {
  const hits = args.sessionTable.findSimilarRecent({
    session_id: args.session_id,
    embedding: args.queryVector,
    threshold: REASK_SIMILARITY_THRESHOLD,
  });
  if (hits.length === 0) return 0;

  const insert = args.db.prepare(
    `INSERT INTO feedback
       (answer_id, question, current_page_id, retrieved, generated, rating,
        bad_citation_ids, tags, created_at,
        signal_source, session_id)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'implicit', ?)`,
  );
  let inserted = 0;
  for (const hit of hits) {
    const prev = hit.entry;
    // The β /v1/ask/feedback row schema has `generated` NOT NULL; we mirror
    // that here even though γ is synthetic — store empty string. The implicit
    // row's value is the citation IDs of the previous answer, not the answer
    // text itself.
    const tags = JSON.stringify([
      'gamma:reask',
      `similarity:${hit.similarity.toFixed(3)}`,
    ]);
    insert.run(
      prev.answer_id ?? `gamma-${args.session_id}`,
      args.question,
      '',
      REASK_NEGATIVE_RATING,
      JSON.stringify(prev.used_chunk_ids.map(String)),
      tags,
      args.now,
      args.session_id,
    );
    inserted += 1;
  }
  return inserted;
}

function recordCurrentAsk(args: {
  sessionTable: SessionTable;
  session_id: string;
  question: string;
  queryVector: Float32Array;
  result: AskResult;
  now: number;
}): void {
  const entry: SessionEntry = {
    question: args.question,
    embedding: args.queryVector,
    answer_id: extractAnswerId(args.result),
    used_chunk_ids: extractUsedChunkIds(args.result),
    asked_at: args.now,
    answer_md_summary: extractAnswerMdSummary(args.result),
  };
  args.sessionTable.record({ session_id: args.session_id, entry });
}

function extractAnswerId(result: AskResult): string | null {
  if (result.type === 'answer' || result.type === 'clarify') return result.answer_id;
  return null;
}

function extractUsedChunkIds(result: AskResult): number[] {
  if (result.type !== 'answer') return [];
  return result.citations.map((c) => c.chunk_id);
}

/** Per RFC 0003 §4.3 hard cap. Higher and prompt input tokens balloon; lower
 *  and pronoun anchors get truncated mid-entity. Not config-exposed. Exported
 *  so the prompt builder can reference the same number when describing the
 *  truncation rule to the LLM (single source of truth). */
export const ANSWER_SUMMARY_MAX_CHARS = 200;

function extractAnswerMdSummary(result: AskResult): string {
  if (result.type === 'answer') return result.answer_md.slice(0, ANSWER_SUMMARY_MAX_CHARS);
  if (result.type === 'clarify') return result.message.slice(0, ANSWER_SUMMARY_MAX_CHARS);
  return '';
}
