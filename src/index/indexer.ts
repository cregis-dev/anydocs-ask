/**
 * Index orchestrator — wires the structure layer and the content layer onto
 * a single project root.
 *
 * Two entry points:
 *   - fullReindex(): bootstrap on startup, or for /v1/index/rebuild. Walks
 *     everything from disk, blanks the structure layer via upsertPages, then
 *     re-chunks every live page. Embedding cache makes the second run free
 *     even for huge projects.
 *   - applyChanges(events): incremental path. Re-runs loadProject (cheap, in-
 *     memory JSON parse), refreshes the structure layer (cheap), and only
 *     re-chunks pages whose content_hash set in the DB diverged from the new
 *     chunk set. Pure metadata edits and navigation reorders short-circuit
 *     here with zero chunk writes — that's the §4.6 contract at the index
 *     layer (the content layer has its own §4.6 test on the cache itself).
 *
 * Branch strategy is the "B / 3-branch naive" form (chosen 2026-05-07):
 *   - navigation/* events: refresh pages table only, no chunk path entered
 *   - pages/<lang>/X.json events: candidate (lang, page_id) marked, then a
 *     single hash-set comparison decides whether to actually write chunks
 *
 * ARCH §7.2 is the canonical reference for the 5-branch optimization. We
 * intentionally postpone the field-level diff until measurements show it
 * matters; the §4.6 hard contract holds either way.
 */

import { resolve } from 'node:path';
import { loadProject, type LoadedProject } from '../anydocs/loader.ts';
import { projectStructure } from '../structure/project.ts';
import { upsertPages } from '../structure/upsert.ts';
import { chunkPage, type ChunkInput } from '../content/chunk.ts';
import { upsertChunksForPage } from '../content/upsert.ts';
import { classifyPath } from './paths.ts';
import type { DbHandle } from '../db/index.ts';
import type { Embedder } from '../embedding/types.ts';
import type { DocsLang, PageDoc } from '../anydocs/types.ts';

export type IndexEvent = {
  /** chokidar action; we only act on add | change | unlink. */
  action: 'add' | 'change' | 'unlink';
  /** Absolute path of the file that triggered the event. */
  absPath: string;
};

export type FullReindexStats = {
  pages: { inserted: number; updated: number; deleted: number };
  chunks: { writtenPages: number; skippedPages: number; totalChunks: number };
  embed: { hits: number; misses: number };
  warnings: string[];
};

export type ApplyChangesStats = {
  pages: { inserted: number; updated: number; deleted: number };
  chunks: { writtenPages: number; skippedPages: number; totalChunks: number };
  embed: { hits: number; misses: number };
  /** Whether the change set was nav-only (chunks path skipped entirely). */
  navOnly: boolean;
  warnings: string[];
};

export type IndexerOptions = {
  db: DbHandle;
  embedder: Embedder;
  projectRoot: string;
};

export class Indexer {
  private readonly db: DbHandle;
  private readonly embedder: Embedder;
  private readonly projectRoot: string;

  constructor(opts: IndexerOptions) {
    this.db = opts.db;
    this.embedder = opts.embedder;
    this.projectRoot = resolve(opts.projectRoot);
  }

  /**
   * Full bootstrap: load → project → upsertPages → chunk every live page.
   *
   * Clears all existing chunks before rebuilding so the result is always a
   * clean slate — no stale rows survive a chunk-algorithm change or a model
   * swap. The embedding cache is left intact so hashes that haven't changed
   * still get zero embed calls.
   */
  async fullReindex(): Promise<FullReindexStats> {
    const project = await loadProject(this.projectRoot);
    const structOut = projectStructure(project);
    const pagesResult = upsertPages(this.db, structOut.rows);

    // Wipe all chunks before rebuilding. chunks_fts is cleaned by its DELETE
    // triggers; chunks_vec has no FK so we clear it explicitly first.
    this.clearAllChunks();

    const livePageKeys = new Set(structOut.rows.map((r) => keyOf(r.page_id, r.lang)));
    let writtenPages = 0;
    let skippedPages = 0;
    let totalChunks = 0;
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const key of livePageKeys) {
      const [pageId, lang] = splitKey(key);
      const pageDoc = pickPage(project, lang as DocsLang, pageId);
      if (!pageDoc) continue;
      const chunks = chunkPage(pageDoc);
      // decideChunkWrite will always return 'write' after clearAllChunks, but
      // we keep the call so applyChanges (which doesn't clear) stays on the
      // same code path without a flag.
      const decision = this.decideChunkWrite(pageId, lang, chunks);
      if (decision === 'skip') {
        skippedPages++;
        continue;
      }
      const result = await upsertChunksForPage(this.db, this.embedder, pageId, lang, chunks);
      writtenPages++;
      totalChunks += result.written;
      cacheHits += result.cache.hits;
      cacheMisses += result.cache.misses;
    }

