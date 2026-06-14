/**
 * `anydocs-ask serve <projectRoot>` — boot the Runtime and start the HTTP
 * server. Health goes 503 → 200 once warm-up completes.
 *
 * The HTTP server starts BEFORE warm-up so probes (Reader polling
 * /v1/health) can connect immediately and observe 503 → 200 in real time.
 * Warm-up runs on a background promise; SIGINT / SIGTERM shut it all down.
 */

import { resolve } from 'node:path';
import { serve as nodeServe } from '@hono/node-server';
import { createApp } from '../server/app.ts';
import { Runtime } from '../server/runtime.ts';
import {
  loadConfig,
  resolveTransformersCacheDir,
  MCP_TOOL_NAMES,
  type ResolvedConfig,
  type McpToolName,
} from '../config.ts';

/**
 * Env overrides for the MCP endpoint, applied after `loadConfig`. Lets the
 * console spawner (and any operator) force-enable `/mcp` and pin its tool set
 * without editing each project's `anydocs.ask.json` — so a CAWP-mounted
 * project serves `search`/`fetch_page` over MCP with zero per-project config
 * (ADR-038 retrieval-MCP shape). Project config is the default; env wins.
 *
 *   ANYDOCS_MCP_ENABLED=1            → config.mcp.enabled = true
 *   ANYDOCS_MCP_TOOLS=search,fetch_page → config.mcp.tools = [...]
 */
function applyMcpEnvOverrides(config: ResolvedConfig): void {
  if (process.env.ANYDOCS_MCP_ENABLED === '1') {
    config.mcp.enabled = true;
  }
  const raw = process.env.ANYDOCS_MCP_TOOLS;
  if (raw && raw.trim().length > 0) {
    const valid = raw
      .split(',')
      .map((s) => s.trim())
      .filter((t): t is McpToolName => (MCP_TOOL_NAMES as readonly string[]).includes(t));
    if (valid.length > 0) config.mcp.tools = valid;
  }
}

export type ServeOptions = {
  projectRoot: string;
  stateRoot: string;
  host?: string;
  port?: number;
};

export async function runServe(opts: ServeOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const { config, source, warnings } = await loadConfig(projectRoot);
  if (source) {
    process.stdout.write(`anydocs-ask: loaded config from ${source}\n`);
  } else {
    process.stdout.write(`anydocs-ask: no anydocs.ask.json found; using defaults\n`);
  }
  for (const w of warnings) process.stderr.write(`[ask] ${w}\n`);
  applyMcpEnvOverrides(config);

  const host = opts.host ?? config.server.host;
  const port = opts.port ?? config.server.port;

  const runtime = new Runtime({ projectRoot, stateRoot, config });
  const app = createApp({ runtime });

  // Start HTTP first so /v1/health is reachable for warm-up probes.
  let httpResolve!: (code: number) => void;
  const httpDone = new Promise<number>((r) => {
    httpResolve = r;
  });
  const server = nodeServe(
    { fetch: app.fetch, hostname: host, port },
    (info) => {
      process.stdout.write(
        `anydocs-ask listening on http://${info.address}:${info.port}\n` +
          `  source:    ${projectRoot}\n` +
          `  state:     ${stateRoot}\n` +
          `  embedding: ${config.embedding.model}\n` +
          `  hf-cache:  ${resolveTransformersCacheDir(config)}\n` +
          `  llm:       ${config.llm.provider}/${config.llm.model}\n` +
          `  GET /v1/health will return 503 until warm-up finishes.\n`,
      );
    },
  );

  // Kick off warm-up (loads bge-m3, fullReindex, starts watcher).
  runtime.start().then(
    (r) => {
      process.stdout.write(
        `[ask] warm in ${r.boot_ms}ms — pages=${r.initialIndex.pages.inserted + r.initialIndex.pages.updated} chunks=${r.initialIndex.chunks.totalChunks} embed_misses=${r.initialIndex.embed.misses}\n`,
      );
    },
    (err) => {
      process.stderr.write(`[ask] FATAL warm-up failure: ${(err as Error).stack ?? err}\n`);
      // Don't kill the server — health stays 503; operator can investigate.
    },
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nreceived ${signal}, shutting down...\n`);
    server.close(async () => {
      await runtime.stop();
      httpResolve(0);
    });
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return await httpDone;
}
