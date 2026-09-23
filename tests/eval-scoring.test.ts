import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCase,
  scoreRetrievalCase,
  summarizeRetrievalResults,
  summarizeResults,
} from '../src/eval/scoring.ts';
import type { GoldenCase } from '../src/golden/types.ts';
import type { AskTrace } from '../src/query/answer.ts';
import type { AskResult } from '../src/query/types.ts';

function golden(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: 'case-1',
    query: 'What is the checkout rate limit?',
    filters: {},
    context_pageId: null,
    expected: {
      must_cite_pages: ['payment-engine-api'],
      must_contain: [],
      forbid_contain: [],
    },
    tags: [],
    created_by: 'manual',
    reviewed_at: '2026-05-21',
    reviewer: 'codex',
    lang: 'en',
    ...overrides,
  };
}

function trace(pageIds: string[]): AskTrace {
  return {
    fused: pageIds.map((page_id, i) => ({
      chunk_id: i + 1,
      page_id,
      rrf_score: 1 / (i + 1),
      final_score: 1 / (i + 1),
      vec_rank: i + 1,
      bm25_rank: null,
      exact_rank: null,
      nav_index: null,
    })),
    subtree_ask_triggered: false,
    top_final_score: 1,
    confidence: 1,
    tokens_in: null,
    tokens_out: null,
  };
}

function traceWithContent(chunks: Array<{
  page_id: string;
  object_path?: string;
  text_preview?: string;
  identifiers?: string[];
}>): AskTrace {
  return {
    ...trace([]),
    fused: chunks.map((chunk, i) => ({
      chunk_id: i + 1,
      page_id: chunk.page_id,
      object_path: chunk.object_path ?? null,
      text_preview: chunk.text_preview,
      identifiers: chunk.identifiers,
      rrf_score: 1 / (i + 1),
      final_score: 1 / (i + 1),
      vec_rank: i + 1,
      bm25_rank: null,
      exact_rank: null,
      nav_index: null,
    })),
  };
}

function answer(overrides: Partial<Extract<AskResult, { type: 'answer' }>> = {}): AskResult {
  return {
    type: 'answer',
    answer_id: 'ans_1',
    answer_lang: 'en',
    answer_md: 'Use `POST /api/v2/checkout`. The limit is 30 per minute.',
    translation_notice: null,
    citations: [
      {
        citation_id: 'cit_1',
        chunk_id: 101,
        page_id: 'payment-engine-api',
        lang: 'en',
        source_lang: null,
        title: 'POST /api/v2/checkout',
        breadcrumb: [],
        url: '/en/reference/payment-engine-api#api-post-api-v2-checkout',
        snippet: 'POST /api/v2/checkout accepts order_currency and has a 30 per minute limit.',
        in_page_path: 'post-api-v2-checkout/p[1]',
      },
    ],
    used_chunks: 1,
    model: 'mock',
    latency_ms: 10,
    ...overrides,
  };
}

test('scoreCase supports regex answer rules and expected outcome kind', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api'],
      must_contain: [],
      must_contain_regex: ['30\\s*per\\s*minute'],
      forbid_contain: [],
      forbid_contain_regex: ['unlimited'],
      expected_kind: 'answer',
    },
  });

  const scored = scoreCase(c, answer(), trace(['payment-engine-api']));

  assert.equal(scored.kind, 'answer');
  assert.equal(scored.kind_pass, true);
  assert.equal(scored.answer_rule_pass, true);
  assert.deepEqual(scored.missing_must_contain_regex, []);
  assert.deepEqual(scored.hit_forbid_contain_regex, []);
});

test('scoreCase computes MRR / Hit@K / context_precision over the fused trace', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api'],
      allow_cite_pages: ['webhook-mechanism'],
      must_contain: [],
      forbid_contain: [],
    },
  });

  // Trace: noise, noise, target, allowed-extra, noise → target at rank 3
  const fused = trace(['noise-1', 'noise-2', 'payment-engine-api', 'webhook-mechanism', 'noise-3']);
  const scored = scoreCase(c, answer(), fused);

  assert.equal(scored.hit_at_1, false, 'top-1 was noise');
  assert.equal(scored.hit_at_3, true, 'target reached top-3');
  assert.equal(scored.hit_at_5, true);
  assert.ok(Math.abs(scored.mrr - 1 / 3) < 1e-9, `MRR should be 1/3, got ${scored.mrr}`);
  // top-5 chunks: 2 are in must_cite ∪ allow_cite (target + allowed-extra)
  assert.ok(
    Math.abs(scored.context_precision_at_5 - 2 / 5) < 1e-9,
    `CP@5 should be 0.4, got ${scored.context_precision_at_5}`,
  );
});

