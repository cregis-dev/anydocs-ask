import type { GoldenCase } from '../golden/types.ts';
import type { AskTrace } from '../query/answer.ts';
import type { AskResult, Citation } from '../query/types.ts';

export type CaseResult = {
  case_id: string;
  query: string;
  kind: 'answer' | 'clarify' | 'error';
  expected_kind: 'answer' | 'clarify' | 'error';
  kind_pass: boolean;
  /**
   * @deprecated Saturates at 1.00 across the current cregis set; kept for
   * regression detection only. Headline-pass signal lives in {@link hit_at_1}
   * / {@link mrr} now. Will be removed once Hit@K is consumed by the console UI.
   */
  r_at_5: boolean;
  /** Top-ranked unique page is in must_cite_pages. */
  hit_at_1: boolean;
  /** Any of the top-3 unique pages is in must_cite_pages. */
  hit_at_3: boolean;
  /**
   * Mean Reciprocal Rank of the first must-cite page over unique pages in the
   * fused trace (1 / position; 0 when no must-cite page appears anywhere in
   * the trace). Position is 1-indexed.
   */
  mrr: number;
  /**
   * (# of top-5 retrieved chunks whose page is in must_cite ∪ allow_cite) / 5.
   * Continuous signal that R@5 / Hit@K can't give — exposes top-K noise
   * even when at least one correct page is present.
   */
  context_precision_at_5: number;
  /**
   * Page-level context recall: |top-5 unique pages ∩ must_cite_pages| /
   * |must_cite_pages|. null when must_cite_pages is empty (averaged like
   * {@link api_rule_pass}).
   *
   * This is the deterministic, page-level version of Ragas
   * `context_recall`. The claim-level LLM-judge variant lands in eval
   * Phase 6 alongside Faithfulness.
   */
  context_recall_at_5: number | null;
  /**
   * At least one final citation points at an expected source
   * (`must_cite_pages ∪ allow_cite_pages`). This is the headline citation
   * signal: the answer is anchored to the approved evidence set even if it
   * also cites extra, potentially valid pages that the Golden allowlist has
   * not been calibrated for yet.
   */
  citation_anchor_pass: boolean;
  /**
   * Legacy strict metric: all cited pages must be in
   * `must_cite_pages ∪ allow_cite_pages`. Kept for historical comparisons and
   * Golden allowlist calibration, but too strict for headline quality.
   */
  citation_pass: boolean;
  /** Cited pages outside `must_cite_pages ∪ allow_cite_pages`. */
  unexpected_citation_pages: string[];
  /** unexpected_citation_pages.length / cited_pages.length, or 0 when uncited. */
  unexpected_citation_rate: number;
  /**
   * Brittle: substring + regex matching against the LLM answer. Misses
   * synonyms and accepts keyword-stuffed wrong answers. Reported as
   * `answer_keyword_overlap` in the markdown report's diagnostic section,
   * not as a pass criterion. Slated for replacement by `semantic_pass`
   * (LLM-judge) in eval Phase 5.
   */
  answer_rule_pass: boolean;
  api_rule_pass: boolean | null;
  retrieved_pages_top5: string[];
  cited_pages: string[];
  missing_must_contain: string[];
  missing_must_contain_regex: string[];
  hit_forbid_contain: string[];
  hit_forbid_contain_regex: string[];
  missing_must_cite_operations: string[];
  missing_must_cite_urls: string[];
  error_code: string | null;
  error_message: string | null;
  error_detail: string | null;
  latency_ms: number;
};

export type EvalSummary = {
  n: number;
  /** @deprecated See {@link CaseResult.r_at_5}. */
  r_at_5: number;
  hit_at_1: number;
  hit_at_3: number;
  mrr: number;
  context_precision_at_5: number;
  context_recall_n: number;
  context_recall_at_5: number | null;
  citation_anchor_pass: number;
  unexpected_citation_rate: number;
  /** Legacy strict citation metric; see {@link CaseResult.citation_pass}. */
  citation_pass: number;
  /** Diagnostic only; see {@link CaseResult.answer_rule_pass}. */
  answer_rule_pass: number;
  kind_pass: number;
  api_rule_n: number;
  api_rule_pass: number | null;
};

