/**
 * Runs jsonl record schema — ARCHITECTURE.md §16.4.
 *
 * Each /v1/ask call appends one line to
 * `<projectRoot>/.anydocs-ask/runs/<YYYY-Www>.jsonl`.
 *
 * Fields are designed to be additive — fields v1 cannot fill yet (e.g.
 * tokens_in/out, feedback.beta) are nullable and stay `null` until a later
 * version supplies them. This keeps the schema forward-compatible without
 * jsonl-version migrations.
 */

/**
 * Origin of the request. `reader` = real user traffic via the public
 * /v1/ask endpoint. `console` = author dogfooding via the dev console
 * ask 体验台 with persist=true (ARCH §17.8). Missing in jsonl rows
 * written before 2026-05-11 — readers MUST treat absent source as
 * `reader` for back-compat.
 */
export type RunSource = 'reader' | 'console';

export type RunRecord = {
  ts: string;
  request_id: string;
  session_id: string | null;
  query: string;
  filters: Record<string, unknown>;
  context_pageId: string | null;
  /**
   * Optional in the on-disk JSON (legacy rows omit it). Use
   * `runSource(record)` from ./reader for safe access with a default
   * of 'reader'.
   */
  source?: RunSource;
  retrieval: RunRetrievalTrace;
  answer: RunAnswer;
  feedback: RunFeedback;
};

export type RunRetrievalTrace = {
  fused: RunFusedChunk[];
  subtree_ask_triggered: boolean;
};

export type RunFusedChunk = {
  chunk_id: number;
  page: string;
  rrf_score: number;
  final_score: number;
  vec_rank: number | null;
  bm25_rank: number | null;
  nav_index: number | null;
  nav_index_boost: number;
};

export type RunCitation = {
  chunk_id: number | null;
  page: string;
  quote: string;
};

export type RunAnswer = {
  /** Outcome kind — 'answer' / 'clarify' / 'error'. */
  kind: 'answer' | 'clarify' | 'error';
  /** Stable answer id (matches /v1/ask/feedback.answer_id). */
  answer_id: string | null;
  /** Markdown body (answer) or clarify message; null on error. */
  md: string | null;
  citations: RunCitation[];
  /** Normalized top-1 share of top-5 final_score sum, in [0,1]. ARCH §16.4. */
  confidence: number;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  model: string | null;
  /** Error code on kind='error'. */
  error_code: string | null;
};

export type RunFeedback = {
  /** Filled by v1.5 §15 reader-explicit signal. */
  beta: 'positive' | 'negative' | null;
  /** Filled by v1.5 §15 implicit signal. */
  gamma: number | null;
};

/**
 * Append-only tail record used to update an earlier run's feedback. Written
 * by v1.5 §15 when β/γ arrives — analyze.ts merges these on read.
 */
export type RunFeedbackUpdate = {
  type: 'feedback-update';
  ts: string;
  request_id: string;
  feedback: Partial<RunFeedback>;
};

export type RunsLine = RunRecord | RunFeedbackUpdate;

/**
 * Safe accessor for RunRecord.source — returns `'reader'` for legacy
 * rows that pre-date the `source` field. Downstream filters (analyze,
 * golden generate --from runs) MUST go through this so historical
 * runs aren't accidentally re-classified.
 */
export function runSource(r: RunRecord): RunSource {
  return r.source ?? 'reader';
}
