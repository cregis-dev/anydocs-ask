/**
 * SQLite + sqlite-vec opener and migration runner for anydocs-ask.
 *
 * Concerns kept here:
 *   1. Resolve the index DB path inside `<projectRoot>/.anydocs-ask/index.db`
 *   2. Open with WAL + foreign_keys=ON
 *   3. Load the sqlite-vec extension (vec0 / vec_distance_cosine / ...)
 *   4. Run any pending migrations using PRAGMA user_version as the cursor
 *
 * Stays free of business logic (chunk shape, embedding model, projection
 * rules) — those live in their own modules.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import Database, { type Database as DatabaseHandle } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type OpenOptions = {
  /** anydocs project root. The DB lives at `<projectRoot>/.anydocs-ask/index.db`. */
  projectRoot?: string;
  /** Override DB path entirely (used by tests; ignores `projectRoot`). */
  dbPath?: string;
  /** If true, skip running migrations after open. Default false. */
  skipMigrations?: boolean;
};

export type DbHandle = DatabaseHandle;

/**
 * Where `index.db` lives for a given anydocs project.
 *
 * Putting state under `.anydocs-ask/` (not `.anydocs/`) keeps us out of
 * anydocs' own subtree, in line with the "do not invade anydocs schema" rule
 * (PRD §6.5).
 */
export function resolveDbPath(projectRoot: string): string {
  return join(resolve(projectRoot), '.anydocs-ask', 'index.db');
}

export function openDatabase(options: OpenOptions = {}): DbHandle {
  const dbPath =
    options.dbPath ??
    (options.projectRoot
      ? resolveDbPath(options.projectRoot)
      : (() => {
          throw new Error('openDatabase: provide projectRoot or dbPath');
        })());

  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  // PRAGMAs: WAL gives much better read-during-write behaviour for our usage
  // (server reads during chokidar-driven reindex). foreign_keys is required
  // for the (page_id, lang) cascade on chunks (ARCH §4 / §7.2).
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  sqliteVec.load(db);

  if (!options.skipMigrations) {
    runMigrations(db);
  }

  return db;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(__dirname, 'migrations');

type Migration = {
  version: number;       // zero-padded numeric prefix from filename
  name: string;          // full filename (for logs)
  sql: string;
};

function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  return files
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (!match) {
        throw new Error(
          `migration filename '${name}' must start with a numeric prefix (e.g. 001_initial.sql)`,
        );
      }
      const version = Number(match[1]);
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return { version, name, sql };
    })
    .sort((a, b) => a.version - b.version);
}

export function runMigrations(db: DbHandle): { applied: string[] } {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  const migrations = loadMigrations();

  // Sanity: numeric prefixes must be unique and contiguous. We don't enforce
  // contiguity strictly (so 001 -> 003 is allowed if a migration is reverted),
  // but duplicate prefixes are always wrong.
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`duplicate migration version ${m.version}`);
    }
    seen.add(m.version);
  }

  const applied: string[] = [];
  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql);
    db.pragma(`user_version = ${m.version}`);
  });

  for (const m of migrations) {
    if (m.version <= current) continue;
    apply(m);
    applied.push(m.name);
  }

  return { applied };
}

/**
 * Returns a small, stable snapshot of the embedded sqlite-vec build, used by
 * `/v1/index/status` and tests to assert the extension actually loaded.
 */
export function vecVersion(db: DbHandle): string {
  const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
  return row.v;
}
