/**
 * Console-side Golden Workshop state — ARCH §17.3.4 (extended 2026-05-11).
 *
 * Read + mutate helpers around `<state>/golden/cases.candidate.jsonl`:
 *   - listPendingCandidates: rows with decision=null (the work queue)
 *   - decideCandidate: stamp decision="approved"|"rejected" on one row
 *   - flushApproved: thin wrapper over golden/reviewer.ts:reviewCandidates
 *
 * **PRD §13.6 第 4 行 v1 锁 (Golden 候选 in-UI 审阅 = 不做) 在 2026-05-12
 *   被破** — console 写 cases.candidate.jsonl 的 decision 字段。文件优先
 *   原则未破：候选 + 已批准都仍是 jsonl 文件、CLI `golden review` 仍能
 *   平行工作。console 只是替代了"在编辑器手改 decision"这一步。
 */

import { readCandidates, writeCandidates } from '../golden/store.ts';
import { reviewCandidates, type ReviewSummary } from '../golden/reviewer.ts';
import type { GoldenCaseCandidate, GoldenDecision } from '../golden/types.ts';

export type CandidateSnapshot = {
  total: number;
  pending: GoldenCaseCandidate[];
  approved: number;
  rejected: number;
  malformed: number;
};

export function loadCandidates(stateRoot: string): CandidateSnapshot {
  const { rows, malformed } = readCandidates(stateRoot);
  const pending: GoldenCaseCandidate[] = [];
  let approved = 0;
  let rejected = 0;
  for (const r of rows) {
    if (r.decision === 'approved') approved++;
    else if (r.decision === 'rejected') rejected++;
    else pending.push(r);
  }
  return {
    total: rows.length,
    pending,
    approved,
    rejected,
    malformed,
  };
}

export type DecideResult =
  | { ok: true; before: GoldenDecision; after: GoldenDecision }
  | { ok: false; error: string };

export function decideCandidate(
  stateRoot: string,
  id: string,
  decision: GoldenDecision,
): DecideResult {
  if (decision !== null && decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, error: `invalid decision: ${String(decision)}` };
  }
  const { rows } = readCandidates(stateRoot);
  let target: GoldenCaseCandidate | undefined;
  for (const r of rows) {
    if (r.id === id) {
      target = r;
      break;
    }
  }
  if (!target) return { ok: false, error: `candidate not found: ${id}` };
  const before = target.decision;
  target.decision = decision;
  writeCandidates(stateRoot, rows);
  return { ok: true, before, after: decision };
}

export function flushApproved(
  stateRoot: string,
  reviewer: string | null = 'console',
): ReviewSummary {
  return reviewCandidates(stateRoot, { reviewer });
}
