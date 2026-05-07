/**
 * Embedder contract — used by the index pipeline (stage 5) and query pipeline
 * (stage 6). Abstract so tests can swap in a deterministic mock and the real
 * bge-m3 download is gated behind explicit opt-in.
 *
 * Implementations:
 *   - `MockEmbedder` (./mock): deterministic, no I/O, used in unit tests.
 *   - `Bgem3Embedder` (./bge-m3): @huggingface/transformers backed, real model.
 */

export type EmbedResult = {
  /** Float32Array of length `dim`. Normalized for cosine retrieval if the
   *  underlying model emits non-normalized vectors (bge-m3 is already
   *  normalized in @huggingface/transformers default config; mock does too). */
  vector: Float32Array;
};

export interface Embedder {
  /** Stable id of the model, written into embedding_cache.model. */
  readonly model: string;
  /** Vector dimension. Must match the chunks_vec virtual table's FLOAT[N]. */
  readonly dim: number;
  /** Whether the embedder is ready to accept embed calls (i.e. model warmed). */
  readonly ready: boolean;
  /** Lazy load: idempotent. Stage 5 calls this during /v1/health warm-up. */
  warmUp(): Promise<void>;
  /**
   * Embed a batch. Returns one EmbedResult per input text in the same order.
   * Implementations may chunk into smaller batches internally.
   */
  embed(texts: string[]): Promise<EmbedResult[]>;
  /**
   * Release any underlying resources (ONNX session, worker threads). Optional
   * because MockEmbedder doesn't need it; required for clean shutdown of
   * Bgem3Embedder — without it node exits while the ONNX worker is mid-
   * teardown and the C runtime aborts with a mutex-lock-failed crash.
   */
  dispose?(): Promise<void>;
}
