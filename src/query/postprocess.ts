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
  const referencedIds = new Set<string>();
  const cleanedAnswer = input.rawAnswer.replace(CITATION_MARKER, (match, id) => {
    if (input.chunkById.has(id)) {
      referencedIds.add(id);
      return match;
    }
    return ''; // strip illegal citation
  });

  // 2. Hallucination filter: code-fenced blocks + backticked identifiers.
  const filteredAnswer = filterHallucinations(cleanedAnswer, [...referencedIds].map(
    (id) => input.chunkById.get(id)!.text,
  ));

  // 3. Truncation.
  const finalAnswer = truncateForLang(filteredAnswer, input.answerLang);

  // 4. Build citations from referenced chunks, preserving the order they
  //    appeared in the answer text.
  const orderedIds: string[] = [];
  for (const m of input.rawAnswer.matchAll(CITATION_MARKER)) {
    const id = m[1]!;
    if (referencedIds.has(id) && !orderedIds.includes(id)) {
      orderedIds.push(id);
    }
  }
  const citations: Citation[] = orderedIds.map((id) =>
    citationFromChunk(id, input.chunkById.get(id)!, input.answerLang),
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
 * Strip code identifiers from the answer that don't appear literally in any
 * cited chunk. Conservative — we only redact, we don't drop the surrounding
 * sentence (preserving readability over precision).
 */
function filterHallucinations(answer: string, contextTexts: string[]): string {
  if (contextTexts.length === 0) return answer;
  const haystack = contextTexts.join('\n');

  // Inline-code identifiers (single backtick) — `getUserById`, `--flag`.
  let out = answer.replace(/`([^`\n]+)`/g, (match, body: string) => {
    return haystack.includes(body) ? match : `\`${body}⚠\``;
  });

  // Fenced code blocks — only mark as suspicious if a non-trivial line in the
  // block (≥ 8 chars, mostly identifier-shaped) is missing from haystack. We
  // check each fenced block lazily to avoid quadratic cost on long answers.
  out = out.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (match, body: string) => {
    const suspicious = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 8 && /^[\w./-]+$/.test(l))
      .some((l) => !haystack.includes(l));
    return suspicious ? `${match}\n<!-- ⚠ contains identifiers not found in cited context -->` : match;
  });

  return out;
}
