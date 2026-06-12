/**
 * Public types for the query pipeline. Mirrors ARCH §5.1 / §6 / PRD §4.8.
 *
 * AskResult is the union returned by `ask()`. The HTTP layer (stage 7) maps
 * it 1:1 onto JSON; the union shape keeps the pipeline honest about the
 * three legitimate outcomes (answer, clarify, error).
 */

import type { DocsLang } from '../anydocs/types.ts';
import type { BreadcrumbNode } from '../db/schema.ts';

export type AskRequest = {
  question: string;
  context?: {
    current_page_id?: string | null;
    scope_id?: string | null;
    /**
     * RFC 0003 multi-turn — most-recent-N prior turns from the same session,
     * oldest → newest. Populated by the server layer when
     * `multiTurn.enabled === true` and a valid session_id is in play (see
     * [src/server/app.ts](../server/app.ts)).
     *
     * Two downstream consumers:
     *   1. History-aware retrieve (M1, RFC §4.2). Only `question` strings
     *      are spliced into the embedding query — vector retrieval inherits
     *      dialogue context so pronoun-only follow-ups land near the right
     *      subtree. BM25 / entity injection stay on the current question.
     *   2. Multi-turn prompt (M2, RFC §4.1). Both `question` and
     *      `answer_summary` (≤ 200 chars per RFC §4.3) feed into the prompt
     *      so Claude can resolve pronouns against the actual prior turn.
     *
     * `undefined` (default) and `[]` are the single-turn path — byte-
     * equivalent to 0.1.x for both embedding and prompt.
     */
    history?: Array<{
      question: string;
      /** Prior answer markdown truncated to ≤ 200 chars (RFC §4.3). May be
       *  the empty string for prior clarify / error turns — caller still
       *  sends the entry so the `question` slot stays in chronological order. */
      answer_summary: string;
    }>;
  };
  options?: {
    /** Cap chunks injected into the prompt. Server applies a hard ceiling. */
    max_chunks?: number;
    /** Override LLM model; null/undefined means "use server default". */
    model?: string | null;
  };
};

export type Citation = {
  /** 1-indexed marker matching `[cit_N]` in answer_md after postprocess renumber. */
  citation_id: string;
  /** Numeric chunk row id; lets runs / eval join back to retrieval trace. */
  chunk_id: number;
  page_id: string;
  lang: DocsLang;
  /** Filled only when lang !== answer_lang (PRD §4.8 cross-lang fallback). */
  source_lang: DocsLang | null;
  title: string;
  breadcrumb: BreadcrumbNode[];
  url: string | null;
  snippet: string;
  in_page_path: string;
};

export type AskAnswer = {
  type: 'answer';
  answer_id: string;
  answer_lang: DocsLang;
  answer_md: string;
  /** Non-null only when cross-lang translation fallback fired (PRD §4.8). */
  translation_notice: string | null;
  citations: Citation[];
  used_chunks: number;
  model: string;
  latency_ms: number;
  /** RFC 0003 M4 — how many prior session turns this call consumed (embedding
   *  splice + prompt). 0 / undefined on first-turn or `multiTurn.enabled=false`
   *  paths. Surfaced to Studio + trace so reviewers can tell single-turn from
   *  multi-turn answers without re-deriving from session_id joins. */
  history_window?: number;
};

export type ClarifyOption = {
  scope_id: string;
  lang: DocsLang;
  label: string;
  breadcrumb: BreadcrumbNode[];
  sample_pages: Array<{ id: string; title: string }>;
};

export type AskClarify = {
  type: 'clarify';
  answer_id: string;
  answer_lang: DocsLang;
  message: string;
  options: ClarifyOption[];
  /** RFC 0003 M4 — same semantics as [[AskAnswer.history_window]]. Clarify
   *  branches return BEFORE the LLM call, so history was only consumed at the
   *  embedding splice stage. Still reported so Studio can group clarify
   *  outcomes per dialogue. */
  history_window?: number;
};

export type AskError = {
  type: 'error';
  /** Stable code for clients to switch on (e.g. 'invalid_scope'). */
  code: string;
  /**
   * User-facing message. Safe to render directly in the console / reader UI.
   * Localized to the query language when known.
   */
  message: string;
  /**
   * Internal diagnostic info — upstream error text, LLM failure detail, etc.
   * Persisted to runs.jsonl for analysis but NOT shown to end users. May be
   * null when no extra detail beyond `code` + `message` is available.
   */
  detail?: string | null;
};

export type AskResult = AskAnswer | AskClarify | AskError;

/**
 * RFC 0007 — a single retrieval hit returned by `search()` (the MCP `search`
 * tool's payload). Shaped like {@link Citation} minus the `citation_id`
 * answer-marker, plus a `score`. The calling agent uses these as grounding
 * passages and synthesizes with its own model — no LLM runs on our side.
 */
export type SearchHit = {
  chunk_id: number;
  page_id: string;
  lang: DocsLang;
  title: string;
  breadcrumb: BreadcrumbNode[];
  url: string | null;
  snippet: string;
  in_page_path: string;
  /** Final rerank score (descending). Relative, not normalized to [0,1]. */
  score: number;
};

export type SearchResult =
  | { type: 'hits'; hits: SearchHit[] }
  | { type: 'error'; code: string; message: string };
