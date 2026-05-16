/**
 * Feedback module — DB + filesystem helpers shared by the export / import /
 * status commands.
 *
 * DB-side reads/writes deliberately don't go through any `RunsWriter`-style
 * long-lived class: feedback CLI runs are one-shot and the surface is small
 * enough that plain functions over a `DbHandle` keep the code dense.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFeedbackRoot } from '../workspace.ts';
import type { DbHandle } from '../db/index.ts';
import type { FeedbackRow } from '../db/schema.ts';
import type { ReviewableFeedback, ReviewableRetrievedChunk } from './types.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type FeedbackPaths = {
  feedbackRoot: string;
  inbox: string;
  approved: string;
  rejected: string;
  suggestions: string;
};

export function feedbackPaths(stateRoot: string): FeedbackPaths {
  const feedbackRoot = resolveFeedbackRoot(stateRoot);
  return {
    feedbackRoot,
    inbox: join(feedbackRoot, 'inbox'),
    approved: join(feedbackRoot, 'approved'),
    rejected: join(feedbackRoot, 'rejected'),
    suggestions: join(feedbackRoot, 'suggestions'),
  };
}

export function ensureSubdir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

/**
 * "Worth reviewing" rows per ARCH §15.5.3:
 *   - signal_source = 'explicit' AND rating <= 0
 *
 * 0.2 deliberately does NOT include the γ accumulation branch
 * (`signal_source = 'implicit' AND same-cluster cumulative ≥ 3`) — γ rows
 * aren't being written yet (S4 lands in 0.2.0-alpha.2). When γ collection
 * goes live, this query will need to grow.
 *
 * Already-reviewed rows (`reviewed_at IS NOT NULL`) are excluded.
 */
export function listReviewable(db: DbHandle): ReviewableFeedback[] {
  const rows = db
    .prepare(
      `SELECT feedback_id, answer_id, question, current_page_id, retrieved,
              generated, rating, bad_citation_ids, signal_source, created_at
         FROM feedback
        WHERE reviewed_at IS NULL
          AND signal_source = 'explicit'
          AND (rating IS NULL OR rating <= 0)
        ORDER BY feedback_id ASC`,
    )
    .all() as Array<
    Pick<
      FeedbackRow,
      | 'feedback_id'
      | 'answer_id'
      | 'question'
      | 'current_page_id'
      | 'retrieved'
      | 'generated'
      | 'rating'
      | 'bad_citation_ids'
      | 'signal_source'
      | 'created_at'
    >
  >;
  return rows.map((r) => ({
    feedback_id: r.feedback_id,
    answer_id: r.answer_id,
    question: r.question,
    current_page_id: r.current_page_id,
    retrieved: parseRetrieved(r.retrieved),
    generated: r.generated,
    rating: r.rating,
    bad_citation_ids: parseStringArray(r.bad_citation_ids),
    signal_source: r.signal_source,
    created_at: r.created_at,
  }));
}

export function findByClusterId(db: DbHandle, clusterId: string): { feedback_id: number } | null {
  return (
    (db
      .prepare(`SELECT feedback_id FROM feedback WHERE cluster_id = ? LIMIT 1`)
      .get(clusterId) as { feedback_id: number } | undefined) ?? null
  );
}

