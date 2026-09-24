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
    const responses = [
        generated([
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookupExact',
            input: JSON.stringify({
              identifier: 'sign',
              lang: 'en',
              requiredFacts: [{ description: 'signature ordering', searchTerms: ['sort', 'MD5'] }],
            }),
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
      ];
    const modelCalls: Array<{ toolChoice?: { type: string }; tools?: unknown[] }> = [];
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        modelCalls.push(options);
        return responses.shift()!;
      },
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
    assert.deepEqual(modelCalls[2]?.toolChoice, { type: 'auto' });
    assert.deepEqual(modelCalls[2]?.tools?.map((entry) => (entry as { name?: string }).name).sort(), [
      'readDoc',
      'searchDocs',
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
            input: JSON.stringify({
              lang: 'en',
              requiredFacts: [{ description: 'documentation answer', searchTerms: ['documentation'] }],
            }),
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

test('AgenticRagRunner repairs an answer with missing evidence citations once', async () => {
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
    ).run('Sort parameter names, prepend the API Key, and calculate lowercase MD5.').lastInsertRowid);
    db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, object_path, created_at)
       VALUES ('waas-auth', 'en', 'signature/p[1]', ?, 'auth-child', 16, ?, 'content', 'sign', 1)`,
    ).run('Sort fields before MD5 signature computation.', parentId);

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
        generated([{ type: 'tool-call', toolCallId: 'call-1', toolName: 'searchDocs', input: JSON.stringify({
          query: 'signature MD5',
          requiredFacts: [{ description: 'signature calculation', searchTerms: ['sort', 'MD5'] }],
        }) }], 'tool-calls'),
        generated([{ type: 'tool-call', toolCallId: 'call-2', toolName: 'readDoc', input: JSON.stringify({ pageId: 'waas-auth', lang: 'en', mode: 'page' }) }], 'tool-calls'),
        generated([{ type: 'text', text: 'Sort the parameters before hashing.' }], 'stop'),
        generated([{ type: 'text', text: `Sort the parameters before hashing [${expectedEvidence.evidenceId}].` }], 'stop'),
      ],
    });
    const runner = new AgenticRagRunner({
      model,
      modelId: 'deepseek-flash',
      config: agentConfig,
      askDeps,
    });

    const response = await runner.ask({ question: 'How is the signature input ordered?' });
    assert.equal(response.result.type, 'answer');
    if (response.result.type !== 'answer') return;
    assert.match(response.result.answer_md, /\[cit_1\]/);
    assert.equal(response.trace.agent?.citation_retry_count, 1);
  } finally {
    db.close();
  }
});

test('AgenticRagRunner continues discovery when required facts are absent from the first read', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    db.prepare(
      `INSERT INTO pages
        (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
       VALUES
        ('payout', 'en', 'published', 'Create payout', '/en/payout', 'waas', 1, '[]', 1),
        ('auth', 'en', 'published', 'Authentication', '/en/auth', 'waas', 2, '[]', 1)`,
    ).run();
    const payoutParent = Number(db.prepare(
      `INSERT INTO chunk_parents
        (page_id, lang, parent_path, heading_id, heading_path, text, content_hash, token_count, created_at)
       VALUES ('payout', 'en', 'endpoint', 'endpoint', '["endpoint"]', ?, 'payout-parent', 12, 1)`,
    ).run('Create a payout with POST /api/v1/payout.').lastInsertRowid);
    const payoutChunk = Number(db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, object_path, created_at)
       VALUES ('payout', 'en', 'endpoint/p[1]', ?, 'payout-child', 8, ?, 'api-request', null, 1)`,
    ).run('POST /api/v1/payout creates a payout.', payoutParent).lastInsertRowid);
    db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, '/api/v1/payout', '/api/v1/payout', 'api_path')`,
    ).run(payoutChunk);
    const authParent = Number(db.prepare(
      `INSERT INTO chunk_parents
        (page_id, lang, parent_path, heading_id, heading_path, text, content_hash, token_count, created_at)
       VALUES ('auth', 'en', 'signature', 'signature', '["signature"]', ?, 'auth-parent', 24, 1)`,
    ).run('Sort parameter names in lexicographical order, prepend the API Key, then calculate lowercase MD5.').lastInsertRowid);
    db.prepare(
      `INSERT INTO chunks
        (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, object_path, created_at)
       VALUES ('auth', 'en', 'signature/p[1]', ?, 'auth-child', 16, ?, 'content', 'sign', 1)`,
    ).run('Use lexicographical order and lowercase MD5 for signatures.', authParent);

    const askDeps = { db, embedder: new MockEmbedder(), llm: new MockLLM(), intentRouter: null };
    const expectedEvidence = new EvidenceService({ db, searchDeps: askDeps }).readDoc({ pageId: 'auth', lang: 'en' });
    const model = new MockLanguageModelV3({
      doGenerate: [
        generated([{ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookupExact', input: JSON.stringify({
          identifier: '/api/v1/payout',
          lang: 'en',
          requiredFacts: [{
            description: 'parameters are sorted lexicographically',
            searchTerms: ['lexicographical order'],
          }, {
            description: 'the digest uses lowercase MD5',
            searchTerms: ['lowercase MD5'],
          }],
        }) }], 'tool-calls'),
        generated([{ type: 'tool-call', toolCallId: 'call-2', toolName: 'readDoc', input: JSON.stringify({ pageId: 'payout', lang: 'en', mode: 'page' }) }], 'tool-calls'),
        generated([{ type: 'tool-call', toolCallId: 'call-3', toolName: 'searchDocs', input: JSON.stringify({
          query: 'lexicographical order lowercase MD5 signature',
          requiredFacts: [{
            description: 'parameters are sorted lexicographically',
            searchTerms: ['lexicographical order'],
          }, {
            description: 'the digest uses lowercase MD5',
            searchTerms: ['lowercase MD5'],
          }],
        }) }], 'tool-calls'),
        generated([{ type: 'tool-call', toolCallId: 'call-4', toolName: 'readDoc', input: JSON.stringify({ pageId: 'auth', lang: 'en', mode: 'page' }) }], 'tool-calls'),
        generated([{ type: 'text', text: `Sort names in lexicographical order and calculate lowercase MD5 [${expectedEvidence.evidenceId}].` }], 'stop'),
      ],
    });
    const runner = new AgenticRagRunner({
      model,
      modelId: 'deepseek-flash',
      config: { ...agentConfig, maxDiscoveryCalls: 1 },
      askDeps,
    });

    const response = await runner.ask({ question: 'Show the exact ordered string before MD5 for /api/v1/payout.' });
    assert.equal(response.result.type, 'answer');
    assert.deepEqual(response.trace.agent?.tool_calls.map((call) => call.tool), [
      'lookupExact', 'readDoc', 'searchDocs', 'readDoc',
    ]);
    assert.equal(response.trace.agent?.budget.supplemental.used, 1);
    assert.equal(response.trace.agent?.required_facts?.[0]?.covered, true);
    assert.deepEqual(response.trace.agent?.required_facts?.[0]?.missing_terms, []);
  } finally {
    db.close();
  }
});
