import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  askDepsForEval,
  askDepsForRetrievalEval,
  buildEvalCaseTraceRecord,
  buildRetrievalEvalCaseTraceRecord,
  evalAskModeForDeps,
  renderRetrievalReport,
  renderReport,
  runEvalCaseWithRetries,
  shouldRetryEvalResult,
  writeCaseTraceJsonl,
} from '../src/commands/eval.ts';

test('askDepsForRetrievalEval disables the LLM router without touching runtime.llm', async () => {
  const db = {};
  const embedder = {};
  let llmAccessed = false;
  const runtime = {
    db,
    embedder,
    get llm() {
      llmAccessed = true;
      throw new Error('runtime.llm should not be read in --no-router retrieval eval');
    },
    reranker: null,
    config: {
      reranker: { enabled: false },
      prompt: { assistantName: 'Cregis AI Assistant' },
    },
  };

  const deps = askDepsForRetrievalEval(runtime, { noRouter: true });
  const route = await deps.intentRouter!.route({
    question: 'Cregis API 签名参数怎么拼接？',
    lang: 'zh',
    history: [{ question: '支付引擎创建订单怎么做？', answer_summary: '...' }],
  });

  assert.equal(llmAccessed, false);
  assert.equal(deps.db, db);
  assert.equal(deps.embedder, embedder);
  assert.equal(route.effectiveQuestion, 'Cregis API 签名参数怎么拼接？');
  assert.equal(route.usesHistory, false);
  assert.equal(route.rewritten, false);
  assert.equal(route.apiIntent, false);
  assert.equal(route.reason, 'retrieval_eval_no_router');
});

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
      citation_anchor_pass: true,
      citation_pass: true,
      unexpected_citation_pages: [],
      unexpected_citation_rate: 0,
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

