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
import { chunkMarkdownStructure, type StructuralChunkPiece } from './structural-chunks.ts';
import { contentHash } from './normalize.ts';
import { extractIndexedIdentifiers, type IndexedIdentifier } from './identifiers.ts';
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
  /** Stable structural parent. Children are embedded; parents provide bounded context. */
  parent: ParentChunkInput;
  /** Coarse type used by retrieval diagnostics and API-aware context selection. */
  chunk_kind: string;
  /** OpenAPI object boundary such as data.rows[] or data.settlement_details. */
  object_path: string | null;
  /** Exact identifiers stored in a dedicated lookup table. */
  identifiers: IndexedIdentifier[];
};

export type ParentChunkInput = {
  parent_path: string;
  heading_id: string;
  heading_path: string[];
  text: string;
  content_hash: string;
  token_count: number;
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
  const pageParentText = buildPageParentText(page.title, pieces);
  const pageParent: ParentChunkInput = {
    parent_path: '$page',
    heading_id: '',
    heading_path: [],
    text: pageParentText,
    content_hash: contentHash(pageParentText),
    token_count: estimateTokens(pageParentText),
  };

  for (const piece of pieces) {
    const nextIndex = (indexesByHeading.get(piece.headingId) ?? 0) + 1;
    indexesByHeading.set(piece.headingId, nextIndex);
    const inPath = piece.headingId
      ? `${piece.headingId}/p[${nextIndex}]`
      : `p[${nextIndex}]`;

    const objectPath = objectPathFor(piece.headingPath);
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
      parent: pageParent,
      chunk_kind: chunkKindFor(piece.headingPath, piece.isCode),
      object_path: objectPath,
      identifiers: extractIndexedIdentifiers(stripContextPrefix(piece.text)),
    });
  }

  return chunks;
}

function buildPageParentText(pageTitle: string, pieces: StructuralChunkPiece[]): string {
  const parts = [`Page: ${pageTitle.trim()}`];
  let previousHeadingPath = '';

  for (const piece of pieces) {
    const headingPath = piece.headingPath.join(' > ');
    if (headingPath && headingPath !== previousHeadingPath) {
      parts.push(`Section: ${headingPath}`);
    }
    parts.push(stripContextPrefix(piece.text));
    previousHeadingPath = headingPath;
  }

  return parts.filter(Boolean).join('\n\n');
}

function buildContextPrefix(pageTitle: string, headingPath: string[]): string {
  const lines = [`Page: ${pageTitle.trim()}`];
  if (headingPath.length > 0) lines.push(`Section: ${headingPath.join(' > ')}`);
  return lines.join('\n');
}

function stripContextPrefix(text: string): string {
  return text.replace(/^Page: [^\n]*(?:\nSection: [^\n]*)?\n?/, '').trim();
}

function objectPathFor(headingPath: string[]): string | null {
  const title = headingPath.at(-1) ?? '';
  const match = /^(?:Request|Response) (?:Object|Example):\s*(.+)$/i.exec(title);
  return match?.[1]?.trim() || null;
}

function chunkKindFor(headingPath: string[], isCode: boolean): string {
  const title = (headingPath.at(-1) ?? '').toLowerCase();
  if (title.startsWith('request object:')) return 'api-request-object';
  if (title.startsWith('response object:')) return 'api-response-object';
  if (title.startsWith('request example:')) return 'api-request-example';
  if (title.startsWith('response example:')) return 'api-response-example';
  if (title === 'request headers' || title === 'request parameters') return 'api-parameters';
  if (title === 'endpoint' || title === 'http request') return 'api-request';
  if (isCode) return 'code';
  return 'content';
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const nonCjkLength = text.replace(/[\u3400-\u9fff]/gu, '').length;
  return Math.max(1, cjk + Math.ceil(nonCjkLength / 4));
}
