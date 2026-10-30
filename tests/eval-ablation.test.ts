import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3 } from 'ai/test';
import { openDatabase } from '../src/db/index.ts';
import { EvidenceService } from '../src/agent/evidence.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { BudgetedEvidenceService, candidateFingerprint, estimateEvidenceTokens, runAblationVariant } from '../src/eval/ablation.ts';
import type { AskDeps } from '../src/query/answer.ts';

function fixture() {
  const db = openDatabase({ dbPath: ':memory:' });
  db.prepare(`INSERT INTO pages (page_id,lang,status,title,url,subtree_root,nav_index,breadcrumb,updated_at)
    VALUES ('auth','en','published','Authentication','/en/auth','waas',1,'[]',1)`).run();
  const body = 'Signature rules: exclude sign and empty values. Sort fields lexicographically. Prepend API Key and calculate lowercase MD5.';
  const parent = Number(db.prepare(`INSERT INTO chunk_parents
    (page_id,lang,parent_path,heading_id,heading_path,text,content_hash,token_count,created_at)
    VALUES ('auth','en','$page','signature','["Signature"]',?,'parent-hash',?,1)`)
    .run(body, estimateEvidenceTokens(body)).lastInsertRowid);
  for (const [index, text] of ['Signature rules: exclude sign.', 'Sort fields lexicographically.'].entries()) {
    const child = Number(db.prepare(`INSERT INTO chunks
      (page_id,lang,in_page_path,text,content_hash,token_count,parent_id,chunk_kind,created_at)
      VALUES ('auth','en',?,?,?, ?,?,'content',1)`)
      .run(`signature/p[${index + 1}]`, text, `child-${index}`, estimateEvidenceTokens(text), parent).lastInsertRowid);
    db.prepare(`INSERT INTO chunk_identifiers (chunk_id,identifier,normalized,kind) VALUES (?,'sign','sign','field')`).run(child);
  }
  const deps: AskDeps = { db, embedder: new MockEmbedder(), llm: new MockLLM() };
  const serviceDeps = { db, searchDeps: deps };
  return { db, deps, serviceDeps, body, evidence: new EvidenceService(serviceDeps) };
}

