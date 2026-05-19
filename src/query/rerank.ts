/**
 * Structural rerank — ARCH §6 step 4.
 *
 *   final_score = rrf_score × (1 + lang_boost + same_subtree_boost
 *                                + nav_index_boost + title_match_boost)
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
 *     title_match_boost   = +0.30 when query contains chunk.page_title
 *                           (case-insensitive, word-aligned for ASCII; CJK
 *                           plain substring). Suppressed when another
 *                           matching page has a strictly longer title that
 *                           contains this title. Editorial-intent signal
 *                           consistent with PRD §4.1 — the author chose the
 *                           page title; a query containing it is a strong
 *                           pointer at that page. Not on the §4.1 v1.5
 *                           schedule (which lists nav.weight / page.priority);
 *                           added 2026-05-08 to address title-spread failures
 *                           seen in the first eval baseline.
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
  /** Raw user query — used for title_match_boost. */
  query: string;
  /**
   * Entity terms extracted from a multi-entity query (e.g.
   * ["sessions", "checkpoints", "memory"]). When set, any chunk whose
   * page_id or page_title contains an entity term gets an entity_match_boost
   * — this rescues compare-style queries where a `compare` verb dominates
   * vector ranking and entity-specific pages get pushed below the
   * prompt-context cap. Codex round-9 follow-up.
   */
  entityTerms?: string[];
};

const LANG_BOOST = 0.3;
const SAME_SUBTREE_BOOST = 0.2;
const NAV_INDEX_BOOST = 0.1;
const TITLE_MATCH_BOOST = 0.3;
const ENTITY_MATCH_BOOST = 0.2;
/** Page titles below this length don't get title-match boost — they're too
 *  short to discriminate ("TTS", "Skins", common 3-4 letter tokens). */
const TITLE_MATCH_MIN_LEN = 5;

export function rerank(
  chunks: RetrievedChunk[],
  opts: RerankOptions,
): RerankedChunk[] {
  const titleMatchedPageIds = computeTitleMatches(chunks, opts.query);
  const entityMatchedPageIds = computeEntityMatches(chunks, opts.entityTerms);
  return chunks
    .map((c) => {
      const langBoost = c.lang === opts.queryLang ? LANG_BOOST : 0;
      const sameSubtreeBoost =
        opts.currentSubtreeRoot !== null && c.subtree_root === opts.currentSubtreeRoot
          ? SAME_SUBTREE_BOOST
          : 0;
      const navIdxBoost = navIndexBoostFor(c.nav_index);
      const titleBoost = titleMatchedPageIds.has(c.page_id) ? TITLE_MATCH_BOOST : 0;
      const entityBoost = entityMatchedPageIds.has(c.page_id) ? ENTITY_MATCH_BOOST : 0;
      const final_score =
        c.rrf_score * (1 + langBoost + sameSubtreeBoost + navIdxBoost + titleBoost + entityBoost);
      return { ...c, final_score };
    })
    .sort((a, b) => b.final_score - a.final_score);
}

/**
 * Set of page_ids whose page_id or page_title contains any of the supplied
 * entity terms. Used to rescue compare-style multi-entity queries where the
 * verb (`compare`/`vs`) dominates vector ranking and entity-specific pages
 * drop below the prompt cap. Page-id match is the strongest signal
 * (anydocs page ids encode authoring intent), title match the next.
 */
function computeEntityMatches(
  chunks: RetrievedChunk[],
  entityTerms: string[] | undefined,
): Set<string> {
  if (!entityTerms || entityTerms.length === 0) return new Set();
  const out = new Set<string>();
  const termsLower = entityTerms.map((t) => t.toLowerCase());
  const seen = new Set<string>();
  for (const c of chunks) {
    if (seen.has(c.page_id)) continue;
    seen.add(c.page_id);
    const idLower = c.page_id.toLowerCase();
    const titleLower = (c.page_title ?? '').toLowerCase();
    for (const term of termsLower) {
      if (term.length < 3) continue;
      if (idLower.includes(term) || titleLower.includes(term)) {
        out.add(c.page_id);
        break;
      }
    }
  }
  return out;
}

