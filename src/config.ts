/**
 * `anydocs.ask.json` loader + defaults — mirrors ARCH §9.
 *
 * The file is optional; we merge over a baked-in defaults object so a project
 * with no config still boots. API keys come exclusively from the environment
 * variable named in `llm.apiKeyEnv`; we never read the value out of disk.
 *
 * Validation is lenient and best-effort — unknown keys are ignored, malformed
 * sub-objects fall back to defaults with a warning. Hard failures only on
 * schema-incompatible JSON (e.g. `embedding.provider` set to a non-string).
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type EmbeddingConfig = {
  provider: 'local';
  model: string;
  allowSingleLangFallback: boolean;
  preferQuantized: boolean;
  /**
   * Absolute path to the transformers.js model cache. null = built-in
   * fallback (~/.cache/huggingface/anydocs-ask/transformers/).
   *
   * The transformers.js default points inside node_modules/, which gets
   * wiped by every `pnpm install` and is per-worktree — forcing a 2GB
   * bge-m3 re-download. A stable home-cache location survives both.
   *
   * Resolution order (highest first):
   *   1. env ANYDOCS_TRANSFORMERS_CACHE
   *   2. anydocs.ask.json embedding.cacheDir
   *   3. ~/.cache/huggingface/anydocs-ask/transformers/
   */
  cacheDir: string | null;
};

export type LLMConfig = {
  provider: 'anthropic' | 'openai' | 'mock';
  model: string;
  apiKeyEnv: string;
};

export type RouterConfig = {
  /** Disable semantic routing entirely and always use the deterministic route. */
  enabled: boolean;
  /** Optional lightweight model override. null reuses llm.model. */
  model: string | null;
  /** Standalone questions at or below this size skip the router LLM. */
  fastPathMaxChars: number;
  /** In-memory route-cache TTL. Zero disables caching. */
  cacheTtlMs: number;
  /** Maximum cached routes retained by one server process. */
  cacheMaxEntries: number;
};

export type RetrievalConfig = {
  topK: number;
  rrfK: number;
  maxChunksHardCap: number;
};

/**
 * Cross-encoder reranker — optionally re-scores the top RRF candidates as
 * (query, doc) pairs. Disabled by default.
 *
 * When enabled, the reranker scores the top {@link rerankTopK} candidates and
 * blends that ordering with the original hybrid-retrieval order. The window
 * size balances recall against linear inference cost.
 */
export type RerankerConfig = {
  enabled: boolean;
  provider: 'bge-cross-encoder' | 'mock';
  model: string;
  /** Pinned Hugging Face model revision for reproducible ONNX loading. */
  revision: string | null;
  preferQuantized: boolean;
  /** Tokens per (query, doc) pair fed into the cross-encoder. 512 = model native. */
  maxLength: number;
  /** Size of the RRF candidate window sent to the cross-encoder. Inference is
   *  O(N) in this number. */
  rerankTopK: number;
  /** Cross-encoder rank weight in the final reciprocal-rank blend. The
   *  remaining weight preserves exact/BM25/vector retrieval evidence. */
  weight: number;
};

export type ServerConfig = {
  host: string;
  port: number;
  /**
   * Maximum number of in-flight /v1/ask and /v1/ask/stream calls handled by
   * one server process. Excess calls fail fast with 429 so SSE clients don't
   * sit on half-open streams under load.
   */
  maxConcurrentAsk: number;
  cors: { allowedOrigins: string[] };
};

export type IndexingConfig = {
  chunkMaxTokens: number;
  debounceMs: number;
};

export type RunsConfig = {
  enabled: boolean;
  /** v1 only supports 'weekly' (ISO-week file rotation). */
  rotation: 'weekly';
  /** Cap persisted query length in chars. null = no truncation. */
  truncateQueryChars: number | null;
  /** Cap persisted answer.md length in chars. null = no truncation. */
  truncateAnswerChars: number | null;
};

export type AnalyzeConfig = {
  /** Default --since window when caller passes nothing. */
  lookbackDays: number;
  /** D2 fires when latency_ms exceeds this (ms). */
  latencyP95Threshold: number;
};

/**
 * v1.5 feedback loop — mirrors ARCH §15.7 + RFC 0001 §2.1 (S6).
 *
 * Default `enabled = false` is load-bearing (PRD §11.4 #6): with this false,
 * query pipeline behaviour is byte-equivalent to v1. Switching to true is
 * what authorises:
 *   - β button reads (Reader → /v1/ask/feedback writes `signal_source='explicit'`)
 *   - γ implicit signals (per `implicitSignals`)
 *   - feedback/ directory population (CLI export/import in 0.2.0-alpha.1)
 *
 * `rerankerWeight` is captured now for forward-compat with 0.3 reranker
 * priors (ARCH §15.3); 0.2 does not read it.
 */
export type FeedbackConfig = {
  enabled: boolean;
  /**
   * 'off'           — collect zero γ rows
   * 'session-only'  — server-side 5min same-session re-ask only (RFC §4.2)
   * 'full'          — also accept Reader-reported click/leave/dwell (0.3+)
   */
  implicitSignals: 'off' | 'session-only' | 'full';
  /** Forward-declared for 0.3 reranker priors; ignored in 0.2. */
  rerankerWeight: number;
};

