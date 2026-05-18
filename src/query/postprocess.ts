/**
 * Answer postprocessing — ARCH §6 step 7.
 *
 * v1 covers (chosen 2026-05-07):
 *   1. Citation legality: every citation in the response must join back to
 *      a chunk that the LLM was actually shown.
 *   2. Lang fill: citations[].lang from chunk.lang; source_lang only set
 *      when chunk.lang != answer_lang (cross-lang fallback).
 *   3. Truncation: 4000 chars with ellipsis.
 *   4. Hallucination filter: every fenced code block / inline-code token in
 *      the answer must appear (literally) somewhere in the cited chunks.
 *      Hits that don't are stripped from the answer with a warning marker.
 *
 * v1 deliberately defers (chosen 2026-05-07):
 *   - Format-validation re-call (would require a second LLM round-trip).
 *
 * The function is pure: takes raw LLM text + the chunk-by-id map, returns
 * a finalized answer markdown + citations array.
 */

import type { DocsLang } from '../anydocs/types.ts';
import type { RerankedChunk } from './rerank.ts';
import type { Citation } from './types.ts';

export type PostprocessInput = {
  answerLang: DocsLang;
  rawAnswer: string;
  chunkById: Map<string, RerankedChunk>;
  /**
   * Original user question. Counts as a trusted source for the
   * hallucination filter so that identifiers the user wrote (e.g. `mcp/pages.json`
   * in "what does mcp/pages.json contain?") aren't flagged when the answer
   * legitimately repeats them — common when the LLM says "the docs don't
   * mention X" and X is shaped like a path.
   *
   * Optional for backwards compatibility with callers that don't have the
   * question handy (e.g. older tests); when absent, only chunks are trusted.
   */
  question?: string;
};

export type PostprocessOutput = {
  answer_md: string;
  citations: Citation[];
  /** Number of chunks the LLM actually cited (deduplicated). */
  used_chunks: number;
};

const MAX_ANSWER_CHARS = 4000;
const TRUNCATION_NOTICE = {
  zh: '\n\n…（答案过长已截断）',
  en: '\n\n…(answer truncated)',
};

const CITATION_MARKER = /\[(cit_\d+)\]/g;

