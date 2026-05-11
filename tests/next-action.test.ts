/**
 * Regression coverage for computeNextAction — ARCH §17.3.7.
 *
 * The banner is a "what should I do now" hint shown above the project tabs.
 * History contains a sneaky bug (commit 04f4e6f): the disk-vs-DB drift check
 * assumed orphan pages don't get indexed, but they do (PRD §4.5: navigation
 * membership is a soft rerank signal, `status === 'published'` is the hard
 * filter). The orphan/published distinction is the highest-value regression
 * to lock down — the rest of the branches are covered for breadth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextAction, type NextActionInputs } from '../src/console/next-action.ts';
import type {
  IndexSnapshot,
  IndexLangSummary,
  IndexPageInfo,
  ChildIndexStatus,
} from '../src/console/index-state.ts';
import type { EvalTabSnapshot } from '../src/console/eval-state.ts';
import type { TrafficWindow } from '../src/console/traffic-state.ts';

function page(overrides: Partial<IndexPageInfo> = {}): IndexPageInfo {
  return {
    id: overrides.id ?? 'p',
    title: overrides.title ?? 'P',
    slug: overrides.slug ?? null,
    status: overrides.status ?? 'published',
    lang: (overrides.lang ?? 'en') as IndexPageInfo['lang'],
    breadcrumb: overrides.breadcrumb ?? [],
    ...(overrides.missingFile ? { missingFile: true as const } : {}),
  };
}

function lang(pages: IndexPageInfo[], orphans: IndexPageInfo[] = []): IndexLangSummary {
  return { lang: 'en', pages, orphans };
}

function snapshot(opts: {
  langs?: IndexLangSummary[];
  dbStatus?: ChildIndexStatus | null;
  warnings?: string[];
}): IndexSnapshot {
  const langs = opts.langs ?? [];
  let totalPages = 0;
  for (const l of langs) totalPages += l.pages.length + l.orphans.length;
  return {
    projectRoot: '/tmp/x',
    langs,
    warnings: opts.warnings ?? [],
    totalPages,
    dbStatus: opts.dbStatus ?? null,
  };
}

function db(page_count: number): ChildIndexStatus {
  return {
    page_count,
    chunk_count: page_count * 3,
    embedding_cache_size: page_count,
    embedding_model: 'bge-m3',
    llm_model: 'gpt-4o-mini',
    warm: true,
    last_indexed_at: 1_700_000_000_000,
  };
}

function inputs(over: Partial<NextActionInputs> = {}): NextActionInputs {
  return {
    indexSnapshot: undefined,
    evalSnapshot: undefined,
    trafficWindow: undefined,
    childLive: true,
    projectValid: true,
    ...over,
  };
}

const emptyEval: EvalTabSnapshot = {
  goldenStats: { totalCases: 0, byLang: {}, byTag: {}, byCreatedBy: {}, lastEditISO: null, malformed: 0 },
  history: [],
  latest: null,
  pinned: null,
  pinnedSummary: null,
};

// ----------------------------------------------------------------------
// index branches
// ----------------------------------------------------------------------

test('projectValid=false short-circuits to "Project files invalid"', () => {
  const r = computeNextAction(inputs({ projectValid: false }));
  assert.equal(r?.level, 'err');
  assert.match(r?.title ?? '', /invalid/i);
});

test('totalPages=0 → "还没放 docs"', () => {
  const r = computeNextAction(inputs({ indexSnapshot: snapshot({}) }));
  assert.equal(r?.level, 'warn');
  assert.match(r?.title ?? '', /docs/);
  assert.equal(r?.cta.targetTab, 'index');
});

test('missing page file → err banner', () => {
  const idx = snapshot({
    langs: [lang([page({ id: 'a' }), page({ id: 'b', missingFile: true })])],
  });
  const r = computeNextAction(inputs({ indexSnapshot: idx }));
  assert.equal(r?.level, 'err');
  assert.match(r?.title ?? '', /缺失/);
});

// ----------------------------------------------------------------------
// disk-vs-DB drift — the orphan/published regression
// ----------------------------------------------------------------------

test('regression: orphan pages do NOT cause drift warning (PRD §4.5)', () => {
  // 5 published pages on disk: 3 in nav, 2 orphans.
  // Indexer hard filter is status === 'published'; orphans are still indexed
  // with NAV_INDEX_UNREACHED. So DB should hold all 5.
  const pages = [page({ id: 'a' }), page({ id: 'b' }), page({ id: 'c' })];
  const orphans = [page({ id: 'o1' }), page({ id: 'o2' })];
  const idx = snapshot({ langs: [lang(pages, orphans)], dbStatus: db(5) });
  const r = computeNextAction(inputs({ indexSnapshot: idx }));
  // No drift action expected. The next-in-line branch (childLive=true, eval
  // empty) shouldn't fire because evalSnapshot is undefined.
  assert.equal(r, null);
});

test('unpublished drafts reduce expectedInDb (DB count matching drafts-excluded → no warning)', () => {
  // 4 on disk: 3 published + 1 draft. Indexer skips the draft.
  // DB has 3 published pages → expected matches, no warning.
  const pages = [
    page({ id: 'a' }),
    page({ id: 'b' }),
    page({ id: 'c' }),
    page({ id: 'd', status: 'draft' }),
  ];
  const idx = snapshot({ langs: [lang(pages)], dbStatus: db(3) });
  const r = computeNextAction(inputs({ indexSnapshot: idx }));
  assert.equal(r, null);
});

test('genuine drift (DB missing a published page) → warn banner', () => {
  // 3 published pages on disk, DB only has 2 → reindex needed.
  const pages = [page({ id: 'a' }), page({ id: 'b' }), page({ id: 'c' })];
  const idx = snapshot({ langs: [lang(pages)], dbStatus: db(2) });
  const r = computeNextAction(inputs({ indexSnapshot: idx }));
  assert.equal(r?.level, 'warn');
  assert.match(r?.title ?? '', /不一致|drift|expected/);
});

test('orphans alone with matching DB count stay silent (no banner spam)', () => {
  // Edge: only orphan pages, all published, DB indexed them.
  const idx = snapshot({ langs: [lang([], [page({ id: 'o1' })])], dbStatus: db(1) });
  const r = computeNextAction(inputs({ indexSnapshot: idx }));
  assert.equal(r, null);
});

test('unpublished orphan also reduces expected', () => {
  // 1 nav-page (published) + 1 orphan (draft) → expected = 1; DB has 1 → ok.
  const pages = [page({ id: 'a' })];
  const orphans = [page({ id: 'o1', status: 'draft' })];
  const idx = snapshot({ langs: [lang(pages, orphans)], dbStatus: db(1) });
  const r = computeNextAction(inputs({ indexSnapshot: idx }));
  assert.equal(r, null);
});

// ----------------------------------------------------------------------
// other downstream branches (breadth coverage)
// ----------------------------------------------------------------------

test('childLive=false with indexed project → "项目尚未启动"', () => {
  const idx = snapshot({ langs: [lang([page({ id: 'a' })])], dbStatus: db(1) });
  const r = computeNextAction(inputs({ indexSnapshot: idx, childLive: false }));
  assert.equal(r?.level, 'info');
  assert.equal(r?.cta.targetTab, 'ask');
});

test('no golden set → suggest building one', () => {
  const idx = snapshot({ langs: [lang([page({ id: 'a' })])], dbStatus: db(1) });
  const r = computeNextAction(inputs({ indexSnapshot: idx, evalSnapshot: emptyEval }));
  assert.equal(r?.cta.targetTab, 'eval');
  assert.match(r?.title ?? '', /golden/);
});

test('golden exists but no eval history → run first eval', () => {
  const idx = snapshot({ langs: [lang([page({ id: 'a' })])], dbStatus: db(1) });
  const ev: EvalTabSnapshot = {
    ...emptyEval,
    goldenStats: { ...emptyEval.goldenStats, totalCases: 5 },
  };
  const r = computeNextAction(inputs({ indexSnapshot: idx, evalSnapshot: ev }));
  assert.match(r?.title ?? '', /baseline|首次 eval/);
});

test('traffic with high error rate → err banner pointing to traffic tab', () => {
  const idx = snapshot({ langs: [lang([page({ id: 'a' })])], dbStatus: db(1) });
  const ev: EvalTabSnapshot = {
    ...emptyEval,
    goldenStats: { ...emptyEval.goldenStats, totalCases: 5 },
    history: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { filename: 'r.json' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { filename: 's.json' } as any,
    ],
    pinned: { filename: 'r.json', pinnedAtMs: 0 } as TrafficSafePin,
  };
  const tr: TrafficWindow = {
    sinceISO: '2026-05-01',
    days: 7,
    records: [],
    totals: {
      count: 100,
      countReader: 100,
      countConsole: 0,
      meanConfidence: 0.8,
      p50LatencyMs: 100,
      p95LatencyMs: 500,
      errorRate: 0.1,
      clarifyRate: 0,
    },
    perDay: [],
  };
  const r = computeNextAction(inputs({ indexSnapshot: idx, evalSnapshot: ev, trafficWindow: tr }));
  assert.equal(r?.level, 'err');
  assert.equal(r?.cta.targetTab, 'traffic');
});

// Pinned baseline shape carries only filename + pinnedAtMs in the code, but
// the import surface isn't exported; alias for clarity.
type TrafficSafePin = { filename: string; pinnedAtMs: number };
