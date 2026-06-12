/**
 * RFC 0007 K2/K3/K5 — MCP tool definitions for the knowledge-base interface.
 *
 * Each tool is a thin wrapper over the existing query pipeline:
 *   - `search`     → `search()`  (hybrid retrieve + rerank; LLM-free)
 *   - `ask`        → `ask()`     (full RAG answer + validated citations; LLM)
 *   - `fetch_page` → DB read     (reconstruct a page's text from its chunks)
 *
 * `search` / `fetch_page` are deliberately LLM-free: `search` injects the
 * static {@link fallbackRoute} intent router (same path as retrieval-only
 * eval) so no provider call happens, and an LLM stub guards against accidental
 * generation. Only `ask` resolves the real LLM — so a `search`-only deployment
 * needs no LLM provider / API key at all (RFC 0007 §4.2).
 *
 * Handlers return plain `content: [{ type: 'text' }]` results — no
 * `outputSchema` / `structuredContent` — for maximum client compatibility. The
 * calling agent reads the text. Errors set `isError: true` with a readable
 * message so the agent can recover rather than crash.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DbHandle } from '../db/index.ts';
import type { BreadcrumbNode } from '../db/schema.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM } from '../llm/types.ts';
import type { Reranker } from '../reranker/types.ts';
import type { McpToolName, PromptConfig, RerankerConfig } from '../config.ts';
import { ask, search } from '../query/answer.ts';
import type { AskDeps } from '../query/answer.ts';
import { fallbackRoute, type IntentRouter } from '../query/intent-router.ts';

/**
 * Dependencies the MCP tools need. The LLM is resolved lazily (and only by
 * `ask`) so that the getter — which builds the provider and can throw when no
 * API key is configured — is never touched on the `search` / `fetch_page`
 * paths.
 */
export type McpToolDeps = {
  db: DbHandle;
  embedder: Embedder;
  reranker: Reranker | null;
  rerankerConfig: RerankerConfig;
  promptConfig: PromptConfig;
  /** Resolve the answer LLM; only `ask` calls it. Throws if unavailable. */
  resolveLlm: () => LLM;
};

/** Text-only tool result, matching the SDK's CallToolResult content shape. */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], isError };
}

/** Render a breadcrumb as a human/LLM-readable `A / B / C` path. */
function breadcrumbPath(breadcrumb: BreadcrumbNode[]): string {
  return breadcrumb.map((b) => b.title).join(' / ');
}

/** Static, LLM-free intent router for the `search` path. */
const STATIC_SEARCH_ROUTER: IntentRouter = {
  async route({ question }) {
    return { ...fallbackRoute(question), reason: 'mcp_search_no_router' };
  },
};

/** LLM stub for LLM-free paths — never invoked (static router skips routing,
 *  search never generates). Throws loudly if that assumption is ever broken. */
const UNUSED_LLM: LLM = {
  model: 'mcp-search-no-llm',
  async generate() {
    throw new Error('MCP search/fetch_page must not call the LLM');
  },
};

