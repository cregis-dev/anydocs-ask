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
  /** RFC 0005 V4 — "cit_N" marker as emitted in answer.md after postprocess
   *  renumber. Optional in the on-disk JSON; absent on legacy rows. Lets the
   *  citation-check-update tail (see RunCitationCheckUpdate) join verdicts
   *  back to the source row without relying on positional order. */
  citation_id?: string;
  /** RFC 0005 V4 — semantic validity verdict for this citation. Written by
   *  the alpha.2 fire-and-forget tail (see RunCitationCheckUpdate) and folded
   *  into the record by readers that need it (analyze / Studio Feedback tab).
   *  Always optional: absent when `citationSemanticCheck.enabled=false`, when
   *  the LLM check failed silently (RFC §4.6), or on legacy rows. */
  semantic_check?: RunCitationSemanticCheck;
};

export type RunCitationSemanticCheck = {
  verdict: 'supports' | 'partially' | 'not_supports';
  /** ≤ 100 chars per RFC §4.1; truncated upstream. */
  reason: string;
  /** Model id reported by the LLM that produced the verdict (e.g.
   *  'claude-sonnet-4-6'). Same provenance as RunAnswer.model. */
  model: string;
  /** ISO 8601 — when the batch this cit belonged to completed. Same value
   *  for every cit in one batch (§4.4). */
  checked_at: string;
  /** Batch latency in ms — same for every cit in one batch. */
  latency_ms: number;
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
  /** RFC 0003 M4 — number of prior session turns consumed by this call
   *  (embedding splice + prompt). Optional in the on-disk JSON; absent on
   *  legacy rows and on single-turn / `multiTurn.enabled=false` paths.
   *  Studio joins on (session_id, history_window) to fold a dialogue's
   *  turns into one group. */
  history_window?: number;
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

/**
 * RFC 0005 V3 alpha.2 — append-only tail record carrying semantic-check
 * verdicts that arrived *after* the /v1/ask response was returned. The
 * citation-validator runs fire-and-forget; when it completes, one of these
 * lines is appended to the same week file as the original record. Readers
 * (Studio Feedback tab in V5, analyze in 0.4 H3) join on `request_id` +
 * `citations[].citation_id` to fold verdicts back onto the source row.
 *
 * `citations` length may be shorter than the original RunRecord's
 * `answer.citations` — silent drops (LLM error / parse failure / unknown
 * verdict) just leave the cit without a `semantic_check` field on join.
 */
export type RunCitationCheckUpdate = {
  type: 'citation-check-update';
  ts: string;
  request_id: string;
  citations: Array<{
    citation_id: string;
    semantic_check: RunCitationSemanticCheck;
  }>;
};

export type RunsLine = RunRecord | RunFeedbackUpdate | RunCitationCheckUpdate;

/**
 * True when a parsed jsonl line is a full RunRecord, not an append-only
 * update tail. Readers that walk runs.jsonl for record-level scans (analyze,
 * golden, console feedback/index/traffic state, runs export) should gate on
 * this so future tail types don't need touch-ups in N places.
 */
export function isRunRecord(line: RunsLine): line is RunRecord {
  return !('type' in line);
}

/**
 * Safe accessor for RunRecord.source — returns `'reader'` for legacy
 * rows that pre-date the `source` field. Downstream filters (analyze,
 * golden generate --from runs) MUST go through this so historical
 * runs aren't accidentally re-classified.
 */
export function runSource(r: RunRecord): RunSource {
  return r.source ?? 'reader';
}
