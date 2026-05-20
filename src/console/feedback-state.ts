/**
 * Console-side Feedback tab state helpers — RFC 0002 T1-a + T1-b.
 *
 * T1-a (skeleton) shipped the two empty-shaped states from
 * console-redesign-brief §7.5.1 (disabled / enabled-no-rows).
 *
 * T1-b adds the middle list + KPI numbers + filter chips. The detail
 * drawer (state 5 / right side) is still T1-d.
 *
 * Data sources:
 *   • feedback table        — row count, signal_source split, list rows
 *                             (read-only via shared openDatabase helper)
 *   • runs.jsonl (7d window)— JOIN on answer_id to recover confidence +
 *                             non-answer rate per rated run
 *
 * The runs JOIN is read-on-render — the console is a local dev tool and
 * the 7-day jsonl scan is the same cost Traffic already pays. We do NOT
 * cache the JOIN; the page handler computes it fresh per request.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db/index.ts';
import type { BreadcrumbNode, FeedbackRow } from '../db/schema.ts';
import { iterateRunsSince } from '../runs/writer.ts';
import type { RunRecord, RunsLine } from '../runs/types.ts';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Pre-0.2.0-alpha.2 rows persisted an empty question (see the spawned
 *  "Backfill question" task). T1-b surfaces a stable placeholder so the
 *  list doesn't look broken until that fix lands. */
const QUESTION_FALLBACK = '(question unavailable — pre-0.2.0-alpha.2 row)';

/** UI filter chips — §7.5.1 list. `semantic_check_failed` still defers
 *  to RFC 0005 (0.3+). `no_citations` is data-driven from the runs.jsonl
 *  JOIN (no schema change). */
export type FeedbackFilter =
  | 'all'
  | 'thumbs_up'
  | 'thumbs_down'
  | 'implicit'
  | 'no_citations';
export const FEEDBACK_FILTERS: readonly FeedbackFilter[] = [
  'all',
  'thumbs_up',
  'thumbs_down',
  'implicit',
  'no_citations',
] as const;

export type FeedbackKpi = {
  /** Total feedback rows in the window (β + γ + curated). */
  count: number;
  explicitCount: number;
  implicitCount: number;
  /** explicit / (explicit + implicit). null when both are 0. */
  explicitShare: number | null;
  /** Mean answer.confidence across runs that have ≥1 feedback row. */
  meanConfidence: number | null;
  /** (error + clarify) / runs-with-feedback. 0 when no runs-with-feedback. */
  nonAnswerRate: number;
  /** Reserved for 0.3 A+ clustering (PRD §10.3, ≥50 threshold). */
  aplusCandidates: null;
};

export type FeedbackRowVM = {
  feedback_id: number;
  /** ISO 8601 from `created_at` ms. */
  ts: string;
  rating: number | null;
  signal_source: 'explicit' | 'implicit' | 'curated';
  question: string;
  answerId: string;
  currentPageId: string | null;
  /** Title chain leading to `currentPageId`, looked up from `pages.breadcrumb`.
   *  null when `currentPageId` is null, OR when no page row matches (page
   *  unpublished / deleted since the feedback row was written). */
  breadcrumb: BreadcrumbNode[] | null;
  /** From runs.jsonl JOIN on answer_id. null if no matching run line in
   *  the window (rare — rows can pre-date runs.enabled or the runs file
   *  rolled out of the window). */
  confidence: number | null;
  /** From runs.jsonl JOIN on answer_id. true when the linked run produced
   *  an answer with zero citations (or kind='error'). null when no
   *  matching run line. Drives the `no_citations` chip badge + per-row
   *  warn affordance. */
  hadNoCitations: boolean | null;
};

export type FilterCounts = Record<FeedbackFilter, number>;

export type FeedbackTabSnapshot = {
  enabled: boolean;
  /** Total rows across all signal_sources in the window. Drives the
   *  T1-a "signals collected" banner + the KPI feedback·7d tile. */
  totalCount: number;
  /** ISO date marking the start of the rolling window. */
  sinceISO: string;
  days: number;
  kpi: FeedbackKpi;
  /** Filter chip badge counts (matched by the same predicates the list
   *  uses, so chip counts and list contents stay in sync). */
  filterCounts: FilterCounts;
  /** Filter applied to `rows`. Default 'all'. */
  filter: FeedbackFilter;
  /** First page of rows for `filter`, newest first. */
  rows: FeedbackRowVM[];
  /** True when `filterCounts[filter] > rows.length`. */
  hasMore: boolean;
};

export type FeedbackConfigSlice = {
  feedback: { enabled: boolean };
};