/**
 * Multi-turn / session rewrite — RFC 0003 (0.4.x). Schema登记 only in 0.2;
 * pipeline does not read these values yet. Mirrors `FeedbackConfig` /
 * `feedback.rerankerWeight` precedent of "register now, consume later".
 *
 * Default `enabled = false` is load-bearing: with this off, query pipeline
 * behaviour is byte-equivalent to single-turn — no extra latency, no extra
 * Claude tokens.
 *
 * Multi-turn questions may use the configured lightweight intent router to
 * resolve references before retrieval. The answer model still receives the
 * bounded conversation history and selected documentation context.
 */
export type MultiTurnConfig = {
  enabled: boolean;
  /**
   * History window length (RFC §4.3). The pipeline keeps the most recent
   * N turns from the session table and injects them into the LLM prompt
   * alongside retrieval chunks. 3 is enough to resolve typical pronoun
   * chains without bloating context; > ~5 risks drowning current_q signal.
   */
  historyTurns: number;
};

/**
 * Evidence-first Agentic RAG rollout controls. The public API stays the same;
 * `enabled` selects the candidate implementation during offline A/B and
 * shadow/gray rollout. Once the Agent passes the release gates this flag can
 * be removed together with the legacy implementation.
 */
export type AgentConfig = {
  enabled: boolean;
  maxSteps: number;
  maxDiscoveryCalls: number;
  maxReadCalls: number;
  maxSupplementalSearchCalls: number;
  readTokenLimit: number;
};

/**
 * RFC 0005 — citation 语义校验（B.2 复用主 LLM 路径）。0.3 起 shadow 模式
 * 上线，事后异步校验每条 citation 的 claim_sentence ↔ chunk_text 是否语义
 * 一致。
 *
 * 0.3 in-scope schema 仅暴露两个字段：`enabled` 控制整段功能，`mode` 留位
 * 未来 0.4 H4（enforce 模式 — 校验失败立即重试）。0.3 alpha 阶段只实现
 * `shadow`；`enforce` 在 schema 留位但运行时拒绝（warn + fallback shadow）
 * 直到 0.4 真正接通。
 *
 * 与 RFC 0003 一致地走 B.2 路径 — 复用现有 Anthropic LLM 通道，不引入小
 * 模型 / 本地推理服务 / 外部 SaaS 校验依赖。
 */
export type CitationSemanticCheckConfig = {
  enabled: boolean;
  mode: 'shadow' | 'enforce';
};

/**
 * RFC 0006 — A+ 失败查询诊断（B.2 复用主 LLM 路径）。0.4 alignment PR
 * (2026-05-24) 仅留 schema 位，四字段都不被代码路径消费（CLI stub 仅
 * 读 `threshold` + `observationWindow` 做门槛检查输出）；alpha.1 才落
 * 聚类 pure 模块。
 *
 * 设计依据：PRD §10.3 表（A+ 启动阈值 ≥ 50 条反馈 + ≥ 4 周观察窗）+
 * PRD §11.3 F2（失败查询诊断概念）+ RFC 0006 §4.2（聚类阈值 0.65 推导）。
 *
 * - `enabled`: 整段功能开关。`false`（默认）= CLI / Studio 都跑门槛检查
 *   提示但不真产 suggestions/；`true` 配合门槛达标后真跑聚类 + 建议。
 * - `threshold`: feedback 行数门槛（默认 50，PRD §10.3）
 * - `observationWindow`: 观察窗（ISO duration 字符串，默认 '28d' = 4 周）
 * - `embedSimilarityThreshold`: bge-m3 cosine 聚类阈值（默认 0.65，
 *   RFC §4.2 推导）
 */
export type AplusConfig = {
  enabled: boolean;
  threshold: number;
  observationWindow: string;
  embedSimilarityThreshold: number;
};

/**
 * RFC 0004 — 嵌入式 Ask Widget。0.4 alignment PR (2026-05-24) 仅留 schema
 * 位，三字段都不被代码路径消费；alpha.0 才接通 W1 协议规格 + TS 类型。
 *
 * - `enabled`: 整段功能开关。`false`（默认）= widget endpoint 不挂、CORS 不
 *   动、运行时与 0.3.x 字节等价。
 * - `rateLimitPerMinute`: 公开接入维度的 token bucket 上限（RFC §5 Q4）。
 *   0.5+ Phase 1 才真消费。
 * - `allowedOrigins`: 域名白名单，每条是合法 Origin 字符串（`https://app.example.com`
 *   形态，不含路径）。空数组在 alpha.x 阶段意味"无任何外部源可用"；GA 后
 *   作为强约束。
 */
export type WidgetConfig = {
  enabled: boolean;
  rateLimitPerMinute: number;
  allowedOrigins: string[];
};

export const WIDGET_MAX_ALLOWED_ORIGINS = 50;