test('scoreCase uses final Agent evidence instead of accumulated navigation candidates', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api'],
      must_contain: [],
      forbid_contain: [],
      must_retrieve_regex: ['valid_time'],
    },
  });
  const agentTrace: AskTrace = {
    ...trace(['noise-1', 'noise-2', 'noise-3', 'noise-4', 'noise-5']),
    selected_context: [{
      chunk_id: 10,
      page_id: 'payment-engine-api',
      lang: 'en',
      page_title: 'Payment Engine API',
      page_url: '/en/payment-engine-api',
      in_page_path: 'request/valid_time',
      text_preview: 'valid_time is the payment window in minutes',
      rrf_score: 0,
      final_score: 0,
      vec_rank: null,
      bm25_rank: null,
      exact_rank: null,
      nav_index: null,
      context_rank: 1,
      context_token_count: 8,
      expanded_parent: null,
    }],
    agent: {
      steps: 3,
      tool_calls: [],
      evidence: [],
      budget: {
        discovery: { used: 1, limit: 2 },
        read: { used: 1, limit: 3 },
        supplemental: { used: 0, limit: 1 },
      },
    },
  };

  const scored = scoreCase(c, answer(), agentTrace);

  assert.equal(scored.hit_at_1, true);
  assert.equal(scored.hit_at_5, true);
  assert.equal(scored.mrr, 1);
  assert.equal(scored.context_precision_at_5, 1);
  assert.equal(scored.retrieval_content_pass, true);
  assert.deepEqual(scored.retrieved_pages_top5, ['payment-engine-api']);
});

test('scoreCase MRR / Hit@K are 0/false when no must-cite page appears in the trace', () => {
  const c = golden();
  const scored = scoreCase(c, answer(), trace(['noise-a', 'noise-b', 'noise-c']));

  assert.equal(scored.hit_at_1, false);
  assert.equal(scored.hit_at_3, false);
  assert.equal(scored.hit_at_5, false);
  assert.equal(scored.mrr, 0);
  assert.equal(scored.context_precision_at_5, 0);
});

test('scoreRetrievalCase computes retrieval-only metrics without answer/citation fields', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api', 'payment-engine-quickstart-30min'],
      allow_cite_pages: ['webhook-mechanism'],
      must_contain: ['checkout_url'],
      forbid_contain: [],
    },
  });

  const scored = scoreRetrievalCase(
    c,
    trace(['noise-1', 'payment-engine-api', 'webhook-mechanism', 'noise-2', 'noise-3']),
    42,
  );

  assert.equal(scored.case_id, 'case-1');
  assert.equal(scored.hit_at_1, false);
  assert.equal(scored.hit_at_3, true);
  assert.equal(scored.hit_at_5, true);
  assert.equal(scored.mrr, 1 / 2);
  assert.equal(scored.context_precision_at_5, 2 / 5);
  assert.deepEqual(scored.retrieved_pages_top5, [
    'noise-1',
    'payment-engine-api',
    'webhook-mechanism',
    'noise-2',
    'noise-3',
  ]);
  assert.equal(scored.latency_ms, 42);
});

test('summarizeRetrievalResults averages retrieval-only metrics', () => {
  const results = [
    scoreRetrievalCase(golden({ id: 'hit-1' }), trace(['payment-engine-api']), 10),
    scoreRetrievalCase(golden({ id: 'miss' }), trace(['noise']), 20),
  ];

  const summary = summarizeRetrievalResults(results);

  assert.equal(summary.n, 2);
  assert.equal(summary.hit_at_5, 0.5);
  assert.equal(summary.hit_at_1, 0.5);
  assert.equal(summary.hit_at_3, 0.5);
  assert.equal(summary.mrr, 0.5);
  assert.equal(summary.retrieval_content_n, 0);
  assert.equal(summary.retrieval_content_pass, null);
});

test('retrieval content rules match field-level paths and previews in the top 5', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['waas-api'],
      must_retrieve_regex: ['data\\.rows(?:\\[\\])?\\.fee', '交易费用'],
      must_contain: [],
      forbid_contain: [],
    },
  });
  const scored = scoreRetrievalCase(c, traceWithContent([
    { page_id: 'waas-api', object_path: 'data.rows[].fee', text_preview: 'fee: 交易费用' },
  ]), 10);

  assert.equal(scored.retrieval_content_pass, true);
  assert.deepEqual(scored.missing_must_retrieve_regex, []);
});

