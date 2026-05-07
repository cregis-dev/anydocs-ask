/**
 * Answer record store — TTL 24h, opportunistic GC (ARCH §4.1 / §6 step 8).
 *
 * Purpose in v1: audit trail so /v1/ask/feedback can join back to the
 * question, retrieval, and answer that the user is rating. We do NOT
 * deduplicate identical questions in v1 — every /v1/ask runs the full
 * pipeline. (Hit-rate dedup is a v1.1 optimization once we have feedback
 * data showing it pays for itself.)
 *
 * Stored shape: row keyed by `answer_id` (the random id minted in
 * answer.ts), with the full AskResult JSON as `payload`.
 */

import type { DbHandle } from '../db/index.ts';
import type { AskAnswer, AskClarify } from '../query/types.ts';

export type StorableResult = AskAnswer | AskClarify;

const TTL_MS = 24 * 60 * 60 * 1000;

export function persistAnswer(
  db: DbHandle,
  result: StorableResult,
  question: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO answers (answer_id, question, payload, created_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT (answer_id) DO NOTHING`,
  ).run(result.answer_id, question, JSON.stringify(result), now);
}

export function readAnswer(
  db: DbHandle,
  answerId: string,
): StorableResult | null {
  const row = db
    .prepare(`SELECT payload, created_at FROM answers WHERE answer_id = ?`)
    .get(answerId) as { payload: string; created_at: number } | undefined;
  if (!row) return null;
  return JSON.parse(row.payload) as StorableResult;
}

/** Delete entries older than TTL. Caller runs periodically. */
export function gcStaleAnswers(db: DbHandle, now: number = Date.now()): number {
  const cutoff = now - TTL_MS;
  const info = db.prepare(`DELETE FROM answers WHERE created_at < ?`).run(cutoff);
  return Number(info.changes);
}