export function scoreCase(c: GoldenCase, result: AskResult, trace: AskTrace): CaseResult {
  const expectedKind = c.expected.expected_kind ?? 'answer';
  const mustPages = new Set(c.expected.must_cite_pages);
  const allowedCitationPages = new Set([
    ...c.expected.must_cite_pages,
    ...(c.expected.allow_cite_pages ?? []),
  ]);

  // Page-level metrics work over the unique-page sequence — top-5 chunks may
  // resolve to fewer than 5 unique pages. Chunk-level metrics (context-P@5)
  // work over the raw chunk sequence so they see top-K noise even when all
  // chunks happen to come from the same page.
  const uniquePagesInOrder = uniqueOrdered(trace.fused.map((f) => f.page_id));
  const top5Pages = uniqueOrdered(trace.fused.slice(0, 5).map((f) => f.page_id));
  const r_at_5 = top5Pages.some((p) => mustPages.has(p));
  const hit_at_1 = uniquePagesInOrder.length > 0 && mustPages.has(uniquePagesInOrder[0]!);
  const hit_at_3 = uniquePagesInOrder.slice(0, 3).some((p) => mustPages.has(p));
  const mrr = computeMrr(uniquePagesInOrder, mustPages);
  const context_precision_at_5 = computeContextPrecision(
    trace.fused.slice(0, 5),
    allowedCitationPages,
  );
  const context_recall_at_5 = mustPages.size === 0
    ? null
    : [...mustPages].filter((p) => top5Pages.includes(p)).length / mustPages.size;

  const kind = result.type;
  let citedPages: string[] = [];
  let citationAnchorPass = false;
  let citationPass = false;
  let unexpectedCitationPages: string[] = [];
  let unexpectedCitationRate = 0;
  let answerRulePass = false;
  let missingMustContain: string[] = [];
  let missingMustContainRegex: string[] = [];
  let hitForbidContain: string[] = [];
  let hitForbidContainRegex: string[] = [];
  let missingMustCiteOperations = [...(c.expected.must_cite_operations ?? [])];
  let missingMustCiteUrls = [...(c.expected.must_cite_urls ?? [])];
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let errorDetail: string | null = null;

  if (result.type === 'answer') {
    citedPages = uniqueOrdered(result.citations.map((cit) => cit.page_id));
    citationAnchorPass = citedPages.some((p) => allowedCitationPages.has(p));
    unexpectedCitationPages = citedPages.filter((p) => !allowedCitationPages.has(p));
    unexpectedCitationRate = citedPages.length === 0 ? 0 : unexpectedCitationPages.length / citedPages.length;
    citationPass = citedPages.length > 0 && citedPages.every((p) => allowedCitationPages.has(p));

    const md = result.answer_md;
    missingMustContain = c.expected.must_contain.filter((s) => !substringHit(md, s));
    missingMustContainRegex = (c.expected.must_contain_regex ?? []).filter((re) => !regexHit(md, re));
    hitForbidContain = c.expected.forbid_contain.filter((s) => substringHit(md, s));
    hitForbidContainRegex = (c.expected.forbid_contain_regex ?? []).filter((re) => regexHit(md, re));
    answerRulePass =
      missingMustContain.length === 0 &&
      missingMustContainRegex.length === 0 &&
      hitForbidContain.length === 0 &&
      hitForbidContainRegex.length === 0;

    const sourceText = apiRuleHaystack(result.answer_md, result.citations);
    missingMustCiteOperations = missingMustCiteOperations.filter((op) => !substringHit(sourceText, op));
    missingMustCiteUrls = missingMustCiteUrls.filter((url) => !citationUrlHit(result.citations, url));
  } else if (result.type === 'error') {
    errorCode = result.code;
    errorMessage = result.message;
    errorDetail = result.detail ?? null;
  }

  const hasApiRules =
    (c.expected.must_cite_operations?.length ?? 0) > 0 ||
    (c.expected.must_cite_urls?.length ?? 0) > 0;
  const apiRulePass = hasApiRules
    ? missingMustCiteOperations.length === 0 && missingMustCiteUrls.length === 0
    : null;

  return {
    case_id: c.id,
    query: c.query,
    kind,
    expected_kind: expectedKind,
    kind_pass: kind === expectedKind,
    r_at_5,
    hit_at_1,
    hit_at_3,
    mrr,
    context_precision_at_5,
    context_recall_at_5,
    citation_anchor_pass: citationAnchorPass,
    citation_pass: citationPass,
    unexpected_citation_pages: unexpectedCitationPages,
    unexpected_citation_rate: unexpectedCitationRate,
    answer_rule_pass: answerRulePass,
    api_rule_pass: apiRulePass,
    retrieved_pages_top5: top5Pages,
    cited_pages: citedPages,
    missing_must_contain: missingMustContain,
    missing_must_contain_regex: missingMustContainRegex,
    hit_forbid_contain: hitForbidContain,
    hit_forbid_contain_regex: hitForbidContainRegex,
    missing_must_cite_operations: missingMustCiteOperations,
    missing_must_cite_urls: missingMustCiteUrls,
    error_code: errorCode,
    error_message: errorMessage,
    error_detail: errorDetail,
    latency_ms: 0,
  };
}

