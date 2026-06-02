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
  /**
   * Individual concept terms extracted from a multi-entity query (e.g.
   * ["sessions", "checkpoints", "memory"] for "how do sessions, checkpoints,
   * and memory work?"). When present, a small per-term BM25 pass (top
   * ENTITY_K each) is injected into the RRF pool at ENTITY_INJECT_RANK so
   * each named concept has at least one representative in the candidate set,
   * even if the combined OR query demoted those chunks below perPathK.
   */
  entityTerms?: string[];
  /** Current page id from the client context. Used to keep page-local context in the candidate pool. */
  currentPageId?: string | null;
  /** Language to use when resolving currentPageId, usually the resolved query language. */
  currentPageLang?: DocsLang | null;
  /** API-intent questions get an extra API reference candidate pass. */
  apiIntent?: boolean;
  /** Additional sanitized FTS queries used only for API reference candidate injection. */
  apiReferenceFtsQueries?: string[];
  /** Additional sanitized FTS queries used to inject non-API supporting context. */
  supplementalFtsQueries?: string[];
  /** Page ids that should contribute supporting context for known domain tasks. */
  supplementalPageIds?: string[];
  /** Optional page_id prefix for API reference pages that belong to the active product area. */
  apiReferencePagePrefix?: string | null;
};

const DEFAULT_PER_PATH_K = 20;
const DEFAULT_FINAL_K = 20;
const RRF_K = 60;
/**
 * Vector path over-fetch multiplier — ARCH §6 needs at least PER_PATH_K hits
 * after the boundary filter. 4× covers reasonable scope_id selectivity.
 */
const VECTOR_OVERFETCH = 4;
/** Max BM25 hits per entity term for the per-entity injection pass. */
const ENTITY_K = 5;
/**
 * Synthetic rank assigned to entity-injected chunks that aren't in the main
 * path pool. Rank perPathK (20) gives them 1/(RRF_K+20) ≈ 0.0125, well below
 * a chunk appearing in both main paths at rank 1 (≈ 0.033), so they fill
 * coverage gaps without displacing strong hits.
 */
const ENTITY_INJECT_RANK = DEFAULT_PER_PATH_K;
/** Max chunks to inject from the exact current page. */
const CURRENT_PAGE_K = 3;
/**
 * Current-page context is a UI signal, not a retrieval path, so give it a
 * modest synthetic rank: strong enough to survive finalK trimming, weaker
 * than top vector/BM25 matches.
 */
const CURRENT_PAGE_INJECT_RANK = 8;
/** Max API reference chunks to inject for endpoint/field/status questions. */
const API_REFERENCE_K = 6;
/** API reference injection should survive trimming but not dominate top dual-path hits. */
const API_REFERENCE_INJECT_RANK = 6;
/** Max chunks to inject for domain-specific supporting context. */
const SUPPLEMENTAL_CONTEXT_K = 4;
/** Supporting context should survive finalK trimming but remain below exact API refs. */
const SUPPLEMENTAL_CONTEXT_INJECT_RANK = 10;

/**
 * Trace metadata from the retrieve step — exposed by retrieveWithTrace() for
 * runs jsonl persistence (ARCH §16.4). Per-path rank is 1-based; missing
 * means the chunk wasn't in that path's top-K (rank null in the run record).
 */
