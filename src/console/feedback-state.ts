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
import { isRunRecord, type RunRecord, type RunsLine } from '../runs/types.ts';

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
  /** RFC 0003 M6 — session_id of the linked run (preferred) or the feedback
   *  row's stored column (fallback). null when neither source has it —
   *  pre-multi-turn rows, or runs.jsonl rolled out of the window. The
   *  Feedback tab uses this to fold contiguous same-session rows into one
   *  conversation block. */
  sessionId: string | null;
  /** RFC 0003 M6 — number of prior turns this answer consumed (from
   *  `RunAnswer.history_window`). null on single-turn calls / pre-M4 rows
   *  / multiTurn.enabled=false. Drives the "history N" badge on grouped
   *  rows. */
  historyWindow: number | null;
  /** RFC 0003 M6 — 1-based position of this row inside its session, ordered
   *  by `created_at` ASC. Always 1 when `sessionId` is null (the row is
   *  treated as a standalone 1-turn session). */
  turnIndex: number;
  /** RFC 0003 M6 — total feedback rows observed for the same `sessionId`
   *  inside the same window. 1 when `sessionId` is null. */
  sessionTurnCount: number;
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

  // Window-wide session turn counts: position each feedback_id inside its
  // session, ordered by created_at ASC (feedback_id tiebreak) across the
  // whole window — not just the current filter / page — so a row's
  // "turn 2 of 3" label stays stable across chip switches. Includes
  // 'curated' rows: they share the session and should count toward the
  // dialogue length when present.
  const sessionTurnIndex = buildSessionTurnIndex(db, sinceMs, runIndex);

  const rows: FeedbackRowVM[] = rowsRaw.map((r) => {
    const runMeta = runIndex.get(r.answer_id);
    // Prefer runs.jsonl session_id (always populated by the ask pipeline);
    // fall back to feedback.session_id (γ rows write it, β explicit path
    // currently does not — see app.ts:308). Either source produces a
    // groupable sessionId for M6.
    const sessionId = runMeta?.sessionId ?? r.session_id ?? null;
    const meta = sessionId ? sessionTurnIndex.get(sessionId) : undefined;
    const turnIndex = meta ? meta.orderedIds.indexOf(r.feedback_id) + 1 : 1;
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
      sessionId,
      historyWindow: runMeta?.historyWindow ?? null,
      turnIndex: turnIndex > 0 ? turnIndex : 1,
      sessionTurnCount: meta ? meta.orderedIds.length : 1,
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
  /** RFC 0003 M6 — session_id from the linked run line. Always present on
   *  the run record (legacy rows may be null pre-RFC 0001 S5). Used by the
   *  Feedback tab to fold same-session rows even when the feedback table
   *  column is null (e.g. β explicit insert path which never wrote it). */
  sessionId: string | null;
  /** RFC 0003 M6 — `RunAnswer.history_window`. null on single-turn / legacy
   *  rows / multiTurn.enabled=false. */
  historyWindow: number | null;
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
    if (!isRunRecord(line)) continue;
    const rec = line;
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
      sessionId: rec.session_id ?? null,
      historyWindow:
        typeof rec.answer.history_window === 'number' ? rec.answer.history_window : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session turn index (RFC 0003 M6)
// ---------------------------------------------------------------------------

type SessionTurnMeta = {
  /** feedback_ids ordered by (created_at ASC, feedback_id ASC) within the
   *  session. Position +1 = turnIndex. Length = sessionTurnCount. */
  orderedIds: number[];
};

/**
 * Build a window-wide session_id → turn-ordered feedback_ids map. Used by
 * the Feedback tab's M6 grouping so a row's "turn N of M" label is stable
 * regardless of which chip filter is active or how the list is paged.
 *
 * Sources `session_id` from the feedback column when present (γ + curated
 * rows write it directly) and falls back to runs.jsonl JOIN for β explicit
 * rows whose insert path never persisted it (see app.ts:308).
 *
 * Rows whose effective session_id is null are not included — they render
 * as standalone 1-turn entries.
 */
function buildSessionTurnIndex(
  db: ReturnType<typeof openDatabase>,
  sinceMs: number,
  runIndex: Map<string, RunIndexEntry>,
): Map<string, SessionTurnMeta> {
  const rows = db
    .prepare(
      `SELECT feedback_id, answer_id, session_id, created_at
         FROM feedback
        WHERE created_at >= ?
        ORDER BY created_at ASC, feedback_id ASC`,
    )
    .all(sinceMs) as Array<{
      feedback_id: number;
      answer_id: string;
      session_id: string | null;
      created_at: number;
    }>;
  const out: Map<string, SessionTurnMeta> = new Map();
  for (const r of rows) {
    const sid = r.session_id ?? runIndex.get(r.answer_id)?.sessionId ?? null;
    if (!sid) continue;
    let meta = out.get(sid);
    if (!meta) {
      meta = { orderedIds: [] };
      out.set(sid, meta);
    }
    meta.orderedIds.push(r.feedback_id);
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
  /** RFC 0003 M6 — same fields as `FeedbackRowVM`. The drawer surfaces
   *  these in the META row + a "session turns" panel when sessionTurnCount > 1. */
  sessionId: string | null;
  historyWindow: number | null;
  turnIndex: number;
  sessionTurnCount: number;
  /** RFC 0003 M6 — peer turns inside the same session (within the lookup
   *  window). Excludes the current row. Empty when sessionTurnCount ≤ 1.
   *  Ordered by created_at ASC. Lets the drawer render a "jump to turn N"
   *  strip without re-fetching the full list. */
  sessionTurns: Array<{
    feedback_id: number;
    turnIndex: number;
    ts: string;
    question: string;
    rating: number | null;
    signal_source: 'explicit' | 'implicit' | 'curated';
    historyWindow: number | null;
  }>;
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

    const sessionId = runMeta?.sessionId ?? row.session_id ?? null;
    const { turnIndex, sessionTurnCount, sessionTurns } = sessionId
      ? loadSessionTurns(db, stateRoot, sinceMs, sessionId, row.feedback_id, runIndex)
      : { turnIndex: 1, sessionTurnCount: 1, sessionTurns: [] };

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
      sessionId,
      historyWindow: runMeta?.historyWindow ?? null,
      turnIndex,
      sessionTurnCount,
      sessionTurns,
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

/**
 * Pull all feedback rows in the window for a given session_id and assemble
 * the drawer's "session turns" panel + the current row's `turnIndex` within
 * that session. Falls back to runs.jsonl JOIN to pick up β explicit rows
 * whose feedback.session_id column is null.
 *
 * The runs JOIN scan is bounded — the drawer's window default is 30d (vs
 * the list's 7d), so we cap it the same way as `buildRunIndex`.
 */
function loadSessionTurns(
  db: ReturnType<typeof openDatabase>,
  stateRoot: string,
  sinceMs: number,
  sessionId: string,
  currentFeedbackId: number,
  currentRunIndex: Map<string, RunIndexEntry>,
): {
  turnIndex: number;
  sessionTurnCount: number;
  sessionTurns: FeedbackRowDetail['sessionTurns'];
} {
  // Pull rows whose feedback.session_id column already matches. β explicit
  // rows with a null column show up via the runs JOIN below.
  const direct = db
    .prepare(
      `SELECT feedback_id, answer_id, session_id, created_at, question, rating, signal_source
         FROM feedback
        WHERE created_at >= ? AND session_id = ?
        ORDER BY created_at ASC, feedback_id ASC`,
    )
    .all(sinceMs, sessionId) as Array<{
      feedback_id: number;
      answer_id: string;
      session_id: string;
      created_at: number;
      question: string;
      rating: number | null;
      signal_source: 'explicit' | 'implicit' | 'curated';
    }>;
  const seen = new Set<number>(direct.map((r) => r.feedback_id));

  // Collect candidate session_id values from runs.jsonl (filter by session
  // first to avoid scanning the whole window's answer_ids). Then look up
  // their feedback rows by answer_id.
  const sessionAnswerIds: Set<string> = new Set();
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if (!isRunRecord(line)) continue;
    const rec = line;
    if (rec.session_id !== sessionId) continue;
    if (rec.answer.answer_id) sessionAnswerIds.add(rec.answer.answer_id);
  }
  let indirect: Array<{
    feedback_id: number;
    answer_id: string;
    created_at: number;
    question: string;
    rating: number | null;
    signal_source: 'explicit' | 'implicit' | 'curated';
  }> = [];
  if (sessionAnswerIds.size > 0) {
    const placeholders = Array(sessionAnswerIds.size).fill('?').join(',');
    indirect = db
      .prepare(
        `SELECT feedback_id, answer_id, created_at, question, rating, signal_source
           FROM feedback
          WHERE created_at >= ? AND answer_id IN (${placeholders})`,
      )
      .all(sinceMs, ...sessionAnswerIds) as typeof indirect;
  }

  // Need history_window per answer_id — pull from runs JOIN for all
  // referenced answer_ids in one walk (re-use buildRunIndex on the merged
  // answer set so a row's metadata is consistent with the list view).
  const allAnswerIds = new Set<string>([
    ...direct.map((r) => r.answer_id),
    ...indirect.map((r) => r.answer_id),
  ]);
  const runIndex =
    allAnswerIds.size <= currentRunIndex.size && [...allAnswerIds].every((a) => currentRunIndex.has(a))
      ? currentRunIndex
      : buildRunIndex(stateRoot, sinceMs, allAnswerIds);

  type Row = {
    feedback_id: number;
    answer_id: string;
    created_at: number;
    question: string;
    rating: number | null;
    signal_source: 'explicit' | 'implicit' | 'curated';
  };
  const merged: Row[] = [...direct];
  for (const r of indirect) {
    if (seen.has(r.feedback_id)) continue;
    seen.add(r.feedback_id);
    merged.push(r);
  }
  merged.sort((a, b) => a.created_at - b.created_at || a.feedback_id - b.feedback_id);

  const turnIndex =
    merged.findIndex((r) => r.feedback_id === currentFeedbackId) + 1 || 1;
  const sessionTurns = merged
    .filter((r) => r.feedback_id !== currentFeedbackId)
    .map((r) => ({
      feedback_id: r.feedback_id,
      turnIndex: merged.findIndex((m) => m.feedback_id === r.feedback_id) + 1,
      ts: new Date(r.created_at).toISOString(),
      question: r.question.length > 0 ? r.question : QUESTION_FALLBACK,
      rating: r.rating,
      signal_source: r.signal_source,
      historyWindow: runIndex.get(r.answer_id)?.historyWindow ?? null,
    }));
  return {
    turnIndex,
    sessionTurnCount: merged.length || 1,
    sessionTurns,
  };
}

function readRunRecord(
  stateRoot: string,
  sinceMs: number,
  answerId: string,
): RunRecord | null {
  let latest: RunRecord | null = null;
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if (!isRunRecord(line)) continue;
    const rec = line;
    if (rec.answer.answer_id !== answerId) continue;
    // Last write wins for re-asks; keep iterating to the end.
    latest = rec;
  }
  return latest;
}

/**
 * Decode `feedback.retrieved` (JSON-encoded citation snapshot) into the
 * drawer's view-model shape.
 *
 * F8 (dogfood 2026-05-23): two parallel citation schemas exist in the
 * codebase:
 *   - `Citation` from src/query/types.ts — `.page_id` + `.snippet`
 *     (β handler writes this into feedback.retrieved at insert time)
 *   - `RunCitation` from src/runs/types.ts — `.page` + `.quote`
 *     (runs.jsonl writer + analyzer use this)
 *
 * Pre-F8 the parser only honoured RunCitation's `.page`, so every β row
 * with a populated retrieved column rendered as "no citations on this
 * answer" in the drawer. Fix: prefer the RunCitation field names (since
 * runs.jsonl is the canonical trace source), fall back to Citation
 * fields when the input was written by the β path.
 */
function parseRunCitations(json: string | null): FeedbackRunCitationVM[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: FeedbackRunCitationVM[] = [];
    for (const c of parsed) {
      if (typeof c !== 'object' || c === null) continue;
      const o = c as Record<string, unknown>;
      const page =
        typeof o.page === 'string'
          ? o.page
          : typeof o.page_id === 'string'
            ? o.page_id
            : null;
      if (page === null) continue;
      const quote =
        typeof o.quote === 'string'
          ? o.quote
          : typeof o.snippet === 'string'
            ? o.snippet
            : '';
      out.push({
        page,
        quote,
        chunkId: typeof o.chunk_id === 'number' ? o.chunk_id : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseFeedbackFilter(raw: unknown): FeedbackFilter {
  return typeof raw === 'string' && (FEEDBACK_FILTERS as readonly string[]).includes(raw)
    ? (raw as FeedbackFilter)
    : 'all';
}
