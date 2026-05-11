/**
 * Eval workflow state helpers for the dev console — ARCH §17.3.1
 * /p/:name eval tab.
 *
 * Pure read/parse helpers + pin-baseline pointer file management. The
 * eval CLI itself is NOT modified: console reads the pinned baseline,
 * resolves it to an absolute path, and passes it as `baselinePath` to
 * `runEval()`. CLI users without a pin keep the historical default
 * ("compare against latest prior eval report").
 *
 * Pin pointer schema (`<state>/golden/eval-baseline.json`):
 *   { "filename": "2026-05-08-eval.md", "pinnedAt": "2026-05-10T..." }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readApproved } from '../golden/store.ts';
import type { GoldenCase } from '../golden/types.ts';

// ----------------------------------------------------------------------
// pin-baseline pointer
// ----------------------------------------------------------------------

export type PinnedBaseline = {
  filename: string;
  pinnedAt: string;
};

const EVAL_REPORT_RE = /^\d{4}-\d{2}-\d{2}-eval\.md$/;

export function pinBaselinePath(stateRoot: string): string {
  return join(stateRoot, 'golden', 'eval-baseline.json');
}

export function readPinnedBaseline(stateRoot: string): PinnedBaseline | null {
  const p = pinBaselinePath(stateRoot);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as PinnedBaseline;
    if (typeof data.filename !== 'string' || !EVAL_REPORT_RE.test(data.filename)) {
      return null;
    }
    // Make sure the file the pin references still exists; broken pin =
    // soft-null (don't error, just behave as if unpinned).
    if (!existsSync(join(stateRoot, 'reports', data.filename))) return null;
    return data;
  } catch {
    return null;
  }
}

export function writePinnedBaseline(stateRoot: string, filename: string): PinnedBaseline {
  if (!EVAL_REPORT_RE.test(filename)) {
    throw new Error(`invalid eval report filename: ${filename}`);
  }
  if (!existsSync(join(stateRoot, 'reports', filename))) {
    throw new Error(`report not found: ${filename}`);
  }
  const dir = join(stateRoot, 'golden');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const pin: PinnedBaseline = { filename, pinnedAt: new Date().toISOString() };
  writeFileSync(pinBaselinePath(stateRoot), JSON.stringify(pin, null, 2) + '\n', 'utf8');
  return pin;
}

export function clearPinnedBaseline(stateRoot: string): boolean {
  const p = pinBaselinePath(stateRoot);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

// ----------------------------------------------------------------------
// eval report history parsing
// ----------------------------------------------------------------------

export type EvalReportSummary = {
  filename: string;
  date: string;
  /** Mean of three metrics (R@5, Citation-pass, Answer-rule-pass). null = could not parse. */
  r_at_5: number | null;
  citation_pass: number | null;
  answer_rule_pass: number | null;
  /** Approx case count parsed from the report header. null = unparseable. */
  cases: number | null;
  /** Bytes — useful for stale-pin debugging. */
  sizeBytes: number;
};

export function listEvalReports(stateRoot: string): EvalReportSummary[] {
  const dir = join(stateRoot, 'reports');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => EVAL_REPORT_RE.test(f))
    .sort()
    .reverse(); // newest first
  return files.map((f) => parseEvalReport(stateRoot, f));
}

export function parseEvalReport(stateRoot: string, filename: string): EvalReportSummary {
  const path = join(stateRoot, 'reports', filename);
  const date = filename.slice(0, 10);
  const summary: EvalReportSummary = {
    filename,
    date,
    r_at_5: null,
    citation_pass: null,
    answer_rule_pass: null,
    cases: null,
    sizeBytes: 0,
  };
  if (!existsSync(path)) return summary;
  const text = readFileSync(path, 'utf8');
  summary.sizeBytes = statSync(path).size;
  // EVAL_SUMMARY embed produced by eval.ts:renderReport.
  const m = text.match(/<!--\s*EVAL_SUMMARY\s+(\{[\s\S]*?\})\s*-->/);
  if (m) {
    try {
      const data = JSON.parse(m[1]!) as {
        date: string;
        summary: { n: number; r_at_5: number; citation_pass: number; answer_rule_pass: number };
      };
      summary.r_at_5 = data.summary.r_at_5;
      summary.citation_pass = data.summary.citation_pass;
      summary.answer_rule_pass = data.summary.answer_rule_pass;
      summary.cases = data.summary.n;
    } catch {
      // fall through with nulls
    }
  }
  return summary;
}

export function readReportBody(stateRoot: string, filename: string): string | null {
  if (!EVAL_REPORT_RE.test(filename)) return null;
  const path = join(stateRoot, 'reports', filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

// ----------------------------------------------------------------------
// golden 题集 stats
// ----------------------------------------------------------------------

export type GoldenSetStats = {
  totalCases: number;
  byLang: Record<string, number>;
  byTag: Record<string, number>;
  byCreatedBy: Record<string, number>;
  lastEditISO: string | null;
  malformed: number;
};

export function loadGoldenStats(stateRoot: string): GoldenSetStats {
  const { rows, malformed } = readApproved(stateRoot);
  const byLang: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  const byCreatedBy: Record<string, number> = {};
  for (const c of rows) {
    byLang[c.lang] = (byLang[c.lang] ?? 0) + 1;
    byCreatedBy[c.created_by] = (byCreatedBy[c.created_by] ?? 0) + 1;
    for (const t of c.tags ?? []) {
      byTag[t] = (byTag[t] ?? 0) + 1;
    }
  }
  const casesPath = join(stateRoot, 'golden', 'cases.jsonl');
  let lastEditISO: string | null = null;
  if (existsSync(casesPath)) {
    lastEditISO = new Date(statSync(casesPath).mtimeMs).toISOString();
  }
  // Use rows to keep type happy
  void (rows as GoldenCase[]);
  return {
    totalCases: rows.length,
    byLang,
    byTag,
    byCreatedBy,
    lastEditISO,
    malformed,
  };
}

// ----------------------------------------------------------------------
// composite snapshot used by the eval tab
// ----------------------------------------------------------------------

export type EvalTabSnapshot = {
  goldenStats: GoldenSetStats;
  history: EvalReportSummary[];
  latest: EvalReportSummary | null;
  pinned: PinnedBaseline | null;
  pinnedSummary: EvalReportSummary | null;
};

export function loadEvalSnapshot(stateRoot: string): EvalTabSnapshot {
  const goldenStats = loadGoldenStats(stateRoot);
  const history = listEvalReports(stateRoot);
  const latest = history[0] ?? null;
  const pinned = readPinnedBaseline(stateRoot);
  const pinnedSummary =
    pinned && history.find((h) => h.filename === pinned.filename)
      ? (history.find((h) => h.filename === pinned.filename) ?? null)
      : null;
  return { goldenStats, history, latest, pinned, pinnedSummary };
}