export function postprocess(input: PostprocessInput): PostprocessOutput {
  // 1. Parse citation markers, drop any that don't join back to a known chunk.
  //    Build orderedIds = unique referenced markers in first-appearance order;
  //    this defines the public 1..K numbering the consumer will see.
  const orderedIds: string[] = [];
  for (const m of input.rawAnswer.matchAll(CITATION_MARKER)) {
    const id = m[1]!;
    if (input.chunkById.has(id) && !orderedIds.includes(id)) {
      orderedIds.push(id);
    }
  }
  const renumber = new Map<string, string>();
  orderedIds.forEach((oldId, idx) => {
    renumber.set(oldId, `cit_${idx + 1}`);
  });

  // 2. Rewrite answer markers: legal -> renumbered cit_N (1..K, matches
  //    citations[N-1]); illegal -> stripped. Renumbering means the consumer
  //    can resolve `[cit_N]` by 1-based index into the citations array
  //    without knowing the prompt's original cit ordering.
  const cleanedAnswer = input.rawAnswer.replace(CITATION_MARKER, (match, id) => {
    const next = renumber.get(id);
    return next ? `[${next}]` : ''; // strip illegal citation
  });

  // 3. Hallucination filter: code-fenced blocks + backticked identifiers.
  //    Trusted sources = cited chunks + the user's original question (an
  //    identifier the user already wrote can't be a hallucination when the
  //    LLM repeats it).
  const trustedTexts = [...input.chunkById.values()].map((c) => c.text);
  if (input.question) trustedTexts.push(input.question);
  const filteredAnswer = filterHallucinations(cleanedAnswer, trustedTexts);

  // 4. Truncation.
  const finalAnswer = truncateForLang(filteredAnswer, input.answerLang);

  // 5. Build citations using renumbered ids, in the same order as orderedIds.
  const citations: Citation[] = orderedIds.map((oldId, idx) =>
    citationFromChunk(`cit_${idx + 1}`, input.chunkById.get(oldId)!, input.answerLang),
  );

  return { answer_md: finalAnswer, citations, used_chunks: citations.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function citationFromChunk(
  citationId: string,
  chunk: RerankedChunk,
  answerLang: DocsLang,
): Citation {
  const isCrossLang = chunk.lang !== answerLang;
  return {
    citation_id: citationId,
    chunk_id: chunk.chunk_id,
    page_id: chunk.page_id,
    lang: chunk.lang,
    source_lang: isCrossLang ? chunk.lang : null,
    title: chunk.page_title,
    breadcrumb: chunk.breadcrumb,
    url: buildCitationUrl(chunk),
    snippet: snippetFromChunk(chunk.text),
    in_page_path: chunk.in_page_path,
  };
}

function buildCitationUrl(chunk: RerankedChunk): string | null {
  if (!chunk.page_url) return null;
  // Suffix the heading anchor when in_page_path encodes one. Format from
  // the chunker: `<headingId>/p[<n>]` — strip the `/p[..]` suffix to get
  // the heading id, which is also the URL fragment.
  const slashIdx = chunk.in_page_path.indexOf('/');
  if (slashIdx <= 0) return chunk.page_url;
  const headingId = chunk.in_page_path.slice(0, slashIdx);
  return `${chunk.page_url}#${headingId}`;
}

function snippetFromChunk(text: string): string {
  // Take the first 240 visible chars from the chunk; collapse internal
  // whitespace so the snippet renders sanely in the Reader's footer.
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

function truncateForLang(text: string, lang: DocsLang): string {
  if (text.length <= MAX_ANSWER_CHARS) return text;
  const head = text.slice(0, MAX_ANSWER_CHARS - TRUNCATION_NOTICE[lang].length);
  return head + TRUNCATION_NOTICE[lang];
}

/**
 * "Clearly a technical identifier" — body shapes that are exempted from the
 * hallucination check outright (no haystack lookup required). The codex eval
 * round-3 follow-up made it clear that technical docs lean on file names,
 * config keys, URLs, and placeholders heavily enough that requiring each to
 * appear verbatim (even softened) in the chunks produces too many false
 * positives. We accept that the occasional fabricated file name slips through
 * un-flagged — readers can check the docs directly — in exchange for not
 * polluting every legitimate identifier with ⚠.
 */
const URL_SCHEME_RE = /:\/\//;
const LOOPBACK_RE = /(^|[^a-zA-Z0-9])(localhost|127\.0\.0\.1|0\.0\.0\.0)(:[0-9]+)?(\/|$)/;
// File extensions that look like file names rather than config-key suffixes.
// `.key` is intentionally absent — too easily confused with `app.config.key`
// style keys. PEM private keys generally appear in paths (`certs/server.key`)
// so they get covered by the path branch below anyway.
const FILE_EXT_RE = /\.(json|ya?ml|toml|md|txt|tsx?|jsx?|mjs|cjs|py|css|html?|sh|env|csv|sql|xml|conf|ini|lock|yaml|log|map|pem|crt|dockerfile)(\b|$)/i;
// Well-known no-extension file names. Docs reference these constantly and
// `Dockerfile`/`Makefile` etc. don't fit any extension rule.
const WELL_KNOWN_FILE_NAMES = new Set([
  'dockerfile', 'makefile', 'gemfile', 'procfile', 'pipfile', 'jenkinsfile',
  'rakefile', 'guardfile', 'vagrantfile', 'brewfile',
]);

// Dotted config keys (≥2 segments, each ≥2 chars, lowercase/camelCase).
// Catches `site.theme.id`, `build.outputDir`, `app.feature.enabled`, etc.
// Excludes single-char segments (`a.b`) and anything with non-identifier
// characters. Method-call shapes like `obj.method()` are filtered by the
// outer charset check and by the trailing `()` not matching this pattern.
const DOTTED_CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]+(\.[a-zA-Z][a-zA-Z0-9]+)+$/;
// Directory-shaped paths ending in a trailing slash (`dist/imports/`,
// `pages/en/`, `src/`). Docs reference these constantly to point at output
// layouts without naming a specific file; refusing to whitelist them
// produced ⚠ on legitimate directory references.
const DIRECTORY_PATH_RE = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*\/$/;

/**
 * Identifiers that look "obviously technical" enough that we trust them
 * without a haystack match. The buckets:
 *   - URL with scheme (`https://...`).
 *   - Loopback endpoints (`localhost:3100`, `127.0.0.1:8080`).
 *   - File names / paths ending in a recognized extension
 *     (`anydocs.config.json`, `imports/manifest.json`).
 *   - Well-known no-extension files (`Dockerfile`, `Makefile`, ...).
 */
function isClearlyTechnicalIdentifier(body: string): boolean {
  if (URL_SCHEME_RE.test(body)) return true;
  if (LOOPBACK_RE.test(body)) return true;
  if (FILE_EXT_RE.test(body) && /^[A-Za-z0-9_./@:~-]+$/.test(body)) return true;
  if (WELL_KNOWN_FILE_NAMES.has(body.toLowerCase())) return true;
  if (DOTTED_CONFIG_KEY_RE.test(body)) return true;
  if (DIRECTORY_PATH_RE.test(body)) return true;
  return false;
}

/**
 * Identifiers that are *probably* structural but ambiguous enough that we
 * still demand a softened haystack match (e.g. dotted config keys without a
 * file extension). Catches `site.theme.branding` and `build.outputDir` while
 * leaving room for the haystack check to reject true hallucinations like
 * `fake.nested.key` when the source corpus says nothing of the kind.
 */
const PATH_OR_KEY_SHAPE = /^[A-Za-z0-9_./-]+$/;
const DOTTED_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/**
 * Detect inline-code bodies that are actually prose sentences (LLM formatting
 * mistake — e.g. wrapping a table-cell description in backticks). Telltale
 * combination: at least one whitespace, a sentence-ending punctuation mark
 * mid-body or at the end, and enough length to rule out short identifiers
 * like `getUser(...)`.
 *
 * Conservative thresholds — we'd rather miss a prose case and let ⚠ stand
 * than incorrectly exempt a long identifier-like string. Bodies under 20
 * chars are never treated as prose.
 */
function isProseSentence(body: string): boolean {
  if (body.length < 20) return false;
  if (!/\s/.test(body)) return false; // no whitespace → not a sentence
  // Sentence-ending punctuation followed by whitespace anywhere in the body
  // ("...is the standard theme. Currently...") — strong prose signal.
  if (/[.!?。！？](\s|["'])/.test(body)) return true;
  // Body ends in terminal punctuation including ellipsis (…/...) AND has
  // multiple words — also prose.
  if (/(\.{3}|…|[.!?。！？])["'”’]?$/.test(body) && /\s/.test(body.trim())) return true;
  return false;
}

/**
 * Detect inline-code bodies that look like a key/value snippet from a JSON,
 * YAML, or config-block — e.g. `siteTitle": "My Documentation"` or
 * `outputDir: "./dist"` or `enabled = true`. LLMs occasionally wrap these
 * in inline backticks rather than fenced blocks; the hallucination filter
 * was then demanding a literal haystack match for what's effectively a
 * pasted-out config slice. Treat any key/value separator (`: ` / `:"` /
 * ` = `) followed by a quoted or bare value as the signal — these
 * patterns don't occur in legitimate code identifiers.
 *
 * Conservative on length so short colon-bearing identifiers (e.g.
 * `ns::method`) don't slip through.
 */
function isJsonLikeSnippet(body: string): boolean {
  // Bare quoted-string example value (e.g. `"API Reference"`, `'My Docs'`).
  // LLMs occasionally backtick a string literal pulled from a doc example;
  // when it has whitespace inside it can't be a code identifier. Length
  // floor of 6 + whitespace inside the quotes filters out trivial `"foo"`.
  if (/^["'].+["']$/.test(body) && body.length >= 6 && /\s/.test(body.slice(1, -1))) return true;
  if (body.length < 10) return false;
  if (!/\s/.test(body)) return false;
  // Key/value separator followed by a quote (JSON/TS string value).
  if (/[:=]\s*["']/.test(body)) return true;
  // Bare `key: value` / `key = value` with key followed by space-padded sep.
  // Requires whitespace around the separator so we don't confuse `foo:bar`
  // path-style tokens with config assignments.
  if (/^[A-Za-z_][A-Za-z0-9_.-]*\s*[:=]\s+[^\s]+/.test(body)) return true;
  return false;
}

function isStructuralCandidate(body: string): boolean {
  if (!PATH_OR_KEY_SHAPE.test(body)) return false;
  if (body.includes('/')) return true; // any slash-bearing token
  if (DOTTED_KEY_RE.test(body)) return true; // foo.bar / foo.bar.baz
  return false;
}

/**
 * Strip code identifiers from the answer that don't appear in any context
 * chunk. Conservative — we only redact, we don't drop the surrounding
 * sentence (preserving readability over precision).
 *
 * Exemptions (in order of cost):
 *   1. Template placeholders — `<lang>`, `<pageId>`, `{org}` etc. Always
 *      legitimate authoring patterns.
 *   2. Clearly-technical identifiers — file names with a known extension,
 *      URLs, loopback endpoints. Direct allow; the false-positive cost
 *      (polluting `anydocs.config.json` / `https://x` / `localhost:3100`) far
 *      exceeds the cost of letting an occasional fabricated file name through.
 *   3. Case-insensitive haystack — chunks strip markdown which can capitalize
 *      identifiers; lowercase compare keeps these clean.
 *   4. Softened haystack — for "looks structural but no file extension" tokens
 *      like `site.theme.branding`, drop `./_-` and compare on the normalized
 *      form so prose like "site theme branding key" still counts as a match.
 *      Still requires *some* haystack presence so true hallucinations like
 *      `totally.fake.key` get flagged.
 */
function filterHallucinations(answer: string, contextTexts: string[]): string {
  if (contextTexts.length === 0) return answer;
  const haystack = contextTexts.join('\n');
  const haystackLower = haystack.toLowerCase();
  // Lazy: built on first softened-check; many answers have none.
  let haystackSoftened: string | null = null;

  const inHaystack = (body: string): boolean => {
    // Prose sentences wrapped in backticks (e.g. table-cell descriptions
    // the LLM accidentally formatted as inline code). These aren't code-
    // identifier claims — running the hallucination check on them produces
    // sentence-tail ⚠'s on entirely legitimate descriptive text. Bail out
    // before any other check.
    if (isProseSentence(body)) return true;
    if (isJsonLikeSnippet(body)) return true;
    // LLMs frequently wrap JSON-style keys in double quotes (e.g.
    // `"site.theme.id"` or `'build.outputDir'`). The quotes are display
    // formatting, not part of the identifier — strip them before any
    // shape check so the underlying token can match the same way the
    // unquoted form would.
    const unquoted = body.replace(/^["'`]+|["'`]+$/g, '');
    // Template placeholder pattern — skip the check entirely.
    if (/\{[^}]+\}|<[^>]+>/.test(unquoted)) return true;
    // Clearly-technical shapes (file names, URLs, loopback) — direct allow.
    if (isClearlyTechnicalIdentifier(unquoted)) return true;
    const bodyLower = unquoted.toLowerCase();
    if (haystackLower.includes(bodyLower)) return true;
    if (isStructuralCandidate(unquoted)) {
      const softened = bodyLower.replace(/[./_-]+/g, '');
      if (softened.length < 6) return false; // too short — risk of incidental match
      if (haystackSoftened === null) {
        haystackSoftened = haystackLower.replace(/[./_\-\s]+/g, '');
      }
      if (haystackSoftened.includes(softened)) return true;
    }
    return false;
  };

  // Inline-code identifiers (single backtick) — `getUserById`, `--flag`.
  let out = answer.replace(/`([^`\n]+)`/g, (match, body: string) => {
    return inHaystack(body) ? match : `\`${body}⚠\``;
  });

  // Fenced code blocks — only mark as suspicious if a non-trivial line in the
  // block (≥ 8 chars, mostly identifier-shaped) is missing from haystack. We
  // check each fenced block lazily to avoid quadratic cost on long answers.
  out = out.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (match, body: string) => {
    const suspicious = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 8 && /^[\w.~/-]+$/.test(l))
      .some((l) => !inHaystack(l));
    return suspicious ? `${match}\n<!-- ⚠ contains identifiers not found in cited context -->` : match;
  });

  return out;
}
