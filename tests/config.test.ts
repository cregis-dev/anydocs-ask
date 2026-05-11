/**
 * Config loader tests — defaults, file overrides, lenient validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, resolveTransformersCacheDir } from '../src/config.ts';

async function withTmpProject(setup: (root: string) => Promise<void>): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-cfg-'));
  await setup(root);
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('loadConfig: missing file -> defaults, source = null', async () => {
  const { root, cleanup } = await withTmpProject(async () => {});
  try {
    const r = await loadConfig(root);
    assert.equal(r.source, null);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.config.embedding.model, 'bge-m3');
    assert.equal(r.config.llm.provider, 'anthropic');
    assert.equal(r.config.server.port, 3100);
    assert.deepEqual(r.config.server.cors.allowedOrigins, []);
  } finally {
    await cleanup();
  }
});

test('loadConfig: user fields merge over defaults', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        embedding: { preferQuantized: true },
        server: { port: 4200, cors: { allowedOrigins: ['https://reader.example.com'] } },
        llm: { model: 'claude-opus-4-7' },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.embedding.preferQuantized, true);
    assert.equal(r.config.embedding.model, 'bge-m3', 'unchanged fields fall back to default');
    assert.equal(r.config.server.port, 4200);
    assert.deepEqual(r.config.server.cors.allowedOrigins, ['https://reader.example.com']);
    assert.equal(r.config.llm.model, 'claude-opus-4-7');
  } finally {
    await cleanup();
  }
});

test('loadConfig: malformed JSON throws with a clear message', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(join(r, 'anydocs.ask.json'), '{ this is not json ');
  });
  try {
    await assert.rejects(() => loadConfig(root), /malformed JSON/);
  } finally {
    await cleanup();
  }
});

test('loadConfig: type-mismatched fields are warned (not thrown), defaults preserved', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        retrieval: { topK: 'twenty' }, // wrong type
        server: 'oops',                // wrong type
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.retrieval.topK, 20, 'default preserved on type mismatch');
    assert.equal(r.config.server.port, 3100, 'default preserved when section is wrong type');
    assert.ok(r.warnings.length >= 2);
  } finally {
    await cleanup();
  }
});

test('loadConfig: ANTHROPIC_MODEL env var overrides llm.model', async () => {
  const prev = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = 'glm-5.1';
  const { root, cleanup } = await withTmpProject(async () => {});
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.llm.model, 'glm-5.1', 'env wins over default');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prev;
    await cleanup();
  }
});

test('loadConfig: blank ANTHROPIC_MODEL leaves config.llm.model alone', async () => {
  const prev = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = '   ';
  const { root, cleanup } = await withTmpProject(async () => {});
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.llm.model, 'claude-sonnet-4-6', 'blank env should not override');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prev;
    await cleanup();
  }
});

test('resolveTransformersCacheDir: default = ~/.cache/huggingface/anydocs-ask/transformers', async () => {
  const prev = process.env.ANYDOCS_TRANSFORMERS_CACHE;
  delete process.env.ANYDOCS_TRANSFORMERS_CACHE;
  const { root, cleanup } = await withTmpProject(async () => {});
  try {
    const r = await loadConfig(root);
    const got = resolveTransformersCacheDir(r.config);
    const expected = join(homedir(), '.cache', 'huggingface', 'anydocs-ask', 'transformers');
    assert.equal(got, expected);
  } finally {
    if (prev !== undefined) process.env.ANYDOCS_TRANSFORMERS_CACHE = prev;
    await cleanup();
  }
});

test('resolveTransformersCacheDir: env ANYDOCS_TRANSFORMERS_CACHE wins over config + default', async () => {
  const prev = process.env.ANYDOCS_TRANSFORMERS_CACHE;
  process.env.ANYDOCS_TRANSFORMERS_CACHE = '/tmp/custom-hf-cache';
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ embedding: { cacheDir: '/tmp/from-config' } }),
    );
  });
  try {
    const r = await loadConfig(root);
    const got = resolveTransformersCacheDir(r.config);
    assert.equal(got, '/tmp/custom-hf-cache');
  } finally {
    if (prev === undefined) delete process.env.ANYDOCS_TRANSFORMERS_CACHE;
    else process.env.ANYDOCS_TRANSFORMERS_CACHE = prev;
    await cleanup();
  }
});

test('resolveTransformersCacheDir: anydocs.ask.json cacheDir picked when env unset', async () => {
  const prev = process.env.ANYDOCS_TRANSFORMERS_CACHE;
  delete process.env.ANYDOCS_TRANSFORMERS_CACHE;
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ embedding: { cacheDir: '/tmp/from-config' } }),
    );
  });
  try {
    const r = await loadConfig(root);
    const got = resolveTransformersCacheDir(r.config);
    assert.equal(got, '/tmp/from-config');
  } finally {
    if (prev !== undefined) process.env.ANYDOCS_TRANSFORMERS_CACHE = prev;
    await cleanup();
  }
});

test('loadConfig: api key never read out of file even if present', async () => {
  // Spec: API keys come ONLY from env vars named in apiKeyEnv. The loader
  // doesn't surface a `apiKey` field; if a user sticks one in, it should be
  // silently ignored (we just don't have a field for it).
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ llm: { apiKey: 'sk-secret', apiKeyEnv: 'CUSTOM_VAR' } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.llm.apiKeyEnv, 'CUSTOM_VAR');
    // No 'apiKey' field exists on the resolved config — narrow types prove it.
    assert.equal((r.config.llm as { apiKey?: string }).apiKey, undefined);
  } finally {
    await cleanup();
  }
});
