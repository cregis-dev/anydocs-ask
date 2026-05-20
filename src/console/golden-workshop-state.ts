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
import { detectLangForQuery, makeIdFromQuery } from '../golden/generator-from-runs.ts';
import { isDocsLang, type DocsLang } from '../anydocs/types.ts';
import type {
  GoldenCaseCandidate,
  GoldenCaseExpected,
  GoldenDecision,
} from '../golden/types.ts';

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

/**
 * Fields the in-UI edit modal is allowed to mutate. Provenance / template /
 * decision / reviewer fields stay read-only — they document where a row came
 * from and what the workshop flow did with it; an "edit" shouldn't rewrite
 * that history. Use decideCandidate() for decision flips, flushApproved()
 * for review promotion.
 */
export type CandidateUpdate = {
  query?: string;
  lang?: string;
  context_pageId?: string | null;
  tags?: string[];
  filters?: { audience?: string | null; version?: string | null };
  expected?: Partial<GoldenCaseExpected>;
  note?: string | null;
};

export type UpdateResult =
  | { ok: true; updated: GoldenCaseCandidate }
  | { ok: false; error: string };

export function updateCandidate(
  stateRoot: string,
  id: string,
  patch: CandidateUpdate,
): UpdateResult {
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'id required' };
  }
  const { rows } = readCandidates(stateRoot);
  const target = rows.find((r) => r.id === id);
  if (!target) return { ok: false, error: `candidate not found: ${id}` };

  if (patch.query !== undefined) {
    if (typeof patch.query !== 'string' || patch.query.trim().length === 0) {
      return { ok: false, error: 'query must be a non-empty string' };
    }
    target.query = patch.query;
  }
  if (patch.lang !== undefined) {
    if (!isDocsLang(patch.lang)) {
      return { ok: false, error: `lang must be one of zh|en (got ${String(patch.lang)})` };
    }
    target.lang = patch.lang;
  }
  if (patch.context_pageId !== undefined) {
    if (patch.context_pageId === null || patch.context_pageId === '') {
      target.context_pageId = null;
    } else if (typeof patch.context_pageId === 'string') {
      target.context_pageId = patch.context_pageId;
    } else {
      return { ok: false, error: 'context_pageId must be a string or null' };
    }
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.some((t) => typeof t !== 'string')) {
      return { ok: false, error: 'tags must be string[]' };
    }
    target.tags = patch.tags;
  }
  if (patch.filters !== undefined) {
    const f = patch.filters;
    const next: { audience?: string | null; version?: string | null } = {};
    if (f.audience !== undefined) next.audience = f.audience === '' ? null : f.audience;
    if (f.version !== undefined) next.version = f.version === '' ? null : f.version;
    target.filters = { ...target.filters, ...next };
  }
  if (patch.expected !== undefined) {
    const e = patch.expected;
    const arrField = (k: 'must_cite_pages' | 'must_contain' | 'forbid_contain'): string | null => {
      const v = e[k];
      if (v === undefined) return null;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        return `expected.${k} must be string[]`;
      }
      target.expected[k] = v;
      return null;
    };
    for (const k of ['must_cite_pages', 'must_contain', 'forbid_contain'] as const) {
      const err = arrField(k);
      if (err) return { ok: false, error: err };
    }
  }
  if (patch.note !== undefined) {
    if (patch.note === null || patch.note === '') {
      delete target.note;
    } else if (typeof patch.note === 'string') {
      target.note = patch.note;
    } else {
      return { ok: false, error: 'note must be a string or null' };
    }
  }

  writeCandidates(stateRoot, rows);
  return { ok: true, updated: target };
}

/**
 * RFC 0002 T2 — Console "Traffic → Golden" cross-journey jump.
 *
 * Promotes a single live run into a pending Golden candidate. Mirrors what
 * `golden generate --from runs` does for a batch, but for one row at the
 * author's explicit click. Idempotent on the same normalized query: a second
 * click on the same run returns the existing candidate with isNew=false.
 *
 * Decision PRD §11.2 ③ stays intact: the new row lands in pending list with
 * decision=null; the author still reviews via the existing approve/reject
 * flow (or the file + git path). This endpoint just removes the "copy query,
 * switch tabs, paste" friction.
 */
export type CreateFromRunInput = {
  query: string;
  context_pageId?: string | null;
  citation_pages?: string[];
  filters?: { audience?: string | null; version?: string | null };
  lang?: DocsLang;
};

export type CreateFromRunResult =
  | { ok: true; created: GoldenCaseCandidate; isNew: boolean }
  | { ok: false; error: string };

export function createCandidateFromRun(
  stateRoot: string,
  input: CreateFromRunInput,
): CreateFromRunResult {
  if (typeof input.query !== 'string' || input.query.trim().length === 0) {
    return { ok: false, error: 'query required (non-empty string)' };
  }
  if (input.lang !== undefined && !isDocsLang(input.lang)) {
    return { ok: false, error: `lang must be one of zh|en (got ${String(input.lang)})` };
  }
  if (input.citation_pages !== undefined) {
    if (!Array.isArray(input.citation_pages) || input.citation_pages.some((p) => typeof p !== 'string')) {
      return { ok: false, error: 'citation_pages must be string[]' };
    }
  }

  const id = makeIdFromQuery(input.query);
  const { rows } = readCandidates(stateRoot);
  const existing = rows.find((r) => r.id === id);
  if (existing) return { ok: true, created: existing, isNew: false };

  const lang = input.lang ?? detectLangForQuery(input.query);
  const citePages = Array.from(new Set(input.citation_pages ?? []));
  const cand: GoldenCaseCandidate = {
    id,
    query: input.query,
    filters: {
      audience: input.filters?.audience ?? null,
      version: input.filters?.version ?? null,
    },
    context_pageId: input.context_pageId ?? null,
    expected: {
      must_cite_pages: citePages,
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
  rows.push(cand);
  writeCandidates(stateRoot, rows);
  return { ok: true, created: cand, isNew: true };
}
