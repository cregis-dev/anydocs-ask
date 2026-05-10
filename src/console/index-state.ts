/**
 * Console-side Index tab state helpers — ARCH §17.3.5.
 *
 * Pure read-only summary of a project's on-disk content + (when the child
 * is running) its in-DB index counts via reverse-proxied /v1/index/status.
 *
 * No mutating logic lives here; reindex itself is a reverse-proxy in the
 * server route (analogous to ask / health). Keeping mutation out of this
 * module mirrors eval-state.ts.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../anydocs/loader.ts';
import type { LoadedProject } from '../anydocs/loader.ts';
import type { DocsLang } from '../anydocs/types.ts';

export type IndexPageInfo = {
  id: string;
  title: string;
  slug: string | null;
  status: string;
  lang: DocsLang;
  /** Path within nav (sequence of titles); empty when page exists but is
   * orphaned (not referenced by navigation). */
  breadcrumb: string[];
  /** True when nav references this page but the page file is missing. */
  missingFile?: true;
};

export type IndexLangSummary = {
  lang: DocsLang;
  pages: IndexPageInfo[];
  /** Pages that exist on disk but are NOT referenced from navigation. */
  orphans: IndexPageInfo[];
};

export type IndexSnapshot = {
  projectRoot: string;
  /** Per-lang summary, ordered by lang code. */
  langs: IndexLangSummary[];
  /** Validation warnings from anydocs loader + console checks. */
  warnings: string[];
  /** Total pages on disk across all langs. */
  totalPages: number;
  /**
   * Optional — populated by the route handler from child /v1/index/status
   * when the child is running. null when offline or not warmed up yet.
   */
  dbStatus: ChildIndexStatus | null;
};

export type ChildIndexStatus = {
  page_count: number;
  chunk_count: number;
  embedding_cache_size: number;
  embedding_model: string;
  llm_model: string;
  warm: boolean;
  last_indexed_at: number | null;
};

export async function loadIndexSnapshot(projectRoot: string): Promise<IndexSnapshot> {
  let project: LoadedProject;
  try {
    project = await loadProject(projectRoot);
  } catch (err) {
    // navigation/ missing or unreadable — surface as a single warning rather
    // than throwing, so the UI can still render the empty-state guidance.
    return {
      projectRoot,
      langs: [],
      warnings: [(err as Error).message],
      totalPages: 0,
      dbStatus: null,
    };
  }

  const langs: IndexLangSummary[] = [];
  const sortedLangs = [...project.navigationsByLang.keys()].sort();
  // Also include langs that have pages but no nav (so orphans surface).
  const pageOnlyLangs = [...project.pagesByLangAndId.keys()].filter(
    (l) => !project.navigationsByLang.has(l),
  );
  const allLangs = [...sortedLangs, ...pageOnlyLangs];

  for (const lang of allLangs) {
    const pagesMap = project.pagesByLangAndId.get(lang) ?? new Map();
    const nav = project.navigationsByLang.get(lang);
    const navReferenced = new Set<string>();
    const referencedPages: IndexPageInfo[] = [];

    if (nav) {
      walkNav(nav.items, [], (pageId, breadcrumb) => {
        navReferenced.add(pageId);
        const page = pagesMap.get(pageId);
        if (!page) {
          referencedPages.push({
            id: pageId,
            title: pageId,
            slug: null,
            status: '—',
            lang,
            breadcrumb,
            missingFile: true,
          });
          return;
        }
        referencedPages.push({
          id: pageId,
          title: page.title ?? pageId,
          slug: page.slug ?? null,
          status: page.status ?? '—',
          lang,
          breadcrumb,
        });
      });
    }

    const orphans: IndexPageInfo[] = [];
    for (const [pageId, page] of pagesMap) {
      if (navReferenced.has(pageId)) continue;
      orphans.push({
        id: pageId,
        title: page.title ?? pageId,
        slug: page.slug ?? null,
        status: page.status ?? '—',
        lang,
        breadcrumb: [],
      });
    }

    langs.push({ lang, pages: referencedPages, orphans });
  }

  let totalPages = 0;
  for (const pagesMap of project.pagesByLangAndId.values()) {
    totalPages += pagesMap.size;
  }

  const warnings: string[] = [...project.warnings];
  // Console-level checks beyond the loader's: pages/ dir exists at all?
  if (!existsSync(join(projectRoot, 'pages'))) {
    warnings.push(
      `pages/ directory is missing — place anydocs page JSON files under ${join(projectRoot, 'pages')}/<lang>/`,
    );
  } else {
    // Pages dir exists but might be empty.
    const langDirs = readdirSync(join(projectRoot, 'pages'), { withFileTypes: true });
    const langDirNames = langDirs.filter((e) => e.isDirectory()).map((e) => e.name);
    if (langDirNames.length === 0) {
      warnings.push('pages/ exists but contains no <lang>/ subdirectory yet');
    }
  }

  return {
    projectRoot,
    langs,
    warnings,
    totalPages,
    dbStatus: null,
  };
}

function walkNav(
  items: unknown,
  trail: string[],
  visit: (pageId: string, breadcrumb: string[]) => void,
): void {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const node = it as { type?: string; title?: string; pageId?: string; children?: unknown };
    if (node.type === 'section') {
      walkNav(node.children, [...trail, node.title ?? ''], visit);
    } else if (node.type === 'page' && typeof node.pageId === 'string') {
      visit(node.pageId, trail);
    }
  }
}
