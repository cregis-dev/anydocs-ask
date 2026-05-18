/**
 * Server-side query language detection (ARCH §6 step 1.5 / PRD §4.8).
 *
 * Two inputs decide the lang:
 *   1. scope_id — encodes the lang in its prefix (`nav:zh.json:...`); when
 *      present it overrides text detection (the user explicitly chose a
 *      lang-specific subtree).
 *   2. raw question text — CJK signal (unified ideographs + CJK punctuation)
 *      ratio against non-whitespace characters. ≥ 0.15 → 'zh', else 'en'.
 *
 * The threshold was tightened from 0.30 to 0.15 (and CJK punctuation added)
 * because real-world zh queries mix in English technical terms heavily:
 *   "如何配置 anydocs.config.json 里的 site.theme.id？" — 6 zh chars in 37
 *   "sessions、checkpoints、memory 有什么区别？" — 5 zh chars in 33
 * Both are clearly Chinese to a human but fell under the 30% bar. CJK
 * punctuation (、。？！「」《》…) adds extra signal so mostly-ASCII queries
 * with Chinese phrasing still tip over.
 *
 * Future langs (ARCH §14 #13) will introduce additional ratio buckets; v1
 * keeps it to the two anydocs supports.
 */

import type { DocsLang } from '../anydocs/types.ts';

const CJK_UNIFIED = /[一-鿿]/;
// Common CJK punctuation in zh-CN authored text. We count these as zh signal
// because a query that uses 、 or ？ instead of , and ? is almost always
// authored by a Chinese speaker, even if the rest is ASCII technical terms.
const CJK_PUNCT = /[　-〿＀-￯]/;
const NON_WS = /\S/;
const NAV_LANG_PREFIX = /^nav:([a-z]+)\.json:/i;

const ZH_RATIO_THRESHOLD = 0.15;

/**
 * Pure text-only detector. Used directly when neither scope_id nor a known
 * current_page_id is available.
 */
export function detectLangFromText(text: string): DocsLang {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    if (!NON_WS.test(ch)) continue;
    total++;
    if (CJK_UNIFIED.test(ch) || CJK_PUNCT.test(ch)) cjk++;
  }
  if (total === 0) return 'en'; // empty / whitespace-only → benign default
  return cjk / total >= ZH_RATIO_THRESHOLD ? 'zh' : 'en';
}

/**
 * Extract lang from a stable nav id. Returns null if the id is not the
 * `nav:<lang>.json:<dfs>` form (e.g. it's a raw page_id like
 * `p_frontend_auth`, which doesn't carry lang on its own).
 */
export function langFromScopeId(scopeId: string): DocsLang | null {
  const match = NAV_LANG_PREFIX.exec(scopeId);
  if (!match) return null;
  const lang = match[1]!.toLowerCase();
  if (lang === 'zh' || lang === 'en') return lang;
  return null;
}
