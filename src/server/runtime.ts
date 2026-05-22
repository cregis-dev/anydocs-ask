/**
 * Server runtime — owns the long-lived state that HTTP routes need.
 *
 * Boot order (ARCH §11.1):
 *   1. Open DB + run migrations
 *   2. Construct embedder, warm it up (loads bge-m3 — typically 5-10s)
 *   3. Construct LLM (real or mock)
 *   4. Run fullReindex on the project (cache makes this cheap on warm starts)
 *   5. Start the chokidar watcher
 *   6. Flip the `warm` flag → /v1/health switches from 503 to 200
 *
 * All of step 1-4 happens inside `start()`. Step 6 is the public signal that
 * the server can serve user traffic; the HTTP server itself can come up
 * earlier (it returns 503 until warm, by design).
 */

import { resolve } from 'node:path';
import { openDatabase, type DbHandle } from '../db/index.ts';
import { Indexer, type FullReindexStats } from '../index/indexer.ts';
import { ProjectWatcher } from '../index/watcher.ts';
import { Bgem3Embedder } from '../embedding/bge-m3.ts';
import { MockEmbedder } from '../embedding/mock.ts';
import { buildDefaultLLM } from '../llm/factory.ts';
import { buildDefaultReranker } from '../reranker/factory.ts';
import { RunsWriter } from '../runs/writer.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM } from '../llm/types.ts';
import type { Reranker } from '../reranker/types.ts';
import { resolveTransformersCacheDir, type ResolvedConfig } from '../config.ts';
import { ensureFeedbackDirs } from '../workspace.ts';
import { SessionTable } from '../feedback/session-table.ts';

export type RuntimeOptions = {
  /** Source: anydocs project (pages/ + navigation/). */
  projectRoot: string;
  /** Runtime: index.db + runs/ + answer-cache/. Always lives under
   *  `<workspace>/state/<projectId>/` (ARCH §16.1 双根分离). */
  stateRoot: string;
  config: ResolvedConfig;
  /** Override embedder (tests inject MockEmbedder). */
  embedder?: Embedder;
  /**
   * Override reranker. Pass `null` to explicitly disable even when config says
   * enabled (useful in tests). Omit to follow config.reranker.enabled.
   */
  reranker?: Reranker | null;
  /** Override LLM (tests inject MockLLM). */
  llm?: LLM;
  /**
   * If true, skip the chokidar watcher at start. Tests use this to keep the
   * filesystem from triggering reindex churn during assertions.
   */
  skipWatcher?: boolean;
  /** Inject a different DB (e.g. in-memory) for tests. Defaults to file path. */
  db?: DbHandle;
};

export type RuntimeStartResult = {
  /** Stats from the bootstrap fullReindex. */
  initialIndex: FullReindexStats;
  /** ms spent in step 1-4. */
  boot_ms: number;
};

export class Runtime {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly config: ResolvedConfig;
  readonly db: DbHandle;
  readonly embedder: Embedder;
  /**
   * Cross-encoder reranker. `null` when config.reranker.enabled = false or
   * tests passed `reranker: null`. answer.ts treats null as "skip the
   * cross-encoder rerank stage" and the rule rerank remains the only ranking
   * authority — keeps v1 pipeline byte-equivalent unless explicitly enabled.
   */
  readonly reranker: Reranker | null;
  readonly indexer: Indexer;
  readonly runs: RunsWriter;
  /**
   * γ session table — holds recent (question, embedding) pairs per Reader
   * session for the 5min re-ask detector (ARCH §15.2.2). Always constructed
   * so callers don't need a null-check; the orchestrator gates writes on
   * config.feedback.{enabled, implicitSignals} (PRD §11.4 #6).
   */
  readonly sessions: SessionTable;
  private watcher: ProjectWatcher | null = null;
  private warmFlag = false;
  private startedAt: number | null = null;
  private lastIndexedAt: number | null = null;
  /**
   * LLM is built lazily — index-only commands (`reindex`, `status`) and
   * health probes never touch it, so requiring ANTHROPIC_API_KEY at boot
   * just to run a reindex would be hostile. The first /v1/ask call resolves
   * the provider; missing env vars surface there as a normal error to the
   * caller, not as a fatal startup crash.
   */
  private readonly llmFactory: () => LLM;
  private llmInstance: LLM | null = null;

