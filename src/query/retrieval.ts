/**
 * Hybrid retrieval — vector (sqlite-vec) + BM25 (FTS5) + RRF fusion.
 *
 * ARCH §6 step 3 says K = 20 from each path, then RRF (k=60) fuses to a
 * top-20. We over-fetch on the vector path (K_PRE = 80) to give the boundary
 * filter (status = 'published' + optional scope_id) headroom: vec0 doesn't
 * accept SQL predicates inside its MATCH, so we filter post-hoc on the JOIN.
 * Without over-fetch a tightly-scoped query could see vec results all
 * filtered away.
 *
 * Each path returns RetrievedChunk rows fully joined to the pages table —
 * downstream rerank/aggregate need lang / subtree_root / nav_index / url /
 * breadcrumb without re-querying.
 */

import type { DbHandle } from '../db/index.ts';
import type { DocsLang } from '../anydocs/types.ts';
import type { BreadcrumbNode } from '../db/schema.ts';
import { sanitizeFtsQuery } from './sanitize.ts';

export type RetrievedChunk = {
  chunk_id: number;
  page_id: string;
  lang: DocsLang;
  in_page_path: string;
  text: string;
  /** Stable across full reindexes; numeric chunk_id is not. */
  content_hash?: string;
  token_count?: number;
  is_code: number;
  parent_id: number | null;
  chunk_kind: string;
  object_path: string | null;
  /** Exact technical identifiers indexed for this chunk. */
  identifiers: string[];
  page_title: string;
  page_url: string | null;
  subtree_root: string | null;
  nav_index: number | null;
  breadcrumb: BreadcrumbNode[];
  /** RRF-fused score (set by retrieve()). */
  rrf_score: number;
};

export type RetrieveOptions = {
  /** L2-normalized query vector for sqlite-vec MATCH. */
  queryVector: Float32Array;
  /** Pre-tokenized question for FTS5 (sanitizeFtsQuery output, or null to skip BM25). */
  ftsQuery: string | null;
  /** Optional boundary: only chunks belonging to pages with this subtree_root. */
  scopeId: string | null;
  /** Per-path top-K before RRF. ARCH §6: 20. */
  perPathK?: number;
  /** Final top-K after RRF. */
  finalK?: number;
  /** RRF rank constant. Larger values make rank differences less steep. */
  rrfK?: number;
  /** Language used to prefer exact identifier matches in the active language. */
  currentPageLang?: DocsLang | null;
  /** Optional product prefix used to disambiguate generic exact identifiers. */
  apiReferencePagePrefix?: string | null;
  /** Opaque addresses, hashes, API paths, or error codes matched literally. */
  exactIdentifiers?: string[];
};

const DEFAULT_PER_PATH_K = 20;
const DEFAULT_FINAL_K = 20;
const DEFAULT_RRF_K = 60;
/**
 * Vector path over-fetch multiplier — ARCH §6 needs at least PER_PATH_K hits
 * after the boundary filter. 4× covers reasonable scope_id selectivity.
 */
const VECTOR_OVERFETCH = 4;
/**
 * Trace metadata from the retrieve step — exposed by retrieveWithTrace() for
 * runs jsonl persistence (ARCH §16.4). Per-path rank is 1-based; missing
 * means the chunk wasn't in that path's top-K (rank null in the run record).
 */
export type RetrievalTrace = {
  vecRanks: Map<number, number>;
  bm25Ranks: Map<number, number>;
  exactRanks: Map<number, number>;
};

export function retrieve(db: DbHandle, opts: RetrieveOptions): RetrievedChunk[] {
  return retrieveWithTrace(db, opts).chunks;
}