export function failedCase(c: GoldenCase, latencyMs: number): CaseResult {
  const expectedKind = c.expected.expected_kind ?? 'answer';
  const hasApiRules =
    (c.expected.must_cite_operations?.length ?? 0) > 0 ||
    (c.expected.must_cite_urls?.length ?? 0) > 0;
  return {
    case_id: c.id,
    query: c.query,
    kind: 'error',
    expected_kind: expectedKind,
    kind_pass: expectedKind === 'error',
    r_at_5: false,
    hit_at_1: false,
    hit_at_3: false,
    mrr: 0,
    context_precision_at_5: 0,
    context_recall_at_5: c.expected.must_cite_pages.length === 0 ? null : 0,
    citation_anchor_pass: false,
    citation_pass: false,
    unexpected_citation_pages: [],
    unexpected_citation_rate: 0,
    answer_rule_pass: false,
    api_rule_pass: hasApiRules ? false : null,
    retrieved_pages_top5: [],
    cited_pages: [],
    missing_must_contain: c.expected.must_contain,
    missing_must_contain_regex: c.expected.must_contain_regex ?? [],
    hit_forbid_contain: [],
    hit_forbid_contain_regex: [],
    missing_must_cite_operations: c.expected.must_cite_operations ?? [],
    missing_must_cite_urls: c.expected.must_cite_urls ?? [],
    error_code: 'exception',
    error_message: null,
    error_detail: null,
    latency_ms: Math.round(latencyMs),
  };
}

export function summarizeResults(results: CaseResult[]): EvalSummary {
  const apiResults = results.filter((r) => r.api_rule_pass !== null);
  const recallResults = results.filter(
    (r): r is CaseResult & { context_recall_at_5: number } => r.context_recall_at_5 !== null,
  );
  return {
    n: results.length,
    r_at_5: mean(results.map((r) => (r.r_at_5 ? 1 : 0))),
    hit_at_1: mean(results.map((r) => (r.hit_at_1 ? 1 : 0))),
    hit_at_3: mean(results.map((r) => (r.hit_at_3 ? 1 : 0))),
    mrr: mean(results.map((r) => r.mrr)),
    context_precision_at_5: mean(results.map((r) => r.context_precision_at_5)),
    context_recall_n: recallResults.length,
    context_recall_at_5: recallResults.length === 0
      ? null
      : mean(recallResults.map((r) => r.context_recall_at_5)),
    citation_anchor_pass: mean(results.map((r) => (r.citation_anchor_pass ? 1 : 0))),
    unexpected_citation_rate: mean(results.map((r) => r.unexpected_citation_rate)),
    citation_pass: mean(results.map((r) => (r.citation_pass ? 1 : 0))),
    answer_rule_pass: mean(results.map((r) => (r.answer_rule_pass ? 1 : 0))),
    kind_pass: mean(results.map((r) => (r.kind_pass ? 1 : 0))),
    api_rule_n: apiResults.length,
    api_rule_pass: apiResults.length === 0
      ? null
      : mean(apiResults.map((r) => (r.api_rule_pass ? 1 : 0))),
  };
}

function computeMrr(uniquePagesInOrder: string[], mustPages: Set<string>): number {
  for (let i = 0; i < uniquePagesInOrder.length; i++) {
    if (mustPages.has(uniquePagesInOrder[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function computeContextPrecision(
  topKChunks: { page_id: string }[],
  relevantPages: Set<string>,
): number {
  if (topKChunks.length === 0) return 0;
  const hits = topKChunks.filter((c) => relevantPages.has(c.page_id)).length;
  return hits / topKChunks.length;
}

function apiRuleHaystack(answerMd: string, citations: Citation[]): string {
  return [
    answerMd,
    ...citations.flatMap((c) => [
      c.title,
      c.url,
      c.snippet,
      c.in_page_path,
      ...c.breadcrumb.map((b) => b.title),
    ]),
  ].join('\n');
}

function citationUrlHit(citations: Citation[], expected: string): boolean {
  return citations.some((c) => (c.url ?? '') === expected || (c.url ?? '').includes(expected));
}

function substringHit(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

function regexHit(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return false;
  }
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

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