/**
 * RFC 0007 — MCP 知识库接口（Streamable HTTP）。把 ask 暴露成可被其他 agent
 * 调用的 MCP server，进程内挂在现有 Hono app 的 `POST /mcp`。
 *
 * - `enabled`: 整段功能开关。`false`（默认）= `/mcp` endpoint 不挂、运行时与
 *   未启用前字节等价。
 * - `tools`: 启用哪些 tool。`search`（包 retrieve，不烧 LLM）/ `ask`（包 ask，
 *   消耗 LLM 配额）/ `fetch_page`（按 page_id 取整页）。默认 `['search','ask']`；
 *   成本敏感的 operator 可只留 `['search']`。
 * - `rateLimitPerMinute`: per-token（无 token 时 per-origin）token bucket 上限。
 * - `allowedOrigins`: 浏览器型 MCP 客户端的 Origin 白名单；空数组 = 不校验
 *   Origin（server-to-server 客户端本就不带 Origin 头）。
 *
 * 鉴权 token 走环境变量 `ANYDOCS_MCP_TOKEN`（密钥不入配置文件）：设置后
 * `Authorization: Bearer <token>` 必须匹配，否则 401。
 */
export const MCP_TOOL_NAMES = ['search', 'ask', 'fetch_page'] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpConfig = {
  enabled: boolean;
  tools: McpToolName[];
  rateLimitPerMinute: number;
  allowedOrigins: string[];
};

export const MCP_MAX_ALLOWED_ORIGINS = 50;

export type PromptConfig = {
  /**
   * Optional project-specific assistant identity. This replaces only the
   * friendly "you are ..." label; safety/citation rules remain hard-coded.
   */
  assistantName: string | null;
  /**
   * Project-specific business/domain instructions appended after the core
   * answer rules. They are additive and cannot disable citation grounding.
   */
  systemInstructions: string[];
};

export const PROMPT_ASSISTANT_NAME_MAX_CHARS = 80;
export const PROMPT_SYSTEM_INSTRUCTION_MAX_ITEMS = 20;
export const PROMPT_SYSTEM_INSTRUCTION_MAX_CHARS = 500;

export type ResolvedConfig = {
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  router: RouterConfig;
  retrieval: RetrievalConfig;
  reranker: RerankerConfig;
  server: ServerConfig;
  indexing: IndexingConfig;
  runs: RunsConfig;
  analyze: AnalyzeConfig;
  feedback: FeedbackConfig;
  multiTurn: MultiTurnConfig;
  agent: AgentConfig;
  citationSemanticCheck: CitationSemanticCheckConfig;
  widget: WidgetConfig;
  mcp: McpConfig;
  aplus: AplusConfig;
  prompt: PromptConfig;
};

export type LoadConfigResult = {
  config: ResolvedConfig;
  /** Path read from, or null when no file existed. */
  source: string | null;
  /** Non-fatal warnings from merging. */
  warnings: string[];
};

const DEFAULTS: ResolvedConfig = {
  embedding: {
    provider: 'local',
    model: 'bge-m3',
    allowSingleLangFallback: false,
    preferQuantized: false,
    cacheDir: null,
  },
  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  router: {
    enabled: true,
    model: null,
    fastPathMaxChars: 240,
    cacheTtlMs: 300_000,
    cacheMaxEntries: 512,
  },
  retrieval: {
    topK: 20,
    rrfK: 60,
    maxChunksHardCap: 20,
  },
  reranker: {
    enabled: false,
    provider: 'bge-cross-encoder',
    model: 'Xenova/bge-reranker-large',
    revision: null,
    preferQuantized: true,
    maxLength: 512,
    rerankTopK: 8,
    weight: 0.6,
  },
  server: {
    host: '127.0.0.1',
    port: 3100,
    maxConcurrentAsk: 12,
    cors: { allowedOrigins: [] },
  },
  indexing: {
    chunkMaxTokens: 500,
    debounceMs: 200,
  },
  runs: {
    enabled: true,
    rotation: 'weekly',
    truncateQueryChars: null,
    truncateAnswerChars: null,
  },
  analyze: {
    lookbackDays: 7,
    latencyP95Threshold: 3000,
  },
  feedback: {
    enabled: false,
    implicitSignals: 'session-only',
    rerankerWeight: 0.15,
  },
  multiTurn: {
    // RFC 0003 alpha.1 flip (2026-05-22). Default ON now that M1+M2+M3+M4
    // are wired end-to-end — design partner queries get pronoun resolution
    // on second turns without the operator needing to flip a knob. Per RFC
    // §6 risk table this raises LLM input tokens by ~1–2k/query on multi-
    // turn calls (~$0.003–0.006 on Sonnet 4.6); acceptable at design-partner
    // volume (< 100 q/day). Operators can still pin to `false` in
    // anydocs.ask.json to revert to the alpha.0 (M1-only) byte-equivalent
    // single-turn behaviour.
    enabled: true,
    historyTurns: 3,
  },
  agent: {
    enabled: false,
    maxSteps: 5,
    maxDiscoveryCalls: 2,
    maxReadCalls: 3,
    maxSupplementalSearchCalls: 1,
    readTokenLimit: 3300,
  },
  citationSemanticCheck: {
    // RFC 0005 alpha.0: schema 留位，整段默认关闭。0.3 alpha.1+ 才接通实际
    // 校验逻辑；当前 flip 到 true 也不产生效果（pipeline 还没读这两个字段）。
    enabled: false,
    mode: 'shadow',
  },
  widget: {
    // RFC 0004 alignment PR (2026-05-24): schema 留位，三字段都不被代码消费。
    // alpha.0 才接通 W1 协议规格。flip enabled=true 在此阶段不产生任何行为。
    enabled: false,
    rateLimitPerMinute: 60,
    allowedOrigins: [],
  },
  mcp: {
    // RFC 0007: 默认关闭。flip enabled=true 才挂 `POST /mcp`。
    enabled: false,
    tools: ['search', 'ask'],
    rateLimitPerMinute: 60,
    allowedOrigins: [],
  },
  aplus: {
    // RFC 0006 alignment PR (2026-05-24): schema 留位，仅 CLI stub 读
    // threshold / observationWindow 做门槛检查输出。alpha.1 才落聚类 pure
    // 模块；alpha.2 接通 LLM 建议生成；0.4.0 operator flip enabled=true。
    enabled: false,
    threshold: 50,
    observationWindow: '28d',
    embedSimilarityThreshold: 0.65,
  },
  prompt: {
    assistantName: null,
    systemInstructions: [],
  },
};