export function registerMcpTools(
  server: McpServer,
  deps: McpToolDeps,
  opts: { enabledTools: ReadonlyArray<McpToolName> },
): void {
  const enabled = new Set(opts.enabledTools);

  const retrievalDeps: AskDeps = {
    db: deps.db,
    embedder: deps.embedder,
    llm: UNUSED_LLM,
    reranker: deps.reranker,
    rerankerConfig: deps.rerankerConfig,
    promptConfig: deps.promptConfig,
    intentRouter: STATIC_SEARCH_ROUTER,
  };

  if (enabled.has('search')) {
    server.registerTool(
      'search',
      {
        title: 'Search the documentation',
        description:
          'Semantic + keyword search over the indexed documentation. Returns the most relevant passages with their source page, URL, and breadcrumb so you can ground answers in the docs. Use this to find supporting material and cite it yourself; it does NOT generate a written answer (use `ask` for that).',
        inputSchema: {
          query: z.string().min(1).max(500).describe('Natural-language search query.'),
          scope_id: z
            .string()
            .optional()
            .describe('Restrict results to a published subtree (scope_id). Omit to search everything.'),
          top_k: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe('Max passages to return (default 8, capped at 20).'),
        },
      },
      async ({ query, scope_id, top_k }) => {
        const result = await search(
          retrievalDeps,
          { question: query, context: { scope_id: scope_id ?? null } },
          top_k,
        );
        if (result.type === 'error') {
          return text(`search failed (${result.code}): ${result.message}`, true);
        }
        const payload = {
          query,
          scope_id: scope_id ?? null,
          count: result.hits.length,
          hits: result.hits.map((h) => ({
            page_id: h.page_id,
            title: h.title,
            url: h.url,
            path: breadcrumbPath(h.breadcrumb),
            lang: h.lang,
            snippet: h.snippet,
            score: Number(h.score.toFixed(4)),
          })),
        };
        return text(JSON.stringify(payload, null, 2));
      },
    );
  }

  if (enabled.has('ask')) {
    server.registerTool(
      'ask',
      {
        title: 'Ask the documentation',
        description:
          'Ask a natural-language question and get a synthesized answer grounded in the documentation, with citations to the source pages. Costs an LLM call on the server. Prefer this when you want a direct answer; use `search` when you only need raw passages to reason over yourself.',
        inputSchema: {
          question: z.string().min(1).max(500).describe('The question to answer.'),
          scope_id: z
            .string()
            .optional()
            .describe('Restrict the answer to a published subtree (scope_id). Omit to use all docs.'),
        },
      },
      async ({ question, scope_id }) => {
        let llm: LLM;
        try {
          llm = deps.resolveLlm();
        } catch (err) {
          return text(`ask failed (llm_unavailable): ${(err as Error).message}`, true);
        }
        const result = await ask(
          { ...retrievalDeps, llm, intentRouter: undefined },
          { question, context: { scope_id: scope_id ?? null } },
        );
        if (result.type === 'error') {
          return text(`ask failed (${result.code}): ${result.message}`, true);
        }
        if (result.type === 'clarify') {
          const options = result.options
            .map((o, i) => `  ${i + 1}. [${o.scope_id}] ${o.label} (${breadcrumbPath(o.breadcrumb)})`)
            .join('\n');
          return text(`${result.message}\n\nNarrow your question to one of:\n${options}`);
        }
        const sources = result.citations.length
          ? '\n\nSources:\n' +
            result.citations
              .map((c) => `  [${c.citation_id}] ${c.title}${c.url ? ` — ${c.url}` : ''}`)
              .join('\n')
          : '';
        return text(`${result.answer_md}${sources}`);
      },
    );
  }

  if (enabled.has('fetch_page')) {
    server.registerTool(
      'fetch_page',
      {
        title: 'Fetch a documentation page',
        description:
          'Retrieve the full text of a documentation page by its page_id (as returned by `search`). Use this to read a whole page after `search` surfaces a relevant snippet.',
        inputSchema: {
          page_id: z.string().min(1).describe('The page_id to fetch (from a `search` hit).'),
          lang: z
            .string()
            .optional()
            .describe('Preferred language code (e.g. "en", "zh"). Omit to take any published language.'),
        },
      },
      async ({ page_id, lang }) => {
        const page = fetchPage(deps.db, page_id, lang ?? null);
        if (!page) {
          return text(`fetch_page failed (not_found): no published page with page_id '${page_id}'`, true);
        }
        const header =
          `# ${page.title}\n` +
          (page.url ? `URL: ${page.url}\n` : '') +
          (page.breadcrumb.length ? `Path: ${breadcrumbPath(page.breadcrumb)}\n` : '') +
          `Language: ${page.lang}\n`;
        return text(`${header}\n${page.body}`);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// fetch_page DB read
// ---------------------------------------------------------------------------

type FetchedPage = {
  title: string;
  url: string | null;
  lang: string;
  breadcrumb: BreadcrumbNode[];
  /** Page text reconstructed by concatenating its chunks in order. */
  body: string;
};

/**
 * Reconstruct a page's text from the indexed chunks. Pages aren't stored as
 * whole markdown (only chunks carry `text`), so we concatenate the chunks for
 * the resolved `(page_id, lang)` ordered by chunk_id — a faithful-enough
 * rendering for an agent reading the page.
 */
function fetchPage(db: DbHandle, pageId: string, preferLang: string | null): FetchedPage | null {
  type PageMetaRow = { title: string; url: string | null; breadcrumb: string; lang: string };
  const rows = db
    .prepare(
      `SELECT title, url, breadcrumb, lang FROM pages
       WHERE page_id = ? AND status = 'published'`,
    )
    .all(pageId) as PageMetaRow[];
  if (rows.length === 0) return null;

  const chosen = (preferLang ? rows.find((r) => r.lang === preferLang) : undefined) ?? rows[0]!;

  type ChunkTextRow = { text: string };
  const chunks = db
    .prepare(`SELECT text FROM chunks WHERE page_id = ? AND lang = ? ORDER BY chunk_id`)
    .all(pageId, chosen.lang) as ChunkTextRow[];

  let breadcrumb: BreadcrumbNode[] = [];
  try {
    breadcrumb = JSON.parse(chosen.breadcrumb) as BreadcrumbNode[];
  } catch {
    breadcrumb = [];
  }

  return {
    title: chosen.title,
    url: chosen.url,
    lang: chosen.lang,
    breadcrumb,
    body: chunks.map((c) => c.text).join('\n\n'),
  };
}
