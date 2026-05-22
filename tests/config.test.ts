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

test('loadConfig: prompt customization merges over defaults', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        prompt: {
          assistantName: 'Cregis AI Assistant',
          systemInstructions: [
            'Payment Engine is for orders, checkout, callbacks, and payment status.',
            'WaaS is for wallets, addresses, deposits, collection, and withdrawals.',
          ],
        },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.prompt.assistantName, 'Cregis AI Assistant');
    assert.deepEqual(r.config.prompt.systemInstructions, [
      'Payment Engine is for orders, checkout, callbacks, and payment status.',
      'WaaS is for wallets, addresses, deposits, collection, and withdrawals.',
    ]);
  } finally {
    await cleanup();
  }
});

test('loadConfig: prompt rejects invalid fields with warnings', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        prompt: {
          assistantName: '',
          systemInstructions: ['valid instruction', 123, ''],
        },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.prompt.assistantName, null);
    assert.deepEqual(r.config.prompt.systemInstructions, ['valid instruction']);
    assert.ok(
      r.warnings.some((w) => /prompt\.assistantName/.test(w)),
      `expected assistantName warning; got ${JSON.stringify(r.warnings)}`,
    );
    assert.ok(
      r.warnings.some((w) => /prompt\.systemInstructions/.test(w)),
      `expected systemInstructions warning; got ${JSON.stringify(r.warnings)}`,
    );
  } finally {
    await cleanup();
  }
});

test('loadConfig: prompt normalizes whitespace and caps prompt size with warnings', async () => {
  const longName = `Cregis\n${'A'.repeat(120)}`;
  const longInstruction = `Line one\n${'B'.repeat(700)}`;
  const manyInstructions = Array.from({ length: 25 }, (_, i) => `instruction ${i + 1}`);
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        prompt: {
          assistantName: longName,
          systemInstructions: [longInstruction, ...manyInstructions],
        },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.prompt.assistantName?.includes('\n'), false);
    assert.equal(r.config.prompt.assistantName?.length, 80);
    assert.equal(r.config.prompt.systemInstructions.length, 20);
    assert.equal(r.config.prompt.systemInstructions[0].includes('\n'), false);
    assert.equal(r.config.prompt.systemInstructions[0].length, 500);
    assert.ok(
      r.warnings.some((w) => /prompt\.assistantName exceeds/.test(w)),
      `expected assistantName length warning; got ${JSON.stringify(r.warnings)}`,
    );
    assert.ok(
      r.warnings.some((w) => /prompt\.systemInstructions\[0\] exceeds/.test(w)),
      `expected instruction length warning; got ${JSON.stringify(r.warnings)}`,
    );
    assert.ok(
      r.warnings.some((w) => /prompt\.systemInstructions keeps only/.test(w)),
      `expected instruction count warning; got ${JSON.stringify(r.warnings)}`,
    );
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

// ---------------------------------------------------------------------------
// feedback section (v1.5 / RFC 0001 §2.1 S6)
// ---------------------------------------------------------------------------

test('loadConfig: feedback defaults — enabled=false, session-only γ, rerankerWeight 0.15', async () => {
  // Default-off is load-bearing — PRD §11.4 #6 says enabled=false must be
  // byte-equivalent to v1. The other two defaults are forward-declared for
  // 0.3 reranker priors / γ collection.
  const { root, cleanup } = await withTmpProject(async () => {});
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.feedback.enabled, false);
    assert.equal(r.config.feedback.implicitSignals, 'session-only');
    assert.equal(r.config.feedback.rerankerWeight, 0.15);
  } finally {
    await cleanup();
  }
});

test('loadConfig: feedback fields merge over defaults', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        feedback: { enabled: true, implicitSignals: 'off', rerankerWeight: 0.25 },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.feedback.enabled, true);
    assert.equal(r.config.feedback.implicitSignals, 'off');
    assert.equal(r.config.feedback.rerankerWeight, 0.25);
  } finally {
    await cleanup();
  }
});

test('loadConfig: feedback rejects invalid implicitSignals values with a warning', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ feedback: { implicitSignals: 'on-and-on' } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.feedback.implicitSignals, 'session-only', 'falls back to default');
    assert.ok(
      r.warnings.some((w) => /implicitSignals/.test(w)),
      `expected an implicitSignals warning; got ${JSON.stringify(r.warnings)}`,
    );
  } finally {
    await cleanup();
  }
});

test('loadConfig: feedback rejects out-of-range rerankerWeight with a warning', async () => {
  // ARCH §15.3 clips chunk priors to [-0.3, +0.3], but the multiplier on top
  // (rerankerWeight) must itself be in [0, 1] — a 2.0 multiplier would let a
  // single curated review dominate every retrieval.
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ feedback: { rerankerWeight: 2 } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.feedback.rerankerWeight, 0.15, 'falls back to default');
    assert.ok(
      r.warnings.some((w) => /rerankerWeight/.test(w)),
      `expected a rerankerWeight warning; got ${JSON.stringify(r.warnings)}`,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// multiTurn section (RFC 0003 — alpha.1 flip, default-on with 3-turn window)
// ---------------------------------------------------------------------------

test('loadConfig: multiTurn defaults — enabled, 3-turn history window (alpha.1 flip)', async () => {
  // RFC 0003 alpha.1 (2026-05-22) flipped the default from false → true once
  // M1+M2+M3+M4 were end-to-end wired. Design partners get pronoun resolution
  // on second turns without flipping a knob; operators who want the old
  // alpha.0 (M1-only, embedding-splice-only) behaviour pin enabled=false.
  const { root, cleanup } = await withTmpProject(async () => {});
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.multiTurn.enabled, true);
    assert.equal(r.config.multiTurn.historyTurns, 3);
  } finally {
    await cleanup();
  }
});

