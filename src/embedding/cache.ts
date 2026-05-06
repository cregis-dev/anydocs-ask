/**
 * embedding_cache lookups and writes.
 *
 * The whole point of PRD §4.6 ("drag = zero re-embed") rests on this layer:
 *   1. Each chunk's `content_hash` is the cache key (model is the second
 *      half of the composite PK).
 *   2. A cache HIT means we never call `Embedder.embed` for that chunk.
 *   3. A cache MISS goes to the embedder, then writes back here so the
 *      next reindex of the same text is free.
 *
 * Stage 5's index pipeline calls `getOrEmbed` to convert a list of (hash,
 * text) requests into a list of vectors, with cache stats for observability.
 */

import type { DbHandle } from '../db/index.ts';
import type { Embedder } from './types.ts';

export type CacheStats = {
  /** Cache hits — embedder was NOT called for these. */
  hits: number;
  /** Cache misses — these were embedded and written back. */
  misses: number;
};

type Request = { content_hash: string; text: string };

export async function getOrEmbed(
  db: DbHandle,
  embedder: Embedder,
  requests: Request[],
): Promise<{ vectors: Map<string, Float32Array>; stats: CacheStats }> {
  const vectors = new Map<string, Float32Array>();
  const stats: CacheStats = { hits: 0, misses: 0 };

  if (requests.length === 0) return { vectors, stats };

  // Dedupe inside the call: identical content_hashes share the same vector.
  const uniqueByHash = new Map<string, string>();
  for (const r of requests) {
    if (!uniqueByHash.has(r.content_hash)) {
      uniqueByHash.set(r.content_hash, r.text);
    }
  }

  // Lookup phase: which hashes are already in the cache?
  const lookup = db.prepare(
    `SELECT content_hash, embedding FROM embedding_cache WHERE content_hash = ? AND model = ?`,
  );
  const missing: Request[] = [];
  for (const [hash, text] of uniqueByHash) {
    const row = lookup.get(hash, embedder.model) as
      | { content_hash: string; embedding: Buffer }
      | undefined;
    if (row) {
      vectors.set(hash, bufferToFloat32(row.embedding, embedder.dim));
      stats.hits += 1;
    } else {
      missing.push({ content_hash: hash, text });
    }
  }

  // Embed phase: only the missing slice goes to the model.
  if (missing.length > 0) {
    const results = await embedder.embed(missing.map((m) => m.text));
    if (results.length !== missing.length) {
      throw new Error(
        `embedder returned ${results.length} vectors for ${missing.length} inputs`,
      );
    }

    const insert = db.prepare(
      `INSERT OR REPLACE INTO embedding_cache (content_hash, model, embedding, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const now = Date.now();
    const writeAll = db.transaction(() => {
      for (let i = 0; i < missing.length; i++) {
        const m = missing[i]!;
        const v = results[i]!.vector;
        if (v.length !== embedder.dim) {
          throw new Error(
            `embedder ${embedder.model} returned vector of dim ${v.length}, expected ${embedder.dim}`,
          );
        }
        const buf = float32ToBuffer(v);
        insert.run(m.content_hash, embedder.model, buf, now);
        vectors.set(m.content_hash, v);
      }
    });
    writeAll();
    stats.misses += missing.length;
  }

  return { vectors, stats };
}

// ---------------------------------------------------------------------------
// (de)serialization — fp32 little-endian; compatible with sqlite-vec BLOB form
// ---------------------------------------------------------------------------

function float32ToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bufferToFloat32(buf: Buffer, expectedDim: number): Float32Array {
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (arr.length !== expectedDim) {
    throw new Error(
      `cached embedding has dim ${arr.length}, expected ${expectedDim} — model mismatch?`,
    );
  }
  // Copy out so callers can hold the value past buffer GC.
  return new Float32Array(arr);
}