function navIndexBoostFor(navIndex: number | null): number {
  if (navIndex === null) return 0;
  // log here is natural log. nav_index=0 → 0.10/log(2) ≈ 0.144; nav_index=10
  // → 0.10/log(12) ≈ 0.040; the curve flattens fast as you go deeper.
  return NAV_INDEX_BOOST * (1 / Math.log(navIndex + 2));
}

/**
 * Set of page_ids whose title appears in the query. Two-pass:
 *
 *   1. Find all (page_id, title) candidates whose title is contained in
 *      the query — word-aligned for ASCII titles, plain substring for
 *      titles containing non-ASCII chars (CJK has no word boundaries).
 *   2. Suppress shadowed matches: if matched titles {A, B} where B's title
 *      strictly contains A's title (e.g. "Installation" inside "Installation
 *      on Termux"), drop A — the longer title is the more specific match.
 *
 * Both pages can still get the boost if the query mentions both titles
 * independently and neither contains the other.
 */
export function computeTitleMatches(chunks: RetrievedChunk[], query: string): Set<string> {
  if (!query) return new Set();
  // Normalize compound identifiers in the query — `codeGroup` becomes
  // `code group` before lowercasing — so word-boundary matches against
  // titles like "Code Blocks and Code Groups" succeed. Without this the
  // query token `codeGroup` is a single opaque blob and never aligns with
  // any natural-language title word.
  const queryLower = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();

  // Unique (page_id, title) pairs from the candidate chunks.
  const titlesByPage = new Map<string, string>();
  for (const c of chunks) {
    if (!titlesByPage.has(c.page_id)) titlesByPage.set(c.page_id, c.page_title);
  }

  type Match = { pageId: string; titleLower: string };
  const matches: Match[] = [];
  for (const [pageId, title] of titlesByPage) {
    if (!title) continue;
    if (title.length < TITLE_MATCH_MIN_LEN) continue;
    const titleLower = title.toLowerCase();
    if (!hitsQuery(queryLower, titleLower)) continue;
    matches.push({ pageId, titleLower });
  }
  if (matches.length === 0) return new Set();

  // Suppress shadowed matches — if some other matched title strictly contains
  // this title as a substring, drop the shorter one.
  const out = new Set<string>();
  for (const m of matches) {
    const shadowed = matches.some(
      (other) =>
        other.pageId !== m.pageId &&
        other.titleLower.length > m.titleLower.length &&
        other.titleLower.includes(m.titleLower),
    );
    if (!shadowed) out.add(m.pageId);
  }
  return out;
}

const ASCII_ONLY = /^[\x00-\x7f]+$/;
// Common English words that carry no discriminative signal for a page title.
const TITLE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'this', 'that',
  'are', 'has', 'have', 'was', 'were', 'will', 'how', 'what', 'when',
  'where', 'which', 'who', 'using', 'getting', 'working',
]);

function hitsQuery(queryLower: string, titleLower: string): boolean {
  if (!ASCII_ONLY.test(titleLower)) {
    // Non-ASCII titles (CJK etc.) — no word boundaries; plain substring is the
    // only sensible match.
    return queryLower.includes(titleLower);
  }

  // Exact phrase match (original behaviour).
  const escaped = titleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`).test(queryLower)) return true;

  // Partial-word match: filter stop-words and short tokens from the title,
  // then require ≥ 50 % of the remaining "significant" words to appear in the
  // query word-aligned. This lets "Working with Claude Code" match a query
  // containing "Claude Code", and "MCP Tools Reference" match "MCP tools",
  // without the query having to include the full title verbatim.
  //
  // Singular/plural tolerance: word boundaries default to exact match, so
  // a query containing "tool" wouldn't hit a title with "Tools". Allow an
  // optional trailing 's' on either side so the match is bidirectional.
  // Trade-off: a few low-frequency words like "glass" → "glas" become loose,
  // but the win on natural-language queries (user types singular, docs use
  // plural or vice versa) is worth that noise.
  const significant = titleLower
    .split(/\s+/)
    .filter((w) => w.length > 3 && !TITLE_STOP_WORDS.has(w));
  if (significant.length < 2) return false; // too few words; rely on exact only
  const hits = significant.filter((w) => {
    const we = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stem = we.endsWith('s') ? we.slice(0, -1) : we;
    return new RegExp(`\\b${stem}s?\\b`).test(queryLower);
  }).length;
  return hits / significant.length >= 0.5;
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