test('renderReport separates core quality, retrieval diagnostics, citation calibration, and answer text diagnostics', () => {
  const summary = {
    n: 1,
    r_at_5: 1,
    hit_at_1: 1,
    hit_at_3: 1,
    mrr: 1,
    context_precision_at_5: 0.6,
    context_recall_n: 1,
    context_recall_at_5: 1,
    citation_anchor_pass: 1,
    unexpected_citation_rate: 0.5,
    citation_pass: 0,
    answer_rule_pass: 0,
    kind_pass: 1,
    api_rule_n: 1,
    api_rule_pass: 1,
  };
  const results = [
    {
      case_id: 'case-1',
      query: 'How do I create an order?',
      kind: 'answer',
      expected_kind: 'answer',
      kind_pass: true,
      r_at_5: true,
      hit_at_1: true,
      hit_at_3: true,
      mrr: 1,
      context_precision_at_5: 0.6,
      context_recall_at_5: 1,
      citation_anchor_pass: true,
      citation_pass: false,
      unexpected_citation_pages: ['extra-page'],
      unexpected_citation_rate: 0.5,
      answer_rule_pass: false,
      api_rule_pass: true,
      retrieved_pages_top5: ['payment-engine-quickstart-30min'],
      cited_pages: ['payment-engine-quickstart-30min', 'extra-page'],
      missing_must_contain: ['checkout_url'],
      missing_must_contain_regex: [],
      hit_forbid_contain: [],
      hit_forbid_contain_regex: [],
      missing_must_cite_operations: [],
      missing_must_cite_urls: [],
      error_code: null,
      error_message: null,
      error_detail: null,
      latency_ms: 123,
    },
  ];

  const report = renderReport('2026-06-04', {
    summary,
    results,
    caseTraces: [],
    totalMs: 1234,
    baseline: null,
  });

  assert.match(report, /## Core quality/);
  assert.match(report, /Citation-anchor/);
  assert.match(report, /## Retrieval diagnostics/);
  assert.match(report, /Hit@5/);
  assert.match(report, /Context-P@5/);
  assert.match(report, /## Citation calibration/);
  assert.match(report, /legacy Citation-pass/);
  assert.match(report, /Unexpected-citation-rate/);
  assert.match(report, /case-1: unexpected=\[extra-page\]/);
  assert.match(report, /## Answer text diagnostics/);
  assert.match(report, /answer_keyword_overlap/);
  assert.doesNotMatch(report, /## Headline metrics/);
  assert.doesNotMatch(report, /\| Citation-pass\s+\|/);
});

test('renderRetrievalReport only reports retrieval quality and diagnostics', () => {
  const summary = {
    n: 2,
    r_at_5: 0.5,
    hit_at_1: 0.25,
    hit_at_3: 0.5,
    mrr: 0.38,
    context_precision_at_5: 0.3,
    context_recall_n: 2,
    context_recall_at_5: 0.5,
  };
  const results = [
    {
      case_id: 'case-hit',
      query: 'How do I create an order?',
      r_at_5: true,
      hit_at_1: false,
      hit_at_3: true,
      mrr: 0.5,
      context_precision_at_5: 0.4,
      context_recall_at_5: 1,
      retrieved_pages_top5: ['noise', 'payment-engine-api'],
      latency_ms: 12,
    },
    {
      case_id: 'case-miss',
      query: 'How do I sign requests?',
      r_at_5: false,
      hit_at_1: false,
      hit_at_3: false,
      mrr: 0,
      context_precision_at_5: 0,
      context_recall_at_5: 0,
      retrieved_pages_top5: ['noise-a', 'noise-b'],
      latency_ms: 9,
    },
  ];

  const report = renderRetrievalReport('2026-06-04', {
    summary,
    results,
    caseTraces: [],
    totalMs: 321,
  });

  assert.match(report, /# Retrieval Eval — 2026-06-04/);
  assert.match(report, /Case traces: `2026-06-04-retrieval-eval\.cases\.jsonl`/);
  assert.match(report, /## Core retrieval quality/);
  assert.match(report, /MRR/);
  assert.match(report, /Hit@1/);
  assert.match(report, /Context-R@5/);
  assert.match(report, /## Retrieval diagnostics/);
  assert.match(report, /Hit@3/);
  assert.match(report, /Hit@5/);
  assert.match(report, /Context-P@5/);
  assert.match(report, /## Retrieval misses \(1\)/);
  assert.match(report, /case-miss/);
  assert.match(report, /<!-- RETRIEVAL_EVAL_SUMMARY /);
  assert.doesNotMatch(report, /Citation/);
  assert.doesNotMatch(report, /answer_keyword_overlap/);
});

test('renderRetrievalReport labels no-router raw retrieval mode', () => {
  const summary = {
    n: 1,
    r_at_5: 1,
    hit_at_1: 1,
    hit_at_3: 1,
    mrr: 1,
    context_precision_at_5: 1,
    context_recall_n: 1,
    context_recall_at_5: 1,
  };

  const report = renderRetrievalReport('2026-06-04', {
    summary,
    results: [],
    caseTraces: [],
    totalMs: 12,
    noRouter: true,
  });

  assert.match(report, /Router: disabled \(--no-router raw retrieval\)/);
  assert.match(report, /Case traces: `2026-06-04-retrieval-eval\.raw\.cases\.jsonl`/);
  assert.match(report, /measures raw retrieval over the user question/);
});

test('buildRetrievalEvalCaseTraceRecord stores retrieval trace without LLM result', () => {
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
    r_at_5: true,
    hit_at_1: true,
    hit_at_3: true,
    mrr: 1,
    context_precision_at_5: 0.2,
    context_recall_at_5: 1,
    retrieved_pages_top5: ['payment-engine-quickstart-30min'],
    latency_ms: 11,
  };
  const traced = {
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
    },
    queryVector: new Float32Array([1, 2, 3]),
  };

  const record = buildRetrievalEvalCaseTraceRecord({
    c,
    index: 0,
    total: 1,
    caseResult,
    traced,
  });

  assert.equal(record.schema_version, 1);
  assert.equal(record.case_id, 'case-1');
  assert.equal(record.result, undefined);
  assert.equal(record.queryVector, undefined);
  assert.equal(record.score.mrr, 1);
  assert.equal(record.trace.fused[0].chunk_id, 7);
});
