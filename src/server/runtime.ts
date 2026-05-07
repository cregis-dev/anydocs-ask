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
import { AnthropicLLM } from '../llm/anthropic.ts';
import { MockLLM } from '../llm/mock.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM } from '../llm/types.ts';
import type { ResolvedConfig } from '../config.ts';

export type RuntimeOptions = {
  projectRoot: string;
  config: ResolvedConfig;
  /** Override embedder (tests inject MockEmbedder). */
  embedder?: Embedder;
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
  readonly config: ResolvedConfig;
  readonly db: DbHandle;
  readonly embedder: Embedder;
  readonly llm: LLM;
  readonly indexer: Indexer;
  private watcher: ProjectWatcher | null = null;
  private warmFlag = false;
  private startedAt: number | null = null;
  private lastIndexedAt: number | null = null;

  constructor(opts: RuntimeOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.config = opts.config;
    this.db = opts.db ?? openDatabase({ projectRoot: this.projectRoot });
    this.embedder = opts.embedder ?? buildDefaultEmbedder(opts.config);
    this.llm = opts.llm ?? buildDefaultLLM(opts.config);
    this.indexer = new Indexer({
      db: this.db,
      embedder: this.embedder,
      projectRoot: this.projectRoot,
    });
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

  get lastIndexedAtMs(): number | null {
    return this.lastIndexedAt;
  }

  get bootedAtMs(): number | null {
    return this.startedAt;
  }

  async start(): Promise<RuntimeStartResult> {
    const t0 = Date.now();
    if (this.embedder.warmUp) await this.embedder.warmUp();
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
    return new Bgem3Embedder({ preferQuantized: config.embedding.preferQuantized });
  }
  // Unknown model — fall back to mock so the server boots but logs are loud.
  process.stderr.write(
    `[ask] embedding.model "${config.embedding.model}" not recognized; using MockEmbedder\n`,
  );
  return new MockEmbedder();
}

function buildDefaultLLM(config: ResolvedConfig): LLM {
  if (config.llm.provider === 'mock') {
    return new MockLLM({ model: config.llm.model });
  }
  if (config.llm.provider === 'anthropic') {
    const apiKey = process.env[config.llm.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `LLM provider 'anthropic' requires environment variable '${config.llm.apiKeyEnv}' to be set`,
      );
    }
    return new AnthropicLLM({ model: config.llm.model, apiKey });
  }
  throw new Error(`LLM provider '${config.llm.provider}' is not supported in v1`);
}
