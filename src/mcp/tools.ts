/**
 * RFC 0007 K2/K3/K5 — MCP tool definitions for the knowledge-base interface.
 *
 * Each tool is a thin wrapper over the existing query pipeline:
 *   - `search`     → `search()`  (hybrid retrieve + rerank; LLM-free)
 *   - `ask`        → `ask()`     (full RAG answer + validated citations; LLM)
 *   - `fetch_page` → DB read     (reconstruct a page's text from its chunks)
 *
 * `search` / `fetch_page` are deliberately LLM-free: `search` uses the
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
import type { McpToolName, PromptConfig, RerankerConfig, RetrievalConfig } from '../config.ts';
import { performance } from 'node:perf_hooks';
import { askWithTrace, search } from '../query/answer.ts';
import type { AskDeps, AskTrace } from '../query/answer.ts';
import type { AskResult } from '../query/types.ts';
import { fallbackRoute, type IntentRouter } from '../query/intent-router.ts';
import { MAX_QUESTION_CHARS } from '../query/diagnostic-input.ts';
import { AGENT_READ_TOKEN_HARD_CAP, EvidenceService, EvidenceToolError } from '../agent/evidence.ts';

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
  retrievalConfig: RetrievalConfig;
  promptConfig: PromptConfig;
  intentRouter: IntentRouter;
  /** Resolve the answer LLM; only `ask` calls it. Throws if unavailable. */
  resolveLlm: () => LLM;
  /**
   * Persist an MCP `ask` turn to runs.jsonl as source=mcp (Studio Traffic).
   * Provided by the server wiring; omitted in unit tests that don't assert on
   * runs. A no-op (or absent) when runs are disabled.
   */
  recordAskRun?: (entry: {
    question: string;
    scopeId: string | null;
    result: AskResult;
    trace: AskTrace;
    latencyMs: number;
  }) => void;
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

  // Contract tool (ADR-038 §2): every MCP server CAWP connects to must expose
  // a read-only `health` tool. CAWP's `connectMcp` asserts its presence at
  // startup (else it refuses the server) and filters it out of the
  // agent-visible tool list. Registered unconditionally — it is a liveness
  // probe, not a feature gated by `config.mcp.tools`. Takes no arguments and
  // never touches the LLM.
  server.registerTool(
    'health',
    {
      title: 'Health check',
      description:
        'Read-only liveness probe for this documentation knowledge base. Returns {ok:true} when the server is serving. Takes no arguments.',
      inputSchema: {},
    },
    async () => text(JSON.stringify({ ok: true, server: 'anydocs-ask', tools: [...enabled] })),
  );

  const retrievalDeps: AskDeps = {
    db: deps.db,
    embedder: deps.embedder,
    llm: UNUSED_LLM,
    reranker: deps.reranker,
    rerankerConfig: deps.rerankerConfig,
    retrievalConfig: deps.retrievalConfig,
    promptConfig: deps.promptConfig,
    intentRouter: STATIC_SEARCH_ROUTER,
  };
  const evidenceService = new EvidenceService({ db: deps.db, searchDeps: retrievalDeps });

  if (enabled.has('search')) {
    server.registerTool(
      'search',
      {
        title: 'Search the documentation',
        description:
          'Semantic + keyword search over the indexed documentation. Returns the most relevant passages with their source page, URL, and breadcrumb so you can ground answers in the docs. Use this to find supporting material, then write and cite the answer yourself; it returns passages only and does NOT generate a written answer.',
        inputSchema: {
          query: z.string().min(1).max(MAX_QUESTION_CHARS).describe('Natural-language search query or API troubleshooting payload.'),
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
          question: z.string().min(1).max(MAX_QUESTION_CHARS).describe('The question or API troubleshooting payload to answer.'),
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
          // Don't echo the provider-specific error (which can name the LLM
          // vendor / a missing config key) back to the MCP client; log it
          // server-side and return a generic code the agent can act on.
          process.stderr.write(
            `[mcp] ask llm_unavailable: ${(err as Error)?.message ?? String(err)}\n`,
          );
          return text(
            'ask failed (llm_unavailable): no answer LLM is configured on this server',
            true,
          );
        }
        const scopeId = scope_id ?? null;
        const t0 = performance.now();
        const { result, trace } = await askWithTrace(
          { ...retrievalDeps, llm, intentRouter: deps.intentRouter },
          { question, context: { scope_id: scopeId } },
        );
        const latencyMs =
          result.type === 'answer' ? result.latency_ms : Math.round(performance.now() - t0);
        deps.recordAskRun?.({ question, scopeId, result, trace, latencyMs });
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
          'Retrieve a bounded structural rendering of a documentation page by its page_id (as returned by `search`). Parent chunks are deduplicated and truncation is reported. Pass the `lang` from the search hit to read the matching language.',
        inputSchema: {
          page_id: z.string().min(1).describe('The page_id to fetch (from a `search` hit).'),
          lang: z
            .string()
            .optional()
            .describe(
              'Language code (e.g. "en", "zh") — pass the `lang` field from the search hit to get the matching language. Omit to return the default; available languages are listed in the response.',
            ),
        },
      },
      async ({ page_id, lang }) => {
        let page;
        try {
          page = evidenceService.readDoc({
            pageId: page_id,
            lang: lang === 'en' || lang === 'zh' ? lang : null,
            mode: 'page',
            maxTokens: AGENT_READ_TOKEN_HARD_CAP,
          });
        } catch (error) {
          const code = error instanceof EvidenceToolError ? error.code : 'read_failed';
          const message = error instanceof Error ? error.message : String(error);
          return text(`fetch_page failed (${code}): ${message}`, true);
        }
        const otherLangs = page.availableLangs.filter((l) => l !== page.lang);
        const header =
          `# ${page.title}\n` +
          (page.url ? `URL: ${page.url}\n` : '') +
          (page.breadcrumb.length ? `Path: ${breadcrumbPath(page.breadcrumb)}\n` : '') +
          `Language: ${page.lang}\n` +
          (otherLangs.length ? `Also available in: ${otherLangs.join(', ')} (pass lang= to switch)\n` : '') +
          `Truncated: ${page.truncated ? 'yes' : 'no'}\n`;
        return text(`${header}\n${page.body}`);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// fetch_page DB read
// ---------------------------------------------------------------------------

/**
 * Pick which published language to serve for a page.
 *
 * `search` hits carry their own `lang`, so an agent that passes it back gets
 * the matching language. When `lang` is omitted we fall back to the first
 * language in sorted order — deterministic (not SQLite row order), so repeated
 * calls are stable and the response can honestly list the alternatives.
 */
export function pickPageLang(
  langs: ReadonlyArray<string>,
  preferLang: string | null,
): { lang: string; available: string[] } | null {
  const available = [...new Set(langs)].sort();
  if (available.length === 0) return null;
  if (preferLang && available.includes(preferLang)) {
    return { lang: preferLang, available };
  }
  return { lang: available[0]!, available };
}