export type RetrievalTrace = {
  vecRanks: Map<number, number>;
  bm25Ranks: Map<number, number>;
  /** chunk_ids that entered the pool via the per-entity injection pass. */
  entityInjected: Set<number>;
  /** chunk_ids that entered the pool because they belong to context.current_page_id. */
  currentPageInjected: Set<number>;
  /** chunk_ids that entered the pool via the API-reference-only retrieval pass. */
  apiReferenceInjected: Set<number>;
  /** chunk_ids that entered the pool via supplemental supporting-context queries. */
  supplementalInjected: Set<number>;
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

  // RRF fusion. Each list provides a rank (1-based); chunks present in only
  // one list get the other's rank as Infinity, contributing 0.
  const rrfScores = new Map<number, number>();
  vectorIds.forEach((id, idx) => {
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + (idx + 1)));
  });
  bm25Ids.forEach((id, idx) => {
    rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + (idx + 1)));
  });

  // Per-entity injection: for each concept term, run a narrow BM25 pass and
  // either add new chunk_ids at ENTITY_INJECT_RANK score, or stack the
  // injection score on top of the existing RRF score so that chunks present
  // in the pool but ranked behind perPathK get pulled forward. This is the
  // codex-round-8 follow-up — without the additive path, a `checkpoints`
  // chunk that the combined OR query already retrieved (but ranked at #21+)
  // stayed below the prompt-context cap and the LLM never saw it.
  const entityInjected = new Set<number>();
  if (opts.entityTerms?.length) {
    const entityInjectScore = 1 / (RRF_K + ENTITY_INJECT_RANK);
    for (const term of opts.entityTerms) {
      const sanitized = sanitizeFtsQuery(term);
      if (!sanitized) continue;
      const entityIds = bm25Path(db, sanitized, ENTITY_K, opts.scopeId);
      for (const id of entityIds) {
        const cur = rrfScores.get(id);
        if (cur === undefined) {
          rrfScores.set(id, entityInjectScore);
          entityInjected.add(id);
        } else {
          rrfScores.set(id, cur + entityInjectScore);
        }
      }
    }
  }

  const supplementalInjected = new Set<number>();
  if (opts.supplementalFtsQueries?.length) {
    const supplementalScore = 1 / (RRF_K + SUPPLEMENTAL_CONTEXT_INJECT_RANK);
    for (const query of [...new Set(opts.supplementalFtsQueries)]) {
      const ids = bm25Path(db, query, SUPPLEMENTAL_CONTEXT_K, opts.scopeId);
      for (const id of ids) {
        supplementalInjected.add(id);
        const cur = rrfScores.get(id);
        if (cur === undefined) {
          rrfScores.set(id, supplementalScore);
        } else {
          rrfScores.set(id, cur + supplementalScore);
        }
      }
    }
  }
  if (opts.supplementalPageIds?.length && opts.currentPageLang) {
    const supplementalScore = 1 / (RRF_K + SUPPLEMENTAL_CONTEXT_INJECT_RANK);
    const pageQueries = [
      ...(opts.supplementalFtsQueries ?? []),
      ...(opts.apiReferenceFtsQueries ?? []),
      ...(opts.ftsQuery ? [opts.ftsQuery] : []),
    ];
    for (const pageId of [...new Set(opts.supplementalPageIds)]) {
      const ids = currentPagePath(
        db,
        pageId,
        opts.currentPageLang,
        2,
        opts.scopeId,
        pageQueries,
      );
      for (const id of ids) {
        supplementalInjected.add(id);
        const cur = rrfScores.get(id);
        if (cur === undefined) {
          rrfScores.set(id, supplementalScore);
        } else {
          rrfScores.set(id, cur + supplementalScore);
        }
      }
    }
  }

  const currentPageInjected = new Set<number>();
  if (opts.currentPageId && opts.currentPageLang) {
    const currentPageInjectScore = 1 / (RRF_K + CURRENT_PAGE_INJECT_RANK);
    const currentPageQueries = [
      ...(opts.apiReferenceFtsQueries ?? []),
      ...(opts.ftsQuery ? [opts.ftsQuery] : []),
    ];
    const currentPageIds = currentPagePath(
      db,
      opts.currentPageId,
      opts.currentPageLang,
      CURRENT_PAGE_K,
      opts.scopeId,
      currentPageQueries,
    );
    for (const id of currentPageIds) {
      currentPageInjected.add(id);
      const cur = rrfScores.get(id);
      if (cur === undefined) {
        rrfScores.set(id, currentPageInjectScore);
      } else {
        rrfScores.set(id, cur + currentPageInjectScore);
      }
    }
  }

  const apiReferenceInjected = new Set<number>();
  if (opts.apiIntent && opts.ftsQuery) {
    const apiReferenceInjectScore = 1 / (RRF_K + API_REFERENCE_INJECT_RANK);
    const queries = [...new Set(
      opts.apiReferenceFtsQueries?.length ? opts.apiReferenceFtsQueries : [opts.ftsQuery],
    )];
    for (const query of queries) {
      const apiReferenceIds = apiReferencePath(
        db,
        query,
        API_REFERENCE_K,
        opts.scopeId,
        opts.currentPageLang ?? null,
        opts.apiReferencePagePrefix ?? null,
      );
      for (const id of apiReferenceIds) {
        const cur = rrfScores.get(id);
        if (cur === undefined) {
          rrfScores.set(id, apiReferenceInjectScore);
          apiReferenceInjected.add(id);
        } else {
          rrfScores.set(id, cur + apiReferenceInjectScore);
        }
      }
    }
  }

  const protectedIds = new Set([...currentPageInjected, ...supplementalInjected]);
  const ranked = keepProtectedIds(
    [...rrfScores.entries()].sort((a, b) => b[1] - a[1]),
    finalK,
    protectedIds,
  );

  if (ranked.length === 0) {
    return {
      chunks: [],
      trace: { vecRanks, bm25Ranks, entityInjected, currentPageInjected, apiReferenceInjected, supplementalInjected },
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
    trace: { vecRanks, bm25Ranks, entityInjected, currentPageInjected, apiReferenceInjected, supplementalInjected },
  };
}

