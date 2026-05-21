import type { GoldenCase } from '../golden/types.ts';
import type { AskTrace } from '../query/answer.ts';
import type { AskResult, Citation } from '../query/types.ts';

export type CaseResult = {
  case_id: string;
  query: string;
  kind: 'answer' | 'clarify' | 'error';
  expected_kind: 'answer' | 'clarify' | 'error';
  kind_pass: boolean;
  r_at_5: boolean;
  citation_pass: boolean;
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
  r_at_5: number;
  citation_pass: number;
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

  const top5Pages = uniqueOrdered(trace.fused.slice(0, 5).map((f) => f.page_id));
  const r_at_5 = top5Pages.some((p) => mustPages.has(p));

  const kind = result.type;
  let citedPages: string[] = [];
  let citationPass = false;
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
    citation_pass: citationPass,
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
    citation_pass: false,
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
  return {
    n: results.length,
    r_at_5: mean(results.map((r) => (r.r_at_5 ? 1 : 0))),
    citation_pass: mean(results.map((r) => (r.citation_pass ? 1 : 0))),
    answer_rule_pass: mean(results.map((r) => (r.answer_rule_pass ? 1 : 0))),
    kind_pass: mean(results.map((r) => (r.kind_pass ? 1 : 0))),
    api_rule_n: apiResults.length,
    api_rule_pass: apiResults.length === 0
      ? null
      : mean(apiResults.map((r) => (r.api_rule_pass ? 1 : 0))),
  };
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
