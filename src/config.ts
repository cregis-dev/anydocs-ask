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

export type RetrievalConfig = {
  topK: number;
  rrfK: number;
  rerankSameSubtreeBoost: number;
  navOrderBoost: number;
  maxChunksHardCap: number;
};

export type ServerConfig = {
  host: string;
  port: number;
  cors: { allowedOrigins: string[] };
};

export type IndexingConfig = {
  chunkMaxTokens: number;
  chunkHardCap: number;
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
  /** D1 confidence floor — runs at-or-below count as low-confidence. */
  confidenceFloor: number;
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
  retrieval: RetrievalConfig;
  server: ServerConfig;
  indexing: IndexingConfig;
  runs: RunsConfig;
  analyze: AnalyzeConfig;
  feedback: FeedbackConfig;
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
  retrieval: {
    topK: 20,
    rrfK: 60,
    rerankSameSubtreeBoost: 0.2,
    navOrderBoost: 0.1,
    maxChunksHardCap: 20,
  },
  server: {
    host: '127.0.0.1',
    port: 3100,
    cors: { allowedOrigins: [] },
  },
  indexing: {
    chunkMaxTokens: 500,
    chunkHardCap: 1000,
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
    confidenceFloor: 0.4,
  },
  feedback: {
    enabled: false,
    implicitSignals: 'session-only',
    rerankerWeight: 0.15,
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
  applySection(user.retrieval, out.retrieval, 'retrieval', warnings);
  applyServer(user.server, out.server, warnings);
  applySection(user.indexing, out.indexing, 'indexing', warnings);
  applyRuns(user.runs, out.runs, warnings);
  applyAnalyze(user.analyze, out.analyze, warnings);
  applyFeedback(user.feedback, out.feedback, warnings);
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

function applyAnalyze(value: unknown, target: AnalyzeConfig, warnings: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push(`anydocs.ask.json: 'analyze' must be an object; ignored`);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ['lookbackDays', 'latencyP95Threshold', 'confidenceFloor'] as const) {
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