function textModel(answer = 'Exclude sign [cit_1].') {
  return new MockLanguageModelV3({ doGenerate: async () => ({
    content: [{ type: 'text', text: answer }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [],
  }) });
}

const agentConfig = { enabled: true, maxSteps: 5, maxDiscoveryCalls: 2, maxReadCalls: 3,
  maxSupplementalSearchCalls: 1, readTokenLimit: 3300 };

test('ablation A/B share live candidates, change Parent selection, and pin generation parameters', async () => {
  const f = fixture();
  try {
    const run = (variant: 'child_only' | 'parent_child') => runAblationVariant({ variant,
      request: { question: 'How is sign calculated?' }, askDeps: f.deps,
      model: textModel(), modelId: 'test', agentConfig });
    const a = await run('child_only');
    const b = await run('parent_child');
    assert.equal(a.traced.result.type, 'answer');
    assert.equal(b.traced.result.type, 'answer');
    assert.equal(a.candidate_fingerprint, b.candidate_fingerprint);
    assert.ok(a.traced.trace.selected_context?.every((chunk) => !chunk.expanded_parent));
    assert.ok(b.traced.trace.selected_context?.some((chunk) => chunk.expanded_parent));
    assert.ok(b.traced.trace.input_snapshot?.documents.some((doc) => doc.text === f.body));
    for (const output of [a, b]) {
      assert.equal(output.model_calls.length, 1);
      assert.equal(output.model_calls[0]?.temperature, 0);
      assert.equal(output.model_calls[0]?.max_output_tokens, 1800);
      assert.ok(output.evidence_tokens <= 8000);
      assert.equal(output.traced.trace.input_snapshot?.attempts[0]?.outcome, 'returned');
    }
    const changedIds = a.child_candidates.map((chunk) => ({ ...chunk, chunk_id: chunk.chunk_id + 1000 }));
    assert.equal(candidateFingerprint(a.child_candidates), candidateFingerprint(changedIds));
    assert.notEqual(candidateFingerprint(a.child_candidates), candidateFingerprint(changedIds.map((chunk) => ({
      ...chunk, text: chunk.text + ' changed evidence',
    }))));
  } finally { f.db.close(); }
});

test('ablation page-static does one discovery, reads authority, and never invokes a planning model', async () => {
  const f = fixture();
  try {
    const result = await runAblationVariant({ variant: 'page_static',
      request: { question: 'How is sign calculated?' }, askDeps: f.deps,
      model: textModel(), modelId: 'test', agentConfig });
    assert.equal(result.traced.result.type, 'answer');
    assert.equal(result.discovery_audit.length, 1);
    assert.equal(result.discovery_audit[0]?.tool, 'searchDocs');
    assert.equal(result.read_audit.length, 1);
    assert.equal(result.read_audit[0]?.ok, true);
    assert.equal(result.model_calls.length, 1);
    assert.equal(result.traced.trace.input_snapshot?.documents[0]?.text, f.body);
  } finally { f.db.close(); }
});

test('evidence wrapper rejects oversized first units before exposing them and counts failed reads', () => {
  const f = fixture();
  try {
    const wrapper = new BudgetedEvidenceService(f.evidence, f.serviceDeps,
      { totalTokens: 4, readTokens: 4, readCalls: 1 });
    assert.throws(() => wrapper.readDoc({ pageId: 'auth', lang: 'en' }), /exceeds/);
    assert.equal(wrapper.records.size, 0);
    assert.equal(wrapper.evidenceTokens, 0);
    assert.equal(wrapper.reads[0]?.error_code, 'evidence_budget_exceeded');
    assert.throws(() => wrapper.readDoc({ pageId: 'auth', lang: 'en' }), /read-call/);
  } finally { f.db.close(); }
});

test('evidence wrapper reuses identical reads without spending evidence budget twice', () => {
  const f = fixture();
  try {
    const cap = estimateEvidenceTokens(f.body);
    const wrapper = new BudgetedEvidenceService(f.evidence, f.serviceDeps,
      { totalTokens: cap, readTokens: cap, readCalls: 3 });
    const first = wrapper.readDoc({ pageId: 'auth', lang: 'en' });
    const repeated = wrapper.readDoc({ pageId: 'auth', lang: 'en' });
    assert.equal(first.evidenceId, repeated.evidenceId);
    assert.equal(wrapper.evidenceTokens, cap);
    assert.equal(wrapper.reads[1]?.repeated, true);
    assert.equal(wrapper.records.size, 1);
    assert.throws(() => wrapper.readDoc({ pageId: 'auth', lang: 'en', mode: 'field', selector: 'sign' }), /budget exhausted/);
  } finally { f.db.close(); }
});

test('generation errors retain full authoritative context for independent recall scoring', async () => {
  const f = fixture();
  try {
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error('Fixture provider failure'); } });
    const result = await runAblationVariant({ variant: 'parent_child',
      request: { question: 'How is sign calculated?' }, askDeps: f.deps,
      model, modelId: 'test', agentConfig });
    assert.equal(result.traced.result.type, 'error');
    assert.equal(result.traced.trace.input_snapshot?.documents[0]?.text, f.body);
    assert.equal(result.traced.trace.input_snapshot?.attempts[0]?.outcome, 'error');
    assert.ok(result.model_calls.length > 0);
    assert.ok(result.model_calls.every((call) => !call.ok));
  } finally { f.db.close(); }
});

