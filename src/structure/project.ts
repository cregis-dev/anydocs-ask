/**
 * Structure-layer projection.
 *
 * Takes the in-memory result of `loadProject(...)` and produces one PageRow
 * per (page_id, lang) pair, ready to upsert into the `pages` table.
 *
 * Lives in pure functions on intent: same inputs, same outputs, no I/O. The
 * upsert step (DB writes) is `src/structure/upsert.ts`.
 *
 * Spec mirror: ARCHITECTURE §2.2 / §2.2.1 / §2.2.2.
 */

import type { PageRow, BreadcrumbNode } from '../db/schema.ts';
import type {
  DocsLang,
  NavItem,
  NavigationDoc,
  PageDoc,
} from '../anydocs/types.ts';

const NAV_INDEX_UNREACHED = Number.MAX_SAFE_INTEGER;

export type ProjectionInput = {
  navigationsByLang: Map<DocsLang, NavigationDoc>;
  pagesByLangAndId: Map<DocsLang, Map<string, PageDoc>>;
};

export type ProjectionOutput = {
  rows: PageRow[];
  warnings: string[];
};

export function projectStructure(input: ProjectionInput): ProjectionOutput {
  const rows: PageRow[] = [];
  const warnings: string[] = [];
  const now = Date.now();

  for (const [lang, nav] of input.navigationsByLang) {
    const langPages = input.pagesByLangAndId.get(lang) ?? new Map<string, PageDoc>();
    const seenPageIds = new Set<string>();

    // Walk navigation/{lang}.json. Track:
    //   - dfsPath: path of child indices from root to current node (for stable id)
    //   - breadcrumbStack: nodes along the current path
    //   - depth1Id: stable id of the depth-1 ancestor (= subtree_root)
    //   - navIndex: monotonically increasing across the lang
    let navIndex = 0;
    const breadcrumbStack: BreadcrumbNode[] = [];

    const walk = (item: NavItem, dfsPath: number[], depth: number, depth1Id: string | null): void => {
      const stableId = stableNavId(item, lang, dfsPath);
      const myDepth1Id = depth === 1 ? stableId : depth1Id;
      const myNavIndex = navIndex++;

      if (item.type === 'page') {
        const pageDoc = langPages.get(item.pageId);
        if (!pageDoc) {
          warnings.push(
            `navigation/${lang}.json: page node references unknown pageId "${item.pageId}"; skipping`,
          );
          return;
        }
        if (seenPageIds.has(pageDoc.id)) {
          warnings.push(
            `navigation/${lang}.json: page id "${pageDoc.id}" referenced more than once; keeping first occurrence`,
          );
          return;
        }
        if (pageDoc.status !== 'published') {
          // Non-published pages don't enter the index at all (PRD §4.5).
          // We still bump nav_index for siblings' positional accuracy.
          return;
        }
        seenPageIds.add(pageDoc.id);

        const title = item.titleOverride ?? pageDoc.title;
        const selfNode: BreadcrumbNode = { id: stableId, title, type: 'page' };
        const breadcrumb = [...breadcrumbStack, selfNode];
        const parent = breadcrumbStack[breadcrumbStack.length - 1];

        rows.push({
          page_id: pageDoc.id,
          lang,
          status: pageDoc.status,
          title,
          slug: pageDoc.slug,
          breadcrumb: JSON.stringify(breadcrumb),
          nav_index: myNavIndex,
          parent_id: parent?.id ?? null,
          subtree_root: myDepth1Id,
          url: `/${lang}/${pageDoc.slug}`,
          updated_at: parseUpdatedAt(pageDoc.updatedAt) ?? now,
        });
        return;
      }

      if (item.type === 'link') {
        // Links don't enter pages, but they bumped navIndex above so siblings
        // get correct sequencing.
        return;
      }

      // section / folder: descend.
      const node: BreadcrumbNode = { id: stableId, title: item.title, type: item.type };
      breadcrumbStack.push(node);
      try {
        item.children.forEach((child, i) => walk(child, [...dfsPath, i], depth + 1, myDepth1Id));
      } finally {
        breadcrumbStack.pop();
      }
    };

    nav.items.forEach((item, i) => walk(item, [i], 1, null));

    // Orphan pages: PageDocs that exist on disk but are never referenced from
    // navigation/{lang}.json. They still go in (PRD §4.5 hard-filters by
    // published; navigation membership is a soft signal), but with degenerate
    // structure-layer values so rerank weights collapse to zero.
    for (const [pageId, pageDoc] of langPages) {
      if (seenPageIds.has(pageId)) continue;
      if (pageDoc.status !== 'published') continue;
      warnings.push(
        `pages/${lang}/${pageDoc.slug}: page "${pageId}" is not referenced by navigation/${lang}.json (orphan)`,
      );
      const selfNode: BreadcrumbNode = { id: pageId, title: pageDoc.title, type: 'page' };
      rows.push({
        page_id: pageId,
        lang,
        status: pageDoc.status,
        title: pageDoc.title,
        slug: pageDoc.slug,
        breadcrumb: JSON.stringify([selfNode]),
        nav_index: NAV_INDEX_UNREACHED,
        parent_id: null,
        subtree_root: null,
        url: `/${lang}/${pageDoc.slug}`,
        updated_at: parseUpdatedAt(pageDoc.updatedAt) ?? now,
      });
    }
  }

  // Pages whose lang has no navigation file at all — also orphans, slightly
  // louder warning to flag a likely project-config error.
  for (const [lang, langPages] of input.pagesByLangAndId) {
    if (input.navigationsByLang.has(lang)) continue;
    warnings.push(
      `pages/${lang}/ has ${langPages.size} page(s) but navigation/${lang}.json is missing; pages from this lang will be unreachable via Ask`,
    );
  }

  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// Stable nav id (ARCH §2.2.2)
// ---------------------------------------------------------------------------

export function stableNavId(item: NavItem, lang: DocsLang, dfsPath: number[]): string {
  if (item.type === 'page') return item.pageId;
  if (item.id) return item.id;
  return `nav:${lang}.json:${dfsPath.join('/')}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseUpdatedAt(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
