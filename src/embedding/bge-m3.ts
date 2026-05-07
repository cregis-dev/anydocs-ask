/**
 * Real bge-m3 embedder via @huggingface/transformers (ONNX runtime, in-process).
 *
 * Default config:
 *   - model: 'Xenova/bge-m3' (community-maintained ONNX export of BAAI/bge-m3)
 *   - dim: 1024 (matches chunks_vec FLOAT[1024])
 *   - normalize=true so cosine retrieval is just dot product
 *   - quantized=false by default (fp32 ~600MB); flip via PreferQuantized for
 *     int8 ~300MB (PRD §6.4 / ARCH §8 `embedding.preferQuantized`)
 *
 * First call to warmUp() downloads the model into ~/.cache/huggingface and
 * may take 10-30s on a fresh machine. PRD §6.1 excludes warm-up from the
 * P50/P95 numbers; the server returns 503 on /v1/health until ready.
 *
 * Tests do NOT exercise this path by default — they use MockEmbedder. The
 * stage-5 e2e test triggers a single warm-up if env ANYDOCS_ASK_TEST_REAL_EMBED=1.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import type { Embedder, EmbedResult } from './types.ts';

export type Bgem3EmbedderOptions = {
  model?: string;
  preferQuantized?: boolean;
  /** Cache directory passed to transformers.js. Defaults to its own pick. */
  cacheDir?: string;
};

export class Bgem3Embedder implements Embedder {
  readonly model: string;
  readonly dim = 1024;
  ready = false;

  private readonly preferQuantized: boolean;
  private readonly cacheDir: string | undefined;
  private pipeline: FeatureExtractionPipeline | null = null;

  constructor(opts: Bgem3EmbedderOptions = {}) {
    this.model = opts.model ?? 'Xenova/bge-m3';
    this.preferQuantized = opts.preferQuantized ?? false;
    this.cacheDir = opts.cacheDir;
  }

  async warmUp(): Promise<void> {
    if (this.ready && this.pipeline) return;
    // Lazy-load to keep MockEmbedder users from paying the import cost.
    const tx = await import('@huggingface/transformers');
    if (this.cacheDir) tx.env.cacheDir = this.cacheDir;
    this.pipeline = (await tx.pipeline('feature-extraction', this.model, {
      dtype: this.preferQuantized ? 'q8' : 'fp32',
    })) as FeatureExtractionPipeline;
    // Run a single token through to ensure ONNX session is hot.
    await this.pipeline(' ', { pooling: 'mean', normalize: true });
    this.ready = true;
  }

  async embed(texts: string[]): Promise<EmbedResult[]> {
    if (!this.ready || !this.pipeline) await this.warmUp();
    if (!this.pipeline) throw new Error('Bgem3Embedder: pipeline not initialized');

    const outputs = await this.pipeline(texts, { pooling: 'mean', normalize: true });

    // The pipeline returns a Tensor of shape [batch, dim]. Slice into per-text
    // Float32Array views.
    const data = outputs.data as Float32Array;
    const results: EmbedResult[] = [];
    for (let i = 0; i < texts.length; i++) {
      const start = i * this.dim;
      const slice = data.slice(start, start + this.dim);
      results.push({ vector: slice });
    }
    return results;
  }

  async dispose(): Promise<void> {
    if (!this.pipeline) return;
    // transformers.js exposes pipeline.dispose() that releases the ONNX
    // session + worker. Without this, node exits with the ONNX session still
    // alive and the C runtime aborts during worker thread teardown
    // (`libc++abi: mutex lock failed`). Order matters in runtime.stop():
    // dispose the embedder BEFORE closing the SQLite handle.
    await this.pipeline.dispose();
    this.pipeline = null;
    this.ready = false;
  }
}
