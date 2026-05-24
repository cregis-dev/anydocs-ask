/**
 * RFC 0006 A7 alpha.3 — A+ suggestions loader for Studio Feedback tab.
 *
 * Reads cluster trace JSON files written by [[runDiagnosePipeline]] under
 * `<stateRoot>/feedback/suggestions/{c_*.json,.shadow/c_*.json}` and projects
 * them into a UI view-model the Feedback tab consumes for:
 *   - KPI tile `A+ candidates`   (count, shadow flag)
 *   - filter chip `aplus_candidates` (set of feedback_ids in any cluster)
 *   - drawer SUGGESTION section (cluster_id / peer queries / md path)
 *
 * Pure read-side; malformed JSON → entry skipped (best-effort, with stderr
 * warn). Missing dir → empty result. Shadow + enabled are read together so
 * the KPI tile can flag mode.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type SuggestionEntry = {
  clusterId: string;
  /** Cluster center question (RFC §4.2). */
  centerQuestion: string;
  /** feedback.feedback_id values that participate in this cluster. */
  members: number[];
  /** Same length as `members`, by index. */
  memberQuestions: string[];
  /** Cluster size = members.length (denormalized for callers). */
  size: number;
  /** Average pairwise cosine within cluster, from cluster trace. */
  density: number;
  /** True when the trace lived under `.shadow/`. */
  shadow: boolean;
  /** Absolute filesystem path to the `c_*.md` companion file. */
  markdownPath: string;
  /** Absolute filesystem path to the `c_*.json` trace file. */
  tracePath: string;
};

export type SuggestionsSnapshot = {
  /** All entries from both dirs, deduplicated by clusterId. Shadow loses to
   *  enabled on collision (operator may have manually promoted a shadow run). */
  entries: SuggestionEntry[];
  /** True when `<stateRoot>/feedback/suggestions/c_*.json` exists.
   *  Distinguishes "shadow-only" from "enabled-run" output. */
  hasEnabled: boolean;
  /** True when `<stateRoot>/feedback/suggestions/.shadow/c_*.json` exists. */
  hasShadow: boolean;
  /** Lookup: feedback_id → clusterId. Used for the filter chip + drawer
   *  to color rows that participated in a cluster. */
  memberIndex: Map<number, string>;
};

/**
 * Best-effort scan + parse. Returns an empty snapshot when stateRoot is null,
 * the suggestions dir is missing, or every file failed to parse.
 */
export function loadSuggestions(stateRoot: string | null): SuggestionsSnapshot {
  const empty: SuggestionsSnapshot = {
    entries: [],
    hasEnabled: false,
    hasShadow: false,
    memberIndex: new Map(),
  };
  if (!stateRoot) return empty;

  const baseDir = join(stateRoot, 'feedback', 'suggestions');
  if (!existsSync(baseDir)) return empty;

  const enabledEntries = readDir(baseDir, false);
  const shadowEntries = readDir(join(baseDir, '.shadow'), true);

  const byId = new Map<string, SuggestionEntry>();
  for (const e of shadowEntries) {
    byId.set(e.clusterId, e);
  }
  for (const e of enabledEntries) {
    byId.set(e.clusterId, e); // enabled overrides shadow on collision
  }

  const entries = Array.from(byId.values()).sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    if (a.density !== b.density) return b.density - a.density;
    return a.clusterId.localeCompare(b.clusterId);
  });

  const memberIndex = new Map<number, string>();
  for (const e of entries) {
    for (const fid of e.members) {
      memberIndex.set(fid, e.clusterId);
    }
  }

  return {
    entries,
    hasEnabled: enabledEntries.length > 0,
    hasShadow: shadowEntries.length > 0,
    memberIndex,
  };
}

function readDir(dir: string, shadow: boolean): SuggestionEntry[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SuggestionEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (!name.startsWith('c_')) continue;
    const tracePath = join(dir, name);
    const mdPath = join(dir, name.slice(0, -'.json'.length) + '.md');
    const parsed = parseTrace(tracePath);
    if (!parsed) continue;
    out.push({ ...parsed, shadow, markdownPath: mdPath, tracePath });
  }
  return out;
}

type RawTrace = {
  cluster_id: string;
  size: number;
  density: number;
  center_question: string;
  center_feedback_id: number;
  members: number[];
  member_questions: string[];
};

function parseTrace(
  path: string,
): Omit<SuggestionEntry, 'shadow' | 'markdownPath' | 'tracePath'> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    process.stderr.write(`[ask/suggestions] malformed JSON, skipping: ${path}\n`);
    return null;
  }
  if (!isRawTrace(raw)) {
    process.stderr.write(`[ask/suggestions] missing required fields, skipping: ${path}\n`);
    return null;
  }
  return {
    clusterId: raw.cluster_id,
    centerQuestion: raw.center_question,
    members: raw.members,
    memberQuestions: raw.member_questions,
    size: raw.size,
    density: raw.density,
  };
}

function isRawTrace(v: unknown): v is RawTrace {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.cluster_id === 'string' &&
    o.cluster_id.length > 0 &&
    typeof o.size === 'number' &&
    typeof o.density === 'number' &&
    typeof o.center_question === 'string' &&
    typeof o.center_feedback_id === 'number' &&
    Array.isArray(o.members) &&
    o.members.every((x) => typeof x === 'number') &&
    Array.isArray(o.member_questions) &&
    o.member_questions.every((x) => typeof x === 'string')
  );
}

/**
 * Read the suggestion markdown body. Returns null when the file is missing
 * or unreadable; callers should fall back to "(suggestion file unavailable)".
 */
export function readSuggestionMarkdown(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
