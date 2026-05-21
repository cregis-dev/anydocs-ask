import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askDepsForEval,
  evalAskModeForDeps,
  runEvalCaseWithRetries,
  shouldRetryEvalResult,
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