export async function loadConfig(projectRoot: string): Promise<LoadConfigResult> {
  const path = join(resolve(projectRoot), 'anydocs.ask.json');
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const config = structuredClone(DEFAULTS);
      applyEnvOverrides(config);
      return { config, source: null, warnings: [] };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`anydocs.ask.json: malformed JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('anydocs.ask.json: top-level value must be an object');
  }

  const warnings: string[] = [];
  const config = mergeWithDefaults(parsed as Record<string, unknown>, warnings);
  applyEnvOverrides(config);
  return { config, source: path, warnings };
}

/**
 * Apply env-var overrides to a freshly loaded (or default) config. Today this
 * is just `ANTHROPIC_MODEL`, but the seam is here so adding more env knobs
 * (e.g. retrieval tuning) doesn't need to ripple into every command. Called
 * once at config-load time so /v1/index/status, /v1/health, and CLI status
 * all see the same resolved values.
 */
/**
 * Same shape as the file-side of `loadConfig`, but accepts the raw JSON text
 * directly. Used by the console's editable Config drawer to validate edits
 * before writing to disk. Does NOT apply env overrides — the caller wants
 * to inspect / persist the file content as-is.
 *
 * Throws a clear Error on malformed JSON or non-object top-level; section
 * issues are surfaced through `warnings` (matches `loadConfig` semantics).
 */
export function parseAndValidateAskConfig(rawText: string): {
  config: ResolvedConfig;
  warnings: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`malformed JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('top-level value must be a JSON object');
  }
  const warnings: string[] = [];
  const config = mergeWithDefaults(parsed as Record<string, unknown>, warnings);
  return { config, warnings };
}

export function applyEnvOverrides(config: ResolvedConfig): void {
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  if (envModel && envModel.length > 0 && config.llm.provider === 'anthropic') {
    config.llm.model = envModel;
  }
  const routerModel = process.env.ANYDOCS_ROUTER_MODEL?.trim();
  if (routerModel && routerModel.length > 0) {
    config.router.model = routerModel;
  }
  const envMaxConcurrentAsk = process.env.ANYDOCS_ASK_MAX_CONCURRENT?.trim();
  if (envMaxConcurrentAsk && envMaxConcurrentAsk.length > 0) {
    const parsed = Number(envMaxConcurrentAsk);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000) {
      config.server.maxConcurrentAsk = parsed;
    }
  }
  const envAgentEnabled = process.env.ANYDOCS_AGENT_ENABLED?.trim().toLowerCase();
  if (envAgentEnabled === 'true' || envAgentEnabled === '1') config.agent.enabled = true;
  if (envAgentEnabled === 'false' || envAgentEnabled === '0') config.agent.enabled = false;
}

/**
 * Resolve the absolute path for the transformers.js model cache. Highest
 * priority wins; null inputs fall through to the next source.
 *
 *   1. env ANYDOCS_TRANSFORMERS_CACHE
 *   2. config.embedding.cacheDir
 *   3. ~/.cache/huggingface/anydocs-ask/transformers/
 *
 * Path is NOT mkdir-ed here — callers (Bgem3Embedder) do that when they
 * actually need to write.
 */
export function resolveTransformersCacheDir(config: ResolvedConfig): string {
  const env = process.env.ANYDOCS_TRANSFORMERS_CACHE?.trim();
  if (env && env.length > 0) return resolve(env);
  if (config.embedding.cacheDir) return resolve(config.embedding.cacheDir);
  return join(homedir(), '.cache', 'huggingface', 'anydocs-ask', 'transformers');
}

