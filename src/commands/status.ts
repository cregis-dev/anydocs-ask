import { resolve } from 'node:path';

export type StatusOptions = {
  projectRoot: string;
};

export async function runStatus(opts: StatusOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  // TODO(stage 2/5): open SQLite, print doc_count / chunk_count / last_indexed_at /
  //                  embedding_model / llm_model. Same shape as GET /v1/index/status.
  process.stderr.write(
    `status not yet implemented (stage 2/5); project: ${projectRoot}\n`,
  );
  return 1;
}
