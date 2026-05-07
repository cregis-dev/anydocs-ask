/**
 * Top-level query orchestrator. Implements ARCH §6 steps 1–7 and returns a
 * fully shaped AskResult. The HTTP layer (stage 7) maps the result onto JSON
 * + adds answer caching + handles invalid_scope status codes.
 *
 * Pipeline:
 *   1. Validate inputs (question length, scope_id existence in pages table)
 *   1.5 Detect query lang (scope_id > current_page_id > text)
 *   2. Boundary filter is applied inside retrieval SQL (status='published',
 *      optional subtree_root match)
 *   3. Hybrid retrieve (vector + BM25 + RRF)
 *   4. Structural rerank (lang_boost / same_subtree_boost / nav_index_boost)
 *   5. Subtree aggregate → answer-same-lang | clarify | translate-fallback
 *   6. Build prompt + generate via LLM
 *   7. Postprocess (citation legality, lang fill, truncation, hallucination)
 *
 * Step 8 (answer cache TTL 24h) is intentionally not done here — it's an
 * HTTP-layer concern in stage 7.
 */

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import type { DbHandle } from '../db/index.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM } from '../llm/types.ts';
import type { DocsLang } from '../anydocs/types.ts';
import type { BreadcrumbNode } from '../db/schema.ts';
import { detectLangFromText, langFromScopeId } from './lang.ts';
import { sanitizeFtsQuery } from './sanitize.ts';
import { retrieve, type RetrievedChunk } from './retrieval.ts';
import { rerank, lookupSubtreeRoot, type RerankedChunk } from './rerank.ts';
import { aggregate, TOP_K_FOR_AGGREGATION, type AggregateOutcome, type SubtreeShare } from './aggregate.ts';
import { buildPrompt, detectFormatHint } from './prompt.ts';
import { postprocess } from './postprocess.ts';
import type { AskRequest, AskResult, ClarifyOption } from './types.ts';

const MAX_QUESTION_CHARS = 500;
const HARD_MAX_CHUNKS = 20;
const DEFAULT_MAX_CHUNKS = 8;

export type AskDeps = {
  db: DbHandle;
  embedder: Embedder;
  llm: LLM;
};

