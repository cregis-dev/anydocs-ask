/**
 * `golden generate --from runs` — ARCH §16.5.3.
 *
 * Picks high-confidence successful runs as Golden regression candidates:
 *
 *   confidence ≥ 0.7
 *   AND no_re_ask_within_30s     (same-session edit-distance proxy)
 *   AND length(answer.md) ≤ 600
 *   AND answer.kind === 'answer' (not clarify/error)
 *
 * Then:
 *   1. Cluster by normalized query — keep the highest-confidence rep per
 *      cluster (no point seeding 5 near-duplicate candidates).
 *   2. Sort by confidence DESC.
 *   3. Apply --limit (default 50).
 *   4. Skip queries already covered by the project's approved cases.jsonl
 *      (Levenshtein ≤ 5 on normalized form).
 *
 * Each emitted candidate carries:
 *   - query           = the real user query
 *   - must_cite_pages = pages from that run's citations (deduped, ordered)
 *   - must_contain    = []  (no template / heading source — reviewer fills)
 *   - lang            = simple CJK-detect heuristic on the query
 *   - template_id     = 'from_runs'
 *
 * The reviewer reconciles the prefilled must_cite_pages (they reflect what
 * the system did, not necessarily what was correct) before approving.
 */

import { clusterByQuery, levenshteinAtMost, normalize } from '../analyze/cluster.ts';
import type { RunRecord } from '../runs/types.ts';
import type { GoldenCase, GoldenCaseCandidate } from './types.ts';

export type FromRunsOptions = {
  /** Hard floor on run.answer.confidence. ARCH §16.5.3 fixes 0.7. */
  minConfidence?: number;
  /** Cap on run.answer.md.length in chars. ARCH §16.5.3 fixes 600. */
  maxAnswerChars?: number;
  /** Re-ask exclusion window in ms; runs followed by a near-duplicate
   *  query in the same session within this window are dropped. */
  reaskWindowMs?: number;
  /** Maximum candidates to emit after clustering + dedup. */
  limit?: number;
  /** Existing approved cases — used to skip queries already covered. */
  existingCases?: GoldenCase[];
};

const DEFAULT_MIN_CONF = 0.7;
const DEFAULT_MAX_ANSWER = 600;
const DEFAULT_REASK_MS = 30_000;
const DEFAULT_LIMIT = 50;
const DEDUP_EDIT_DISTANCE = 5;

export type FromRunsStats = {
  /** Total runs in input window. */
  total: number;
  /** Dropped because kind!=='answer'. */
  droppedNonAnswer: number;
  /** Dropped because confidence < threshold. */
  droppedLowConf: number;
  /** Dropped because answer.md too long. */
  droppedLongAnswer: number;
  /** Dropped because same-session re-ask within window. */
  droppedReask: number;
  /** Dropped because already covered by existing approved cases. */
  droppedDuplicate: number;
  /** Distinct clusters formed from survivors. */
  clusters: number;
};

export type FromRunsResult = {
  candidates: GoldenCaseCandidate[];
  stats: FromRunsStats;
};

