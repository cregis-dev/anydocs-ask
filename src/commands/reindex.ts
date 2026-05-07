/**
 * `anydocs-ask reindex <projectRoot>` — single-shot full reindex, then exit.
 *
 * Useful when:
 *   - the index DB was lost / corrupted
 *   - the embedding model changed (config swap)
 *   - someone hand-edited project files outside the watcher's view
 *
 * Exit-cleanness note: onnxruntime-node 1.21 (pulled in by
 * @huggingface/transformers 3.8) aborts with `libc++abi: mutex lock failed`
 * during process shutdown when its worker thread races with node's native
 * teardown. Calling pipeline.dispose() doesn't fix it. We therefore force-
 * exit via SIGKILL after the SQLite handle has been closed (WAL is fsynced
 * on commit, so no data loss). This is the same workaround the rest of the
 * onnxruntime-node ecosystem uses pending an upstream fix.
 */

import { resolve } from 'node:path';
import { Runtime } from '../server/runtime.ts';
import { loadConfig } from '../config.ts';

export type ReindexOptions = {
  projectRoot: string;
};

export async function runReindex(opts: ReindexOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const { config, warnings } = await loadConfig(projectRoot);
  for (const w of warnings) process.stderr.write(`[ask] ${w}\n`);

  const runtime = new Runtime({ projectRoot, config, skipWatcher: true });
  try {
    process.stdout.write(`anydocs-ask reindex: warming embedder (${config.embedding.model})...\n`);
    const t0 = Date.now();
    const result = await runtime.start();
    const duration = Date.now() - t0;
    const { initialIndex } = result;
    process.stdout.write(
      `done in ${duration}ms\n` +
        `  pages: +${initialIndex.pages.inserted} ~${initialIndex.pages.updated} -${initialIndex.pages.deleted}\n` +
        `  chunks: ${initialIndex.chunks.totalChunks} written across ${initialIndex.chunks.writtenPages} pages (${initialIndex.chunks.skippedPages} skipped)\n` +
        `  embeddings: hits=${initialIndex.embed.hits} misses=${initialIndex.embed.misses}\n`,
    );
    if (initialIndex.warnings.length > 0) {
      process.stderr.write(`warnings:\n  ${initialIndex.warnings.join('\n  ')}\n`);
    }
    return 0;
  } finally {
    await runtime.stop();
  }
}
