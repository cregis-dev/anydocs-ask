/**
 * Path classification helpers for the indexer.
 *
 * chokidar gives us absolute file paths. The indexer needs to map those to:
 *   - "is this a page file or a navigation file?"
 *   - which lang does it belong to?
 *
 * Conventions (locked to anydocs project layout, ARCH §7.1.1):
 *   - navigation files live at `<root>/navigation/<lang>.json`
 *   - page files live at `<root>/pages/<lang>/**\/*.json` (any depth)
 *
 * page_id resolution is intentionally NOT done here — for pages/* paths we
 * only return the lang. The page_id has to be read from the JSON content,
 * which the indexer does after a reload.
 */

import { relative, resolve, sep, posix } from 'node:path';
import { isDocsLang, type DocsLang } from '../anydocs/types.ts';

export type PathKind =
  | { kind: 'navigation'; lang: DocsLang }
  | { kind: 'page'; lang: DocsLang }
  | { kind: 'unrelated' };

export function classifyPath(absPath: string, projectRoot: string): PathKind {
  const rel = relative(resolve(projectRoot), resolve(absPath));
  if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
    return { kind: 'unrelated' };
  }
  // Normalize Windows separators to posix for matching.
  const segs = rel.split(sep).join(posix.sep).split(posix.sep);
  if (segs.length === 0) return { kind: 'unrelated' };

  // navigation/<lang>.json
  if (segs.length === 2 && segs[0] === 'navigation' && segs[1]!.endsWith('.json')) {
    const lang = segs[1]!.slice(0, -'.json'.length);
    if (isDocsLang(lang)) return { kind: 'navigation', lang };
    return { kind: 'unrelated' };
  }

  // pages/<lang>/**/*.json
  if (segs.length >= 3 && segs[0] === 'pages' && segs[segs.length - 1]!.endsWith('.json')) {
    const lang = segs[1]!;
    if (isDocsLang(lang)) return { kind: 'page', lang };
    return { kind: 'unrelated' };
  }

  return { kind: 'unrelated' };
}
