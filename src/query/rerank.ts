/**
 * Structural rerank — ARCH §6 step 4.
 *
 *   final_score = rrf_score × (1 + lang_boost + same_subtree_boost + nav_index_boost)
 *
 *     lang_boost          = +0.30 when chunk.lang == query_lang (PRD §4.8)
 *     same_subtree_boost  = +0.20 when chunk's page shares subtree_root with
 *                           the user's current page (ARCH §12 cross-ref).
 *                           Note: §6 step 4 phrases this as "current_page_id
 *                           ancestor chain hits chunk's page", which would be
 *                           a strict descendant test. We adopt §12's
 *                           "same_subtree_root" interpretation: it's both
 *                           more useful (boosts siblings, not just ancestors)
 *                           and consistent with PRD §4.2 "structure context"
 *                           intent.
 *     nav_index_boost     = +0.10 × (1 / log(nav_index + 2))
 *                           (anydocs nav order ≈ author intent priority)
 *
 * The result is a ranked list, sorted by descending final_score.
 */

import type { RetrievedChunk } from './retrieval.ts';
import type { DbHandle } from '../db/index.ts';
import type { DocsLang } from '../anydocs/types.ts';

export type RerankedChunk = RetrievedChunk & {
  final_score: number;
};

export type RerankOptions = {
  queryLang: DocsLang;
  /** Subtree root of the user's current page. Pass null if unknown. */
  currentSubtreeRoot: string | null;
};

const LANG_BOOST = 0.3;
const SAME_SUBTREE_BOOST = 0.2;
const NAV_INDEX_BOOST = 0.1;

export function rerank(
  chunks: RetrievedChunk[],
  opts: RerankOptions,
): RerankedChunk[] {
  return chunks
    .map((c) => {
      const langBoost = c.lang === opts.queryLang ? LANG_BOOST : 0;
      const sameSubtreeBoost =
        opts.currentSubtreeRoot !== null && c.subtree_root === opts.currentSubtreeRoot
          ? SAME_SUBTREE_BOOST
          : 0;
      const navIdxBoost = navIndexBoostFor(c.nav_index);
      const final_score =
        c.rrf_score * (1 + langBoost + sameSubtreeBoost + navIdxBoost);
      return { ...c, final_score };
    })
    .sort((a, b) => b.final_score - a.final_score);
}

function navIndexBoostFor(navIndex: number | null): number {
  if (navIndex === null) return 0;
  // log here is natural log. nav_index=0 → 0.10/log(2) ≈ 0.144; nav_index=10
  // → 0.10/log(12) ≈ 0.040; the curve flattens fast as you go deeper.
  return NAV_INDEX_BOOST * (1 / Math.log(navIndex + 2));
}

/**
 * Resolve a current_page_id (passed by the client in `context.current_page_id`)
 * to its subtree_root using the pages table. Falls back to null if the page
 * isn't published / doesn't exist (stale context from the Reader).
 *
 * The lang argument scopes the lookup — anydocs allows the same page_id to
 * exist under multiple langs, and the user's "current page" is bound to a
 * specific lang context.
 */
export function lookupSubtreeRoot(
  db: DbHandle,
  pageId: string,
  lang: DocsLang,
): string | null {
  const row = db
    .prepare(`SELECT subtree_root FROM pages WHERE page_id = ? AND lang = ?`)
    .get(pageId, lang) as { subtree_root: string | null } | undefined;
  return row?.subtree_root ?? null;
}
