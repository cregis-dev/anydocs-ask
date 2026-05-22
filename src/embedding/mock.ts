/**
 * Deterministic mock embedder for tests and the cache-hit gate that the §4.6
 * "drag-zero-reembed" guarantee depends on.
 *
 * Properties:
 *   - Same input string always yields the same vector (within a process).
 *   - `calls` counter exposed so tests can assert "no embed calls happened
 *     after a metadata-only edit" (the cornerstone of §4.6 verification).
 *   - Vector layout is sparse-ish but non-trivial: we hash 8-char windows
 *     into the vector dim, so unrelated strings rarely collide.
 *   - No I/O, no async work — `await` is just for interface compatibility.
 */

import { createHash } from 'node:crypto';
import type { Embedder, EmbedResult } from './types.ts';

export type MockEmbedderOptions = {
  model?: string;
  dim?: number;
};

export class MockEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  ready = false;
  calls = 0;
  textsEmbedded = 0;
  /**
   * The exact texts passed to the most recent `embed()` call. Tests use
   * this to verify upstream pipeline behaviour (e.g. RFC 0003 M1 splices
   * session history into the embedding input — tests check the joined
   * string here without inspecting the resulting vector). Reset on each
   * call; only the latest invocation's texts survive.
   */
  lastEmbeddedTexts: string[] = [];
  /**
   * Flat list of every text passed to embed() since construction, across
   * all calls. RFC 0003 alpha.1 — the pipeline now runs TWO embeds per ask
   * when history is in play (raw current_q for γ similarity + history-
   * augmented for retrieve). Tests assert both inputs appear here.
   */
  allEmbeddedTexts: string[] = [];

  constructor(opts: MockEmbedderOptions = {}) {
    this.model = opts.model ?? 'mock-embedder';
    this.dim = opts.dim ?? 1024;
  }

  async warmUp(): Promise<void> {
    this.ready = true;
  }

  async embed(texts: string[]): Promise<EmbedResult[]> {
    if (!this.ready) await this.warmUp();
    this.calls += 1;
    this.textsEmbedded += texts.length;
    this.lastEmbeddedTexts = [...texts];
    this.allEmbeddedTexts.push(...texts);
    return texts.map((text) => ({ vector: vectorFor(text, this.dim) }));
  }
}

function vectorFor(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  if (text.length === 0) return v;

  // Hash overlapping 8-char windows; each hash bucket adds 1.0 to its
  // dim-mod slot. Then L2-normalize so the cosine space behaves.
  const windowSize = Math.min(8, text.length);
  for (let i = 0; i + windowSize <= text.length; i++) {
    const window = text.slice(i, i + windowSize);
    const h = createHash('sha1').update(window).digest();
    const slot = (h.readUInt32BE(0) % dim);
    v[slot] = (v[slot] ?? 0) + 1;
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (v[i] ?? 0) ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}
