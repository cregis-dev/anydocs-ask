/**
 * Per-page chunk upsert: writes chunks + chunks_vec for one (page_id, lang).
 *
 * Strategy:
 *   - Compute the new chunk set for the page.
 *   - Resolve embeddings via cache (most common path: 100% hits — see PRD §4.6).
 *   - In one transaction: delete the page's old chunks (cascade clears
 *     chunks_vec via we-do-it-manually since chunks_vec is a virtual table
 *     and has no FK), insert the new chunks, mirror into chunks_vec, let
 *     the FTS5 triggers handle chunks_fts.
 *
 * The §4.6 contract: when a page's text content is unchanged (only metadata
 * or navigation moved), every new chunk's content_hash matches an old chunk's
 * content_hash, so:
 *   - The cache returns hits for all of them. Embedder.calls increases by 0.
 *   - We still rewrite chunks rows (different chunk_id, but identical content)
 *     because tracking "did the content actually change" is the next layer's
 *     job (stage 5 incremental). For metadata-only edits, stage 5 will skip
 *     calling this function entirely.
 */

import type { DbHandle } from '../db/index.ts';
import type { Embedder } from '../embedding/types.ts';
import { getOrEmbed, type CacheStats } from '../embedding/cache.ts';
import type { ChunkInput } from './chunk.ts';

export type ChunkUpsertResult = {
  /** Number of chunks now stored for the page. */
  written: number;
  /** Cache hits/misses from the embed step (stage 5 surfaces this in logs). */
  cache: CacheStats;
};

export async function upsertChunksForPage(
  db: DbHandle,
  embedder: Embedder,
  pageId: string,
  lang: string,
  chunks: ChunkInput[],
): Promise<ChunkUpsertResult> {
  // 1. Resolve all vectors first (async / outside the SQLite transaction).
  const { vectors, stats } = await getOrEmbed(
    db,
    embedder,
    chunks.map((c) => ({ content_hash: c.content_hash, text: c.text })),
  );

  // 2. Single transaction for the chunks <-> chunks_vec swap.
  const deletePageChunkIds = db.prepare(
    `SELECT chunk_id FROM chunks WHERE page_id = ? AND lang = ?`,
  );
  const deleteChunks = db.prepare(`DELETE FROM chunks WHERE page_id = ? AND lang = ?`);
  const deleteVec = db.prepare(`DELETE FROM chunks_vec WHERE chunk_id = ?`);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (page_id, lang, in_page_path, text, content_hash, token_count, is_code, created_at)
    VALUES (@page_id, @lang, @in_page_path, @text, @content_hash, @token_count, @is_code, @created_at)
  `);
  const insertVec = db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)`);

  const tx = db.transaction(() => {
    // Drop existing chunks_vec rows for this page (vec0 is virtual; no cascade).
    const old = deletePageChunkIds.all(pageId, lang) as Array<{ chunk_id: number | bigint }>;
    for (const o of old) {
      deleteVec.run(typeof o.chunk_id === 'bigint' ? o.chunk_id : BigInt(o.chunk_id));
    }
    // Now drop chunks rows. FTS5 trigger fires on each delete to clean
    // chunks_fts.
    deleteChunks.run(pageId, lang);

    // Insert new chunks. lastInsertRowid is BigInt — feed straight into vec0.
    const now = Date.now();
    for (const c of chunks) {
      const info = insertChunk.run({
        page_id: c.page_id,
        lang: c.lang,
        in_page_path: c.in_page_path,
        text: c.text,
        content_hash: c.content_hash,
        token_count: c.token_count,
        is_code: c.is_code,
        created_at: now,
      });
      const newId =
        typeof info.lastInsertRowid === 'bigint'
          ? info.lastInsertRowid
          : BigInt(info.lastInsertRowid);
      const v = vectors.get(c.content_hash);
      if (!v) {
        throw new Error(
          `internal: vector missing for content_hash ${c.content_hash} after getOrEmbed`,
        );
      }
      insertVec.run(newId, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    }
  });
  tx();

  return { written: chunks.length, cache: stats };
}
