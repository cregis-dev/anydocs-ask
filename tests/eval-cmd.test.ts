import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  askDepsForEval,
  buildEvalCaseTraceRecord,
  evalAskModeForDeps,
  runEvalCaseWithRetries,
  shouldRetryEvalResult,
  writeCaseTraceJsonl,
} from '../src/commands/eval.ts';

test('askDepsForEval includes project prompt config so eval matches runtime asks', () => {
  const db = {};
  const embedder = {};
  const llm = {};
  const prompt = {
    assistantName: 'Cregis AI Assistant',
    systemInstructions: ['Answer in the same language as the user.'],
  };

  const deps = askDepsForEval({ db, embedder, llm, config: { prompt } });

  assert.equal(deps.db, db);
  assert.equal(deps.embedder, embedder);
  assert.equal(deps.llm, llm);
  assert.equal(deps.promptConfig, prompt);
});

test('evalAskModeForDeps prefers streaming when the configured LLM supports it', () => {
  assert.equal(evalAskModeForDeps({ llm: { generate: async () => ({ text: '', modelUsed: 'm' }) } }), 'json');
  assert.equal(
    evalAskModeForDeps({
      llm: {
        generate: async () => ({ text: '', modelUsed: 'm' }),
        streamGenerate: async () => ({ text: '', modelUsed: 'm' }),
      },
    }),
    'stream',
  );
});


test('shouldRetryEvalResult retries only transient generation failures', () => {
  assert.equal(shouldRetryEvalResult({ type: 'error', code: 'llm_failed', message: 'temporary' }), true);
  assert.equal(shouldRetryEvalResult({ type: 'error', code: 'no_citations', message: 'temporary' }), true);
  assert.equal(shouldRetryEvalResult({ type: 'error', code: 'invalid_question', message: 'bad input' }), false);
  assert.equal(shouldRetryEvalResult({ type: 'answer', answer_id: 'a', answer_lang: 'en', answer_md: 'ok [cit_1]', citations: [], used_chunks: 1, model: 'm', latency_ms: 1 }), false);
});

test('runEvalCaseWithRetries retries transient LLM errors before scoring a case', async () => {
  const calls: string[] = [];
  const c = {
    id: 'case-1',
    query: 'How do I create an order?',
    lang: 'en',
    filters: {},
    expected: { must_cite_pages: [], must_contain: [], forbid_contain: [] },
  };
  const answer = {
    result: {
      type: 'answer',
      answer_id: 'ans_1',
      answer_lang: 'en',
      answer_md: 'Use the checkout API [cit_1].',
      citations: [],
      used_chunks: 1,
      model: 'mock',
      latency_ms: 1,
    },
    trace: { fused: [], subtree_ask_triggered: false, top_final_score: 0, confidence: 0, tokens_in: null, tokens_out: null },
    queryVector: null,
  };

  const traced = await runEvalCaseWithRetries(
    c,
    {},
    async () => {
      calls.push('ask');
      if (calls.length === 1) {
        return {
          ...answer,
          result: { type: 'error', code: 'llm_failed', message: 'temporary' },
        };
      }
      return answer;
    },
    { maxAttempts: 2, retryDelayMs: 0 },
  );

  assert.equal(calls.length, 2);
  assert.equal(traced.result.type, 'answer');
});

test('writeCaseTraceJsonl persists per-case result, score, and retrieval trace without query vectors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anydocs-eval-trace-'));
  try {
    const c = {
      id: 'case-1',
      query: 'How do I create an order?',
      lang: 'en',
      filters: {},
      expected: {
        must_cite_pages: ['payment-engine-quickstart-30min'],
        must_contain: ['checkout_url'],
        forbid_contain: [],
      },
    };
    const caseResult = {
      case_id: 'case-1',
      query: c.query,
      kind: 'answer',
      expected_kind: 'answer',
      kind_pass: true,
      r_at_5: true,
      hit_at_1: true,
      hit_at_3: true,
      mrr: 1,
      context_precision_at_5: 0.2,
      context_recall_at_5: 1,
      citation_pass: true,
      answer_rule_pass: true,
      api_rule_pass: null,
      retrieved_pages_top5: ['payment-engine-quickstart-30min'],
      cited_pages: ['payment-engine-quickstart-30min'],
      missing_must_contain: [],
      missing_must_contain_regex: [],
      hit_forbid_contain: [],
      hit_forbid_contain_regex: [],
      missing_must_cite_operations: [],
      missing_must_cite_urls: [],
      error_code: null,
      error_message: null,
      error_detail: null,
      latency_ms: 123,
    };
    const traced = {
      result: {
        type: 'answer',
        answer_id: 'ans_1',
        answer_lang: 'en',
        answer_md: 'Use checkout_url [cit_1].',
        citations: [
          {
            citation_id: 'cit_1',
            chunk_id: 7,
            page_id: 'payment-engine-quickstart-30min',
            lang: 'en',
            source_lang: null,
            title: 'Payment Engine Quickstart',
            breadcrumb: [],
            url: '/en/payment-engine-quickstart-30min',
            snippet: 'checkout_url',
            in_page_path: 'p[1]',
          },
        ],
        used_chunks: 1,
        model: 'mock',
        latency_ms: 12,
      },
      trace: {
        fused: [
          {
            chunk_id: 7,
            page_id: 'payment-engine-quickstart-30min',
            rrf_score: 0.5,
            final_score: 0.5,
            vec_rank: 1,
            bm25_rank: null,
            nav_index: 2,
            nav_index_boost: 0.1,
          },
        ],
        subtree_ask_triggered: false,
        top_final_score: 0.5,
        confidence: 1,
        tokens_in: null,
        tokens_out: null,
        intent_route: {
          originalQuestion: c.query,
          effectiveQuestion: c.query,
          usesHistory: false,
          rewritten: false,
          intent: 'payment_flow',
          product: 'payment_engine',
          apiIntent: false,
          signatureAuthIntent: false,
          projectSetupIntent: false,
          apiReferenceHints: [],
          supplementalContextHints: ['checkout_url payment flow'],
          supplementalPageIds: ['payment-engine-quickstart-30min'],
          apiReferenceVersionPrefs: [],
          reason: 'test trace',
        },
      },
      queryVector: new Float32Array([1, 2, 3]),
    };

    const record = buildEvalCaseTraceRecord({
      c,
      index: 0,
      total: 1,
      caseResult,
      traced,
    });
    const out = join(dir, 'cases.jsonl');
    writeCaseTraceJsonl(out, [record]);

    const raw = await readFile(out, 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.case_id, 'case-1');
    assert.equal(parsed.result.answer_id, 'ans_1');
    assert.equal(parsed.score.mrr, 1);
    assert.equal(parsed.trace.fused[0].chunk_id, 7);
    assert.equal(parsed.trace.intent_route.intent, 'payment_flow');
    assert.deepEqual(parsed.trace.intent_route.supplementalPageIds, ['payment-engine-quickstart-30min']);
    assert.equal(parsed.queryVector, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