function keepProtectedIds(
  ranked: Array<[number, number]>,
  finalK: number,
  protectedIds: Set<number>,
): Array<[number, number]> {
  const top = ranked.slice(0, finalK);
  if (protectedIds.size === 0) return top;
  const seen = new Set(top.map(([id]) => id));
  for (const row of ranked) {
    const id = row[0];
    if (!protectedIds.has(id) || seen.has(id)) continue;
    top.push(row);
    seen.add(id);
  }
  return top;
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

function currentPagePath(
  db: DbHandle,
  pageId: string,
  lang: DocsLang,
  limit: number,
  scopeId: string | null,
  ftsQueries: string[],
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const ftsQuery of [...new Set(ftsQueries)]) {
    if (out.length >= limit) break;
    const rows = db
      .prepare(
        `SELECT f.rowid AS chunk_id
           FROM chunks_fts f
           JOIN chunks c ON c.chunk_id = f.rowid
           JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
          WHERE chunks_fts MATCH ?
            AND c.page_id = ?
            AND c.lang = ?
            AND p.status = 'published'
            AND (? IS NULL OR p.subtree_root = ?)
          ORDER BY rank
          LIMIT ?`,
      )
      .all(ftsQuery, pageId, lang, scopeId, scopeId, limit) as Array<{ chunk_id: number }>;
    for (const row of rows) {
      if (seen.has(row.chunk_id)) continue;
      out.push(row.chunk_id);
      seen.add(row.chunk_id);
      if (out.length >= limit) break;
    }
  }
  if (out.length >= limit) return out;
  const rows = db
    .prepare(
      `SELECT c.chunk_id
         FROM chunks c
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE c.page_id = ?
          AND c.lang = ?
          AND p.status = 'published'
          AND (? IS NULL OR p.subtree_root = ?)
        ORDER BY c.chunk_id ASC
        LIMIT ?`,
    )
    .all(pageId, lang, scopeId, scopeId, limit) as Array<{ chunk_id: number }>;
  for (const row of rows) {
    if (seen.has(row.chunk_id)) continue;
    out.push(row.chunk_id);
    if (out.length >= limit) break;
  }
  return out;
}

function apiReferencePath(
  db: DbHandle,
  ftsQuery: string,
  limit: number,
  scopeId: string | null,
  lang: DocsLang | null,
  pagePrefix: string | null,
): number[] {
  const likePrefix = pagePrefix ? `${pagePrefix}%` : null;
  const rows = db
    .prepare(
      `SELECT f.rowid AS chunk_id
         FROM chunks_fts f
         JOIN chunks c ON c.chunk_id = f.rowid
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE chunks_fts MATCH ?
          AND p.status = 'published'
          AND (? IS NULL OR p.lang = ?)
          AND (? IS NULL OR p.subtree_root = ?)
          AND (? IS NULL OR p.page_id LIKE ?)
          AND (
            p.page_id LIKE 'api-%'
            OR p.url LIKE '%/reference/%'
            OR c.text LIKE '%API reference:%'
          )
        ORDER BY rank
        LIMIT ?`,
    )
    .all(ftsQuery, lang, lang, scopeId, scopeId, likePrefix, likePrefix, limit) as Array<{ chunk_id: number }>;
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
