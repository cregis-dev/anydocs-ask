/**
 * Console-side Feedback tab state helpers — RFC 0002 T1-a.
 *
 * 0.2.0-alpha.1 T1-a is intentionally just a tab skeleton: only the two
 * empty-shaped states from console-redesign-brief §7.5.1 are wired:
 *   1. disabled  — `feedback.enabled = false` (the PRD §11.4 #6 default).
 *   2. enabled, no data — switch flipped on but the feedback table is empty.
 *
 * KPI calculation, list rendering, and detail drawer ship in T1-b. This
 * snapshot stays minimal on purpose; the page only needs to know which
 * empty state to render.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db/index.ts';

export type FeedbackTabSnapshot = {
  /** `feedback.enabled` from anydocs.ask.json (PRD §11.4 #6 — defaults false). */
  enabled: boolean;
  /** COUNT(*) from feedback table; 0 when DB or table absent. */
  totalCount: number;
};

/**
 * Minimal slice of `ResolvedConfig` we need so callers can pass either the
 * full config or a stub in tests.
 */
export type FeedbackConfigSlice = {
  feedback: { enabled: boolean };
};

export function loadFeedbackTabSnapshot(
  stateRoot: string | null,
  projectConfig: FeedbackConfigSlice,
): FeedbackTabSnapshot {
  return {
    enabled: projectConfig.feedback.enabled === true,
    totalCount: stateRoot ? readFeedbackCount(stateRoot) : 0,
  };
}

function readFeedbackCount(stateRoot: string): number {
  if (!existsSync(join(stateRoot, 'index.db'))) return 0;
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase({ stateRoot, skipMigrations: true });
  } catch {
    return 0;
  }
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM feedback`)
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    // Migration 001 creates `feedback`; a DB without it is malformed but we
    // surface 0 rather than crash the project page.
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