test('controlled Agent uses the injected evidence service and audits every model step', async () => {
  const f = fixture();
  try {
    const evidenceId = f.evidence.readDoc({ pageId: 'auth', lang: 'en', mode: 'page' }).evidenceId;
    const response = (content: unknown[], finish: string) => ({ content,
      finishReason: { unified: finish, raw: finish },
      usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [],
    }) as never;
    const responses = [
      response([{ type: 'tool-call', toolCallId: 'a1', toolName: 'lookupExact', input: JSON.stringify({
        identifier: 'sign', requiredFacts: [{ description: 'signature rules', searchTerms: ['sign'] }],
      }) }], 'tool-calls'),
      response([{ type: 'tool-call', toolCallId: 'a2', toolName: 'readDoc', input: JSON.stringify({
        pageId: 'auth', lang: 'en', mode: 'page',
      }) }], 'tool-calls'),
      response([{ type: 'text', text: `Exclude sign [${evidenceId}].` }], 'stop'),
    ];
    const model = new MockLanguageModelV3({ doGenerate: async () => responses.shift()! });
    const result = await runAblationVariant({ variant: 'agentic',
      request: { question: 'How is sign calculated?' }, askDeps: f.deps, model, modelId: 'test', agentConfig });
    assert.equal(result.traced.result.type, 'answer');
    assert.equal(result.model_calls.length, 3);
    assert.equal(result.read_audit.length, 1);
    assert.equal(result.read_audit[0]?.ok, true);
    assert.equal(result.discovery_audit[0]?.tool, 'lookupExact');
    assert.equal(result.evidence_tokens, estimateEvidenceTokens(f.body));
    assert.ok(result.raw_response?.includes(evidenceId));
  } finally { f.db.close(); }
});

test('static reader does not serialize evaluation-only fields from the request into model inputs', async () => {
  const f = fixture();
  try {
    let prompt = '';
    const model = textModel();
    const original = model.doGenerate.bind(model);
    model.doGenerate = async (options) => { prompt = JSON.stringify(options.prompt); return original(options); };
    const request = { question: 'How is sign calculated?',
      expected: { reference_answer: 'EVAL_LABEL_CANARY_7e51', reference_facts: ['PRIVATE_ORACLE_DO_NOT_INJECT'] } };
    const result = await runAblationVariant({ variant: 'parent_child', request,
      askDeps: f.deps, model, modelId: 'test', agentConfig });
    assert.equal(result.traced.result.type, 'answer');
    assert.ok(prompt.includes('Signature rules'));
    assert.ok(!prompt.includes('EVAL_LABEL_CANARY'));
    assert.ok(!prompt.includes('PRIVATE_ORACLE'));
  } finally { f.db.close(); }
});

test('page-static measures page length from its Parent rather than repeated child prefixes', async () => {
  const f = fixture();
  try {
    f.db.prepare('UPDATE chunks SET token_count=2000').run();
    const result = await runAblationVariant({ variant: 'page_static',
      request: { question: 'How is sign calculated?' }, askDeps: f.deps,
      model: textModel(), modelId: 'test', agentConfig });
    assert.equal(result.traced.result.type, 'answer');
    assert.equal(result.read_audit[0]?.mode, 'page');
    assert.equal(result.traced.trace.input_snapshot?.documents[0]?.text, f.body);
  } finally { f.db.close(); }
});

test('absolute deadline labels both static and native Agent cancellation as evaluation timeout', async () => {
  const f = fixture();
  try {
    for (const variant of ['parent_child', 'agentic'] as const) {
      const model = new MockLanguageModelV3({ doGenerate: (options) => new Promise((_resolve, reject) => {
        const cancel = () => reject(new Error('Fixture cancellation'));
        if (options.abortSignal?.aborted) cancel();
        else options.abortSignal?.addEventListener('abort', cancel, { once: true });
      }) });
      const result = await runAblationVariant({ variant, request: { question: 'How is sign calculated?' },
        askDeps: f.deps, model, modelId: 'test', agentConfig, deadlineMs: 50 });
      assert.equal(result.traced.result.type, 'error');
      if (result.traced.result.type === 'error') assert.equal(result.traced.result.code, 'evaluation_timeout');
      assert.ok(result.model_calls.length >= 1);
    }
  } finally { f.db.close(); }
});