export type LoadFeedbackOpts = {
  filter?: FeedbackFilter;
  /** Cap rows in the returned page. Clamped to [1, MAX_LIMIT]. */
  limit?: number;
  days?: number;
};

export function loadFeedbackTabSnapshot(
  stateRoot: string | null,
  projectConfig: FeedbackConfigSlice,
  opts: LoadFeedbackOpts = {},
): FeedbackTabSnapshot {
  const filter = opts.filter ?? 'all';
  const limit = clamp(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const days = Math.max(1, opts.days ?? DEFAULT_DAYS);
  const enabled = projectConfig.feedback.enabled === true;

  const empty = emptySnapshot(enabled, filter, days);
  if (!enabled || !stateRoot) return empty;

  const dbPath = join(stateRoot, 'index.db');
  if (!existsSync(dbPath)) return empty;

  const sinceMs = Date.now() - days * DAY_MS;

  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase({ stateRoot, skipMigrations: true });
  } catch {
    return empty;
  }

  try {
    return computeSnapshot(db, stateRoot, sinceMs, days, filter, limit);
  } catch {
    // Malformed DB / missing table → degrade to empty-enabled rather than
    // 500 the project page.
    return empty;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// SQL + JOIN
// ---------------------------------------------------------------------------

function computeSnapshot(
  db: ReturnType<typeof openDatabase>,
  stateRoot: string,
  sinceMs: number,
  days: number,
  filter: FeedbackFilter,
  limit: number,
): FeedbackTabSnapshot {
  const sinceISO = new Date(sinceMs).toISOString().slice(0, 10);

  // One pass for window-scoped counts. We deliberately compute totalCount
  // across ALL time (drives the banner on the disabled→empty transition
  // even when the window is empty), then bucket counts within the window.
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM feedback`)
    .get() as { n: number } | undefined;
  const totalCount = totalRow?.n ?? 0;

  const inWindow = db
    .prepare(
      `SELECT signal_source, rating, answer_id
         FROM feedback
        WHERE created_at >= ?`,
    )
    .all(sinceMs) as Array<Pick<FeedbackRow, 'signal_source' | 'rating' | 'answer_id'>>;

  // `all` is the union of the four chips, NOT a raw row count — curated
  // rows are deliberately outside the chip taxonomy (post-review, surfaced
  // via inbox/approved files), and the `all` SQL filter excludes them too,
  // so the badge and the list must agree.
  // Build the runs.jsonl JOIN once for the full window, restricted to the
  // answer_ids that have feedback (signal_source IN explicit/implicit) in
  // the window. The result drives chip counts, KPI math, AND per-row
  // confidence/no_citations — keeping a single scan instead of two like
  // T1-b had.
  const inWindowFeedbackIds = new Set<string>();
  for (const r of inWindow) {
    if (r.signal_source === 'explicit' || r.signal_source === 'implicit') {
      inWindowFeedbackIds.add(r.answer_id);
    }
  }
  const runIndex = buildRunIndex(stateRoot, sinceMs, inWindowFeedbackIds);

  const filterCounts: FilterCounts = {
    all: 0,
    thumbs_up: 0,
    thumbs_down: 0,
    implicit: 0,
    no_citations: 0,
  };
  let explicitCount = 0;
  let implicitCount = 0;
  // `no_citations` is cross-cutting: it counts the rows in `all` whose
  // linked run had zero citations (or kind='error'). Tracked alongside
  // the other buckets so chip badges + list contents agree.
  for (const r of inWindow) {
    if (r.signal_source !== 'explicit' && r.signal_source !== 'implicit') continue;
    if (r.signal_source === 'explicit') {
      explicitCount++;
      filterCounts.all++;
      if (r.rating !== null && r.rating > 0) filterCounts.thumbs_up++;
      else if (r.rating !== null && r.rating < 0) filterCounts.thumbs_down++;
    } else {
      implicitCount++;
      filterCounts.all++;
      filterCounts.implicit++;
    }
    if (runIndex.get(r.answer_id)?.citationsEmpty === true) {
      filterCounts.no_citations++;
    }
    // 'curated' rows skip every counter; see chip-taxonomy comment above.
  }

  // For the `no_citations` filter, narrow the SQL selection to answer_ids
  // we already know match. Other filters use the same SQL predicates as
  // T1-b.
  const noCitationAnswerIds =
    filter === 'no_citations'
      ? new Set<string>(
          [...inWindowFeedbackIds].filter(
            (aid) => runIndex.get(aid)?.citationsEmpty === true,
          ),
        )
      : null;
  const rowsRaw = selectRows(db, sinceMs, filter, limit, noCitationAnswerIds);

  // Breadcrumb JOIN: pages.breadcrumb is JSON-encoded and already lives in
  // the same DB, so a single `WHERE page_id IN (...)` keeps the lookup
  // cheap. Pages may be unpublished/deleted since the feedback row was
  // written — those resolve to `null` (rendered as the raw page_id).
  const breadcrumbs = loadBreadcrumbs(
    db,
    rowsRaw.map((r) => r.current_page_id).filter((id): id is string => id !== null),
  );

  const rows: FeedbackRowVM[] = rowsRaw.map((r) => {
    const runMeta = runIndex.get(r.answer_id);
    return {
      feedback_id: r.feedback_id,
      ts: new Date(r.created_at).toISOString(),
      rating: r.rating,
      signal_source: r.signal_source,
      question: r.question.length > 0 ? r.question : QUESTION_FALLBACK,
      answerId: r.answer_id,
      currentPageId: r.current_page_id,
      breadcrumb: r.current_page_id ? breadcrumbs.get(r.current_page_id) ?? null : null,
      confidence: runMeta?.confidence ?? null,
      hadNoCitations: runMeta?.citationsEmpty ?? null,
    };
  });

  // KPI mean confidence + non-answer rate use the same runIndex —
  // semantics: "across rated runs" = runs in the window that have ≥1
  // feedback row (curated included since they're rated post-hoc).
  let confSum = 0;
  let confN = 0;
  let nonAnswer = 0;
  let ratedN = 0;
  const allFeedbackAnswerIds = db
    .prepare(
      `SELECT DISTINCT answer_id
         FROM feedback
        WHERE created_at >= ?`,
    )
    .all(sinceMs) as Array<{ answer_id: string }>;
  // Re-use runIndex when possible; fill gaps for curated-only answer_ids.
  const ratedRunIndex =
    allFeedbackAnswerIds.length === inWindowFeedbackIds.size
      ? runIndex
      : buildRunIndex(
          stateRoot,
          sinceMs,
          new Set(allFeedbackAnswerIds.map((r) => r.answer_id)),
        );
  for (const v of ratedRunIndex.values()) {
    ratedN++;
    if (typeof v.confidence === 'number') {
      confSum += v.confidence;
      confN++;
    }
    if (v.kind === 'error' || v.kind === 'clarify') nonAnswer++;
  }

  const explicitShare =
    explicitCount + implicitCount > 0
      ? explicitCount / (explicitCount + implicitCount)
      : null;

  return {
    enabled: true,
    totalCount,
    sinceISO,
    days,
    kpi: {
      // Same denominator as filterCounts.all — KPI footer reads "β + γ
      // combined" so curated rows must not be folded in.
      count: explicitCount + implicitCount,
      explicitCount,
      implicitCount,
      explicitShare,
      meanConfidence: confN > 0 ? confSum / confN : null,
      nonAnswerRate: ratedN > 0 ? nonAnswer / ratedN : 0,
      aplusCandidates: null,
    },
    filterCounts,
    filter,
    rows,
    hasMore: filterCounts[filter] > rows.length,
  };
}

function selectRows(
  db: ReturnType<typeof openDatabase>,
  sinceMs: number,
  filter: FeedbackFilter,
  limit: number,
  /** Required when filter='no_citations' — the precomputed set of
   *  answer_ids known to have zero citations in their linked run. Empty
   *  set short-circuits to an empty result. */
  noCitationAnswerIds: Set<string> | null,
): FeedbackRow[] {
  if (filter === 'no_citations') {
    const ids = noCitationAnswerIds ?? new Set<string>();
    if (ids.size === 0) return [];
    const placeholders = Array(ids.size).fill('?').join(',');
    return db
      .prepare(
        `SELECT * FROM feedback
          WHERE created_at >= ?
            AND signal_source IN ('explicit', 'implicit')
            AND answer_id IN (${placeholders})
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(sinceMs, ...ids, limit) as FeedbackRow[];
  }
  const where = filterToWhere(filter);
  return db
    .prepare(
      `SELECT * FROM feedback
        WHERE created_at >= ? ${where ? 'AND ' + where : ''}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(sinceMs, limit) as FeedbackRow[];
}

function filterToWhere(filter: FeedbackFilter): string {
  switch (filter) {
    case 'all':
      // exclude curated — see chip taxonomy note above.
      return `signal_source IN ('explicit', 'implicit')`;
    case 'thumbs_up':
      return `signal_source = 'explicit' AND rating > 0`;
    case 'thumbs_down':
      return `signal_source = 'explicit' AND rating < 0`;
    case 'implicit':
      return `signal_source = 'implicit'`;
    case 'no_citations':
      // Handled out-of-line by selectRows (needs runIndex JOIN); this
      // branch keeps the switch exhaustive for TypeScript.
      return `signal_source IN ('explicit', 'implicit')`;
  }
}

/**
 * Look up breadcrumb chains for a set of page_ids via the pages table.
 * Returns a map page_id → BreadcrumbNode[]; page_ids without a row
 * (unpublished / deleted) are simply absent. The breadcrumb column is
 * JSON-encoded by the indexer (ARCH §2.2.1).
 *
 * For multilingual projects a page may have one row per lang — we don't
 * try to pick a "preferred" lang here; the first row wins (good enough
 * for a UI hint, and the per-row drawer in T1-d can be smarter).
 */
function loadBreadcrumbs(
  db: ReturnType<typeof openDatabase>,
  pageIds: readonly string[],
): Map<string, BreadcrumbNode[]> {
  const out: Map<string, BreadcrumbNode[]> = new Map();
  if (pageIds.length === 0) return out;
  const unique = [...new Set(pageIds)];
  const placeholders = Array(unique.length).fill('?').join(',');
  let rows: Array<{ page_id: string; breadcrumb: string }>;
  try {
    rows = db
      .prepare(
        `SELECT page_id, breadcrumb FROM pages WHERE page_id IN (${placeholders})`,
      )
      .all(...unique) as Array<{ page_id: string; breadcrumb: string }>;
  } catch {
    return out;
  }
  for (const row of rows) {
    if (out.has(row.page_id)) continue;
    try {
      const parsed = JSON.parse(row.breadcrumb) as unknown;
      if (Array.isArray(parsed)) {
        out.set(row.page_id, parsed as BreadcrumbNode[]);
      }
    } catch {
      // malformed breadcrumb JSON → leave page unmapped
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// runs.jsonl JOIN helper
// ---------------------------------------------------------------------------

type RunIndexEntry = {
  confidence: number | null;
  kind: 'answer' | 'clarify' | 'error';
  /** True when the run produced zero citations (error or empty list).
   *  Drives the no_citations chip + per-row warn affordance. */
  citationsEmpty: boolean;
};

/**
 * Walk runs.jsonl in [sinceMs, now) and bucket each answer_id → meta.
 * When `restrictTo` is non-empty we early-skip non-matching rows to keep
 * the scan cheap on busy projects.
 */
function buildRunIndex(
  stateRoot: string,
  sinceMs: number,
  restrictTo: Set<string>,
): Map<string, RunIndexEntry> {
  const out: Map<string, RunIndexEntry> = new Map();
  if (restrictTo.size === 0) return out;
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if ('type' in line && line.type === 'feedback-update') continue;
    const rec = line as RunRecord;
    const aid = rec.answer.answer_id;
    if (aid === null) continue;
    if (!restrictTo.has(aid)) continue;
    // Last-write-wins (a re-asked answer_id is rare; the latest line is
    // usually the relevant one).
    const citations = rec.answer.citations ?? [];
    out.set(aid, {
      confidence: rec.answer.confidence ?? null,
      kind: rec.answer.kind,
      citationsEmpty: citations.length === 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(
  enabled: boolean,
  filter: FeedbackFilter,
  days: number,
): FeedbackTabSnapshot {
  return {
    enabled,
    totalCount: 0,
    sinceISO: new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10),
    days,
    kpi: {
      count: 0,
      explicitCount: 0,
      implicitCount: 0,
      explicitShare: null,
      meanConfidence: null,
      nonAnswerRate: 0,
      aplusCandidates: null,
    },
    filterCounts: { all: 0, thumbs_up: 0, thumbs_down: 0, implicit: 0, no_citations: 0 },
    filter,
    rows: [],
    hasMore: false,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Per-row detail (T1-d drawer)
// ---------------------------------------------------------------------------

export type FeedbackRunCitationVM = {
  page: string;
  quote: string;
  chunkId: number | null;
};

export type FeedbackFusedChunkVM = {
  page: string;
  chunkId: number;
  finalScore: number | null;
  rrfScore: number | null;
  vecRank: number | null;
  bm25Rank: number | null;
  navIndex: number | null;
};

export type FeedbackRowDetail = {
  /** List view fields — same shape as `FeedbackRowVM` so the client doesn't
   *  have to reconcile two schemas. */
  feedback_id: number;
  ts: string;
  rating: number | null;
  signal_source: 'explicit' | 'implicit' | 'curated';
  question: string;
  answerId: string;
  currentPageId: string | null;
  breadcrumb: BreadcrumbNode[] | null;
  confidence: number | null;
  hadNoCitations: boolean | null;
  /** Markdown body — pulled from feedback.generated. Empty string when the
   *  ask never made it through generation (error kind). */
  answerMd: string;
  /** Citation snapshot stored at feedback time. Best-effort decode. */
  citations: FeedbackRunCitationVM[];
  /** Reviewer correction (β button "答错了" sends a `correction` field) or
   *  null when none. */
  correction: string | null;
  /** Linked run record fields. Null when no run line matched (rare —
   *  the run rolled out of the window, or runs.enabled=false). */
  run: {
    kind: 'answer' | 'clarify' | 'error';
    fused: FeedbackFusedChunkVM[];
    subtreeAskTriggered: boolean;
    latencyMs: number;
    model: string | null;
    errorCode: string | null;
  } | null;
};

export function loadFeedbackRowDetail(
  stateRoot: string | null,
  feedbackId: number,
  opts: { days?: number } = {},
): FeedbackRowDetail | null {
  if (!stateRoot) return null;
  const dbPath = join(stateRoot, 'index.db');
  if (!existsSync(dbPath)) return null;
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase({ stateRoot, skipMigrations: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(`SELECT * FROM feedback WHERE feedback_id = ?`)
      .get(feedbackId) as FeedbackRow | undefined;
    if (!row) return null;

    // Pull breadcrumb + run record via the existing helpers, narrowed to the
    // single answer_id. The runs window default is generous (30d) here
    // since older feedback rows may legitimately be inspected; the list
    // view's 7d is purely a chip-counting window.
    const days = Math.max(1, opts.days ?? 30);
    const sinceMs = Date.now() - days * DAY_MS;
    const runIndex = buildRunIndex(stateRoot, sinceMs, new Set([row.answer_id]));
    const runMeta = runIndex.get(row.answer_id);
    const runRecord = readRunRecord(stateRoot, sinceMs, row.answer_id);

    const breadcrumbs = row.current_page_id
      ? loadBreadcrumbs(db, [row.current_page_id])
      : new Map<string, BreadcrumbNode[]>();

    const citations = parseRunCitations(row.retrieved);

    return {
      feedback_id: row.feedback_id,
      ts: new Date(row.created_at).toISOString(),
      rating: row.rating,
      signal_source: row.signal_source,
      question: row.question.length > 0 ? row.question : QUESTION_FALLBACK,
      answerId: row.answer_id,
      currentPageId: row.current_page_id,
      breadcrumb: row.current_page_id ? breadcrumbs.get(row.current_page_id) ?? null : null,
      confidence: runMeta?.confidence ?? null,
      hadNoCitations: runMeta?.citationsEmpty ?? null,
      answerMd: row.generated ?? '',
      citations,
      correction: row.correction ?? null,
      run: runRecord
        ? {
            kind: runRecord.answer.kind,
            fused: runRecord.retrieval.fused.map((f) => ({
              page: f.page,
              chunkId: f.chunk_id,
              finalScore: f.final_score ?? null,
              rrfScore: f.rrf_score ?? null,
              vecRank: f.vec_rank,
              bm25Rank: f.bm25_rank,
              navIndex: f.nav_index,
            })),
            subtreeAskTriggered: runRecord.retrieval.subtree_ask_triggered,
            latencyMs: runRecord.answer.latency_ms,
            model: runRecord.answer.model,
            errorCode: runRecord.answer.error_code,
          }
        : null,
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function readRunRecord(
  stateRoot: string,
  sinceMs: number,
  answerId: string,
): RunRecord | null {
  let latest: RunRecord | null = null;
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if ('type' in line && line.type === 'feedback-update') continue;
    const rec = line as RunRecord;
    if (rec.answer.answer_id !== answerId) continue;
    // Last write wins for re-asks; keep iterating to the end.
    latest = rec;
  }
  return latest;
}

function parseRunCitations(json: string | null): FeedbackRunCitationVM[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is { page: string; quote?: string; chunk_id?: number | null } =>
        typeof c?.page === 'string',
      )
      .map((c) => ({
        page: c.page,
        quote: typeof c.quote === 'string' ? c.quote : '',
        chunkId: typeof c.chunk_id === 'number' ? c.chunk_id : null,
      }));
  } catch {
    return [];
  }
}

export function parseFeedbackFilter(raw: unknown): FeedbackFilter {
  return typeof raw === 'string' && (FEEDBACK_FILTERS as readonly string[]).includes(raw)
    ? (raw as FeedbackFilter)
    : 'all';
}
