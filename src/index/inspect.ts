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
  parent_id: number | null;
  parent_path: string | null;
  parent_heading_path: string[];
  parent_token_count: number | null;
  chunk_kind: string;
  object_path: string | null;
  identifiers: Array<{ value: string; kind: string }>;
  created_at: number;
  embedded: boolean;
  embedding_cached: boolean;
};

export type IndexedParentMeta = {
  parent_id: number;
  parent_path: string;
  heading_id: string | null;
  heading_path: string[];
  text: string;
  content_hash: string;
  token_count: number;
  child_count: number;
  created_at: number;
};

export type IndexedPageChunks = {
  page: IndexedPageMeta;
  parents: IndexedParentMeta[];
  chunks: IndexedChunkMeta[];
};

export type IndexedChunkReference = {
  chunk_id: number;
  content_hash?: string | null;
  page_id?: string | null;
};

export type ResolvedIndexedChunk = {
  requested_chunk_id: number;
  requested_content_hash: string | null;
  /** Legacy IDs cannot be verified after a full reindex without a hash. */
  match: 'id' | 'id_unverified' | 'content_hash' | 'missing';
  stale_id: boolean;
  page: IndexedPageMeta | null;
  parent: IndexedParentMeta | null;
  chunk: IndexedChunkMeta | null;
};

type PageDbRow = Omit<IndexedPageMeta, 'breadcrumb'> & { breadcrumb: string };
type ChunkDbRow = Omit<
  IndexedChunkMeta,
  'ordinal' | 'is_code' | 'embedded' | 'embedding_cached' | 'parent_heading_path' | 'identifiers'
> & {
  is_code: number;
  parent_heading_path: string | null;
  identifiers_json: string;
  embedded: number;
  embedding_cached: number;
};
type ParentDbRow = Omit<IndexedParentMeta, 'heading_path'> & { heading_path: string };

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

  const parentRows = db.prepare(
    `SELECT cp.parent_id, cp.parent_path, cp.heading_id, cp.heading_path,
            cp.text, cp.content_hash, cp.token_count, cp.created_at,
            COUNT(c.chunk_id) AS child_count
       FROM chunk_parents cp
       LEFT JOIN chunks c ON c.parent_id = cp.parent_id
      WHERE cp.page_id = ? AND cp.lang = ?
      GROUP BY cp.parent_id
      ORDER BY MIN(c.chunk_id), cp.parent_id`,
  ).all(pageId, lang) as ParentDbRow[];

  const chunkRows = db.prepare(
    `SELECT c.chunk_id, c.in_page_path, c.text, c.content_hash,
            c.token_count, c.is_code, c.parent_id, c.chunk_kind, c.object_path, c.created_at,
            cp.parent_path, cp.heading_path AS parent_heading_path,
            cp.token_count AS parent_token_count,
            COALESCE((
              SELECT json_group_array(json_object('value', ci.identifier, 'kind', ci.kind))
                FROM chunk_identifiers ci WHERE ci.chunk_id = c.chunk_id
            ), '[]') AS identifiers_json,
            EXISTS(SELECT 1 FROM chunks_vec v WHERE v.chunk_id = c.chunk_id) AS embedded,
            EXISTS(
              SELECT 1 FROM embedding_cache e
               WHERE e.content_hash = c.content_hash AND e.model = ?
            ) AS embedding_cached
       FROM chunks c
       LEFT JOIN chunk_parents cp ON cp.parent_id = c.parent_id
      WHERE c.page_id = ? AND c.lang = ?
      ORDER BY c.chunk_id`,
  ).all(embeddingModel, pageId, lang) as ChunkDbRow[];

  return {
    page: {
      ...pageRow,
      breadcrumb: parseBreadcrumb(pageRow.breadcrumb),
    },
    parents: parentRows.map((row) => ({
      ...row,
      heading_path: parseStringArray(row.heading_path),
    })),
    chunks: chunkRows.map((row, index) => ({
      ...row,
      ordinal: index + 1,
      is_code: row.is_code === 1,
      embedded: row.embedded === 1,
      embedding_cached: row.embedding_cached === 1,
      parent_heading_path: parseStringArray(row.parent_heading_path),
      identifiers: parseIdentifiers(row.identifiers_json),
    })),
  };
}

/** Resolve persisted run references against the current index in one call. */
export function resolveIndexedChunks(
  db: DbHandle,
  refs: IndexedChunkReference[],
  embeddingModel: string,
): ResolvedIndexedChunk[] {
  const byId = db.prepare(
    `SELECT chunk_id, page_id, lang, content_hash FROM chunks WHERE chunk_id = ?`,
  );
  const byHashAndPage = db.prepare(
    `SELECT chunk_id, page_id, lang, content_hash
       FROM chunks
      WHERE content_hash = ? AND (? IS NULL OR page_id = ?)
      ORDER BY CASE WHEN page_id = ? THEN 0 ELSE 1 END, chunk_id
      LIMIT 1`,
  );
  const pageCache = new Map<string, IndexedPageChunks | null>();

  return refs.map((ref) => {
    const requestedHash = ref.content_hash?.trim() || null;
    const requestedPage = ref.page_id?.trim() || null;
    type IdentityRow = { chunk_id: number; page_id: string; lang: string; content_hash: string };
    const idRow = byId.get(ref.chunk_id) as IdentityRow | undefined;
    const idMatches = Boolean(
      idRow
      && (!requestedHash || idRow.content_hash === requestedHash)
      && (!requestedPage || idRow.page_id === requestedPage),
    );
    let row = idMatches ? idRow : undefined;
    let match: ResolvedIndexedChunk['match'] = requestedHash ? 'id' : 'id_unverified';

    if (!row && requestedHash) {
      row = byHashAndPage.get(
        requestedHash,
        requestedPage,
        requestedPage,
        requestedPage,
      ) as IdentityRow | undefined;
      match = row ? 'content_hash' : 'missing';
    } else if (!row) {
      match = 'missing';
    }

    if (!row) {
      return {
        requested_chunk_id: ref.chunk_id,
        requested_content_hash: requestedHash,
        match,
        stale_id: false,
        page: null,
        parent: null,
        chunk: null,
      };
    }

    const cacheKey = `${row.lang}:${row.page_id}`;
    let pageData = pageCache.get(cacheKey);
    if (pageData === undefined) {
      pageData = inspectIndexedPage(db, row.page_id, row.lang, embeddingModel);
      pageCache.set(cacheKey, pageData);
    }
    const chunk = pageData?.chunks.find((item) => item.chunk_id === row!.chunk_id) ?? null;
    const parent = chunk?.parent_id === null || chunk?.parent_id === undefined
      ? null
      : pageData?.parents.find((item) => item.parent_id === chunk.parent_id) ?? null;
    return {
      requested_chunk_id: ref.chunk_id,
      requested_content_hash: requestedHash,
      match,
      stale_id: row.chunk_id !== ref.chunk_id,
      page: pageData?.page ?? null,
      parent,
      chunk,
    };
  });
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseIdentifiers(raw: string): Array<{ value: string; kind: string }> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      return typeof value.value === 'string' && typeof value.kind === 'string'
        ? [{ value: value.value, kind: value.kind }]
        : [];
    });
  } catch {
    return [];
  }
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