// ---------------------------------------------------------------------------
// Merge / validate helpers
// ---------------------------------------------------------------------------

function mergeWithDefaults(
  user: Record<string, unknown>,
  warnings: string[],
): ResolvedConfig {
  const out = structuredClone(DEFAULTS);
  applySection(user.embedding, out.embedding, 'embedding', warnings);
  applySection(user.llm, out.llm, 'llm', warnings);
  applyRouter(user.router, out.router, warnings);
  applyRetrieval(user.retrieval, out.retrieval, warnings);
  applyReranker(user.reranker, out.reranker, warnings);
  applyServer(user.server, out.server, warnings);
  applySection(user.indexing, out.indexing, 'indexing', warnings);
  applyRuns(user.runs, out.runs, warnings);
  applyAnalyze(user.analyze, out.analyze, warnings);
  applyFeedback(user.feedback, out.feedback, warnings);
  applyMultiTurn(user.multiTurn, out.multiTurn, warnings);
  applyAgent(user.agent, out.agent, warnings);
  applyCitationSemanticCheck(
    user.citationSemanticCheck,
    out.citationSemanticCheck,
    warnings,
  );
  applyWidget(user.widget, out.widget, warnings);
  applyMcp(user.mcp, out.mcp, warnings);
  applyAplus(user.aplus, out.aplus, warnings);
  applyPrompt(user.prompt, out.prompt, warnings);
  return out;
}

export function normalizePromptConfig(
  value: unknown,
  warnings: string[] = [],
): PromptConfig {
  const out = structuredClone(DEFAULTS.prompt);
  applyPrompt(value, out, warnings);
  return out;
}

function applyPrompt(value: unknown, target: PromptConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'prompt' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.assistantName !== undefined) {
    if (obj.assistantName === null) {
      target.assistantName = null;
    } else if (typeof obj.assistantName === 'string' && obj.assistantName.trim().length > 0) {
      target.assistantName = capPromptString(
        compactPromptWhitespace(obj.assistantName),
        PROMPT_ASSISTANT_NAME_MAX_CHARS,
        'prompt.assistantName',
        warnings,
      );
    } else {
      warnings.push(`anydocs.ask.json: prompt.assistantName must be a non-empty string or null; using default`);
    }
  }
  if (obj.systemInstructions !== undefined) {
    if (!Array.isArray(obj.systemInstructions)) {
      warnings.push(`anydocs.ask.json: prompt.systemInstructions must be an array of strings; using default`);
      return;
    }
    const instructions: string[] = [];
    let rejected = 0;
    for (const [index, item] of obj.systemInstructions.entries()) {
      if (typeof item !== 'string') {
        rejected++;
        continue;
      }
      const trimmed = compactPromptWhitespace(item);
      if (trimmed.length === 0) {
        rejected++;
        continue;
      }
      instructions.push(
        capPromptString(
          trimmed,
          PROMPT_SYSTEM_INSTRUCTION_MAX_CHARS,
          `prompt.systemInstructions[${index}]`,
          warnings,
        ),
      );
      if (instructions.length === PROMPT_SYSTEM_INSTRUCTION_MAX_ITEMS) {
        const remaining = obj.systemInstructions.length - index - 1;
        if (remaining > 0) {
          warnings.push(
            `anydocs.ask.json: prompt.systemInstructions keeps only first ${PROMPT_SYSTEM_INSTRUCTION_MAX_ITEMS} item(s); ignored ${remaining} extra item(s)`,
          );
        }
        break;
      }
    }
    target.systemInstructions = instructions;
    if (rejected > 0) {
      warnings.push(`anydocs.ask.json: prompt.systemInstructions ignored ${rejected} non-string/empty item(s)`);
    }
  }
}

function compactPromptWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function capPromptString(
  value: string,
  maxChars: number,
  label: string,
  warnings: string[],
): string {
  if (value.length <= maxChars) return value;
  warnings.push(`anydocs.ask.json: ${label} exceeds ${maxChars} characters; truncated`);
  return value.slice(0, maxChars).trim();
}

function applyFeedback(value: unknown, target: FeedbackConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'feedback' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') {
      target.enabled = obj.enabled;
    } else {
      warnings.push(`anydocs.ask.json: feedback.enabled must be a boolean; using default`);
    }
  }
  if (obj.implicitSignals !== undefined) {
    if (obj.implicitSignals === 'off' || obj.implicitSignals === 'session-only' || obj.implicitSignals === 'full') {
      target.implicitSignals = obj.implicitSignals;
    } else {
      warnings.push(
        `anydocs.ask.json: feedback.implicitSignals must be 'off' | 'session-only' | 'full'; using default`,
      );
    }
  }
  if (obj.rerankerWeight !== undefined) {
    const v = obj.rerankerWeight;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) {
      target.rerankerWeight = v;
    } else {
      warnings.push(`anydocs.ask.json: feedback.rerankerWeight must be a number in [0, 1]; using default`);
    }
  }
}