export function retrieveWithTrace(
  db: DbHandle,
  opts: RetrieveOptions,
): { chunks: RetrievedChunk[]; trace: RetrievalTrace } {
  const perPathK = opts.perPathK ?? DEFAULT_PER_PATH_K;
  const finalK = opts.finalK ?? DEFAULT_FINAL_K;
  const rrfK = opts.rrfK ?? DEFAULT_RRF_K;

  const vectorIds = vectorPath(db, opts.queryVector, perPathK, opts.scopeId);
  const bm25Ids = opts.ftsQuery ? bm25Path(db, opts.ftsQuery, perPathK, opts.scopeId) : [];

  const vecRanks = new Map<number, number>();
  vectorIds.forEach((id, idx) => {
    if (!vecRanks.has(id)) vecRanks.set(id, idx + 1);
  });
  const bm25Ranks = new Map<number, number>();
  bm25Ids.forEach((id, idx) => {
    if (!bm25Ranks.has(id)) bm25Ranks.set(id, idx + 1);
  });

  const exactIds: number[] = [];
  const seenExactIds = new Set<number>();
  for (const identifier of opts.exactIdentifiers ?? []) {
    const ids = exactIdentifierPath(
      db,
      identifier,
      perPathK,
      opts.scopeId,
      opts.currentPageLang ?? null,
      opts.apiReferencePagePrefix ?? null,
    );
    for (const id of ids) {
      if (seenExactIds.has(id)) continue;
      exactIds.push(id);
      seenExactIds.add(id);
      if (exactIds.length >= perPathK) break;
    }
    if (exactIds.length >= perPathK) break;
  }
  const exactRanks = new Map<number, number>();
  exactIds.forEach((id, idx) => exactRanks.set(id, idx + 1));

  // Vector, BM25, and exact identifier matching are equal, explainable
  // ranked paths. No synthetic boosts or protected slots are applied after
  // fusion: overlap and source rank alone determine the result.
  const rrfScores = new Map<number, number>();
  for (const ids of [vectorIds, bm25Ids, exactIds]) {
    ids.forEach((id, idx) => {
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (rrfK + idx + 1));
    });
  }
  const ranked = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, finalK);

  if (ranked.length === 0) {
    return {
      chunks: [],
      trace: { vecRanks, bm25Ranks, exactRanks },
    };
  }

  const idList = ranked.map(([id]) => id);
  const rows = fetchChunkRows(db, idList);
  // Stitch RRF score and preserve the ranked order.
  const byId = new Map(rows.map((r) => [r.chunk_id, r] as const));
  const out: RetrievedChunk[] = [];
  for (const [id, score] of ranked) {
    const r = byId.get(id);
    if (!r) continue; // boundary check kicked it; shouldn't happen since we already filtered
    out.push({ ...r, rrf_score: score });
  }
  return {
    chunks: out,
    trace: { vecRanks, bm25Ranks, exactRanks },
  };
}

// ---------------------------------------------------------------------------
// Vector / BM25 path helpers
// ---------------------------------------------------------------------------

function vectorPath(
  db: DbHandle,
  queryVector: Float32Array,
  perPathK: number,
  scopeId: string | null,
): number[] {
  const overfetch = perPathK * VECTOR_OVERFETCH;
  // sqlite-vec wants the embedding as a JSON array string OR a Buffer in fp32
  // little-endian; we use the Buffer route to match how we wrote the index.
  // vec0 doesn't allow `k = ?` and `LIMIT` together — we use `k = ?` so the
  // vec engine itself does the over-fetch, then we trim post-filter.
  const queryBlob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
  const rows = db
    .prepare(
      `SELECT v.chunk_id AS chunk_id, v.distance AS distance
         FROM chunks_vec v
         JOIN chunks c ON c.chunk_id = v.chunk_id
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE v.embedding MATCH ? AND v.k = ?
          AND p.status = 'published'
          AND (? IS NULL OR p.subtree_root = ?)
        ORDER BY v.distance ASC`,
    )
    .all(queryBlob, overfetch, scopeId, scopeId) as Array<{
      chunk_id: number;
      distance: number;
    }>;
  return rows.slice(0, perPathK).map((r) => r.chunk_id);
}

function bm25Path(
  db: DbHandle,
  ftsQuery: string,
  perPathK: number,
  scopeId: string | null,
): number[] {
  // bm25() returns lower = better; ORDER BY rank picks up FTS5's default
  // ranking. We JOIN through chunks → pages to apply the boundary filter.
  const rows = db
    .prepare(
      `SELECT f.rowid AS chunk_id
         FROM chunks_fts f
         JOIN chunks c ON c.chunk_id = f.rowid
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE chunks_fts MATCH ?
          AND p.status = 'published'
          AND (? IS NULL OR p.subtree_root = ?)
        ORDER BY rank
        LIMIT ?`,
    )
    .all(ftsQuery, scopeId, scopeId, perPathK) as Array<{ chunk_id: number }>;
  return rows.map((r) => r.chunk_id);
}