export function generateFromRuns(runs: RunRecord[], opts: FromRunsOptions = {}): FromRunsResult {
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONF;
  const maxAnswer = opts.maxAnswerChars ?? DEFAULT_MAX_ANSWER;
  const reaskMs = opts.reaskWindowMs ?? DEFAULT_REASK_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const existing = opts.existingCases ?? [];

  const stats: FromRunsStats = {
    total: runs.length,
    droppedNonAnswer: 0,
    droppedLowConf: 0,
    droppedLongAnswer: 0,
    droppedReask: 0,
    droppedDuplicate: 0,
    clusters: 0,
  };

  // Find request_ids that were re-asked within window (these are "the run
  // didn't satisfy" → exclude). Mirrors analyze D1 re-ask logic.
  const reasked = computeReaskedIds(runs, reaskMs);

  const survivors: RunRecord[] = [];
  for (const r of runs) {
    if (r.answer.kind !== 'answer') {
      stats.droppedNonAnswer++;
      continue;
    }
    if (r.answer.confidence < minConf) {
      stats.droppedLowConf++;
      continue;
    }
    if ((r.answer.md?.length ?? 0) > maxAnswer) {
      stats.droppedLongAnswer++;
      continue;
    }
    if (reasked.has(r.request_id)) {
      stats.droppedReask++;
      continue;
    }
    survivors.push(r);
  }

  if (survivors.length === 0) {
    return { candidates: [], stats };
  }

  const clusters = clusterByQuery(survivors, { queryOf: (r) => r.query });
  stats.clusters = clusters.length;

  // One rep per cluster: the run with the highest confidence (tie-break by
  // earliest ts so the result is stable across re-runs over the same data).
  const reps: RunRecord[] = clusters.map((c) =>
    [...c.items].sort((a, b) => {
      const dc = b.answer.confidence - a.answer.confidence;
      if (dc !== 0) return dc;
      return Date.parse(a.ts) - Date.parse(b.ts);
    })[0]!
  );

  // Sort all reps by confidence DESC then ts ASC for limit cut.
  reps.sort((a, b) => {
    const dc = b.answer.confidence - a.answer.confidence;
    if (dc !== 0) return dc;
    return Date.parse(a.ts) - Date.parse(b.ts);
  });

  const existingNorms = existing.map((e) => normalize(e.query));
  const candidates: GoldenCaseCandidate[] = [];
  for (const rep of reps) {
    if (candidates.length >= limit) break;
    const repNorm = normalize(rep.query);
    const dup = existingNorms.some(
      (en) => levenshteinAtMost(en, repNorm, DEDUP_EDIT_DISTANCE) <= DEDUP_EDIT_DISTANCE,
    );
    if (dup) {
      stats.droppedDuplicate++;
      continue;
    }
    candidates.push(toCandidate(rep));
    // Also dedup against just-accepted candidates so two run clusters that
    // are themselves near-duplicates don't both land.
    existingNorms.push(repNorm);
  }
  return { candidates, stats };
}

function toCandidate(r: RunRecord): GoldenCaseCandidate {
  const cited = uniqueOrdered(r.answer.citations.map((c) => c.page));
  const lang = detectLang(r.query);
  return {
    id: makeId(r),
    query: r.query,
    filters: {
      audience: typeof r.filters.audience === 'string' ? r.filters.audience : null,
      version: typeof r.filters.version === 'string' ? r.filters.version : null,
    },
    context_pageId: r.context_pageId,
    expected: {
      must_cite_pages: cited,
      must_contain: [],
      forbid_contain: [],
    },
    tags: [],
    created_by: 'runs',
    reviewed_at: null,
    reviewer: null,
    lang,
    decision: null,
    template_id: 'from_runs',
  };
}

/**
 * Stable id derived from the run: `runs:<8-hex-of-normalized-query>`. Stable
 * across re-runs over the same data; collisions across two runs with the
 * same normalized query collapse to one id, which is what we want (cluster
 * dedup already picked one rep — the id reflects that).
 */
function makeId(r: RunRecord): string {
  return `runs:${shortHash(normalize(r.query))}`;
}

function shortHash(s: string): string {
  // FNV-1a 32-bit; portable, no crypto dep needed for label hashing.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const CJK_RE = /[㐀-鿿豈-﫿]/;
function detectLang(query: string): 'zh' | 'en' {
  return CJK_RE.test(query) ? 'zh' : 'en';
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
 * request_ids whose run was re-asked in the same session within `windowMs`
 * with edit distance < 5 on the normalized query. Mirrors analyze D1.
 */
function computeReaskedIds(runs: RunRecord[], windowMs: number): Set<string> {
  const out = new Set<string>();
  const bySession = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (!r.session_id) continue;
    const arr = bySession.get(r.session_id) ?? [];
    arr.push(r);
    bySession.set(r.session_id, arr);
  }
  for (const session of bySession.values()) {
    session.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 0; i < session.length - 1; i++) {
      const a = session[i]!;
      const b = session[i + 1]!;
      if (Date.parse(b.ts) - Date.parse(a.ts) > windowMs) continue;
      const dist = levenshteinAtMost(normalize(a.query), normalize(b.query), DEDUP_EDIT_DISTANCE);
      if (dist < DEDUP_EDIT_DISTANCE) out.add(a.request_id);
    }
  }
  return out;
}
