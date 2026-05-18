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
    // Compound camelCase ("codeGroup", "getUserById"): also emit a phrase
    // form so BM25 hits the same identifier spelled as separate words
    // ("code group", "get user by id"). Without this, a user query of
    // `codeGroup` doesn't surface chunks whose prose writes "code group"
    // — which is exactly how most authored docs render the concept.
    const altered = splitCompoundIdentifier(t);
    if (altered && altered.toLowerCase() !== t.toLowerCase()) {
      useful.push(`"${altered}"`);
    }
  }

  if (useful.length === 0) return null;
  return useful.join(' OR ');
}

/**
 * Split a camelCase / PascalCase / mixed identifier into a space-separated
 * phrase. Returns null when the token has no internal case boundary (no
 * useful split to emit).
 *
 *   codeGroup       → "code Group"
 *   getUserById     → "get User By Id"
 *   XMLHttpRequest  → "XML Http Request"
 *   plainword       → null
 */
function splitCompoundIdentifier(token: string): string | null {
  if (!/[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(token)) return null;
  const split = token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (split.length < 2) return null;
  return split.join(' ');
}
