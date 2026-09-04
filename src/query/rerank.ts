/**
 * Ranking adapter for the hybrid retrieval result.
 *
 * Vector, BM25, and exact-identifier candidates are already fused and sorted
 * by retrieveWithTrace(). Keep that RRF order unchanged here so relevance has
 * one authority. An optional cross-encoder may replace final_score later.
 */

import type { RetrievedChunk } from './retrieval.ts';

export type RerankedChunk = RetrievedChunk & {
  /** RRF score unless the optional cross-encoder replaces it. */
  final_score: number;
};

export function rankByRrf(chunks: RetrievedChunk[]): RerankedChunk[] {
  return chunks
    .map((chunk) => ({ ...chunk, final_score: chunk.rrf_score }))
    .sort((a, b) => b.rrf_score - a.rrf_score);
}
