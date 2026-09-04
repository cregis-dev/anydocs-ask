/**
 * Page → chunk pipeline.
 *
 *   PageDoc.content (DocContentV1)
 *     └─ renderPageContent (@anydocs/core)
 *          → markdown
 *               └─ chunkMarkdownStructure
 *                    → heading-aware prose/list/code/table pieces
 *                         → ChunkInput[]
 *
 * Each ChunkInput carries everything needed to (a) hash for cache lookup,
 * (b) embed, (c) insert into the chunks / chunks_vec / chunks_fts triplet,
 * and (d) reconstruct the citation URL on retrieval.
 *
 * No I/O, no DB writes, no embedding calls — those happen in stage 5.
 */

import { renderPageContent } from '@anydocs/core/render-page-content';
import { CHUNK_MAX_CHARS_DEFAULT, CHUNK_OVERLAP_CHARS_DEFAULT } from './sections.ts';
import { chunkMarkdownStructure } from './structural-chunks.ts';
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
  /** is_code = 1 when the structural piece contains a fenced code block.
   *  Hint for BM25 / rerank weight, not a routing signal. */
  is_code: number;
};

export type ChunkPageOptions = {
  maxChars?: number;
  overlapChars?: number;
};

export function chunkPage(page: PageDoc, options: ChunkPageOptions = {}): ChunkInput[] {
  const maxChars = options.maxChars ?? CHUNK_MAX_CHARS_DEFAULT;
  // Kept in the public options shape for backwards compatibility. Chunker v2
  // uses structural repetition instead of arbitrary character overlap.
  void (options.overlapChars ?? CHUNK_OVERLAP_CHARS_DEFAULT);

  const markdown = page.render?.markdown ?? renderPageContent(page.content).markdown ?? '';
  if (!markdown.trim()) return [];

  const pieces = chunkMarkdownStructure(markdown, page.title, maxChars);
  const chunks: ChunkInput[] = [];
  const indexesByHeading = new Map<string, number>();

  for (const piece of pieces) {
    const nextIndex = (indexesByHeading.get(piece.headingId) ?? 0) + 1;
    indexesByHeading.set(piece.headingId, nextIndex);
    const inPath = piece.headingId
      ? `${piece.headingId}/p[${nextIndex}]`
      : `p[${nextIndex}]`;

    chunks.push({
      page_id: page.id,
      lang: page.lang,
      in_page_path: inPath,
      heading_id: piece.headingId,
      heading_path: piece.headingPath,
      text: piece.text,
      content_hash: contentHash(piece.text),
      token_count: estimateTokens(piece.text),
      is_code: piece.isCode ? 1 : 0,
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
