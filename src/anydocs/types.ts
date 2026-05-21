/**
 * Subset of `@anydocs/core` schema that anydocs-ask consumes.
 *
 * Why hand-maintained rather than `import from "@anydocs/core"`:
 *   - @anydocs/core's published surface drags in React, Yoopta, Tailwind, Next
 *     and a 50+-package install footprint. Ask is a server, not a UI; we don't
 *     want any of that.
 *   - Keeping the schema mirror local makes the "we do not invade anydocs"
 *     boundary in PRD §6.5 mechanical: anydocs can refactor its internals
 *     freely, and we just bump these types if the on-disk JSON shape changes.
 *
 * Source of truth: `anydocs/packages/core/src/types/docs.ts` (snapshot
 * 2026-05-06). When bumping anydocs, diff that file against this one.
 */

export const DOCS_LANGS = ['zh', 'en'] as const;
export type DocsLang = (typeof DOCS_LANGS)[number];

export const PAGE_STATUSES = ['draft', 'in_review', 'published'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export type NavItem =
  | { type: 'section'; id?: string; title: string; children: NavItem[] }
  | { type: 'folder'; id?: string; title: string; children: NavItem[] }
  | { type: 'page'; pageId: string; titleOverride?: string; hidden?: boolean }
  | { type: 'link'; id?: string; title: string; href: string };

export type NavigationDoc = {
  version: number;
  items: NavItem[];
};

/**
 * PageDoc as far as Ask needs to read. We deliberately type `content` as
 * `unknown` here — stage 4 (content layer) parses DocContentV1 properly.
 */
export type PageDoc = {
  id: string;
  lang: DocsLang;
  slug: string;
  title: string;
  description?: string;
  tags?: string[];
  status: PageStatus;
  updatedAt?: string;
  content: unknown;
  metadata?: Record<string, unknown>;
  /** Optional pre-rendered markdown used by generated docs such as OpenAPI references. */
  render?: { markdown?: string };
};

export function isDocsLang(value: unknown): value is DocsLang {
  return typeof value === 'string' && (DOCS_LANGS as readonly string[]).includes(value);
}

export function isPageStatus(value: unknown): value is PageStatus {
  return typeof value === 'string' && (PAGE_STATUSES as readonly string[]).includes(value);
}
