/**
 * Cross-encoder reranker contract — used by the query pipeline after retrieval
 * to re-score top-K candidates against the query as (query, doc) pairs.
 *
 * Why a separate layer:
 *   - Bi-encoder retrieval (bge-m3 + BM25) is fast but its query/doc encoders
 *     never see each other; subtle relevance signals (e.g. "this chunk has the
 *     valid_time field definition the user is asking about") are lost.
 *   - A cross-encoder scores (query, doc) jointly, recovering those signals.
 *   - Rule-based rerank (src/query/rerank.ts) catches structural biases
 *     (same-subtree, nav order, API intent). Cross-encoder catches semantic
 *     relevance the rules can't express.
 *
 * Implementations:
 *   - MockReranker (./mock): deterministic identity (returns input order with
 *     dummy scores). Used in unit tests and when reranker is disabled.
 *   - BgeRerankerV2M3 (./bge-reranker-v2-m3): @huggingface/transformers backed,
 *     real model. Multilingual (English + Chinese both strong), ~280MB q8.
 */

export type RerankerInputDoc = {
  /** Identifier carried through from retrieval; opaque to the reranker. */
  chunk_id: number | bigint;
  /** The text the reranker scores against the query. Typically the chunk's
   *  body; callers may prepend heading_path to lift signal on table-heavy
   *  pages. Empty strings are valid (score 0). */
  text: string;
};

export type RerankerScore = {
  chunk_id: number | bigint;
  /** Raw cross-encoder logit. NOT normalized — different models output
   *  different scales (bge-reranker-v2-m3 emits roughly -10..+10). Use
   *  ranks, not absolute scores, when composing with other signals. */
  score: number;
};

export interface Reranker {
  /** Stable id of the model, surfaced in trace + reports. */
  readonly model: string;
  /** Whether the reranker is ready to accept rerank calls. */
  readonly ready: boolean;
  /** Lazy load: idempotent. Runtime.start() warms in parallel with the
   *  embedder. */
  warmUp(): Promise<void>;
  /**
   * Score docs against the query. Returns one RerankerScore per input doc in
   * the SAME ORDER as the input (caller sorts by score; we keep the interface
   * order-preserving so the caller can match scores back to its own chunk
   * objects without a lookup).
   */
  rerank(query: string, docs: RerankerInputDoc[]): Promise<RerankerScore[]>;
  /**
   * Release ONNX session + worker threads. Same lifecycle hazard as the
   * embedder — without dispose() the C runtime can abort during shutdown.
   */
  dispose?(): Promise<void>;
}