    return {
      pages: pagesResult,
      chunks: { writtenPages, skippedPages, totalChunks },
      embed: { hits: cacheHits, misses: cacheMisses },
      warnings: [...project.warnings, ...structOut.warnings],
    };
  }

  /**
   * Incremental update for a debounce-coalesced change set.
   *
   * Strategy:
   *   1. Always refresh the structure layer (full reload + upsertPages). This
   *      handles nav reorders, page additions, page deletions, and metadata
   *      edits in one pass without any branch logic.
   *   2. Walk only the pages whose path appeared in `events` (post-classify).
   *      For each, compare new chunks' content_hash set vs the DB's set:
   *        - identical → no chunk writes (the §4.6 metadata-edit case)
   *        - different → upsertChunksForPage (cache absorbs unchanged hashes)
   *   3. If the event set was nav-only, step 2 is skipped entirely.
   */
  async applyChanges(events: IndexEvent[]): Promise<ApplyChangesStats> {
    const project = await loadProject(this.projectRoot);
    const structOut = projectStructure(project);
    const pagesResult = upsertPages(this.db, structOut.rows);

    // Classify events. Nav events don't enter the chunk pipeline at all.
    const candidatePages = new Map<string, { lang: DocsLang }>(); // key = page_id|lang derived after reload
    let hasPageEvents = false;
    let hasNavEvents = false;

    for (const evt of events) {
      const cls = classifyPath(evt.absPath, this.projectRoot);
      if (cls.kind === 'navigation') {
        hasNavEvents = true;
        continue;
      }
      if (cls.kind === 'page') {
        hasPageEvents = true;
        // We don't know page_id from the path alone — record the lang and let
        // the post-reload reconciliation walk all live pages of that lang to
        // find ones whose content_hash set diverged. That's coarser than
        // path → page_id but trivially correct under add/move/rename.
        candidatePages.set(`__lang__:${cls.lang}`, { lang: cls.lang });
      }
    }

    const navOnly = hasNavEvents && !hasPageEvents;

    let writtenPages = 0;
    let skippedPages = 0;
    let totalChunks = 0;
    let cacheHits = 0;
    let cacheMisses = 0;

    if (!navOnly) {
      // Walk the live pages of every lang that had a page event. This is O(N)
      // in pages-of-affected-langs; per-page hash-set compare is one short
      // SELECT. A future optimization could thread path → page_id mapping to
      // narrow this further, but for v1 project sizes it's already negligible.
      const affectedLangs = new Set(
        [...candidatePages.values()].map((c) => c.lang),
      );
      for (const row of structOut.rows) {
        if (!affectedLangs.has(row.lang as DocsLang)) continue;
        const pageDoc = pickPage(project, row.lang as DocsLang, row.page_id);
        if (!pageDoc) continue;
        const chunks = chunkPage(pageDoc);
        const decision = this.decideChunkWrite(row.page_id, row.lang, chunks);
        if (decision === 'skip') {
          skippedPages++;
          continue;
        }
        const result = await upsertChunksForPage(
          this.db,
          this.embedder,
          row.page_id,
          row.lang,
          chunks,
        );
        writtenPages++;
        totalChunks += result.written;
        cacheHits += result.cache.hits;
        cacheMisses += result.cache.misses;
      }
    }

    return {
      pages: pagesResult,
      chunks: { writtenPages, skippedPages, totalChunks },
      embed: { hits: cacheHits, misses: cacheMisses },
      navOnly,
      warnings: [...project.warnings, ...structOut.warnings],
    };
  }

  /**
   * Drop every chunk row (and its chunks_vec mirror). Called at the top of
   * fullReindex to guarantee a clean slate before rebuilding.
   *
   * chunks_fts is handled by the DELETE triggers on the chunks table, so we
   * only need to clear chunks_vec manually (it has no FK / trigger wiring).
   */
  private clearAllChunks(): void {
    this.db.transaction(() => {
      // Must clear chunks_vec before chunks because we need the chunk_id list.
      const ids = this.db
        .prepare('SELECT chunk_id FROM chunks')
        .all() as Array<{ chunk_id: number | bigint }>;
      const deleteVec = this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?');
      for (const { chunk_id } of ids) {
        deleteVec.run(typeof chunk_id === 'bigint' ? chunk_id : BigInt(chunk_id));
      }
      this.db.prepare('DELETE FROM chunks').run();
    })();
  }

  /**
   * Returns 'skip' when the new chunk set is byte-identical (by content_hash
   * sequence + in_page_path) to what's in DB for (page_id, lang). The
   * sequence — not just the set — must match, because in_page_path encodes
   * structural position; if a heading was renamed its anchor changes even
   * when the chunk text is identical, and we want that to flow through.
   */
  private decideChunkWrite(
    pageId: string,
    lang: string,
    newChunks: ChunkInput[],
  ): 'write' | 'skip' {
    const existing = this.db
      .prepare(
        `SELECT content_hash, in_page_path FROM chunks
         WHERE page_id = ? AND lang = ?
         ORDER BY chunk_id`,
      )
      .all(pageId, lang) as Array<{ content_hash: string; in_page_path: string }>;
    if (existing.length !== newChunks.length) return 'write';
    for (let i = 0; i < existing.length; i++) {
      if (existing[i]!.content_hash !== newChunks[i]!.content_hash) return 'write';
      if (existing[i]!.in_page_path !== newChunks[i]!.in_page_path) return 'write';
    }
    return 'skip';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyOf(pageId: string, lang: string): string {
  return `${pageId}\x00${lang}`;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('\x00');
  return [key.slice(0, i), key.slice(i + 1)];
}

function pickPage(project: LoadedProject, lang: DocsLang, pageId: string): PageDoc | undefined {
  return project.pagesByLangAndId.get(lang)?.get(pageId);
}
