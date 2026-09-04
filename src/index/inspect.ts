import type { DbHandle } from '../db/index.ts';
import type { BreadcrumbNode } from '../db/schema.ts';

export type IndexedPageMeta = {
  page_id: string;
  lang: string;
  status: string;
  title: string;
  slug: string | null;
  breadcrumb: BreadcrumbNode[];
  nav_index: number | null;
  parent_id: string | null;
  subtree_root: string | null;
  url: string | null;
  updated_at: number;
};

export type IndexedChunkMeta = {
  chunk_id: number;
  ordinal: number;
  in_page_path: string | null;
  text: string;
  content_hash: string;
  token_count: number;
  is_code: boolean;
  created_at: number;
  embedded: boolean;
  embedding_cached: boolean;
};

export type IndexedPageChunks = {
  page: IndexedPageMeta;
  chunks: IndexedChunkMeta[];
};

type PageDbRow = Omit<IndexedPageMeta, 'breadcrumb'> & { breadcrumb: string };
type ChunkDbRow = Omit<IndexedChunkMeta, 'ordinal' | 'is_code' | 'embedded' | 'embedding_cached'> & {
  is_code: number;
  embedded: number;
  embedding_cached: number;
};

export function inspectIndexedPage(
  db: DbHandle,
  pageId: string,
  lang: string,
  embeddingModel: string,
): IndexedPageChunks | null {
  const pageRow = db.prepare(
    `SELECT page_id, lang, status, title, slug, breadcrumb, nav_index,
            parent_id, subtree_root, url, updated_at
       FROM pages
      WHERE page_id = ? AND lang = ?`,
  ).get(pageId, lang) as PageDbRow | undefined;

  if (!pageRow) return null;

  const chunkRows = db.prepare(
    `SELECT c.chunk_id, c.in_page_path, c.text, c.content_hash,
            c.token_count, c.is_code, c.created_at,
            EXISTS(SELECT 1 FROM chunks_vec v WHERE v.chunk_id = c.chunk_id) AS embedded,
            EXISTS(
              SELECT 1 FROM embedding_cache e
               WHERE e.content_hash = c.content_hash AND e.model = ?
            ) AS embedding_cached
       FROM chunks c
      WHERE c.page_id = ? AND c.lang = ?
      ORDER BY c.chunk_id`,
  ).all(embeddingModel, pageId, lang) as ChunkDbRow[];

  return {
    page: {
      ...pageRow,
      breadcrumb: parseBreadcrumb(pageRow.breadcrumb),
    },
    chunks: chunkRows.map((row, index) => ({
      ...row,
      ordinal: index + 1,
      is_code: row.is_code === 1,
      embedded: row.embedded === 1,
      embedding_cached: row.embedding_cached === 1,
    })),
  };
}

function parseBreadcrumb(raw: string): BreadcrumbNode[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is BreadcrumbNode => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Record<string, unknown>;
      return typeof value.id === 'string'
        && typeof value.title === 'string'
        && (value.type === 'section' || value.type === 'folder' || value.type === 'page');
    });
  } catch {
    return [];
  }
}
