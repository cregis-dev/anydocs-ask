/**
 * Static asset resolution for console — ARCH §17.4.
 *
 * The console ships a tiny vendor surface (marked) loaded by the browser
 * as ESM. We resolve files via `createRequire().resolve()` against the
 * package's `lib/` exports so it works equivalently in dev (strip-types
 * from src/) and prod (compiled dist/). No CDN: keeps the "127.0.0.1
 * internal dev tool" assumption intact.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export type StaticAsset = {
  contentType: string;
  body: string;
};

/** Map of `/console/static/<name>` → resolver returning file content. */
const ASSETS: Record<string, () => StaticAsset> = {
  'marked.esm.js': () => ({
    contentType: 'application/javascript; charset=utf-8',
    // marked@18 exports `.` only; resolve the entry then read the ESM file.
    body: readFileSync(require_.resolve('marked'), 'utf8'),
  }),
  'index-app.js': () => loadConsoleUiAsset('console-app.js', 'application/javascript; charset=utf-8'),
  'index-app.css': () => loadConsoleUiAsset('console-app.css', 'text/css; charset=utf-8'),
  'console-app.js': () => loadConsoleUiAsset('console-app.js', 'application/javascript; charset=utf-8'),
  'console-app.css': () => loadConsoleUiAsset('console-app.css', 'text/css; charset=utf-8'),
};

function loadConsoleUiAsset(name: string, contentType: string): StaticAsset {
  const candidates = [
    join(here, '..', '..', 'dist', 'console-ui', name),
    join(here, '..', 'console-ui', name),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`console UI asset is missing: ${name}; run pnpm build`);
  return { contentType, body: readFileSync(path, 'utf8') };
}

export function getStaticAsset(name: string): StaticAsset | null {
  const loader = ASSETS[name];
  if (!loader) return null;
  return loader();
}

export function staticAssetNames(): string[] {
  return Object.keys(ASSETS);
}
