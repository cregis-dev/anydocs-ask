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

import { mkdirSync } from 'node:fs';
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

  private readonly hfModel: string;
  private readonly preferQuantized: boolean;
  private readonly cacheDir: string | undefined;
  private pipeline: FeatureExtractionPipeline | null = null;

  constructor(opts: Bgem3EmbedderOptions = {}) {
    this.hfModel = opts.model ?? 'Xenova/bge-m3';
    this.preferQuantized = opts.preferQuantized ?? false;
    this.cacheDir = opts.cacheDir;
    // The `model` field is what gets written to embedding_cache.model and is
    // the cache key downstream. fp32 and int8 produce different vectors, so
    // they MUST occupy different cache key spaces — flipping preferQuantized
    // after warm should not silently serve the other flavor's vectors.
    this.model = this.preferQuantized ? `${this.hfModel}:q8` : this.hfModel;
  }

  async warmUp(): Promise<void> {
    if (this.ready && this.pipeline) return;
    // Lazy-load to keep MockEmbedder users from paying the import cost.
    const tx = await import('@huggingface/transformers');
    const remoteHost = process.env.HF_ENDPOINT?.trim() || process.env.TRANSFORMERS_REMOTE_HOST?.trim();
    if (remoteHost) {
      tx.env.remoteHost = remoteHost.endsWith('/') ? remoteHost : `${remoteHost}/`;
    }
    if (this.cacheDir) {
      // mkdir before transformers.js touches it; getModelFile fails opaquely
      // if the parent dir doesn't exist on first run.
      mkdirSync(this.cacheDir, { recursive: true });
      tx.env.cacheDir = this.cacheDir;
    }
    // HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 set env.allowRemoteModels=false
    // in transformers.js v3.x, which causes an immediate "Unable to get model
    // file path or buffer" when the local cache is empty. We are an interactive
    // dev tool that must download on first run, so always allow remote access.
    tx.env.allowRemoteModels = true;

    const dtype = this.preferQuantized ? 'q8' : 'fp32';
    process.stderr.write(
      `[ask/embedding] loading ${this.hfModel} (dtype=${dtype}, cache=${this.cacheDir ?? 'default'}) — first run downloads ~${this.preferQuantized ? '300' : '600'} MB\n`,
    );
    try {
      this.pipeline = (await tx.pipeline('feature-extraction', this.hfModel, {
        dtype,
      })) as FeatureExtractionPipeline;
      // Run a single token through to ensure ONNX session is hot.
      await this.pipeline(' ', { pooling: 'mean', normalize: true });
    } catch (err) {
      throw new Error(
        `[ask/embedding] failed to load model "${this.hfModel}" (dtype=${dtype}, cache=${this.cacheDir ?? 'default'}).\n` +
          `  allowRemoteModels=${tx.env.allowRemoteModels} allowLocalModels=${tx.env.allowLocalModels}\n` +
          `  Cause: ${(err as Error).message}`,
        { cause: err },
      );
    }
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