export function findById(db: DbHandle, feedbackId: number): FeedbackRow | null {
  return (
    (db.prepare(`SELECT * FROM feedback WHERE feedback_id = ?`).get(feedbackId) as
      | FeedbackRow
      | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

/**
 * Mark a feedback row as reviewed. Per RFC §4.4, we do NOT rewrite the
 * source row's `signal_source` — the original β/γ row stays as it was, and
 * (when approved) a new `signal_source='curated'` row is inserted that
 * links back through `cluster_id`. That preserves the signal trail for A+
 * diagnosis later.
 */
export function markReviewed(
  db: DbHandle,
  feedbackId: number,
  clusterId: string,
  decision: 'approved' | 'rejected',
  reviewedAtMs: number,
): void {
  db.prepare(
    `UPDATE feedback
        SET review_decision = ?, reviewed_at = ?, cluster_id = ?
      WHERE feedback_id = ?`,
  ).run(decision, reviewedAtMs, clusterId, feedbackId);
}

/**
 * Insert a derived `signal_source='curated'` row tied to the source via
 * cluster_id. Reviewer notes are NOT replicated here — they live in the
 * `approved/*.jsonl` archive (full inbox frontmatter is preserved there)
 * which is the canonical audit trail; the curated DB row is the
 * reranker-consumable summary.
 */
export function insertCurated(
  db: DbHandle,
  args: {
    sourceRow: FeedbackRow;
    clusterId: string;
    correctedAnswer: string;
    reviewedAtMs: number;
  },
): number {
  const { sourceRow, clusterId, correctedAnswer, reviewedAtMs } = args;
  const tags = JSON.stringify(['curated', 'cluster:' + clusterId]);
  const info = db
    .prepare(
      `INSERT INTO feedback
        (answer_id, question, current_page_id, retrieved, generated, rating,
         correction, bad_citation_ids, tags, model_used, created_at,
         signal_source, reviewed_at, review_decision, session_id, cluster_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'curated', ?, 'approved', ?, ?)`,
    )
    .run(
      sourceRow.answer_id,
      sourceRow.question,
      sourceRow.current_page_id,
      sourceRow.retrieved,
      // `generated` keeps the system's original answer; the author's
      // correction lives in `correction` so consumers can diff them.
      sourceRow.generated,
      // +1 affirms the corrected content for downstream reranker priors.
      1,
      correctedAnswer.length > 0 ? correctedAnswer : sourceRow.correction,
      sourceRow.bad_citation_ids,
      tags,
      sourceRow.model_used,
      reviewedAtMs,
      reviewedAtMs,
      // session_id is meaningless for a curated row (it summarises a cluster,
      // not a single session); explicitly null.
      null,
      clusterId,
    );
  return typeof info.lastInsertRowid === 'bigint'
    ? Number(info.lastInsertRowid)
    : info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Counts (for `feedback status`)
// ---------------------------------------------------------------------------

export type FeedbackCounts = {
  pendingFiles: number;
  approvedRows: number;
  rejectedRows: number;
  reviewableInDb: number;
};

export function countCounts(db: DbHandle, stateRoot: string): FeedbackCounts {
  const paths = feedbackPaths(stateRoot);
  const pendingFiles = listInboxFiles(paths.inbox).length;
  const approvedRows = (
    db.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE review_decision = 'approved'`).get() as
      | { n: number }
      | undefined
  )?.n ?? 0;
  const rejectedRows = (
    db.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE review_decision = 'rejected'`).get() as
      | { n: number }
      | undefined
  )?.n ?? 0;
  const reviewableInDb = listReviewable(db).length;
  return { pendingFiles, approvedRows, rejectedRows, reviewableInDb };
}

// ---------------------------------------------------------------------------
// Inbox / archive filesystem helpers
// ---------------------------------------------------------------------------

export function listInboxFiles(inboxDir: string): string[] {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

export function readInboxFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function deleteInboxFile(path: string): void {
  unlinkSync(path);
}

/**
 * Write an inbox file. Returns true on write, false when the file already
 * exists (idempotency for `export`).
 */
export function writeInboxFileIfAbsent(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, content, 'utf8');
  return true;
}

export function appendArchive(
  archiveDir: string,
  monthKey: string,
  line: object,
): void {
  ensureSubdir(archiveDir);
  appendFileSync(join(archiveDir, `${monthKey}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// JSON column decoders
// ---------------------------------------------------------------------------

function parseRetrieved(json: string | null): ReviewableRetrievedChunk[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is ReviewableRetrievedChunk => typeof x?.chunk_id === 'number');
  } catch {
    return [];
  }
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}