function applyMultiTurn(value: unknown, target: MultiTurnConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'multiTurn' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') {
      target.enabled = obj.enabled;
    } else {
      warnings.push(`anydocs.ask.json: multiTurn.enabled must be a boolean; using default`);
    }
  }
  if (obj.historyTurns !== undefined) {
    const v = obj.historyTurns;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 20) {
      target.historyTurns = v;
    } else {
      warnings.push(`anydocs.ask.json: multiTurn.historyTurns must be an integer in [1, 20]; using default`);
    }
  }
}

function applyAgent(value: unknown, target: AgentConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'agent' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') target.enabled = obj.enabled;
    else warnings.push(`anydocs.ask.json: agent.enabled must be a boolean; using default`);
  }
  applyAgentInteger(obj, 'maxSteps', target, 2, 12, warnings);
  applyAgentInteger(obj, 'maxDiscoveryCalls', target, 1, 8, warnings);
  applyAgentInteger(obj, 'maxReadCalls', target, 1, 8, warnings);
  applyAgentInteger(obj, 'maxSupplementalSearchCalls', target, 0, 4, warnings);
  applyAgentInteger(obj, 'readTokenLimit', target, 256, 8000, warnings);
}

function applyAgentInteger(
  obj: Record<string, unknown>,
  key: keyof Omit<AgentConfig, 'enabled'>,
  target: AgentConfig,
  min: number,
  max: number,
  warnings: string[],
): void {
  const value = obj[key];
  if (value === undefined) return;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    target[key] = value;
    return;
  }
  warnings.push(`anydocs.ask.json: agent.${key} must be an integer in [${min}, ${max}]; using default`);
}

function applyCitationSemanticCheck(
  value: unknown,
  target: CitationSemanticCheckConfig,
  warnings: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'citationSemanticCheck' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') {
      target.enabled = obj.enabled;
    } else {
      warnings.push(
        `anydocs.ask.json: citationSemanticCheck.enabled must be a boolean; using default`,
      );
    }
  }
  if (obj.mode !== undefined) {
    if (obj.mode === 'shadow' || obj.mode === 'enforce') {
      target.mode = obj.mode;
    } else {
      warnings.push(
        `anydocs.ask.json: citationSemanticCheck.mode must be 'shadow' or 'enforce'; using default`,
      );
    }
  }
}

/**
 * RFC 0004 alignment — schema 留位。三字段都不被代码消费；本函数仅做形
 * 状校验 + 默认填充。`allowedOrigins` 仅做"合法 URL origin 形态"的字符
 * 串检查，不去重 / 不规范化大小写；GA 后会有更严格的规范化处理。
 */
function applyWidget(value: unknown, target: WidgetConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'widget' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') {
      target.enabled = obj.enabled;
    } else {
      warnings.push(`anydocs.ask.json: widget.enabled must be a boolean; using default`);
    }
  }
  if (obj.rateLimitPerMinute !== undefined) {
    const v = obj.rateLimitPerMinute;
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= 10_000) {
      target.rateLimitPerMinute = v;
    } else {
      warnings.push(
        `anydocs.ask.json: widget.rateLimitPerMinute must be an integer in [1, 10000]; using default`,
      );
    }
  }
  if (obj.allowedOrigins !== undefined) {
    if (!Array.isArray(obj.allowedOrigins)) {
      warnings.push(`anydocs.ask.json: widget.allowedOrigins must be an array of strings; using default`);
      return;
    }
    const origins: string[] = [];
    let rejected = 0;
    for (const item of obj.allowedOrigins) {
      if (typeof item !== 'string') {
        rejected++;
        continue;
      }
      const trimmed = item.trim();
      // Origin = scheme + "://" + host + optional ":port", no path.
      // Cheap shape check: must parse as URL and the parsed string must
      // equal `<origin>/` or `<origin>` — anything trailing means the
      // operator probably included a path by mistake.
      let ok = false;
      try {
        const u = new URL(trimmed);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/' && !u.search && !u.hash) {
          ok = true;
        }
      } catch {
        // not a valid URL
      }
      if (!ok) {
        rejected++;
        continue;
      }
      origins.push(trimmed);
      if (origins.length === WIDGET_MAX_ALLOWED_ORIGINS) {
        const remaining = obj.allowedOrigins.length - obj.allowedOrigins.indexOf(item) - 1;
        if (remaining > 0) {
          warnings.push(
            `anydocs.ask.json: widget.allowedOrigins keeps only first ${WIDGET_MAX_ALLOWED_ORIGINS} item(s); ignored ${remaining} extra item(s)`,
          );
        }
        break;
      }
    }
    target.allowedOrigins = origins;
    if (rejected > 0) {
      warnings.push(
        `anydocs.ask.json: widget.allowedOrigins ignored ${rejected} non-string / non-origin item(s)`,
      );
    }
  }
}

/**
 * RFC 0007 — `mcp` 段。形状校验 + 默认填充，逻辑与 applyWidget 平行。
 */
