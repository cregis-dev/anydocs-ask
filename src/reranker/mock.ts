/**
 * Deterministic mock reranker — preserves input order, assigns linearly
 * decreasing scores so callers that sort by score get the input ordering.
 *
 * Used in tests and as the default when no real reranker is configured. The
 * pipeline must remain byte-equivalent to "no reranker" when the mock is in
 * place; the wire-through tests in tests/ask.test.ts depend on this.
 */

import type { Reranker, RerankerInputDoc, RerankerScore } from './types.ts';

export class MockReranker implements Reranker {
  readonly model = 'mock';
  readonly ready = true;

  async warmUp(): Promise<void> {
    // no-op
  }

  async rerank(_query: string, docs: RerankerInputDoc[]): Promise<RerankerScore[]> {
    // Linear-decreasing score so sort-by-score reproduces input order. Using
    // length - i instead of -i keeps scores positive — easier to reason about
    // in trace dumps.
    return docs.map((d, i) => ({ chunk_id: d.chunk_id, score: docs.length - i }));
  }
}
