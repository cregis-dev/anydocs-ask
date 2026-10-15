#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { serve } from '@hono/node-server';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { Bgem3Embedder } from '../src/embedding/bge-m3.ts';
import { EvidenceService } from '../src/agent/evidence.ts';
import { BgeCrossEncoder } from '../src/reranker/bge-cross-encoder.ts';
import { retrieveWithTrace } from '../src/query/retrieval.ts';
import { sanitizeFtsQuery } from '../src/query/sanitize.ts';
import { extractIndexedIdentifiers } from '../src/content/identifiers.ts';
import { Runtime } from '../src/server/runtime.ts';
import { createApp } from '../src/server/app.ts';
import type { LLM } from '../src/llm/types.ts';

type Args = Record<string, string>;
type RequestResult = {
  latencyMs: number;
  ok: boolean;
  status?: number;
  code?: string;
  timings?: Record<string, number>;
};

const NOOP_LLM: LLM = {
  model: 'benchmark-noop',
  async generate() {
    throw new Error('benchmark retrieval must not invoke an LLM');
  },
};

function parseArgs(argv: string[]): { command: string; flags: Args } {
  const [command = '', ...rest] = argv;
  const flags: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) flags[token.slice(2)] = 'true';
    else {
      flags[token.slice(2)] = value;
      i++;
    }
  }
  return { command, flags };
}

function required(flags: Args, name: string): string {
  const value = flags[name]?.trim();
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
}

function loadQueries(path: string): string[] {
  const rows = readFileSync(expandHome(path), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const queries = rows
    .map((row) => typeof row.query === 'string'
      ? row.query
      : typeof row.user_input === 'string'
        ? row.user_input
        : null)
    .filter((value): value is string => Boolean(value));
  if (queries.length === 0) throw new Error(`no query/user_input strings found in ${path}`);
  return queries;
}

function numbers(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = value.split(',').map(Number);
  if (parsed.some((item) => !Number.isInteger(item) || item < 1)) {
    throw new Error(`invalid positive integer list: ${value}`);
  }
  return parsed;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function summarize(results: RequestResult[], wallMs: number, concurrency: number) {
  const successes = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const successLatencies = successes.map((result) => result.latencyMs);
  const stageNames = new Set(successes.flatMap((result) => Object.keys(result.timings ?? {})));
  const stageLatency: Record<string, { mean_ms: number; p95_ms: number }> = {};
  for (const name of stageNames) {
    const values = successes.map((result) => result.timings?.[name] ?? 0);
    stageLatency[name] = {
      mean_ms: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
      p95_ms: round(percentile(values, 95)),
    };
  }
  const errorCounts: Record<string, number> = {};
  for (const failure of failures) {
    const key = failure.code ?? String(failure.status ?? 'unknown');
    errorCounts[key] = (errorCounts[key] ?? 0) + 1;
  }
  return {
    concurrency,
    requests: results.length,
    successes: successes.length,
    failures: failures.length,
    wall_ms: round(wallMs),
    offered_qps: round(results.length / (wallMs / 1000)),
    success_qps: round(successes.length / (wallMs / 1000)),
    latency_ms: {
      mean: round(successLatencies.reduce((sum, value) => sum + value, 0) / Math.max(1, successLatencies.length)),
      p50: round(percentile(successLatencies, 50)),
      p95: round(percentile(successLatencies, 95)),
      max: round(Math.max(0, ...successLatencies)),
    },
    stage_latency_ms: stageLatency,
    errors: errorCounts,
  };
}

async function runPool(
  requestCount: number,
  concurrency: number,
  operation: (index: number) => Promise<RequestResult>,
): Promise<{ results: RequestResult[]; wallMs: number }> {
  const results = new Array<RequestResult>(requestCount);
  let cursor = 0;
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= requestCount) return;
      try {
        results[index] = await operation(index);
      } catch (error) {
        results[index] = {
          latencyMs: 0,
          ok: false,
          code: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }));
  return { results, wallMs: performance.now() - startedAt };
}

