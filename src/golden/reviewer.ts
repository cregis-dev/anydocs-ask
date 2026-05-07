/**
 * `golden review` — flush decisions on cases.candidate.jsonl into cases.jsonl
 * and rewrite the candidate file with whatever's still pending.
 *
 * Workflow:
 *   1. Author runs `golden generate` -> cases.candidate.jsonl with each row
 *      `{ ..., decision: null }`.
 *   2. Author edits the file in their editor: flips `decision` to `"approved"`
 *      / `"rejected"` (or adds a `note`), saves.
 *   3. Author runs `golden review` -> we move approved rows to cases.jsonl,
 *      drop rejected rows, leave nulls where they are. The candidate file
 *      now contains only un-decided rows; running `golden review` again is
 *      a no-op.
 *
 * Approved rows are stamped with `reviewed_at` (UTC ISO date) and stripped
 * of the `decision` / `note` / `template_id` fields before they land in
 * cases.jsonl — those are review-time metadata, not eval-time data.
 */

import type { GoldenCase, GoldenCaseCandidate } from './types.ts';
import { appendCases, readCandidates, writeCandidates } from './store.ts';

export type ReviewSummary = {
  approved: number;
  rejected: number;
  pending: number;
  malformed: number;
};

export type ReviewOptions = {
  /** Override clock (tests). */
  now?: () => Date;
  /** Reviewer name (e.g. git user.email). Stored on each approved case. */
  reviewer?: string | null;
};

export function reviewCandidates(
  stateRoot: string,
  opts: ReviewOptions = {},
): ReviewSummary {
  const { rows, malformed } = readCandidates(stateRoot);
  const now = (opts.now ?? (() => new Date()))();
  const reviewedAt = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const reviewer = opts.reviewer ?? null;

  const approved: GoldenCase[] = [];
  const pending: GoldenCaseCandidate[] = [];
  let rejected = 0;
  for (const row of rows) {
    if (row.decision === 'approved') {
      approved.push(promote(row, reviewedAt, reviewer));
    } else if (row.decision === 'rejected') {
      rejected++;
    } else {
      pending.push(row);
    }
  }

  if (approved.length > 0) appendCases(stateRoot, approved);
  // Always rewrite the candidate file (even when pending.length === 0) so
  // a fully-decided run cleans the file rather than leaving stale entries.
  writeCandidates(stateRoot, pending);

  return {
    approved: approved.length,
    rejected,
    pending: pending.length,
    malformed,
  };
}

function promote(
  c: GoldenCaseCandidate,
  reviewedAt: string,
  reviewer: string | null,
): GoldenCase {
  // Strip review-only metadata; stamp reviewed_at + reviewer.
  return {
    id: c.id,
    query: c.query,
    filters: c.filters,
    context_pageId: c.context_pageId,
    expected: c.expected,
    tags: c.tags,
    created_by: c.created_by,
    reviewed_at: reviewedAt,
    reviewer,
    lang: c.lang,
  };
}
