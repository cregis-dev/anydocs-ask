#!/usr/bin/env node
/**
 * Copies non-TS assets that tsc ignores into dist/, so the published bin can
 * find them at runtime.
 *
 * Currently: src/db/migrations/*.sql -> dist/db/migrations/*.sql
 *
 * Run after `tsc -p tsconfig.json`. Idempotent — safe to re-run.
 */

import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const pairs = [
  ['src/db/migrations', 'dist/db/migrations'],
];

for (const [from, to] of pairs) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    process.stderr.write(`copy-assets: source missing: ${from}\n`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  process.stdout.write(`copy-assets: ${from} -> ${to}\n`);
}

// tsc emits the CLI entry without an exec bit; npm/pnpm will symlink it as
// the package bin and call it via #!/usr/bin/env node, but installing the
// tarball into a project that runs the bin directly (e.g. CI scripts) needs
// the file to be executable.
const cli = join(root, 'dist/cli.js');
if (existsSync(cli)) {
  chmodSync(cli, 0o755);
  process.stdout.write(`copy-assets: chmod 0755 dist/cli.js\n`);
}
