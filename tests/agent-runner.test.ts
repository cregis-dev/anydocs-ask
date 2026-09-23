import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3 } from 'ai/test';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { AgenticRagRunner } from '../src/agent/runner.ts';
import { EvidenceService } from '../src/agent/evidence.ts';
import type { AgentConfig } from '../src/config.ts';

const agentConfig: AgentConfig = {
  enabled: true,
  maxSteps: 5,
  maxDiscoveryCalls: 2,
  maxReadCalls: 2,
  maxSupplementalSearchCalls: 1,
  readTokenLimit: 3300,
};

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function generated(content: unknown[], finish: 'tool-calls' | 'stop') {
  return {
    content,
    finishReason: { unified: finish, raw: finish },
    usage,
    warnings: [],
  } as never;
}

test('AgenticRagRunner forces discovery + read and binds evidence citations', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages
        (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES ('waas-auth', 'en', 'published', 'WaaS Authentication', '/en/waas-auth',
               'waas', 1, '[]', 1)`,
    ).run();
    const parentId = Number(db.prepare(
      `INSERT INTO chunk_parents
        (page_id, lang, parent_path, heading_id, heading_path, text, content_hash, token_count, created_at)
       VALUES ('waas-auth', 'en', 'signature', 'signature', '["signature"]', ?, 'auth-parent', 24, 1)`,
    ).run(
      'For signing, exclude sign and empty values, sort parameter names, concatenate key and value, prepend the API Key, and calculate lowercase MD5.',
    ).lastInsertRowid);
    const chunkId = Number(db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, object_path, created_at)
       VALUES ('waas-auth', 'en', 'signature/p[1]', ?, 'auth-child', 16, ?, 'content', 'sign', 1)`,
    ).run('Sort fields before MD5 signature computation.', parentId).lastInsertRowid);
    db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, 'sign', 'sign', 'field')`,
    ).run(chunkId);

    const askDeps = {
      db,
      embedder: new MockEmbedder(),
      llm: new MockLLM(),
      intentRouter: null,
    };
    const expectedEvidence = new EvidenceService({ db, searchDeps: askDeps }).readDoc({
      pageId: 'waas-auth',
      lang: 'en',
    });
    const model = new MockLanguageModelV3({
      doGenerate: [
        generated([
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookupExact',
            input: JSON.stringify({ identifier: 'sign', lang: 'en' }),
          },
        ], 'tool-calls'),
        generated([
          {
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'readDoc',
            input: JSON.stringify({ pageId: 'waas-auth', lang: 'en', mode: 'page' }),
          },
        ], 'tool-calls'),
        generated([
          {
            type: 'text',
            text: `Sort parameter names, concatenate key and value, prepend the API Key, then calculate lowercase MD5 [${expectedEvidence.evidenceId}].`,
          },
        ], 'stop'),
      ],
    });
    const runner = new AgenticRagRunner({
      model,
      modelId: 'deepseek-flash',
      config: agentConfig,
      askDeps,
    });

    const response = await runner.ask({ question: 'How is the signature string ordered?' });
    assert.equal(response.result.type, 'answer');
    if (response.result.type !== 'answer') return;
    assert.match(response.result.answer_md, /\[cit_1\]/);
    assert.equal(response.result.citations[0]?.page_id, 'waas-auth');
    assert.equal(response.result.citations[0]?.chunk_id, chunkId);
    assert.equal(response.trace.agent?.steps, 3);
    assert.deepEqual(response.trace.agent?.tool_calls.map((call) => call.tool), [
      'lookupExact',
      'readDoc',
    ]);
    assert.equal(response.trace.agent?.evidence[0]?.evidence_id, expectedEvidence.evidenceId);
  } finally {
    db.close();
  }
});

test('AgenticRagRunner rejects answers that never read evidence', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages
        (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES ('only-page', 'en', 'published', 'Only Page', '/en/only-page',
               'waas', 1, '[]', 1)`,
    ).run();
    const model = new MockLanguageModelV3({
      doGenerate: [
        generated([
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'browseCatalog',
            input: JSON.stringify({ lang: 'en' }),
          },
        ], 'tool-calls'),
        generated([{ type: 'text', text: 'An unsupported answer.' }], 'stop'),
      ],
    });
    const runner = new AgenticRagRunner({
      model,
      modelId: 'deepseek-flash',
      config: { ...agentConfig, maxSteps: 2 },
      askDeps: {
        db,
        embedder: new MockEmbedder(),
        llm: new MockLLM(),
        intentRouter: null,
      },
    });

    const response = await runner.ask({ question: 'What does the documentation say?' });
    assert.equal(response.result.type, 'error');
    if (response.result.type === 'error') assert.equal(response.result.code, 'agent_no_evidence');
  } finally {
    db.close();
  }
});
