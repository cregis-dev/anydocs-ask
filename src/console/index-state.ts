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
import { iterateRunsSince } from '../runs/writer.ts';
import type { RunRecord, RunsLine } from '../runs/types.ts';

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
  /** Reverse mark (RFC 0002 T4): how often this page contributed to an
   *  answer in the past N days + the median confidence across those
   *  hits. Absent when no runs touched the page, OR when count is below
   *  the noise threshold (kept undefined so the renderer can skip without
   *  hard-coding the threshold twice). */
  askStats?: AskUsageEntry;
};

/** Aggregate ask-usage stats per page (RFC 0002 T4). Only populated when
 *  the page accumulated ≥ ASK_STATS_MIN_COUNT hits in the window. */
export type AskUsageEntry = {
  /** Number of distinct runs whose `retrieval.fused` cited this page. */
  count: number;
  /** Median of those runs' `answer.confidence`. null when every run had
   *  null confidence (rare — usually only on errors). */
  medianConfidence: number | null;
};

export type AskUsageStats = {
  /** Rolling window length in days. */
  days: number;
  /** ISO date (UTC) marking the start of the window. */
  sinceISO: string;
  /** Per-page entries — only includes pages that crossed the noise floor. */
  byPageId: Map<string, AskUsageEntry>;
};

/** RFC 0002 §5.3 + decision Q4: ≥ 3 hits before we show a mark. Below
 *  that the signal is too noisy to gripe at the author. */
export const ASK_STATS_MIN_COUNT = 3;
/** RFC 0002 §5.3: confidence median below this means "warn" tinting. */
export const ASK_STATS_LOW_CONFIDENCE = 0.5;

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
  /** Ask-usage reverse marks (RFC 0002 T4). null when stateRoot wasn't
   *  provided (e.g. invalid project / no projectId) or when runs.jsonl
   *  is absent. Per-page entries already gated on the noise floor. */
  askStats: AskUsageStats | null;
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

export type LoadIndexOpts = {
  /** Runtime state root (<workspace>/state/<projectId>/). When supplied
   *  we compute RFC 0002 T4 reverse marks from runs.jsonl. Omit to skip
   *  the scan (e.g. invalid projects / no projectId / unit tests). */
  stateRoot?: string;
  /** Rolling-window length for the ask-usage scan. Default 7 days per
   *  RFC 0002 §5.3. */
  askStatsDays?: number;
};

export async function loadIndexSnapshot(
  projectRoot: string,
  opts: LoadIndexOpts = {},
): Promise<IndexSnapshot> {
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
      askStats: null,
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

  // RFC 0002 T4 — reverse marks. Tagged onto the page summaries before
  // the snapshot returns, so the renderer just reads `p.askStats` and
  // doesn't need to do its own JOIN.
  const askStats = opts.stateRoot
    ? loadAskUsageStats(opts.stateRoot, opts.askStatsDays ?? 7)
    : null;
  if (askStats) {
    for (const l of langs) {
      for (const p of l.pages) {
        const e = askStats.byPageId.get(p.id);
        if (e) p.askStats = e;
      }
      for (const p of l.orphans) {
        const e = askStats.byPageId.get(p.id);
        if (e) p.askStats = e;
      }
    }
  }

  return {
    projectRoot,
    langs,
    warnings,
    totalPages,
    dbStatus: null,
    askStats,
  };
}

/**
 * Walk runs.jsonl in [now-days, now) and bucket "which pages did each ask
 * surface in retrieval.fused?". One ask hitting the same page across
 * multiple fused chunks still counts as 1 hit (deduped per request). We
 * track confidence per hitting run so the renderer can show median-style
 * tinting per RFC 0002 §5.3.
 *
 * The scan is read-on-render — same cost class as Traffic / Feedback —
 * so we don't cache between requests. Pages below ASK_STATS_MIN_COUNT
 * are dropped to keep the renderer's branch logic simple.
 */
export function loadAskUsageStats(stateRoot: string, days: number): AskUsageStats {
  const safeDays = Math.max(1, days);
  const sinceMs = Date.now() - safeDays * 86_400_000;
  const acc: Map<string, { count: number; confs: number[] }> = new Map();
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if ('type' in line && line.type === 'feedback-update') continue;
    const rec = line as RunRecord;
    const fused = rec.retrieval?.fused;
    if (!Array.isArray(fused) || fused.length === 0) continue;
    const seenPages = new Set<string>();
    for (const f of fused) {
      if (!f || typeof f.page !== 'string' || f.page.length === 0) continue;
      seenPages.add(f.page);
    }
    if (seenPages.size === 0) continue;
    const conf = typeof rec.answer?.confidence === 'number' ? rec.answer.confidence : null;
    for (const pageId of seenPages) {
      const bucket = acc.get(pageId) ?? { count: 0, confs: [] };
      bucket.count++;
      if (conf !== null) bucket.confs.push(conf);
      acc.set(pageId, bucket);
    }
  }

  const byPageId: Map<string, AskUsageEntry> = new Map();
  for (const [pageId, bucket] of acc) {
    if (bucket.count < ASK_STATS_MIN_COUNT) continue;
    byPageId.set(pageId, {
      count: bucket.count,
      medianConfidence: bucket.confs.length > 0 ? median(bucket.confs) : null,
    });
  }
  return {
    days: safeDays,
    sinceISO: new Date(sinceMs).toISOString().slice(0, 10),
    byPageId,
  };
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
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
