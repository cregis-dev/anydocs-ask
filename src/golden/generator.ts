/**
 * Structure-based golden candidate generator — ARCH §16.5.1.
 *
 * Walks each lang's navigation tree, and for every page node emits 1–5
 * template-driven candidate questions. The candidate set is the input to
 * `golden generate --from structure` (optionally LLM-rewritten — see
 * llm-rewrite.ts) and ultimately to a human review step that flips each
 * candidate's `decision` field.
 *
 * Templates (per ARCH §16.5.1):
 *   what_is             "什么是 {title}" / "What is {title}?"
 *   how_to_use          "{title} 怎么用" / "How do I use {title}?"
 *   compare_siblings    "{parent} 里 {title} 和 {sibling} 的区别"
 *                       (only when the page has at least one sibling)
 *   how_to_configure    "如何配置 {title}" / "How do I configure {title}?"
 *   caveats             "{title} 的注意事项" / "{title} caveats"
 *
 * Templates are intentionally bilingual: zh template strings for zh pages,
 * en for en pages. Languages with no built-in template fall back to the
 * raw English form so the candidate is at least loadable for review.
 *
 * Determinism: id is derived from page slug + template id, so re-running
 * the generator on unchanged content produces stable ids (which matters
 * because eval reports cite cases by id).
 */

import type { DocsLang, NavItem, NavigationDoc, PageDoc } from '../anydocs/types.ts';
import type { LoadedProject } from '../anydocs/loader.ts';
import { TEMPLATE_IDS, type GoldenCaseCandidate, type TemplateId } from './types.ts';

export type GenerateOptions = {
  /** Cap total candidates returned. Truncates after a stable walk order. */
  limit?: number;
  /** Limit langs to generate from. Default = all langs in the project. */
  langs?: readonly DocsLang[];
};

export function generateFromStructure(
  project: LoadedProject,
  opts: GenerateOptions = {},
): GoldenCaseCandidate[] {
  const out: GoldenCaseCandidate[] = [];
  const langs = opts.langs ?? Array.from(project.navigationsByLang.keys());

  for (const lang of langs) {
    const nav = project.navigationsByLang.get(lang);
    if (!nav) continue;
    const pages = project.pagesByLangAndId.get(lang);
    if (!pages) continue;
    walk(nav, pages, lang, [], out);
  }

  if (opts.limit !== undefined && opts.limit >= 0 && out.length > opts.limit) {
    return out.slice(0, opts.limit);
  }
  return out;
}

type SectionFrame = { title: string; pageSiblings: PageRef[] };

type PageRef = { pageId: string; title: string; slug: string };

function walk(
  nav: NavigationDoc,
  pages: Map<string, PageDoc>,
  lang: DocsLang,
  ancestors: SectionFrame[],
  out: GoldenCaseCandidate[],
): void {
  visitItems(nav.items, pages, lang, ancestors, out);
}

function visitItems(
  items: NavItem[],
  pages: Map<string, PageDoc>,
  lang: DocsLang,
  ancestors: SectionFrame[],
  out: GoldenCaseCandidate[],
): void {
  // First pass: collect direct page siblings under this level so the
  // compare_siblings template can pick a counterpart.
  const directPageSiblings: PageRef[] = [];
  for (const it of items) {
    if (it.type !== 'page') continue;
    const pg = pages.get(it.pageId);
    if (!pg || pg.status !== 'published') continue;
    directPageSiblings.push({ pageId: pg.id, title: it.titleOverride ?? pg.title, slug: pg.slug });
  }

  for (const it of items) {
    if (it.type === 'page') {
      const pg = pages.get(it.pageId);
      if (!pg || pg.status !== 'published') continue;
      const ref: PageRef = {
        pageId: pg.id,
        title: it.titleOverride ?? pg.title,
        slug: pg.slug,
      };
      const parent = ancestors[ancestors.length - 1];
      const siblings = directPageSiblings.filter((s) => s.pageId !== ref.pageId);
      emitForPage(ref, lang, parent ?? null, siblings, out);
      continue;
    }
    if (it.type === 'section' || it.type === 'folder') {
      const frame: SectionFrame = { title: it.title, pageSiblings: [] };
      visitItems(it.children, pages, lang, [...ancestors, frame], out);
    }
    // 'link' nodes are ignored — they don't index pages.
  }
}

function emitForPage(
  page: PageRef,
  lang: DocsLang,
  parent: SectionFrame | null,
  siblings: PageRef[],
  out: GoldenCaseCandidate[],
): void {
  for (const tmpl of TEMPLATE_IDS) {
    const query = renderTemplate(tmpl, page, lang, parent, siblings);
    if (query === null) continue;
    out.push({
      id: `${tmpl}:${page.slug}`,
      query,
      filters: { audience: null, version: null },
      context_pageId: null,
      expected: {
        must_cite_pages: [page.slug],
        must_contain: [],
        forbid_contain: [],
      },
      tags: parent?.title ? [parent.title] : [],
      created_by: 'structure',
      reviewed_at: null,
      reviewer: null,
      lang,
      decision: null,
      template_id: tmpl,
    });
  }
}

/**
 * Render one template for a (page, lang, parent, siblings) tuple. Returns
 * null when the template doesn't apply (e.g. compare_siblings with no
 * sibling). Sibling pick is deterministic — alphabetical by slug.
 */
function renderTemplate(
  tmpl: TemplateId,
  page: PageRef,
  lang: DocsLang,
  parent: SectionFrame | null,
  siblings: PageRef[],
): string | null {
  if (tmpl === 'compare_siblings') {
    if (siblings.length === 0 || parent === null) return null;
    const sib = [...siblings].sort((a, b) => a.slug.localeCompare(b.slug))[0]!;
    if (lang === 'zh') return `${parent.title}里${page.title}和${sib.title}有什么区别？`;
    return `In ${parent.title}, what is the difference between ${page.title} and ${sib.title}?`;
  }
  if (lang === 'zh') {
    switch (tmpl) {
      case 'what_is':
        return `什么是${page.title}？`;
      case 'how_to_use':
        return `${page.title}怎么用？`;
      case 'how_to_configure':
        return `如何配置${page.title}？`;
      case 'caveats':
        return `使用${page.title}有什么注意事项？`;
    }
  }
  switch (tmpl) {
    case 'what_is':
      return `What is ${page.title}?`;
    case 'how_to_use':
      return `How do I use ${page.title}?`;
    case 'how_to_configure':
      return `How do I configure ${page.title}?`;
    case 'caveats':
      return `What are the caveats when using ${page.title}?`;
  }
}
