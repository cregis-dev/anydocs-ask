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
  const filteredAnswer = filterHallucinations(
    cleanedAnswer,
    [...input.chunkById.values()].map((c) => c.text),
  );

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
 * Strip code identifiers from the answer that don't appear in any context
 * chunk. Conservative — we only redact, we don't drop the surrounding
 * sentence (preserving readability over precision).
 *
 * Two exemptions prevent false positives:
 *   1. Case-insensitive match — chunk text strips markdown formatting which
 *      can capitalize words (e.g. table cells: "View" vs command "view").
 *   2. Template placeholders — bodies containing <…> angle-bracket syntax
 *      (e.g. `pages/<lang>/`, `<pageId>`) are intentional LLM generalisations
 *      of concrete examples in the chunks; flagging them as hallucinations
 *      breaks legitimate pattern explanations.
 */
function filterHallucinations(answer: string, contextTexts: string[]): string {
  if (contextTexts.length === 0) return answer;
  const haystack = contextTexts.join('\n');
  const haystackLower = haystack.toLowerCase();

  const inHaystack = (body: string): boolean => {
    // Template placeholder pattern — skip the check entirely.
    if (/\{[^}]+\}|<[^>]+>/.test(body)) return true;
    return haystackLower.includes(body.toLowerCase());
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
