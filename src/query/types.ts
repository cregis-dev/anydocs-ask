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
