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
  is_code: number;
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
};

const DEFAULT_PER_PATH_K = 20;
const DEFAULT_FINAL_K = 20;
const RRF_K = 60;
/**
 * Vector path over-fetch multiplier — ARCH §6 needs at least PER_PATH_K hits
 * after the boundary filter. 4× covers reasonable scope_id selectivity.
 */
const VECTOR_OVERFETCH = 4;

export function retrieve(db: DbHandle, opts: RetrieveOptions): RetrievedChunk[] {
  const perPathK = opts.perPathK ?? DEFAULT_PER_PATH_K;
  const finalK = opts.finalK ?? DEFAULT_FINAL_K;

  const vectorIds = vectorPath(db, opts.queryVector, perPathK, opts.scopeId);
  const bm25Ids = opts.ftsQuery ? bm25Path(db, opts.ftsQuery, perPathK, opts.scopeId) : [];

  // RRF fusion. Each list provides a rank (1-based); chunks present in only
  // one list get the other's rank as Infinity, contributing 0.
  const rrfScores = new Map<number, number>();
  vectorIds.forEach((id, idx) => {
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + (idx + 1)));
  });
  bm25Ids.forEach((id, idx) => {
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + (idx + 1)));
  });

  const ranked = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, finalK);

  if (ranked.length === 0) return [];

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
  return out;
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

function fetchChunkRows(
  db: DbHandle,
  chunkIds: number[],
): Omit<RetrievedChunk, 'rrf_score'>[] {
  if (chunkIds.length === 0) return [];
  // Build a placeholder list because better-sqlite3 doesn't bind arrays.
  const placeholders = chunkIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.chunk_id, c.page_id, c.lang, c.in_page_path, c.text, c.is_code,
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
      is_code: number;
      page_title: string;
      page_url: string | null;
      subtree_root: string | null;
      nav_index: number | null;
      breadcrumb: string;
    }>;
  return rows.map((r) => ({
    ...r,
    breadcrumb: JSON.parse(r.breadcrumb) as BreadcrumbNode[],
  }));
}

// Re-export for callers that want to do the FTS sanitization themselves.
export { sanitizeFtsQuery };
