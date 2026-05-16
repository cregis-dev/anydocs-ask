/**
 * v1.5 feedback loop types (PRD §11 / ARCH §15 / RFC 0001).
 *
 * 0.2.0-alpha.1 keeps the data flat:
 *   - one inbox file per `feedback` row (no real clustering yet — A+ HDBSCAN
 *     clustering arrives in 0.3 with `feedback diagnose`)
 *   - `queries` is therefore always a single-element array, kept as an array
 *     so the spec format (ARCH §15.5.2) doesn't shift when 0.3 lands
 *   - multi-line "corrected answer" lives in a markdown body section, not in
 *     the frontmatter, so our deliberately small YAML subset stays tractable
 */

import type { FeedbackRow } from '../db/schema.ts';

/**
 * A `feedback` row pulled for review. Mirrors the db row but post-decodes the
 * JSON columns the parsers need (`bad_citation_ids`, `retrieved`).
 */
export type ReviewableFeedback = {
  feedback_id: number;
  answer_id: string;
  question: string;
  current_page_id: string | null;
  retrieved: ReviewableRetrievedChunk[];
  generated: string;
  rating: number | null;
  bad_citation_ids: string[];
  signal_source: FeedbackRow['signal_source'];
  created_at: number;
};

export type ReviewableRetrievedChunk = {
  chunk_id: number;
  page_id?: string;
  score?: number;
  breadcrumb?: string;
  snippet?: string;
};

/** Frontmatter block on every inbox file. Round-trips through the parser. */
export type InboxFrontmatter = {
  cluster_id: string;
  created_at_iso: string;
  queries: string[];
  sample_answer_id: string;
  current_page_id: string | null;
  signal_source: FeedbackRow['signal_source'];
  explicit_negative: number;
  implicit_negative: number;
  bad_citation_ids: string[];
  decision: InboxDecision;
  notes: string;
};

export type InboxDecision = 'pending' | 'approved' | 'rejected';

/** Sections rendered in the inbox file body, after the frontmatter. */
export type InboxBody = {
  /** System answer the row captured (read-only context for the reviewer). */
  systemAnswer: string;
  /** Retrieved chunks rendered as breadcrumb + snippet (read-only). */
  retrievedChunks: ReviewableRetrievedChunk[];
  /** Optional author-supplied correction; preserved verbatim when present. */
  correctedAnswer: string;
};

export type InboxFile = {
  frontmatter: InboxFrontmatter;
  body: InboxBody;
};
