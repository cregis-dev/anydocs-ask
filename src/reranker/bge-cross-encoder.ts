/**
 * BGE-family cross-encoder reranker via @huggingface/transformers.
 *
 * Default model: 'Xenova/bge-reranker-large' (community ONNX export of
 * BAAI/bge-reranker-large). bge-reranker-v2-m3 would be the SOTA pick
 * for our zh+en use case but as of 2026-05-22 has no Xenova-converted
 * ONNX build with q8 quantization; bge-reranker-large is the closest
 * available substitute (568M params, multilingual focus on zh+en,
 * 512-token window). Swap via the `model` constructor arg / config
 * field when a v2-m3 ONNX port lands.
 *
 *   - dtype: q8 by default (~280MB) — fp32 is ~560MB and slower for the
 *     small cross-encoder gains we typically see on multilingual docs.
 *
 * The cross-encoder takes pairs of (query, doc) and emits a single logit per
 * pair. We sigmoid it lightly only for reporting / debug — the order is what
 * matters and applying sigmoid is monotonic.
 *
 * First call to warmUp() downloads the model and may take 5-15s. After warm,
 * a 20-doc rerank batch takes ~80-200ms on CPU.
 *
 * Tests do NOT exercise this path by default — they use MockReranker.
 */

import { mkdirSync } from 'node:fs';
import type { PreTrainedTokenizer, PreTrainedModel, Tensor } from '@huggingface/transformers';
import type { Reranker, RerankerInputDoc, RerankerScore } from './types.ts';

export type BgeCrossEncoderOptions = {
  model?: string;
  preferQuantized?: boolean;
  /** Cache directory passed to transformers.js. Defaults to its own pick. */
  cacheDir?: string;
  /** Hard cap on tokens per (query, doc) pair. Tokens above this are
   *  truncated. 512 matches the model's native window. */
  maxLength?: number;
};

export class BgeCrossEncoder implements Reranker {
  readonly model: string;
  ready = false;

  private readonly hfModel: string;
  private readonly preferQuantized: boolean;
  private readonly cacheDir: string | undefined;
  private readonly maxLength: number;
  private tokenizer: PreTrainedTokenizer | null = null;
  private xmodel: PreTrainedModel | null = null;

  constructor(opts: BgeCrossEncoderOptions = {}) {
    this.hfModel = opts.model ?? 'Xenova/bge-reranker-large';
    this.preferQuantized = opts.preferQuantized ?? true;
    this.cacheDir = opts.cacheDir;
    this.maxLength = opts.maxLength ?? 512;
    this.model = this.preferQuantized ? `${this.hfModel}:q8` : this.hfModel;
  }

  async warmUp(): Promise<void> {
    if (this.ready && this.tokenizer && this.xmodel) return;
    const tx = await import('@huggingface/transformers');
    const remoteHost = process.env.HF_ENDPOINT?.trim() || process.env.TRANSFORMERS_REMOTE_HOST?.trim();
    if (remoteHost) {
      tx.env.remoteHost = remoteHost.endsWith('/') ? remoteHost : `${remoteHost}/`;
    }
    if (this.cacheDir) {
      mkdirSync(this.cacheDir, { recursive: true });
      tx.env.cacheDir = this.cacheDir;
    }
    tx.env.allowRemoteModels = true;

    const dtype = this.preferQuantized ? 'q8' : 'fp32';
    process.stderr.write(
      `[ask/reranker] loading ${this.hfModel} (dtype=${dtype}, cache=${this.cacheDir ?? 'default'}) — first run downloads ~${this.preferQuantized ? '280' : '560'} MB\n`,
    );
    try {
      this.tokenizer = await tx.AutoTokenizer.from_pretrained(this.hfModel);
      this.xmodel = await tx.AutoModelForSequenceClassification.from_pretrained(this.hfModel, {
        dtype,
      });
      // Single warm pass so the ONNX session is hot before the first real call.
      const probe = this.tokenizer(['warm'], {
        text_pair: ['probe'],
        truncation: true,
        padding: true,
        max_length: this.maxLength,
      });
      await this.xmodel(probe);
    } catch (err) {
      throw new Error(
        `[ask/reranker] failed to load model "${this.hfModel}" (dtype=${dtype}, cache=${this.cacheDir ?? 'default'}).\n` +
          `  allowRemoteModels=${tx.env.allowRemoteModels} allowLocalModels=${tx.env.allowLocalModels}\n` +
          `  Cause: ${(err as Error).message}`,
        { cause: err },
      );
    }
    this.ready = true;
  }

  async rerank(query: string, docs: RerankerInputDoc[]): Promise<RerankerScore[]> {
    if (docs.length === 0) return [];
    if (!this.ready || !this.tokenizer || !this.xmodel) await this.warmUp();
    if (!this.tokenizer || !this.xmodel) {
      throw new Error('BgeCrossEncoder: model not initialized after warmUp');
    }

    // Replicate query for each doc; tokenizer accepts parallel arrays via the
    // `text_pair` option to produce sentence-pair classifier inputs.
    const queries = docs.map(() => query);
    const texts = docs.map((d) => d.text);
    const inputs = this.tokenizer(queries, {
      text_pair: texts,
      truncation: true,
      padding: true,
      max_length: this.maxLength,
    });
    const { logits } = (await this.xmodel(inputs)) as { logits: Tensor };
    // logits shape is [batch, 1] for bge-reranker-v2-m3 (single relevance head).
    // Flatten to 1D and map back to chunk_ids in input order.
    const raw = logits.data as Float32Array;
    return docs.map((d, i) => ({ chunk_id: d.chunk_id, score: raw[i] ?? 0 }));
  }

  async dispose(): Promise<void> {
    // transformers.js v3 exposes dispose on the model. Tokenizer doesn't need
    // explicit release. Same shutdown-order hazard as the embedder — dispose
    // before closing the SQLite handle from runtime.stop().
    if (this.xmodel) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = this.xmodel as any;
      if (typeof m.dispose === 'function') await m.dispose();
    }
    this.xmodel = null;
    this.tokenizer = null;
    this.ready = false;
  }
}
