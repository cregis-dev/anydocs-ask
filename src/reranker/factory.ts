/**
 * Build the default reranker from a resolved config. Mirrors the embedder
 * factory: hides the cross-encoder choice + cache directory resolution
 * behind one entry point so Runtime / tests just say `buildDefaultReranker(config)`.
 *
 * The reranker layer is opt-in via `reranker.enabled = true` in
 * anydocs.ask.json. When disabled, callers should pass `null` through to
 * `answer.ts` and the cross-encoder rerank step is skipped (the existing
 * rule rerank remains the only ranking authority).
 */

import { resolveTransformersCacheDir, type ResolvedConfig } from '../config.ts';
import { MockReranker } from './mock.ts';
import { BgeCrossEncoder } from './bge-cross-encoder.ts';
import type { Reranker } from './types.ts';

export function buildDefaultReranker(config: ResolvedConfig): Reranker | null {
  if (!config.reranker.enabled) return null;
  if (config.reranker.provider === 'mock') return new MockReranker();
  return new BgeCrossEncoder({
    model: config.reranker.model,
    preferQuantized: config.reranker.preferQuantized,
    cacheDir: resolveTransformersCacheDir(config),
    maxLength: config.reranker.maxLength,
  });
}
