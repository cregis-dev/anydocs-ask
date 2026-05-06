import { resolve } from 'node:path';

export type ReindexOptions = {
  projectRoot: string;
};

export async function runReindex(opts: ReindexOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  // TODO(stage 5): wire to IndexManager.rebuildAll().
  process.stderr.write(
    `reindex not yet implemented (stage 5); project: ${projectRoot}\n`,
  );
  return 1;
}
