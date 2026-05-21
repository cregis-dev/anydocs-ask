import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCase, summarizeResults } from '../src/eval/scoring.ts';
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
      nav_index: null,
      nav_index_boost: 0,
    })),
    subtree_ask_triggered: false,
    top_final_score: 1,
    confidence: 1,
    tokens_in: null,
    tokens_out: null,
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
        url: '/en/reference/payment-engine-api#post-api-v2-checkout',
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

test('scoreCase scores API operation and citation URL rules only when configured', () => {
  const c = golden({
    expected: {
      must_cite_pages: ['payment-engine-api'],
      must_cite_operations: ['POST /api/v2/checkout'],
      must_cite_urls: ['/en/reference/payment-engine-api#post-api-v2-checkout'],
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

test('scoreCase allows extra citations listed in allow_cite_pages without changing R@5 target', () => {
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

  assert.equal(scored.r_at_5, true);
  assert.equal(scored.citation_pass, true);
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
});
