/**
 * BGE-family cross-encoder reranker via @huggingface/transformers.
 *
 * Default model: Xenova's Transformers.js-compatible ONNX export of
 * BAAI/bge-reranker-large. It supports Chinese and English with a 512-token
 * window, which matches the child chunks reranked here. v2-m3 remains a
 * supported pinned alternative, but the Cregis 92-case A/B favored large.
 *
 *   - dtype: q8 by default (~570MB); fp32 is ~2.3GB.
 *
 * The cross-encoder takes pairs of (query, doc) and emits a single logit per
 * pair. The query pipeline uses those logits only to derive semantic rank;
 * absolute score scales are not compared across model families.
 *
 * First call to warmUp() downloads the model. Warm inference cost is linear
 * in the configured rerank window and depends heavily on the host CPU.
 *
 * Tests do NOT exercise this path by default — they use MockReranker.
 */

import { mkdirSync } from 'node:fs';
import type { PreTrainedTokenizer, PreTrainedModel, Tensor } from '@huggingface/transformers';
import type { Reranker, RerankerInputDoc, RerankerScore } from './types.ts';

export const DEFAULT_BGE_RERANKER_MODEL = 'Xenova/bge-reranker-large';
export const DEFAULT_BGE_RERANKER_REVISION =
  '3c4ff3c9420fb24ea62acd31e3884e09c8827f2a';
export const BGE_RERANKER_V2_M3_MODEL = 'onnx-community/bge-reranker-v2-m3-ONNX';
export const BGE_RERANKER_V2_M3_REVISION =
  '6f5ff65298512715a1e669753bc754d2bc8f367b';

const PINNED_MODEL_REVISIONS: Readonly<Record<string, string>> = {
  [DEFAULT_BGE_RERANKER_MODEL]: DEFAULT_BGE_RERANKER_REVISION,
  [BGE_RERANKER_V2_M3_MODEL]: BGE_RERANKER_V2_M3_REVISION,
};

export type BgeCrossEncoderOptions = {
  model?: string;
  /** Optional Hugging Face revision. Falls back to BGE_RERANKER_REVISION. */
  revision?: string;
  preferQuantized?: boolean;
  /** Cache directory passed to transformers.js. Defaults to its own pick. */
  cacheDir?: string;
  /** Hard cap on tokens per (query, doc) pair. Tokens above this are
   *  truncated. 512 matches the model's native window. */
  maxLength?: number;
};

export function resolveBgeRerankerRevision(
  explicitRevision: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicitRevision?.trim() || env.BGE_RERANKER_REVISION?.trim() || undefined;
}

export class BgeCrossEncoder implements Reranker {
  readonly model: string;
  ready = false;

  private readonly hfModel: string;
  private readonly revision: string | undefined;
  private readonly preferQuantized: boolean;
  private readonly cacheDir: string | undefined;
  private readonly maxLength: number;
  private tokenizer: PreTrainedTokenizer | null = null;
  private xmodel: PreTrainedModel | null = null;

  constructor(opts: BgeCrossEncoderOptions = {}) {
    this.hfModel = opts.model ?? DEFAULT_BGE_RERANKER_MODEL;
    const modelDefaultRevision = PINNED_MODEL_REVISIONS[this.hfModel];
    this.revision = resolveBgeRerankerRevision(opts.revision) ?? modelDefaultRevision;
    this.preferQuantized = opts.preferQuantized ?? true;
    this.cacheDir = opts.cacheDir;
    this.maxLength = opts.maxLength ?? 512;
    const revision = this.revision ? `@${this.revision}` : '';
    this.model = `${this.hfModel}${revision}${this.preferQuantized ? ':q8' : ''}`;
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
    const revisionLabel = this.revision ? `, revision=${this.revision}` : '';
    process.stderr.write(
      `[ask/reranker] loading ${this.hfModel} (dtype=${dtype}, cache=${this.cacheDir ?? 'default'}${revisionLabel}) — first run downloads ~${this.preferQuantized ? '570' : '2300'} MB\n`,
    );
    try {
      const modelOptions = this.revision ? { revision: this.revision } : {};
      this.tokenizer = await tx.AutoTokenizer.from_pretrained(
        this.hfModel,
        modelOptions,
      );
      this.xmodel = await tx.AutoModelForSequenceClassification.from_pretrained(this.hfModel, {
        dtype,
        ...modelOptions,
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
        `[ask/reranker] failed to load model "${this.hfModel}" (dtype=${dtype}, cache=${this.cacheDir ?? 'default'}${revisionLabel}).\n` +
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
