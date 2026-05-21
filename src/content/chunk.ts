/**
 * Page → chunk pipeline.
 *
 *   PageDoc.content (DocContentV1)
 *     └─ renderPageContent (@anydocs/core)
 *          → markdown
 *               └─ extractMarkdownSections (heading-bounded)
 *                    → SearchSection[]
 *                         └─ splitChunkText (long sections roll over)
 *                              → ChunkInput[]
 *
 * Each ChunkInput carries everything needed to (a) hash for cache lookup,
 * (b) embed, (c) insert into the chunks / chunks_vec / chunks_fts triplet,
 * and (d) reconstruct the citation URL on retrieval.
 *
 * No I/O, no DB writes, no embedding calls — those happen in stage 5.
 */

import { renderPageContent } from '@anydocs/core/render-page-content';
import {
  extractMarkdownSections,
  splitChunkText,
  CHUNK_MAX_CHARS_DEFAULT,
  CHUNK_OVERLAP_CHARS_DEFAULT,
} from './sections.ts';
import { contentHash } from './normalize.ts';
import type { PageDoc } from '../anydocs/types.ts';

export type ChunkInput = {
  page_id: string;
  lang: string;
  /**
   * In-page locator. Format:
   *   - `${headingId}/p[${chunkIndexInSection}]` when there's a heading
   *   - `p[${chunkIndexInSection}]` when the chunk is in the prose preface
   * Mirrors ARCH §4 chunks.in_page_path.
   */
  in_page_path: string;
  /** Heading slug used to build the citation URL anchor. Empty for preface chunks. */
  heading_id: string;
  /** Heading titles, root → current. Used to enrich the LLM prompt context. */
  heading_path: string[];
  text: string;
  content_hash: string;
  /** Cheap estimate, ARCH §7.1 ≈ ceil(chars / 4). True tokenization happens
   *  inside the embedder when needed. */
  token_count: number;
  /** is_code = 1 when this chunk is overwhelmingly code (post-strip ratio ≥ 0.7).
   *  Hint for BM25 / rerank weight, not a routing signal. */
  is_code: number;
};

export type ChunkPageOptions = {
  maxChars?: number;
  overlapChars?: number;
};

export function chunkPage(page: PageDoc, options: ChunkPageOptions = {}): ChunkInput[] {
  const maxChars = options.maxChars ?? CHUNK_MAX_CHARS_DEFAULT;
  const overlapChars = options.overlapChars ?? CHUNK_OVERLAP_CHARS_DEFAULT;

  const markdown = page.render?.markdown ?? renderPageContent(page.content).markdown ?? '';
  if (!markdown.trim()) return [];

  const sections = extractMarkdownSections(markdown, page.title);
  const chunks: ChunkInput[] = [];

  for (const section of sections) {
    const pieces = splitChunkText(section.text, maxChars, overlapChars);
    pieces.forEach((piece, idx) => {
      // Detect "mostly code": the heuristic is a coarse one-shot check on the
      // section's source markdown, not per-chunk. Stage 5 may refine this.
      const isCode = isMostlyCode(section.text) ? 1 : 0;
      const inPath = section.headingId
        ? `${section.headingId}/p[${idx + 1}]`
        : `p[${idx + 1}]`;

      chunks.push({
        page_id: page.id,
        lang: page.lang,
        in_page_path: inPath,
        heading_id: section.headingId,
        heading_path: section.headingPath,
        text: piece,
        content_hash: contentHash(piece),
        token_count: estimateTokens(piece),
        is_code: isCode,
      });
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Token estimate. anydocs build uses ceil(chars/4) which over-counts CJK and
 * under-counts spaced English; we keep it for compatibility with the
 * `token_count` field semantics in ARCH §4. Real tokenization happens in
 * the embedder pipeline when batching has to respect a model context window.
 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Heuristic for "this section is overwhelmingly code". Used as a BM25 / rerank
 * hint, not as a routing signal — see ARCH §7.1 (revised). We look at the
 * raw section text (which still contains line breaks from extracted code
 * blocks) and count the share of lines that look code-shaped.
 */
function isMostlyCode(sectionText: string): boolean {
  const lines = sectionText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const codeLines = lines.filter(looksLikeCode).length;
  return codeLines / lines.length >= 0.7;
}

function looksLikeCode(line: string): boolean {
  if (/^[\s]*\/\//.test(line)) return true;       // // comment
  if (/^[\s]*#\s/.test(line)) return false;        // markdown heading-ish; bail
  if (/[{}()\[\];]\s*$/.test(line)) return true;   // common code endings
  if (/=>\s*\{/.test(line)) return true;
  if (/\b(function|const|let|var|class|import|export|return|if|else|for|while)\b/.test(line)) return true;
  return false;
}
