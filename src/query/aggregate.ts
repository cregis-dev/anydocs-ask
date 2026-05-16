/**
 * Subtree aggregation + lang routing — ARCH §6 step 5.
 *
 * Decides one of three outcomes for a top-K reranked list:
 *
 *   A. answer-same-lang   — same-lang slice has signal AND a single subtree
 *                           clearly dominates (max share ≥ 0.65), OR top-2
 *                           subtree share difference is large enough that
 *                           we can safely pick the leader.
 *   B. clarify            — same-lang slice has signal AND top-2 subtree
 *                           shares are close (Δ < 0.15); we ask the user to
 *                           pick. Options are constrained to same-lang
 *                           subtrees (PRD §8 #13).
 *   C. translate-fallback — same-lang slice is empty, OR even the strongest
 *                           same-lang hit is too weak (max RRF < 0.05). We
 *                           use the cross-lang top-K and the LLM is told to
 *                           translate (PRD §4.8).
 *
 * The ARCH-level thresholds (0.65 dominance, 0.15 spread, 0.05 RRF floor)
 * are the v1 acceptance lock. They live as named constants so a future
 * spike can tune them without touching call sites.
 */

import type { DocsLang } from '../anydocs/types.ts';
import type { RerankedChunk } from './rerank.ts';

export const SUBTREE_DOMINANCE = 0.55;
export const SUBTREE_SPREAD = 0.25;
/**
 * Minimum same-lang RRF score that counts as "we got a real hit". Reality
 * check on ARCH §6's 0.05: with K=60 RRF and per-path top-K=20, a chunk
 * appearing at rank 1 in BOTH paths scores 2 / 61 ≈ 0.033 — so 0.05 is
 * unreachable. We pin to 0.01, which corresponds to a chunk appearing in
 * one path within the top ~40 (1 / 100 = 0.01). Any lower would treat all
 * non-empty retrievals as "real" and the cross-lang fallback would never
 * fire when same-lang has stale matches.
 */
export const SAME_LANG_FLOOR_RRF = 0.01;
export const TOP_K_FOR_AGGREGATION = 10;

export type AggregateOutcome =
  | { kind: 'answer-same-lang'; pick: RerankedChunk[]; dominantSubtree: string | null }
  | { kind: 'clarify'; sameLangChunks: RerankedChunk[]; topSubtrees: SubtreeShare[] }
  | { kind: 'translate-fallback'; pick: RerankedChunk[] };

export type SubtreeShare = {
  subtree_root: string;
  /** Score share among same-lang chunks. */
  share: number;
  /** Sum of final_score values that voted for this subtree. */
  raw_score: number;
  /** All same-lang chunks under this subtree, in input order. */
  chunks: RerankedChunk[];
};

export type AggregateOptions = {
  queryLang: DocsLang;
  /** Top-K to consider (default 10). */
  topK?: number;
  /** Subtree root of the user's current page (from rerank context). When set,
   *  used as a tiebreaker: if the current subtree appears in the clarify
   *  candidates, prefer it over asking the user to choose. */
  currentSubtreeRoot?: string | null;
};

export function aggregate(
  reranked: RerankedChunk[],
  opts: AggregateOptions,
): AggregateOutcome {
  const topK = opts.topK ?? TOP_K_FOR_AGGREGATION;
  const top = reranked.slice(0, topK);

  const sameLang = top.filter((c) => c.lang === opts.queryLang);
  const maxRrf = sameLang.length === 0 ? 0 : Math.max(...sameLang.map((c) => c.rrf_score));

  if (sameLang.length === 0 || maxRrf < SAME_LANG_FLOOR_RRF) {
    // Branch C: either no same-lang context at all, or the strongest hit
    // doesn't clear the relevance floor. Fall back to cross-lang.
    return { kind: 'translate-fallback', pick: top };
  }

  // Branch A vs B decision: subtree share distribution among same-lang chunks.
  const shares = computeSubtreeShares(sameLang);
  if (shares.length === 0) {
    // All same-lang chunks lack a subtree_root — degenerate but possible
    // (orphan pages outside any nav tree). Treat as same-lang answer.
    return { kind: 'answer-same-lang', pick: sameLang, dominantSubtree: null };
  }

  shares.sort((a, b) => b.share - a.share);
  const top1 = shares[0]!;
  const top2 = shares[1];

  if (top1.share >= SUBTREE_DOMINANCE) {
    return {
      kind: 'answer-same-lang',
      pick: sameLang,
      dominantSubtree: top1.subtree_root,
    };
  }
  if (top2 && top1.share - top2.share < SUBTREE_SPREAD) {
    // Two competing subtrees with similar weight — normally we'd ask the user
    // to clarify. But if one of the candidates matches the user's current page
    // subtree, that's a strong contextual signal: prefer it and answer directly.
    if (opts.currentSubtreeRoot) {
      const contextMatch = shares.find((s) => s.subtree_root === opts.currentSubtreeRoot);
      if (contextMatch) {
        return {
          kind: 'answer-same-lang',
          pick: sameLang,
          dominantSubtree: contextMatch.subtree_root,
        };
      }
    }
    return { kind: 'clarify', sameLangChunks: sameLang, topSubtrees: shares };
  }
  // Otherwise: leader by spread is clear enough to answer with.
  return {
    kind: 'answer-same-lang',
    pick: sameLang,
    dominantSubtree: top1.subtree_root,
  };
}

function computeSubtreeShares(sameLang: RerankedChunk[]): SubtreeShare[] {
  const total = sameLang.reduce((acc, c) => acc + c.final_score, 0);
  if (total <= 0) return [];

  const buckets = new Map<string, { score: number; chunks: RerankedChunk[] }>();
  for (const c of sameLang) {
    if (!c.subtree_root) continue;
    const b = buckets.get(c.subtree_root) ?? { score: 0, chunks: [] };
    b.score += c.final_score;
    b.chunks.push(c);
    buckets.set(c.subtree_root, b);
  }

  const out: SubtreeShare[] = [];
  for (const [subtree_root, b] of buckets) {
    out.push({
      subtree_root,
      raw_score: b.score,
      share: b.score / total,
      chunks: b.chunks,
    });
  }
  return out;
}
