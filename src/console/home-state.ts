/**
 * Console-side Home page extra stats — ARCH §17.3.8.
 *
 * Per-project tiny summaries (cases / last eval / runs 7d / last
 * activity) for the project grid. Cheap, disk-only; no DB.
 *
 * Workspace-level aggregation lives in summarizeWorkspace() — sums up
 * the per-project stats for the strip at the top of the page.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectListing } from '../workspace.ts';
import { listEvalReports } from './eval-state.ts';
import { loadTrafficWindow } from './traffic-state.ts';
import { readApproved } from '../golden/store.ts';
import { resolveStateRoot } from '../workspace.ts';

export type ProjectHomeStats = {
  cases: number;
  lastEvalDate: string | null;
  runs7d: number;
  /** Date string (YYYY-MM-DD) of most recent visible activity, or null. */
  lastActivity: string | null;
};

export function loadProjectHomeStats(
  workspacePath: string,
  project: ProjectListing,
): ProjectHomeStats {
  const empty: ProjectHomeStats = {
    cases: 0,
    lastEvalDate: null,
    runs7d: 0,
    lastActivity: null,
  };
  if (!project.valid || !project.projectId) return empty;
  const stateRoot = resolveStateRoot(workspacePath, project.projectId);
  if (!existsSync(stateRoot)) return empty;

  let cases = 0;
  try {
    cases = readApproved(stateRoot).rows.length;
  } catch {
    // ignore — no cases.jsonl yet
  }

  const evalReports = listEvalReports(stateRoot);
  const lastEvalDate = evalReports[0]?.date ?? null;

  let runs7d = 0;
  let lastRunISO: string | null = null;
  try {
    const window = loadTrafficWindow(stateRoot, 7);
    runs7d = window.records.length;
    if (window.records.length > 0) {
      lastRunISO = window.records[window.records.length - 1]!.ts;
    }
  } catch {
    // ignore — no runs yet
  }

  const lastRunDate = lastRunISO ? lastRunISO.slice(0, 10) : null;
  const lastActivity = pickLatest([lastEvalDate, lastRunDate, indexMtimeDate(stateRoot, project)]);

  return { cases, lastEvalDate, runs7d, lastActivity };
}

function indexMtimeDate(stateRoot: string, project: ProjectListing): string | null {
  // Last time the on-disk pages/ tree was touched. Cheap proxy for
  // "did the author edit content recently?".
  const pagesDir = join(project.path, 'pages');
  if (!existsSync(pagesDir)) return null;
  try {
    const mt = statSync(pagesDir).mtimeMs;
    return new Date(mt).toISOString().slice(0, 10);
  } catch {
    return null;
  }
  void stateRoot;
}

function pickLatest(dates: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!latest || d > latest) latest = d;
  }
  return latest;
}

// ---------------------------------------------------------------------
// Workspace aggregate strip
// ---------------------------------------------------------------------

export type WorkspaceSummary = {
  projectsTotal: number;
  projectsValid: number;
  projectsIndexed: number;
  projectsRunning: number;
  totalCases: number;
  totalRuns7d: number;
  /** Project name with most recent activity, or null. */
  mostRecentProject: string | null;
};

export function summarizeWorkspace(
  workspacePath: string,
  projects: ProjectListing[],
  running: Set<string>,
  perProject: Map<string, ProjectHomeStats>,
): WorkspaceSummary {
  void workspacePath;
  let totalCases = 0;
  let totalRuns7d = 0;
  let mostRecentDate: string | null = null;
  let mostRecentProject: string | null = null;
  let projectsValid = 0;
  let projectsIndexed = 0;
  for (const p of projects) {
    if (p.valid) projectsValid++;
    if (p.indexed) projectsIndexed++;
    const s = perProject.get(p.name);
    if (!s) continue;
    totalCases += s.cases;
    totalRuns7d += s.runs7d;
    if (s.lastActivity && (!mostRecentDate || s.lastActivity > mostRecentDate)) {
      mostRecentDate = s.lastActivity;
      mostRecentProject = p.name;
    }
  }
  return {
    projectsTotal: projects.length,
    projectsValid,
    projectsIndexed,
    projectsRunning: running.size,
    totalCases,
    totalRuns7d,
    mostRecentProject,
  };
}
