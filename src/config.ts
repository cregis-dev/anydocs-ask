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

export type ResolvedConfig = {
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  retrieval: RetrievalConfig;
  clarify: ClarifyConfig;
  server: ServerConfig;
  indexing: IndexingConfig;
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
};

export async function loadConfig(projectRoot: string): Promise<LoadConfigResult> {
  const path = join(resolve(projectRoot), 'anydocs.ask.json');
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: structuredClone(DEFAULTS), source: null, warnings: [] };
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
  return { config, source: path, warnings };
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
  return out;
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
