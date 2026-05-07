/**
 * On-disk file management for golden cases — both the candidate jsonl and
 * the approved cases.jsonl live under <stateRoot>/golden/, where stateRoot
 * is `<workspace>/state/<projectId>/` (ARCH §16.1 双根分离).
 *
 * Reads tolerate malformed lines (skip + warn count) so partial files from
 * crashed writes don't break tooling.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoldenCase, GoldenCaseCandidate } from './types.ts';

export type GoldenPaths = {
  dir: string;
  cases: string;
  candidates: string;
};

export function goldenPaths(stateRoot: string): GoldenPaths {
  const dir = join(stateRoot, 'golden');
  return {
    dir,
    cases: join(dir, 'cases.jsonl'),
    candidates: join(dir, 'cases.candidate.jsonl'),
  };
}

export function ensureGoldenDir(stateRoot: string): GoldenPaths {
  const paths = goldenPaths(stateRoot);
  if (!existsSync(paths.dir)) {
    mkdirSync(paths.dir, { recursive: true });
  }
  return paths;
}

export type ReadResult<T> = {
  rows: T[];
  malformed: number;
};

export function readCandidates(stateRoot: string): ReadResult<GoldenCaseCandidate> {
  const paths = goldenPaths(stateRoot);
  return readJsonl<GoldenCaseCandidate>(paths.candidates);
}

export function readApproved(stateRoot: string): ReadResult<GoldenCase> {
  const paths = goldenPaths(stateRoot);
  return readJsonl<GoldenCase>(paths.cases);
}

function readJsonl<T>(path: string): ReadResult<T> {
  if (!existsSync(path)) return { rows: [], malformed: 0 };
  const content = readFileSync(path, 'utf8');
  const rows: T[] = [];
  let malformed = 0;
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

/**
 * Overwrite cases.candidate.jsonl with `rows`. Used by `golden generate`.
 * Caller is responsible for the "file already exists, --force?" check.
 */
export function writeCandidates(stateRoot: string, rows: GoldenCaseCandidate[]): string {
  const paths = ensureGoldenDir(stateRoot);
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
  writeFileSync(paths.candidates, body, 'utf8');
  return paths.candidates;
}

/**
 * Append `rows` to cases.jsonl. Used by `golden review` to promote approved
 * candidates. Returns the path written.
 */
export function appendCases(stateRoot: string, rows: GoldenCase[]): string {
  const paths = ensureGoldenDir(stateRoot);
  if (rows.length === 0) return paths.cases;
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(paths.cases, body, 'utf8');
  return paths.cases;
}
