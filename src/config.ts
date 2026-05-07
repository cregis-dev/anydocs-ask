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
import { join, resolve } from 'node:path';

export type EmbeddingConfig = {
  provider: 'local';
  model: string;
  allowSingleLangFallback: boolean;
  preferQuantized: boolean;
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

export type ClarifyConfig = {
  dominantThreshold: number;
  ambiguousGap: number;
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

export type ResolvedConfig = {
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  retrieval: RetrievalConfig;
  clarify: ClarifyConfig;
  server: ServerConfig;
  indexing: IndexingConfig;
  runs: RunsConfig;
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
  clarify: {
    dominantThreshold: 0.65,
    ambiguousGap: 0.15,
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
export function applyEnvOverrides(config: ResolvedConfig): void {
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  if (envModel && envModel.length > 0 && config.llm.provider === 'anthropic') {
    config.llm.model = envModel;
  }
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
  applySection(user.clarify, out.clarify, 'clarify', warnings);
  applyServer(user.server, out.server, warnings);
  applySection(user.indexing, out.indexing, 'indexing', warnings);
  applyRuns(user.runs, out.runs, warnings);
  return out;
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
