/**
 * FTS5 MATCH query sanitizer.
 *
 * SQLite FTS5 reserves these characters as part of its query grammar:
 *   "  *  -  +  :  (  )  ^
 * Plus AND / OR / NOT are reserved keywords. Passing raw user text containing
 * any of these to MATCH yields a SQLITE_ERROR (malformed MATCH expression),
 * which would surface as a 500 to the caller — and worse, attackers could
 * craft queries that confuse the tokenizer.
 *
 * Strategy (v1):
 *   1. Drop reserved punctuation and quotes.
 *   2. Tokenize on whitespace and remaining punctuation.
 *   3. Lowercase tokens that match a reserved keyword (AND/OR/NOT) and
 *      either drop them or wrap them in double quotes.
 *   4. Wrap every surviving token in double quotes (FTS5 phrase syntax) so
 *      the tokenizer treats it literally.
 *   5. Join with explicit OR — natural-language questions rarely have every
 *      keyword present in the relevant chunk (e.g. "how do I auth a JWT
 *      request" vs a chunk titled "JWT bearer token usage"). Implicit AND
 *      misses too much. RRF + rerank tolerate the wider candidate pool
 *      because rank position, not raw BM25 score, is what feeds fusion.
 *
 * Returns null when nothing useful survives (e.g. question was all
 * punctuation) — callers should skip the BM25 path entirely in that case.
 */

const FTS5_RESERVED_CHARS = /["*\-+:()^]/g;
const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);
// Token boundary: any whitespace, any latin punctuation, any CJK punctuation.
// Keeping CJK ideographs and ASCII alphanumerics intact lets the FTS5
// unicode61 tokenizer do its own segmentation downstream.
const TOKEN_SPLIT = /[\s,.!?;。，！？；：、（）「」『』《》【】~“”‘’`/\\|]+/u;

export function sanitizeFtsQuery(text: string): string | null {
  // Strip reserved chars first so they don't survive into tokens.
  const cleaned = text.replace(FTS5_RESERVED_CHARS, ' ');
  const tokens = cleaned
    .split(TOKEN_SPLIT)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const useful: string[] = [];
  for (const t of tokens) {
    if (FTS5_KEYWORDS.has(t.toUpperCase())) continue; // drop AND/OR/NOT/NEAR
    useful.push(`"${t}"`);
  }

  if (useful.length === 0) return null;
  return useful.join(' OR ');
}