  constructor(opts: RuntimeOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.stateRoot = resolve(opts.stateRoot);
    this.config = opts.config;
    this.db = opts.db ?? openDatabase({ stateRoot: this.stateRoot });
    this.embedder = opts.embedder ?? buildDefaultEmbedder(opts.config);
    this.reranker = opts.reranker === undefined ? buildDefaultReranker(opts.config) : opts.reranker;
    if (opts.llm) {
      this.llmInstance = opts.llm;
      this.llmFactory = () => opts.llm!;
    } else {
      this.llmFactory = () => buildDefaultLLM(opts.config);
    }
    this.indexer = new Indexer({
      db: this.db,
      embedder: this.embedder,
      projectRoot: this.projectRoot,
      chunkOptions: {
        maxChars: opts.config.indexing.chunkMaxTokens * 4,
      },
    });
    this.runs = new RunsWriter({
      stateRoot: this.stateRoot,
      enabled: opts.config.runs.enabled,
      truncateQueryChars: opts.config.runs.truncateQueryChars,
      truncateAnswerChars: opts.config.runs.truncateAnswerChars,
    });
    this.sessions = new SessionTable();
    if (!opts.skipWatcher) {
      this.watcher = new ProjectWatcher({
        projectRoot: this.projectRoot,
        indexer: this.indexer,
        debounceMs: opts.config.indexing.debounceMs,
        onApplied: () => {
          this.lastIndexedAt = Date.now();
        },
      });
    }
  }

  get warm(): boolean {
    return this.warmFlag;
  }

  /**
   * Returns the LLM, building it on first access. Throws synchronously if
   * the configured provider can't be constructed (e.g. missing API key);
   * /v1/ask catches this and turns it into a structured error response.
   */
  get llm(): LLM {
    if (!this.llmInstance) {
      this.llmInstance = this.llmFactory();
    }
    return this.llmInstance;
  }

  get lastIndexedAtMs(): number | null {
    return this.lastIndexedAt;
  }

  get bootedAtMs(): number | null {
    return this.startedAt;
  }

  async start(): Promise<RuntimeStartResult> {
    const t0 = Date.now();
    // v1.5 feedback loop (RFC 0001 §2.1 S1): create the per-project review
    // directory tree only when the operator has opted in. PRD §11.4 #6 says
    // `feedback.enabled = false` (the default) must leave the workspace
    // byte-identical to v1 — so no dirs touched on disabled boots.
    if (this.config.feedback.enabled) {
      ensureFeedbackDirs(this.stateRoot);
    }
    // Warm embedder + reranker in parallel — they're independent and both
    // pay the ONNX session startup cost on first call. ~1-2s saved at boot
    // when reranker is enabled.
    await Promise.all([
      this.embedder.warmUp ? this.embedder.warmUp() : Promise.resolve(),
      this.reranker?.warmUp ? this.reranker.warmUp() : Promise.resolve(),
    ]);
    const initialIndex = await this.indexer.fullReindex();
    this.lastIndexedAt = Date.now();
    if (this.watcher) {
      this.watcher.start();
      await this.watcher.ready();
    }
    this.warmFlag = true;
    this.startedAt = Date.now();
    return { initialIndex, boot_ms: this.startedAt - t0 };
  }

  async stop(): Promise<void> {
    this.warmFlag = false;
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    // We deliberately do NOT call embedder.dispose() here. With
    // onnxruntime-node 1.21 (the version transformers.js@3.8 pulls in),
    // explicit pipeline.dispose() races with the ONNX worker thread's own
    // shutdown and the C runtime aborts with `libc++abi: mutex lock failed`.
    // Letting the OS reap the worker on process exit produces a clean exit
    // because SQLite WAL is already fsynced by the close() below. dispose()
    // is still on the Embedder interface for future use / for a safer ONNX
    // upgrade path.
    try {
      this.db.close();
    } catch {
      // already closed; ignore.
    }
  }

  /** Run a full reindex on demand (POST /v1/index/rebuild). */
  async forceReindex(): Promise<FullReindexStats> {
    const stats = await this.indexer.fullReindex();
    this.lastIndexedAt = Date.now();
    return stats;
  }
}

// ---------------------------------------------------------------------------
// Default builders
// ---------------------------------------------------------------------------

function buildDefaultEmbedder(config: ResolvedConfig): Embedder {
  // The 'mock' provider isn't a real config option per ARCH §9 (only `local`
  // is), but we want a deterministic default for tests / dev that explicitly
  // ask. For the real `local` path, dispatch by model name.
  if (config.embedding.provider === 'local' && config.embedding.model === 'bge-m3') {
    return new Bgem3Embedder({
      preferQuantized: config.embedding.preferQuantized,
      cacheDir: resolveTransformersCacheDir(config),
    });
  }
  // Unknown model — fall back to mock so the server boots but logs are loud.
  process.stderr.write(
    `[ask] embedding.model "${config.embedding.model}" not recognized; using MockEmbedder\n`,
  );
  return new MockEmbedder();
}
