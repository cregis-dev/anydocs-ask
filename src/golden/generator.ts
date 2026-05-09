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

import { renderPageContent } from '@anydocs/core/render-page-content';
import type { DocsLang, NavItem, NavigationDoc, PageDoc } from '../anydocs/types.ts';
import type { LoadedProject } from '../anydocs/loader.ts';
import { extractMarkdownSections } from '../content/sections.ts';
import { TEMPLATE_IDS, type GoldenCaseCandidate, type TemplateId } from './types.ts';

/** must_cite_pages includes the page itself + up to this many nav siblings.
 *  ARCH §16.3.2 R@5 / Citation-pass treat the list as OR-set, so widening
 *  here makes both metrics tolerate "answer cites a same-section neighbor",
 *  which is the right editorial reading per PRD §4.1. */
const SIBLING_CITE_CAP = 5;

/** must_contain extracts up to this many heading-derived keywords. Provides
 *  a meaningful Answer-rule-pass signal — empty list (status quo) made the
 *  metric vacuous. Keywords come from the page's own headings, so the rule
 *  is "answer should mention what the page itself talks about". */
const HEADING_KEYWORD_CAP = 3;
const HEADING_KEYWORD_MIN_LEN = 4;

/** Common English stopwords + page-meta words that appear in headings but
 *  carry no semantic discrimination (the Anydocs heading-id slug uses the
 *  same words, so the word would always trivially substring-match). */
const HEADING_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you',
  'are', 'what', 'when', 'how', 'why', 'all', 'any', 'use', 'using',
  'into', 'about', 'over', 'more', 'less', 'than', 'their', 'them',
  'overview', 'introduction', 'getting', 'started', 'reference',
  'guide', 'guides', 'examples', 'example', 'notes', 'note',
]);

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
      const headingKeywords = extractHeadingKeywords(pg);
      emitForPage(ref, lang, parent ?? null, siblings, headingKeywords, out);
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
  headingKeywords: string[],
  out: GoldenCaseCandidate[],
): void {
  // OR-set semantics on must_cite_pages: same-section neighbors are valid
  // citations. Cap to keep the metric meaningful on big sections.
  const siblingSlugs = [...siblings]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, SIBLING_CITE_CAP)
    .map((s) => s.slug);
  const mustCite = uniqueOrdered([page.slug, ...siblingSlugs]);

  for (const tmpl of TEMPLATE_IDS) {
    const query = renderTemplate(tmpl, page, lang, parent, siblings);
    if (query === null) continue;
    out.push({
      id: `${tmpl}:${page.slug}`,
      query,
      filters: { audience: null, version: null },
      context_pageId: null,
      expected: {
        must_cite_pages: mustCite,
        must_contain: headingKeywords,
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

function uniqueOrdered<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * Pull 1-3 substantive keywords from the page's heading titles.
 *
 * Algorithm (English):
 *   - Render content to markdown, extract sections, flatten headingPath strings
 *   - Tokenize on whitespace + punctuation; lowercase
 *   - Drop tokens shorter than HEADING_KEYWORD_MIN_LEN, in HEADING_STOPWORDS,
 *     or contained in the page title (already implied by must_cite_pages)
 *   - First HEADING_KEYWORD_CAP unique survivors win
 *
 * For zh pages we use a simpler path: treat each heading as a single token
 * (CJK has no spaces). The cap and stopword list don't apply meaningfully.
 */
function extractHeadingKeywords(page: PageDoc): string[] {
  let markdown: string;
  try {
    const rendered = renderPageContent(page.content);
    markdown = rendered.markdown ?? '';
  } catch {
    return [];
  }
  if (!markdown.trim()) return [];

  const sections = extractMarkdownSections(markdown, page.title);
  const headingTitles: string[] = [];
  for (const s of sections) {
    for (const h of s.headingPath) headingTitles.push(h);
  }
  if (headingTitles.length === 0) return [];

  if (page.lang === 'zh') {
    return uniqueOrdered(headingTitles).slice(0, HEADING_KEYWORD_CAP);
  }

  const titleLower = page.title.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const heading of headingTitles) {
    const tokens = heading.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const tok of tokens) {
      if (tok.length < HEADING_KEYWORD_MIN_LEN) continue;
      if (HEADING_STOPWORDS.has(tok)) continue;
      if (titleLower.includes(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= HEADING_KEYWORD_CAP) return out;
    }
  }
  return out;
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