function exactIdentifierPath(
  db: DbHandle,
  identifier: string,
  limit: number,
  scopeId: string | null,
  lang: DocsLang | null,
  apiReferencePagePrefix: string | null,
): number[] {
  const normalized = identifier.toLowerCase();
  const queryIndex = (requestedLang: DocsLang | null, pagePrefix: string | null) => db
    .prepare(
      `SELECT ci.chunk_id
         FROM chunk_identifiers ci
         JOIN chunks c ON c.chunk_id = ci.chunk_id
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE ci.normalized = ?
          AND p.status = 'published'
          AND (? IS NULL OR p.subtree_root = ?)
          AND (? IS NULL OR p.lang = ?)
          AND (? IS NULL OR p.page_id LIKE ?)
        ORDER BY p.nav_index ASC, c.chunk_id ASC
        LIMIT ?`,
    )
    .all(
      normalized,
      scopeId,
      scopeId,
      requestedLang,
      requestedLang,
      pagePrefix,
      pagePrefix ? `${pagePrefix}%` : null,
      limit,
    ) as Array<{ chunk_id: number }>;

  // Generic field/header/operation names occur across many APIs. When intent
  // routing identified a product area, prefer exact matches inside that API
  // reference subtree and only fall back globally when the scoped index has no
  // match. Opaque values such as addresses, hashes, and error codes remain
  // global because their literal value is already discriminative.
  const preferredPrefix = isScopeSensitiveIdentifier(identifier)
    ? apiReferencePagePrefix
    : null;
  if (preferredPrefix) {
    const scoped = queryIndex(lang, preferredPrefix);
    if (scoped.length > 0) return scoped.map((row) => row.chunk_id);
    if (lang !== null) {
      const scopedFallback = queryIndex(null, preferredPrefix);
      if (scopedFallback.length > 0) return scopedFallback.map((row) => row.chunk_id);
    }
  }

  const indexed = queryIndex(lang, null);
  if (indexed.length > 0) return indexed.map((row) => row.chunk_id);
  if (lang !== null) {
    const fallback = queryIndex(null, null);
    if (fallback.length > 0) return fallback.map((row) => row.chunk_id);
  }

  // Compatibility fallback for databases that have migrated but have not
  // yet been reindexed.
  const queryText = (requestedLang: DocsLang | null, pagePrefix: string | null) => db
    .prepare(
      `SELECT c.chunk_id
         FROM chunks c
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE instr(lower(c.text), lower(?)) > 0
          AND p.status = 'published'
          AND (? IS NULL OR p.subtree_root = ?)
          AND (? IS NULL OR p.lang = ?)
          AND (? IS NULL OR p.page_id LIKE ?)
        ORDER BY p.nav_index ASC, c.chunk_id ASC
        LIMIT ?`,
    )
    .all(
      identifier,
      scopeId,
      scopeId,
      requestedLang,
      requestedLang,
      pagePrefix,
      pagePrefix ? `${pagePrefix}%` : null,
      limit,
    ) as Array<{ chunk_id: number }>;
  if (preferredPrefix) {
    const scopedRows = queryText(lang, preferredPrefix);
    if (scopedRows.length > 0) return scopedRows.map((row) => row.chunk_id);
    if (lang !== null) {
      const scopedFallback = queryText(null, preferredPrefix);
      if (scopedFallback.length > 0) return scopedFallback.map((row) => row.chunk_id);
    }
  }
  const rows = queryText(lang, null);
  if (rows.length === 0 && lang !== null) return queryText(null, null).map((row) => row.chunk_id);
  return rows.map((row) => row.chunk_id);
}

function isScopeSensitiveIdentifier(identifier: string): boolean {
  return (
    /^Access-(?:Key|Timestamp|Nonce|Signature)$/i.test(identifier) ||
    /^[a-z][a-z0-9]{2,}$/.test(identifier) ||
    /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?:\[\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)*$/.test(identifier) ||
    /^(?:data|request|response)(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\])?)+$/i.test(identifier) ||
    /^[a-z]+(?:[A-Z][A-Za-z0-9]+){2,}$/.test(identifier)
  );
}

function fetchChunkRows(
  db: DbHandle,
  chunkIds: number[],
): Omit<RetrievedChunk, 'rrf_score'>[] {
  if (chunkIds.length === 0) return [];
  // Build a placeholder list because better-sqlite3 doesn't bind arrays.
  const placeholders = chunkIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.chunk_id, c.page_id, c.lang, c.in_page_path, c.text,
              c.content_hash, c.token_count, c.is_code,
              c.parent_id, c.chunk_kind, c.object_path,
              COALESCE((
                SELECT json_group_array(ci.identifier)
                  FROM chunk_identifiers ci
                 WHERE ci.chunk_id = c.chunk_id
              ), '[]') AS identifiers_json,
              p.title AS page_title, p.url AS page_url, p.subtree_root,
              p.nav_index, p.breadcrumb
         FROM chunks c
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE c.chunk_id IN (${placeholders})`,
    )
    .all(...chunkIds) as Array<{
      chunk_id: number;
      page_id: string;
      lang: DocsLang;
      in_page_path: string;
      text: string;
      content_hash: string;
      token_count: number;
      is_code: number;
      parent_id: number | null;
      chunk_kind: string;
      object_path: string | null;
      identifiers_json: string;
      page_title: string;
      page_url: string | null;
      subtree_root: string | null;
      nav_index: number | null;
      breadcrumb: string;
    }>;
  return rows.map(({ identifiers_json, ...r }) => ({
    ...r,
    identifiers: JSON.parse(identifiers_json) as string[],
    breadcrumb: JSON.parse(r.breadcrumb) as BreadcrumbNode[],
  }));
}

// Re-export for callers that want to do the FTS sanitization themselves.
export { sanitizeFtsQuery };