function applyMcp(value: unknown, target: McpConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'mcp' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') {
      target.enabled = obj.enabled;
    } else {
      warnings.push(`anydocs.ask.json: mcp.enabled must be a boolean; using default`);
    }
  }
  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools)) {
      warnings.push(`anydocs.ask.json: mcp.tools must be an array of tool names; using default`);
    } else {
      const seen = new Set<McpToolName>();
      let rejected = 0;
      for (const item of obj.tools) {
        if (typeof item === 'string' && (MCP_TOOL_NAMES as readonly string[]).includes(item)) {
          seen.add(item as McpToolName);
        } else {
          rejected++;
        }
      }
      // Preserve canonical order regardless of how the operator listed them.
      target.tools = MCP_TOOL_NAMES.filter((name) => seen.has(name));
      if (rejected > 0) {
        warnings.push(
          `anydocs.ask.json: mcp.tools ignored ${rejected} unknown tool name(s); valid: ${MCP_TOOL_NAMES.join(', ')}`,
        );
      }
    }
  }
  if (obj.rateLimitPerMinute !== undefined) {
    const v = obj.rateLimitPerMinute;
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= 10_000) {
      target.rateLimitPerMinute = v;
    } else {
      warnings.push(
        `anydocs.ask.json: mcp.rateLimitPerMinute must be an integer in [1, 10000]; using default`,
      );
    }
  }
  if (obj.allowedOrigins !== undefined) {
    if (!Array.isArray(obj.allowedOrigins)) {
      warnings.push(`anydocs.ask.json: mcp.allowedOrigins must be an array of strings; using default`);
      return;
    }
    const origins: string[] = [];
    let rejected = 0;
    for (const item of obj.allowedOrigins) {
      if (typeof item !== 'string') {
        rejected++;
        continue;
      }
      const trimmed = item.trim();
      let ok = false;
      try {
        const u = new URL(trimmed);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/' && !u.search && !u.hash) {
          ok = true;
        }
      } catch {
        // not a valid URL
      }
      if (!ok) {
        rejected++;
        continue;
      }
      origins.push(trimmed);
      if (origins.length === MCP_MAX_ALLOWED_ORIGINS) {
        const remaining = obj.allowedOrigins.length - obj.allowedOrigins.indexOf(item) - 1;
        if (remaining > 0) {
          warnings.push(
            `anydocs.ask.json: mcp.allowedOrigins keeps only first ${MCP_MAX_ALLOWED_ORIGINS} item(s); ignored ${remaining} extra item(s)`,
          );
        }
        break;
      }
    }
    target.allowedOrigins = origins;
    if (rejected > 0) {
      warnings.push(
        `anydocs.ask.json: mcp.allowedOrigins ignored ${rejected} non-string / non-origin item(s)`,
      );
    }
  }
}

/**
 * RFC 0006 alignment — schema 留位。四字段都不被代码消费；本函数仅做
 * 形状校验 + 默认填充。alpha.1 才接通真聚类。
 */
function applyAplus(value: unknown, target: AplusConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'aplus' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') {
      target.enabled = obj.enabled;
    } else {
      warnings.push(`anydocs.ask.json: aplus.enabled must be a boolean; using default`);
    }
  }
  if (obj.threshold !== undefined) {
    const v = obj.threshold;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100_000) {
      target.threshold = v;
    } else {
      warnings.push(
        `anydocs.ask.json: aplus.threshold must be an integer in [1, 100000]; using default`,
      );
    }
  }
  if (obj.observationWindow !== undefined) {
    if (typeof obj.observationWindow === 'string' && /^\d+[dhm]$/.test(obj.observationWindow)) {
      target.observationWindow = obj.observationWindow;
    } else {
      warnings.push(
        `anydocs.ask.json: aplus.observationWindow must be a duration string (e.g. '28d', '48h', '120m'); using default`,
      );
    }
  }
  if (obj.embedSimilarityThreshold !== undefined) {
    const v = obj.embedSimilarityThreshold;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1) {
      target.embedSimilarityThreshold = v;
    } else {
      warnings.push(
        `anydocs.ask.json: aplus.embedSimilarityThreshold must be a number in (0, 1); using default`,
      );
    }
  }
}

function applyAnalyze(value: unknown, target: AnalyzeConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'analyze' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ['lookbackDays', 'latencyP95Threshold'] as const) {
    if (obj[key] === undefined) continue;
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      target[key] = v;
    } else {
      warnings.push(`anydocs.ask.json: analyze.${key} must be a non-negative number; using default`);
    }
  }
}

function applyRuns(value: unknown, target: RunsConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'runs' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.enabled === 'boolean') target.enabled = obj.enabled;
  if (obj.rotation === 'weekly') target.rotation = 'weekly';
  else if (obj.rotation !== undefined) {
    warnings.push(`anydocs.ask.json: runs.rotation only supports 'weekly' in v1; using default`);
  }
  for (const key of ['truncateQueryChars', 'truncateAnswerChars'] as const) {
    if (obj[key] === undefined) continue;
    if (obj[key] === null) {
      target[key] = null;
    } else if (typeof obj[key] === 'number' && Number.isFinite(obj[key]) && (obj[key] as number) > 0) {
      target[key] = obj[key] as number;
    } else {
      warnings.push(
        `anydocs.ask.json: runs.${key} must be a positive number or null; using default`,
      );
    }
  }
}