test('retrieval content rules use indexed identifiers beyond truncated previews', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['waas-api'],
      must_retrieve_regex: ['data\\.rows(?:\\[\\])?\\.fee|交易费用'],
      must_contain: [],
      forbid_contain: [],
    },
  });
  const scored = scoreRetrievalCase(c, traceWithContent([
    {
      page_id: 'waas-api',
      object_path: 'data.rows[]',
      text_preview: 'data.rows[].cid ...',
      identifiers: ['data.rows[].fee', 'fee'],
    },
  ]), 10);

  assert.equal(scored.retrieval_content_pass, true);
  assert.deepEqual(scored.missing_must_retrieve_regex, []);
});

test('retrieval content rules fail when the right page omits the required field chunk', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['waas-api'],
      must_retrieve_regex: ['data\\.rows(?:\\[\\])?\\.fee'],
      must_contain: [],
      forbid_contain: [],
    },
  });
  const scored = scoreRetrievalCase(c, traceWithContent([
    { page_id: 'waas-api', object_path: 'data', text_preview: 'pageNum pageSize total' },
  ]), 10);
  const summary = summarizeRetrievalResults([scored]);

  assert.equal(scored.hit_at_5, true, 'page-level retrieval still passes');
  assert.equal(scored.retrieval_content_pass, false, 'field-level retrieval fails');
  assert.deepEqual(scored.missing_must_retrieve_regex, ['data\\.rows(?:\\[\\])?\\.fee']);
  assert.equal(summary.retrieval_content_n, 1);
  assert.equal(summary.retrieval_content_pass, 0);
});

test('scoreCase MRR ignores chunk-level duplication of the same page', () => {
  const c = golden();
  // Same page appears as chunks #1 and #2 — should count as the first unique page.
  const scored = scoreCase(
    c,
    answer(),
    trace(['payment-engine-api', 'payment-engine-api', 'noise']),
  );

  assert.equal(scored.hit_at_1, true);
  assert.equal(scored.mrr, 1);
});

test('scoreCase Hit@5 treats must_cite_pages as an OR-set', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['page-A', 'page-B', 'page-C', 'page-D'],
      must_contain: [],
      forbid_contain: [],
    },
  });

  const scored = scoreCase(
    c,
    answer(),
    trace(['page-A', 'noise-1', 'page-B', 'noise-2', 'noise-3']),
  );

  assert.equal(scored.hit_at_5, true, 'any one acceptable page satisfies Hit@5');
});

test('scoreCase scores API operation and citation URL rules only when configured', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api'],
      must_cite_operations: ['POST /api/v2/checkout'],
      must_cite_urls: ['/en/reference/payment-engine-api#api-post-api-v2-checkout'],
      must_contain: ['order_currency'],
      forbid_contain: [],
    },
  });

  const scored = scoreCase(
    c,
    answer({ answer_md: 'Use `POST /api/v2/checkout` with `order_currency`.' }),
    trace(['payment-engine-api']),
  );

  assert.equal(scored.api_rule_pass, true);
  assert.deepEqual(scored.missing_must_cite_operations, []);
  assert.deepEqual(scored.missing_must_cite_urls, []);
});

test('scoreCase treats legacy API operation paths as the same public citation URL', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api'],
      must_cite_urls: ['/en/reference/payment-engine-api/post-api-v2-checkout'],
      must_contain: ['order_currency'],
      forbid_contain: [],
    },
  });

  const scored = scoreCase(
    c,
    answer({ answer_md: 'Use `order_currency`.' }),
    trace(['payment-engine-api']),
  );

  assert.equal(scored.api_rule_pass, true);
  assert.deepEqual(scored.missing_must_cite_urls, []);
});

test('scoreCase allows extra citations listed in allow_cite_pages without changing Hit@5 target', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-quickstart-30min'],
      allow_cite_pages: ['webhook-mechanism'],
      must_contain: ['success'],
      forbid_contain: [],
    },
  });
  const result = answer({
    answer_md: 'Return success after processing.',
    citations: [
      {
        citation_id: 'cit_1',
        chunk_id: 101,
        page_id: 'payment-engine-quickstart-30min',
        lang: 'zh',
        source_lang: null,
        title: '支付引擎 30 分钟接入实战',
        breadcrumb: [],
        url: '/zh/payment-engine-quickstart-30min',
        snippet: '回调成功后返回 success。',
        in_page_path: 'p[1]',
      },
      {
        citation_id: 'cit_2',
        chunk_id: 102,
        page_id: 'webhook-mechanism',
        lang: 'zh',
        source_lang: null,
        title: 'Webhook 回调机制',
        breadcrumb: [],
        url: '/zh/webhook-mechanism',
        snippet: 'Webhook 需要幂等处理。',
        in_page_path: 'p[1]',
      },
    ],
  });
  const retrievalTrace = trace(['payment-engine-quickstart-30min']);

  const scored = scoreCase(c, result, retrievalTrace);

  assert.equal(scored.hit_at_5, true);
  assert.equal(scored.citation_anchor_pass, true);
  assert.equal(scored.unexpected_citation_rate, 0);
});