export async function ask(deps: AskDeps, req: AskRequest): Promise<AskResult> {
  const t0 = performance.now();

  // 1. Input validation.
  const question = (req.question ?? '').trim();
  if (question.length === 0) {
    return errorResult('invalid_question', 'question must not be empty');
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return errorResult(
      'invalid_question',
      `question exceeds ${MAX_QUESTION_CHARS} characters`,
    );
  }

  const scopeId = req.context?.scope_id ?? null;
  if (scopeId !== null) {
    const valid = isValidScopeId(deps.db, scopeId);
    if (!valid) {
      return errorResult(
        'invalid_scope',
        `scope_id '${scopeId}' is not a published subtree`,
      );
    }
  }

  // 1.5 Lang detection.
  const queryLang = resolveQueryLang(deps.db, question, req);

  // 3. Hybrid retrieve.
  const queryVector = (await deps.embedder.embed([question]))[0]!.vector;
  const ftsQuery = sanitizeFtsQuery(question);
  const retrieved = retrieve(deps.db, {
    queryVector,
    ftsQuery,
    scopeId,
  });

  // 4. Rerank.
  const currentSubtreeRoot = req.context?.current_page_id
    ? lookupSubtreeRoot(deps.db, req.context.current_page_id, queryLang)
    : null;
  const reranked = rerank(retrieved, { queryLang, currentSubtreeRoot });

  // 5. Aggregate.
  const outcome = aggregate(reranked, { queryLang });

  if (outcome.kind === 'clarify') {
    return buildClarifyResult({
      answerLang: queryLang,
      shares: outcome.topSubtrees,
    });
  }

  // 6 + 7. Generate + postprocess.
  const isCrossLang = outcome.kind === 'translate-fallback';
  const pickedChunks = pickContextChunks(outcome, req.options?.max_chunks);
  const formatHint = detectFormatHint(question);
  const prompt = buildPrompt({
    question,
    chunks: pickedChunks,
    answerLang: queryLang,
    isCrossLang,
    formatHint,
  });

  const llmOutput = await deps.llm.generate({
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
  });

  const post = postprocess({
    answerLang: queryLang,
    rawAnswer: llmOutput.text,
    chunkById: prompt.chunkById,
  });

  return {
    type: 'answer',
    answer_id: makeAnswerId(),
    answer_lang: queryLang,
    answer_md: post.answer_md,
    translation_notice: isCrossLang ? translationNoticeFor(queryLang) : null,
    citations: post.citations,
    used_chunks: post.used_chunks,
    model: llmOutput.modelUsed,
    latency_ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

function resolveQueryLang(db: DbHandle, question: string, req: AskRequest): DocsLang {
  const scopeId = req.context?.scope_id ?? null;
  if (scopeId) {
    const fromScope = langFromScopeId(scopeId);
    if (fromScope) return fromScope;
  }
  const currentPageId = req.context?.current_page_id ?? null;
  if (currentPageId) {
    const rows = db
      .prepare(`SELECT lang FROM pages WHERE page_id = ?`)
      .all(currentPageId) as Array<{ lang: DocsLang }>;
    if (rows.length === 1) return rows[0]!.lang;
    if (rows.length > 1) {
      // Same page id under multiple langs — disambiguate by text detection
      // and pick the lang that's actually present.
      const detected = detectLangFromText(question);
      if (rows.some((r) => r.lang === detected)) return detected;
      return rows[0]!.lang;
    }
  }
  return detectLangFromText(question);
}

function isValidScopeId(db: DbHandle, scopeId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS hit FROM pages WHERE subtree_root = ? AND status = 'published' LIMIT 1`)
    .get(scopeId) as { hit: number } | undefined;
  return !!row;
}

function pickContextChunks(
  outcome: AggregateOutcome,
  clientMax: number | undefined,
): RerankedChunk[] {
  const cap = Math.min(clientMax ?? DEFAULT_MAX_CHUNKS, HARD_MAX_CHUNKS);
  if (outcome.kind === 'translate-fallback') return outcome.pick.slice(0, cap);
  if (outcome.kind === 'answer-same-lang') return outcome.pick.slice(0, cap);
  // 'clarify' is handled before this function; defensive return.
  return [];
}

function translationNoticeFor(lang: DocsLang): string {
  return lang === 'zh'
    ? '原文为其他语言，已为您翻译要点。'
    : 'Source documents are in another language; key points translated below.';
}

function buildClarifyResult(args: {
  answerLang: DocsLang;
  shares: SubtreeShare[];
}): AskResult {
  const options: ClarifyOption[] = args.shares.slice(0, 4).map((share) => {
    const firstChunk = share.chunks[0]!;
    const subtreeBreadcrumb = breadcrumbToSubtree(firstChunk.breadcrumb, share.subtree_root);
    const samplePages = uniqueSamplePages(share.chunks).slice(0, 2);
    const label =
      subtreeBreadcrumb[subtreeBreadcrumb.length - 1]?.title ?? share.subtree_root;
    return {
      scope_id: share.subtree_root,
      lang: args.answerLang,
      label,
      breadcrumb: subtreeBreadcrumb,
      sample_pages: samplePages,
    };
  });

  return {
    type: 'clarify',
    answer_id: makeAnswerId(),
    answer_lang: args.answerLang,
    message: clarifyMessageFor(args.answerLang),
    options,
  };
}

function breadcrumbToSubtree(
  breadcrumb: BreadcrumbNode[],
  subtreeRoot: string,
): BreadcrumbNode[] {
  const idx = breadcrumb.findIndex((b) => b.id === subtreeRoot);
  if (idx < 0) return breadcrumb.slice(0, 1); // degenerate; fall back to depth-1 prefix
  return breadcrumb.slice(0, idx + 1);
}

function uniqueSamplePages(chunks: RerankedChunk[]): Array<{ id: string; title: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string }> = [];
  for (const c of chunks) {
    if (seen.has(c.page_id)) continue;
    seen.add(c.page_id);
    out.push({ id: c.page_id, title: c.page_title });
  }
  return out;
}

function clarifyMessageFor(lang: DocsLang): string {
  return lang === 'zh'
    ? '您的问题可能涉及以下几个范围，请选择一个：'
    : 'Your question could refer to several areas; pick one:';
}

function errorResult(code: string, message: string): AskResult {
  return { type: 'error', code, message };
}

function makeAnswerId(): string {
  // Stable enough for cache joins; not security-sensitive. 8 hex bytes.
  return `ans_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

// re-export for tests / callers.
export { TOP_K_FOR_AGGREGATION };
export type { RetrievedChunk };
