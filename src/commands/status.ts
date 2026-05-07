/**
 * `anydocs-ask status <projectRoot>` — read-only summary of the index DB.
 *
 * Same shape as GET /v1/index/status, but talks to SQLite directly without
 * starting the embedder / watcher / HTTP server. Useful for ops scripts.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase, resolveDbPath } from '../db/index.ts';
import { loadConfig } from '../config.ts';

export type StatusOptions = {
  projectRoot: string;
  stateRoot: string;
};

export async function runStatus(opts: StatusOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const dbPath = resolveDbPath(stateRoot);
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `no index DB at ${dbPath}; run 'anydocs-ask reindex ${projectRoot}' first.\n`,
    );
    return 1;
  }
  const { config } = await loadConfig(projectRoot);
  const db = openDatabase({ stateRoot, skipMigrations: true });
  try {
    const counts = db
      .prepare(`SELECT
                  (SELECT COUNT(*) FROM pages) AS pages,
                  (SELECT COUNT(*) FROM chunks) AS chunks,
                  (SELECT COUNT(*) FROM embedding_cache) AS cache,
                  (SELECT COUNT(*) FROM feedback) AS feedback,
                  (SELECT COUNT(*) FROM answers) AS answers`)
      .get() as { pages: number; chunks: number; cache: number; feedback: number; answers: number };
    const userVersion = db.pragma('user_version', { simple: true });

    process.stdout.write(
      `anydocs-ask status\n` +
        `  source root:   ${projectRoot}\n` +
        `  state root:    ${stateRoot}\n` +
        `  db path:       ${dbPath}\n` +
        `  schema version: ${userVersion}\n` +
        `  pages:         ${counts.pages}\n` +
        `  chunks:        ${counts.chunks}\n` +
        `  embedding cache: ${counts.cache}\n` +
        `  feedback rows: ${counts.feedback}\n` +
        `  answers rows:  ${counts.answers}\n` +
        `  embedding model: ${config.embedding.model}\n` +
        `  llm provider:    ${config.llm.provider}/${config.llm.model}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}