test('scoreCase separates citation anchor from unexpected citation pages', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-quickstart-30min'],
      allow_cite_pages: ['webhook-mechanism'],
      must_contain: [],
      forbid_contain: [],
    },
  });
  const result = answer({
    citations: [
      {
        citation_id: 'cit_1',
        chunk_id: 101,
        page_id: 'webhook-mechanism',
        lang: 'en',
        source_lang: null,
        title: 'Webhook Callback Mechanism',
        breadcrumb: [],
        url: '/en/webhook-mechanism',
        snippet: 'Callbacks should be idempotent.',
        in_page_path: 'p[1]',
      },
      {
        citation_id: 'cit_2',
        chunk_id: 102,
        page_id: 'unrelated-page',
        lang: 'en',
        source_lang: null,
        title: 'Unrelated',
        breadcrumb: [],
        url: '/en/unrelated-page',
        snippet: 'Noise.',
        in_page_path: 'p[1]',
      },
    ],
  });

  const scored = scoreCase(c, result, trace(['payment-engine-quickstart-30min']));

  assert.equal(scored.citation_anchor_pass, true, 'allowed citations still anchor the answer');
  assert.deepEqual(scored.unexpected_citation_pages, ['unrelated-page']);
  assert.equal(scored.unexpected_citation_rate, 0.5);
});

test('scoreCase citation anchor fails when answer only cites unexpected pages', () => {
  const scored = scoreCase(
    golden(),
    answer({
      citations: [
        {
          citation_id: 'cit_1',
          chunk_id: 101,
          page_id: 'unrelated-page',
          lang: 'en',
          source_lang: null,
          title: 'Unrelated',
          breadcrumb: [],
          url: '/en/unrelated-page',
          snippet: 'Noise.',
          in_page_path: 'p[1]',
        },
      ],
    }),
    trace(['payment-engine-api']),
  );

  assert.equal(scored.citation_anchor_pass, false);
  assert.deepEqual(scored.unexpected_citation_pages, ['unrelated-page']);
  assert.equal(scored.unexpected_citation_rate, 1);
});

test('scoreCase preserves structured error diagnostics for eval reports', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api'],
      must_contain: ['checkout_url'],
      forbid_contain: [],
      expected_kind: 'answer',
    },
  });

  const scored = scoreCase(
    c,
    {
      type: 'error',
      code: 'no_citations',
      message: 'Could not find enough support in the docs.',
      detail: 'LLM response cited [cit_9], which was not in the retrieved context.',
    },
    trace(['payment-engine-api']),
  );

  assert.equal(scored.kind, 'error');
  assert.equal(scored.kind_pass, false);
  assert.equal(scored.error_code, 'no_citations');
  assert.equal(scored.error_message, 'Could not find enough support in the docs.');
  assert.match(scored.error_detail ?? '', /cit_9/);
});

test('summarizeResults averages API rules over API cases only', () => {
  const withApi = scoreCase(
    golden({
      id: 'api-case',
      expected: {
        must_cite_pages: ['payment-engine-api'],
        must_cite_operations: ['POST /api/v2/checkout'],
        must_contain: [],
        forbid_contain: [],
      },
    }),
    answer(),
    trace(['payment-engine-api']),
  );
  const withoutApi = scoreCase(golden({ id: 'plain-case' }), answer(), trace(['payment-engine-api']));

  const summary = summarizeResults([withApi, withoutApi]);

  assert.equal(summary.n, 2);
  assert.equal(summary.api_rule_n, 1);
  assert.equal(summary.api_rule_pass, 1);
  assert.equal(summary.mrr, 1, 'both cases hit at rank 1');
  assert.equal(summary.hit_at_1, 1);
  assert.equal(summary.hit_at_3, 1);
  assert.equal(summary.citation_anchor_pass, 1);
  assert.equal(summary.unexpected_citation_rate, 0);
});
