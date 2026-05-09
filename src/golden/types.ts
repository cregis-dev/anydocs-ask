/**
 * Golden case schema — ARCH §16.3.
 *
 * Two on-disk shapes share one structural definition:
 *   - cases.candidate.jsonl   each line has a `decision: null|approved|rejected`
 *                             field; the author's editor flow flips this.
 *   - cases.jsonl             approved cases only; never carries `decision`.
 *
 * eval reads cases.jsonl. Generators (structure / runs / inbox) write
 * cases.candidate.jsonl. `golden review` moves approved candidates into
 * cases.jsonl and drops rejected ones.
 */

import type { DocsLang } from '../anydocs/types.ts';

export type GoldenCaseExpected = {
  /** At least one slug must appear in retrieval top-K (R@5 OR semantics). */
  must_cite_pages: string[];
  /** Substrings that must all appear in answer.md (case-insensitive substring). */
  must_contain: string[];
  /** Substrings that must NOT appear in answer.md. */
  forbid_contain: string[];
};

export type GoldenCase = {
  id: string;
  query: string;
  filters: { audience?: string | null; version?: string | null };
  /** When non-null, eval calls /v1/ask with context.current_page_id = this. */
  context_pageId: string | null;
  expected: GoldenCaseExpected;
  tags: string[];
  /** Provenance — which generator produced this case. */
  created_by: 'structure' | 'structure+llm' | 'runs' | 'inbox' | 'manual';
  /** ISO date when an author flipped decision -> approved. Null for unreviewed. */
  reviewed_at: string | null;
  reviewer: string | null;
  /** Lang of the source page. eval optionally filters by this. */
  lang: DocsLang;
};

export type GoldenDecision = null | 'approved' | 'rejected';

/** Candidate: GoldenCase + author's decision marker. */
export type GoldenCaseCandidate = GoldenCase & {
  decision: GoldenDecision;
  /** Free-form note the author can leave next to a candidate during review. */
  note?: string;
  /** Which template produced this candidate (for analytics + dedup hints). */
  template_id: TemplateId;
};

export const TEMPLATE_IDS = [
  'what_is',
  'how_to_use',
  'compare_siblings',
  'how_to_configure',
  'caveats',
  /** Synthetic id used by `golden generate --from runs`. Real user queries
   *  don't fit a template; this label keeps analytics + dedup hints typed. */
  'from_runs',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