async function benchmarkLocal(flags: Args) {
  const projectRoot = expandHome(required(flags, 'project'));
  const stateRoot = expandHome(required(flags, 'state'));
  const queries = loadQueries(required(flags, 'queries'));
  const requestCount = Number(flags.requests ?? 30);
  const concurrencyLevels = numbers(flags.concurrency, [1, 3, 5]);
  const rerankerMode = flags.reranker ?? 'both';
  if (!['on', 'off', 'both'].includes(rerankerMode)) throw new Error('--reranker must be on, off, or both');

  const { config } = await loadConfig(projectRoot);
  const db = openDatabase({ stateRoot });
  const embedder = new Bgem3Embedder({
    preferQuantized: config.embedding.preferQuantized,
    cacheDir: process.env.ANYDOCS_TRANSFORMERS_CACHE,
  });
  const warmStartedAt = performance.now();
  await embedder.warmUp();
  const embeddingWarmMs = performance.now() - warmStartedAt;

  const selectedQueries = queries.slice(0, Math.min(24, queries.length));
  const precomputed = await embedder.embed(selectedQueries);
  for (let i = 0; i < Math.min(20, selectedQueries.length); i++) {
    retrieveWithTrace(db, {
      queryVector: precomputed[i]!.vector,
      ftsQuery: sanitizeFtsQuery(selectedQueries[i]!),
      scopeId: null,
      perPathK: config.retrieval.topK,
      finalK: config.retrieval.maxChunksHardCap,
      rrfK: config.retrieval.rrfK,
      exactIdentifiers: extractIndexedIdentifiers(selectedQueries[i]!).map((item) => item.value),
    });
  }
  const dbIterations = Number(flags['db-requests'] ?? 1000);
  const dbStartedAt = performance.now();
  for (let i = 0; i < dbIterations; i++) {
    const queryIndex = i % selectedQueries.length;
    retrieveWithTrace(db, {
      queryVector: precomputed[queryIndex]!.vector,
      ftsQuery: sanitizeFtsQuery(selectedQueries[queryIndex]!),
      scopeId: null,
      perPathK: config.retrieval.topK,
      finalK: config.retrieval.maxChunksHardCap,
      rrfK: config.retrieval.rrfK,
      exactIdentifiers: extractIndexedIdentifiers(selectedQueries[queryIndex]!).map((item) => item.value),
    });
  }
  const dbWallMs = performance.now() - dbStartedAt;
  const pageCount = (db.prepare('SELECT COUNT(*) AS count FROM pages').get() as { count: number }).count;
  const chunkCount = (db.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }).count;

  const modes = rerankerMode === 'both' ? ['off', 'on'] : [rerankerMode];
  const searchResults: Record<string, unknown> = {};
  for (const mode of modes) {
    const reranker = mode === 'on'
      ? new BgeCrossEncoder({
          model: config.reranker.model,
          revision: config.reranker.revision ?? undefined,
          preferQuantized: config.reranker.preferQuantized,
          cacheDir: process.env.ANYDOCS_TRANSFORMERS_CACHE,
          maxLength: config.reranker.maxLength,
        })
      : null;
    let rerankerWarmMs = 0;
    if (reranker) {
      const startedAt = performance.now();
      await reranker.warmUp();
      rerankerWarmMs = performance.now() - startedAt;
    }
    const evidence = new EvidenceService({
      db,
      searchDeps: {
        db,
        embedder,
        llm: NOOP_LLM,
        reranker,
        rerankerConfig: { ...config.reranker, enabled: Boolean(reranker) },
        retrievalConfig: config.retrieval,
        promptConfig: config.prompt,
        intentRouter: null,
      },
    });
    await evidence.searchDocs({ query: selectedQueries[0]!, limit: 20 });
    const levels = [];
    for (const concurrency of concurrencyLevels) {
      const run = await runPool(requestCount, concurrency, async (index) => {
        const startedAt = performance.now();
        const output = await evidence.searchDocs({
          query: selectedQueries[index % selectedQueries.length]!,
          limit: 20,
        });
        return {
          latencyMs: performance.now() - startedAt,
          ok: output.candidates.length > 0,
          timings: output.timings,
        };
      });
      levels.push(summarize(run.results, run.wallMs, concurrency));
    }
    searchResults[mode] = { reranker_warm_ms: round(rerankerWarmMs), levels };
  }
  db.close();

  return {
    kind: 'local-retrieval-throughput',
    generated_at: new Date().toISOString(),
    corpus: { pages: pageCount, chunks: chunkCount },
    query_count: selectedQueries.length,
    embedding_model: embedder.model,
    embedding_warm_ms: round(embeddingWarmMs),
    precomputed_vector_db: {
      requests: dbIterations,
      wall_ms: round(dbWallMs),
      qps: round(dbIterations / (dbWallMs / 1000)),
      mean_ms: round(dbWallMs / dbIterations),
    },
    search: searchResults,
  };
}