function applySection(
  value: unknown,
  target: Record<string, unknown>,
  name: string,
  warnings: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: '${name}' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (!(key in obj)) continue;
    const v = obj[key];
    // null in the default signals an "optional string" slot. Accept string
    // values (and explicit null, treated as a no-op); reject other types.
    if (target[key] === null) {
      if (v === null) continue;
      if (typeof v !== 'string') {
        warnings.push(
          `anydocs.ask.json: ${name}.${key} expected string|null, got ${typeof v}; using default`,
        );
        continue;
      }
      target[key] = v;
      continue;
    }
    const expected = typeof target[key];
    if (typeof v !== expected) {
      warnings.push(
        `anydocs.ask.json: ${name}.${key} expected ${expected}, got ${typeof v}; using default`,
      );
      continue;
    }
    target[key] = v;
  }
}

function applyRetrieval(
  value: unknown,
  target: RetrievalConfig,
  warnings: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'retrieval' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  const limits: Record<keyof RetrievalConfig, { min: number; max: number }> = {
    topK: { min: 1, max: 100 },
    rrfK: { min: 1, max: 10_000 },
    maxChunksHardCap: { min: 1, max: 100 },
  };
  for (const key of Object.keys(limits) as Array<keyof RetrievalConfig>) {
    if (obj[key] === undefined) continue;
    const valueForKey = obj[key];
    const { min, max } = limits[key];
    if (
      typeof valueForKey !== 'number'
      || !Number.isInteger(valueForKey)
      || valueForKey < min
      || valueForKey > max
    ) {
      warnings.push(
        `anydocs.ask.json: retrieval.${key} must be an integer from ${min} to ${max}; using default`,
      );
      continue;
    }
    target[key] = valueForKey;
  }
}

function applyReranker(
  value: unknown,
  target: RerankerConfig,
  warnings: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'reranker' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  applySection(obj, target as unknown as Record<string, unknown>, 'reranker', warnings);

  if (obj.rerankTopK !== undefined) {
    const v = obj.rerankTopK;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
      target.rerankTopK = DEFAULTS.reranker.rerankTopK;
      warnings.push('anydocs.ask.json: reranker.rerankTopK must be an integer from 1 to 100; using default');
    }
  }
  if (obj.weight !== undefined) {
    const v = obj.weight;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      target.weight = DEFAULTS.reranker.weight;
      warnings.push('anydocs.ask.json: reranker.weight must be a number from 0 to 1; using default');
    }
  }
}

function applyRouter(value: unknown, target: RouterConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'router' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === 'boolean') target.enabled = obj.enabled;
    else warnings.push(`anydocs.ask.json: router.enabled must be boolean; using default`);
  }
  if (obj.model !== undefined) {
    if (obj.model === null) target.model = null;
    else if (typeof obj.model === 'string' && obj.model.trim()) target.model = obj.model.trim();
    else warnings.push(`anydocs.ask.json: router.model must be a non-empty string or null; using default`);
  }
  const limits: Record<'fastPathMaxChars' | 'cacheTtlMs' | 'cacheMaxEntries', { min: number; max: number }> = {
    fastPathMaxChars: { min: 0, max: 2_000 },
    cacheTtlMs: { min: 0, max: 86_400_000 },
    cacheMaxEntries: { min: 1, max: 10_000 },
  };
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    if (obj[key] === undefined) continue;
    const valueForKey = obj[key];
    const { min, max } = limits[key];
    if (
      typeof valueForKey !== 'number'
      || !Number.isInteger(valueForKey)
      || valueForKey < min
      || valueForKey > max
    ) {
      warnings.push(
        `anydocs.ask.json: router.${key} must be an integer from ${min} to ${max}; using default`,
      );
      continue;
    }
    target[key] = valueForKey;
  }
}

function applyServer(
  value: unknown,
  target: ServerConfig,
  warnings: string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'server' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.host === 'string') target.host = obj.host;
  if (typeof obj.port === 'number') target.port = obj.port;
  if (obj.maxConcurrentAsk !== undefined) {
    const v = obj.maxConcurrentAsk;
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= 10_000) {
      target.maxConcurrentAsk = v;
    } else {
      warnings.push(
        `anydocs.ask.json: server.maxConcurrentAsk must be an integer in [1, 10000]; using default`,
      );
    }
  }
  if (obj.cors !== undefined) {
    if (typeof obj.cors !== 'object' || obj.cors === null) {
      warnings.push(`anydocs.ask.json: server.cors must be an object; ignored`);
    } else {
      const cors = obj.cors as Record<string, unknown>;
      if (Array.isArray(cors.allowedOrigins)) {
        target.cors.allowedOrigins = cors.allowedOrigins.filter(
          (o): o is string => typeof o === 'string',
        );
      }
    }
  }
}