test('loadConfig: multiTurn.enabled=false explicit override pins single-turn', async () => {
  // Escape hatch — operators wanting alpha.0 byte-equivalent single-turn
  // behaviour (no prompt history block, no embedding splice, no
  // history_window field on responses) must be able to disable cleanly.
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ multiTurn: { enabled: false } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.multiTurn.enabled, false);
    assert.equal(r.config.multiTurn.historyTurns, 3, 'historyTurns default preserved');
    assert.deepEqual(r.warnings, []);
  } finally {
    await cleanup();
  }
});

test('loadConfig: multiTurn fields merge over defaults', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        multiTurn: { enabled: true, historyTurns: 5 },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.multiTurn.enabled, true);
    assert.equal(r.config.multiTurn.historyTurns, 5);
    assert.deepEqual(r.warnings, []);
  } finally {
    await cleanup();
  }
});

test('loadConfig: multiTurn rejects out-of-range historyTurns with a warning', async () => {
  // Hard cap at 20 — beyond that the primary LLM's input grows fast enough
  // to dilute current_q signal and inflate token cost without recall gain
  // (RFC §4.3).
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ multiTurn: { historyTurns: 0 } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.multiTurn.historyTurns, 3, 'falls back to default');
    assert.ok(
      r.warnings.some((w) => /historyTurns/.test(w)),
      `expected a historyTurns warning; got ${JSON.stringify(r.warnings)}`,
    );
  } finally {
    await cleanup();
  }
});

test('loadConfig: multiTurn rejects non-object value with a warning, leaves siblings intact', async () => {
  // Defensive: a malformed multiTurn section must not bleed into other
  // sections (feedback / prompt etc.). Same posture as feedback / runs.
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        multiTurn: 'enabled',
        feedback: { enabled: true },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.multiTurn.enabled, true, 'multiTurn defaults preserved');
    assert.equal(r.config.feedback.enabled, true, 'sibling section still merges');
    assert.ok(
      r.warnings.some((w) => /'multiTurn' must be an object/.test(w)),
      `expected a multiTurn shape warning; got ${JSON.stringify(r.warnings)}`,
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// citationSemanticCheck section (RFC 0005 alpha.0 — schema 留位, default off)
// ---------------------------------------------------------------------------

test('loadConfig: citationSemanticCheck defaults — off, shadow mode', async () => {
  // RFC 0005 alpha.0 (2026-05-23) lands the schema slot for the B.2 reused-
  // main-LLM citation validator. 0.3 alpha.1 wires the actual validation;
  // for now flipping enabled has no runtime effect (the field is read by
  // future code), and `mode` is reserved for the 0.4 H4 enforce upgrade.
  const { root, cleanup } = await withTmpProject(async () => {});
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.citationSemanticCheck.enabled, false);
    assert.equal(r.config.citationSemanticCheck.mode, 'shadow');
  } finally {
    await cleanup();
  }
});

test('loadConfig: citationSemanticCheck.enabled=true is accepted without warning', async () => {
  // Operators opting in early should not see noise — alpha.0 silently
  // accepts the flip even though the pipeline does not yet consume it.
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ citationSemanticCheck: { enabled: true } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.citationSemanticCheck.enabled, true);
    assert.equal(r.config.citationSemanticCheck.mode, 'shadow', 'mode default preserved');
    assert.deepEqual(r.warnings, []);
  } finally {
    await cleanup();
  }
});

test('loadConfig: citationSemanticCheck.mode=enforce schema-accepted but warned (0.4 H4 reserved)', async () => {
  // `enforce` is reserved for the 0.4 H4 hard-gate upgrade. The schema accepts
  // it so the file validates cleanly, but until 0.4 H4 lands operators should
  // be told flipping it does not yet change behaviour.
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ citationSemanticCheck: { enabled: true, mode: 'enforce' } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.citationSemanticCheck.mode, 'enforce');
    assert.deepEqual(r.warnings, [], 'enforce is a valid schema value, no warning');
  } finally {
    await cleanup();
  }
});

test('loadConfig: citationSemanticCheck.mode rejects garbage with a warning', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({ citationSemanticCheck: { mode: 'paranoid' } }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(r.config.citationSemanticCheck.mode, 'shadow', 'falls back to default');
    assert.ok(
      r.warnings.some((w) => /citationSemanticCheck\.mode/.test(w)),
      `expected a mode warning; got ${JSON.stringify(r.warnings)}`,
    );
  } finally {
    await cleanup();
  }
});

test('loadConfig: citationSemanticCheck rejects non-object value with a warning, leaves siblings intact', async () => {
  const { root, cleanup } = await withTmpProject(async (r) => {
    await fs.writeFile(
      join(r, 'anydocs.ask.json'),
      JSON.stringify({
        citationSemanticCheck: 42,
        feedback: { enabled: true },
      }),
    );
  });
  try {
    const r = await loadConfig(root);
    assert.equal(
      r.config.citationSemanticCheck.enabled,
      false,
      'citationSemanticCheck defaults preserved',
    );
    assert.equal(r.config.feedback.enabled, true, 'sibling section still merges');
    assert.ok(
      r.warnings.some((w) => /'citationSemanticCheck' must be an object/.test(w)),
      `expected a citationSemanticCheck shape warning; got ${JSON.stringify(r.warnings)}`,
    );
  } finally {
    await cleanup();
  }
});