async function benchmarkHttp(flags: Args) {
  const baseUrl = required(flags, 'url').replace(/\/$/, '');
  const queries = loadQueries(required(flags, 'queries')).slice(0, 24);
  const requestCount = Number(flags.requests ?? 12);
  const concurrencyLevels = numbers(flags.concurrency, [1, 3, 5, 10]);
  const health = await fetch(`${baseUrl}/v1/health`);
  if (!health.ok) throw new Error(`health check failed: HTTP ${health.status}`);

  const levels = [];
  for (const concurrency of concurrencyLevels) {
    const run = await runPool(requestCount, concurrency, async (index) => {
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}/v1/ask?dry_run=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: queries[index % queries.length]!,
          lang: /[\u3400-\u9fff]/u.test(queries[index % queries.length]!) ? 'zh' : 'en',
        }),
      });
      let body: Record<string, unknown> = {};
      try {
        body = await response.json() as Record<string, unknown>;
      } catch {
        body = {};
      }
      return {
        latencyMs: performance.now() - startedAt,
        ok: response.ok && body.type === 'answer',
        status: response.status,
        code: typeof body.code === 'string' ? body.code : undefined,
      };
    });
    levels.push(summarize(run.results, run.wallMs, concurrency));
  }
  return {
    kind: 'agent-http-throughput',
    generated_at: new Date().toISOString(),
    url: baseUrl,
    query_count: queries.length,
    levels,
  };
}

async function runBenchmarkServer(flags: Args): Promise<never> {
  const projectRoot = expandHome(required(flags, 'project'));
  const stateRoot = expandHome(required(flags, 'state'));
  const { config } = await loadConfig(projectRoot);
  config.agent.enabled = true;
  config.reranker.enabled = (flags.reranker ?? 'on') === 'on';
  config.runs.enabled = false;
  config.feedback.enabled = false;
  config.citationSemanticCheck.enabled = false;
  config.server.maxConcurrentAsk = Number(flags['max-concurrency'] ?? 12);
  const port = Number(flags.port ?? 4310);
  const runtime = new Runtime({ projectRoot, stateRoot, config, skipWatcher: true });
  const started = await runtime.start();
  const app = createApp({ runtime });
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  process.stdout.write(`${JSON.stringify({
    kind: 'benchmark-server-ready',
    port,
    reranker: config.reranker.enabled,
    max_concurrent_ask: config.server.maxConcurrentAsk,
    boot_ms: started.boot_ms,
  })}\n`);
  const stop = async () => {
    server.close();
    await runtime.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  return await new Promise<never>(() => undefined);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'serve') return await runBenchmarkServer(flags);
  const result = command === 'local'
    ? await benchmarkLocal(flags)
    : command === 'http'
      ? await benchmarkHttp(flags)
      : (() => { throw new Error('usage: benchmark-throughput.ts <local|http|serve> [flags]'); })();
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (flags.output) writeFileSync(expandHome(flags.output), json, 'utf8');
  process.stdout.write(json);
}

await main();
