/**
 * Reads an anydocs project root from disk into in-memory data structures.
 *
 * Lays out the inputs that the structure-layer projection (src/structure/)
 * will consume. Validation is intentionally lenient — we collect warnings
 * instead of throwing, so a single malformed file doesn't take the whole
 * server down. Hard failures are reserved for "the project clearly isn't an
 * anydocs project" (no navigation/ directory).
 */

import { promises as fs } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import {
  DOCS_LANGS,
  isDocsLang,
  isPageStatus,
  type DocsLang,
  type NavigationDoc,
  type PageDoc,
} from './types.ts';

export type LoadedProject = {
  projectRoot: string;
  navigationsByLang: Map<DocsLang, NavigationDoc>;
  /** lang -> page_id -> PageDoc. Same page_id can appear under multiple langs. */
  pagesByLangAndId: Map<DocsLang, Map<string, PageDoc>>;
  warnings: string[];
};

export async function loadProject(projectRoot: string): Promise<LoadedProject> {
  const root = resolve(projectRoot);
  const warnings: string[] = [];

  const navDir = join(root, 'navigation');
  let navEntries: string[];
  try {
    navEntries = await fs.readdir(navDir);
  } catch {
    throw new Error(
      `navigation/ directory missing at ${navDir}; Ask requires an anydocs project with navigation files`,
    );
  }

  const navigationsByLang = new Map<DocsLang, NavigationDoc>();
  for (const entry of navEntries) {
    if (extname(entry) !== '.json') continue;
    const lang = basename(entry, '.json');
    if (!isDocsLang(lang)) {
      warnings.push(
        `navigation/${entry}: unrecognized lang "${lang}" (expected one of ${DOCS_LANGS.join(', ')}); skipped`,
      );
      continue;
    }
    const path = join(navDir, entry);
    const nav = await readNavigation(path, warnings);
    if (nav) navigationsByLang.set(lang, nav);
  }

  const pagesByLangAndId = new Map<DocsLang, Map<string, PageDoc>>();
  for (const lang of DOCS_LANGS) {
    const langDir = join(root, 'pages', lang);
    let pageFiles: string[];
    try {
      pageFiles = await listJsonFilesRecursively(langDir);
    } catch {
      // Missing pages/<lang>/ is fine — project may not have content for this
      // lang yet. Only warn if the corresponding navigation does exist (which
      // would mean an internal inconsistency).
      if (navigationsByLang.has(lang)) {
        warnings.push(
          `navigation/${lang}.json exists but pages/${lang}/ is missing; pages from this lang will be absent`,
        );
      }
      continue;
    }

    const langMap = new Map<string, PageDoc>();
    for (const path of pageFiles) {
      const page = await readPage(path, lang, warnings);
      if (!page) continue;
      if (langMap.has(page.id)) {
        warnings.push(
          `pages/${lang}/${basename(path)}: duplicate page id "${page.id}" (already loaded earlier in this lang); skipped`,
        );
        continue;
      }
      langMap.set(page.id, page);
    }
    if (langMap.size > 0) {
      pagesByLangAndId.set(lang, langMap);
    } else if (navigationsByLang.has(lang)) {
      warnings.push(
        `navigation/${lang}.json exists but pages/${lang}/ has no readable page files`,
      );
    }
  }

  return { projectRoot: root, navigationsByLang, pagesByLangAndId, warnings };
}

// ---------------------------------------------------------------------------
// File-level readers
// ---------------------------------------------------------------------------

async function readNavigation(path: string, warnings: string[]): Promise<NavigationDoc | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    warnings.push(`${path}: read failed (${describeError(err)})`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`${path}: JSON parse failed (${describeError(err)})`);
    return null;
  }
  if (!isNavigationDocLike(parsed)) {
    warnings.push(`${path}: not a NavigationDoc (missing or malformed 'items' / 'version')`);
    return null;
  }
  return parsed;
}

async function readPage(
  path: string,
  expectedLang: DocsLang,
  warnings: string[],
): Promise<PageDoc | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    warnings.push(`${path}: read failed (${describeError(err)})`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`${path}: JSON parse failed (${describeError(err)})`);
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    warnings.push(`${path}: not an object`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const { id, lang, slug, title, status, content } = obj;
  if (typeof id !== 'string' || id.length === 0) {
    warnings.push(`${path}: missing or empty 'id'`);
    return null;
  }
  if (typeof slug !== 'string') {
    warnings.push(`${path}: missing 'slug'`);
    return null;
  }
  if (typeof title !== 'string') {
    warnings.push(`${path}: missing 'title'`);
    return null;
  }
  if (!isPageStatus(status)) {
    warnings.push(`${path}: invalid 'status' (${String(status)})`);
    return null;
  }
  if (!isDocsLang(lang)) {
    warnings.push(`${path}: invalid 'lang' (${String(lang)})`);
    return null;
  }
  // ARCH §2.2.1: lang from path wins; warn if PageDoc.lang disagrees.
  if (lang !== expectedLang) {
    warnings.push(
      `${path}: PageDoc.lang="${lang}" does not match path lang="${expectedLang}"; using path lang`,
    );
  }
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined;
  const description = typeof obj.description === 'string' ? obj.description : undefined;
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : undefined;
  const metadata =
    typeof obj.metadata === 'object' && obj.metadata !== null
      ? (obj.metadata as Record<string, unknown>)
      : undefined;

  return {
    id,
    lang: expectedLang,    // path-derived, per ARCH §2.2.1
    slug,
    title,
    status,
    content,
    description,
    tags,
    updatedAt,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listJsonFilesRecursively(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && extname(entry.name) === '.json') {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

function isNavigationDocLike(value: unknown): value is NavigationDoc {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === 'number' && Array.isArray(v.items);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
