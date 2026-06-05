/**
 * Unit tests for the pure-function modules of the query pipeline:
 * lang detection, FTS5 sanitization, rerank, aggregate, postprocess.
 *
 * Each module is exercised standalone — no DB and no LLM — so the e2e
 * suite (tests/ask.test.ts) can stay focused on PRD §8 acceptance #11/#12/#13.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLangFromText, langFromScopeId } from '../src/query/lang.ts';
import { sanitizeFtsQuery } from '../src/query/sanitize.ts';
import { rerank, computeTitleMatches } from '../src/query/rerank.ts';
import { aggregate } from '../src/query/aggregate.ts';
import { postprocess } from '../src/query/postprocess.ts';
import { buildPrompt, detectFormatHint } from '../src/query/prompt.ts';
import { LLMIntentRouter } from '../src/query/intent-router.ts';
import type { LLM, LLMGenerateInput, LLMGenerateOutput } from '../src/llm/types.ts';
import type { RerankedChunk } from '../src/query/rerank.ts';
import type { RetrievedChunk } from '../src/query/retrieval.ts';

// ---------------------------------------------------------------------------
// lang.ts
// ---------------------------------------------------------------------------

test('detectLangFromText: pure CJK -> zh', () => {
  assert.equal(detectLangFromText('如何鉴权？'), 'zh');
});

test('detectLangFromText: pure ASCII -> en', () => {
  assert.equal(detectLangFromText('how do I authenticate?'), 'en');
});

test('detectLangFromText: mixed but ≥30% CJK -> zh', () => {
  // Token "API 鉴权方法" — 1/8 chars are ASCII; well over 30% CJK.
  assert.equal(detectLangFromText('API 鉴权方法 setUp'), 'zh');
});

test('detectLangFromText: mostly English with a couple of zh chars stays en', () => {
  // ~6.7% CJK well below the 15% threshold.
  assert.equal(detectLangFromText('how do I configure the 设置 endpoint properly'), 'en');
});

// Regression for codex round-8 zh-lang-aware findings. Real zh queries
// frequently mix in English technical terms; under the old 30% threshold
// they got misdetected as 'en' and the LLM was prompted to reply in English.
test('detectLangFromText: zh question with technical terms (16% CJK) detects zh', () => {
  // 如何配置 (4) + 里的 (2) = 6 CJK chars in 37 non-WS chars = 16.2%.
  assert.equal(
    detectLangFromText('如何配置 anydocs.config.json 里的 site.theme.id？'),
    'zh',
  );
});

test('detectLangFromText: CJK punctuation counts as zh signal', () => {
  // 5 CJK chars (有什么区别) + 3 CJK punct (、、？) in 36 chars = 22%.
  assert.equal(
    detectLangFromText('sessions、checkpoints、memory 有什么区别？'),
    'zh',
  );
});

test('detectLangFromText: zh-only short query stays zh', () => {
  // 3 chars (什么是) + codeGroup (9) + ？ (1 — CJK punct) = 4 CJK / 13 = 30%.
  assert.equal(detectLangFromText('什么是 codeGroup？'), 'zh');
});

// Regression for codex round-9 zh-lang case. Long queries with heavy English
// technical tokens at the front can have <15% CJK ratio but are clearly
// Chinese to a human reader. ≥3 CJK characters by themselves is enough
// signal regardless of ratio.
test('detectLangFromText: ≥3 CJK chars detect zh even at low ratio (11%)', () => {
  // 4 CJK chars (如何配置) / 36 non-WS ≈ 11% — under the 15% ratio gate, but
  // 4 CJK chars passes the absolute-count gate.
  assert.equal(
    detectLangFromText('anydocs.config.json 如何配置 site.theme.id'),
    'zh',
  );
});

test('detectLangFromText: 1-2 incidental CJK chars do NOT count as zh', () => {
  // Single zh token sprinkled in English shouldn't flip the lang.
  assert.equal(detectLangFromText('check the 设置 endpoint'), 'en');
  assert.equal(detectLangFromText('see config 设置 file'), 'en');
});

test('detectLangFromText: empty string -> en (benign default)', () => {
  assert.equal(detectLangFromText(''), 'en');
  assert.equal(detectLangFromText('   '), 'en');
});

test('langFromScopeId: nav:zh.json:... -> zh', () => {
  assert.equal(langFromScopeId('nav:zh.json:0'), 'zh');
});

test('langFromScopeId: nav:en.json:... -> en', () => {
  assert.equal(langFromScopeId('nav:en.json:1.2'), 'en');
});

test('langFromScopeId: page-id form returns null', () => {
  assert.equal(langFromScopeId('p_frontend_auth'), null);
});

test('langFromScopeId: unsupported lang prefix returns null', () => {
  assert.equal(langFromScopeId('nav:fr.json:0'), null);
});

// ---------------------------------------------------------------------------
// extractEntityTerms (answer.ts internal helper)
// ---------------------------------------------------------------------------

import { extractEntityTerms } from '../src/query/answer.ts';

test('extractEntityTerms: comma-separated triple', () => {
  assert.deepEqual(
    extractEntityTerms('how do sessions, checkpoints, and memory work in Hermes?'),
    ['sessions', 'checkpoints', 'memory'],
  );
});

test('extractEntityTerms: Chinese ideographic comma is a separator', () => {
  assert.deepEqual(
    extractEntityTerms('sessions、checkpoints、memory 有什么区别？'),
    ['sessions', 'checkpoints', 'memory'],
  );
});

test('extractEntityTerms: `and`/`or` conjunctions also count as separators', () => {
  assert.deepEqual(
    extractEntityTerms('compare sessions and checkpoints and memory in Hermes'),
    ['sessions', 'checkpoints', 'memory'],
  );
});

test('extractEntityTerms: single comma is below the gate -> undefined', () => {
  assert.equal(extractEntityTerms('what is the difference between X and Y?'), undefined);
});

test('extractEntityTerms: segment-leading stop words are walked past', () => {
  // "how do sessions, ..." — `how`/`do` are stop / too short; we walk to `sessions`.
  const out = extractEntityTerms('how do sessions, and checkpoints')!;
  assert.ok(out.includes('sessions'));
  assert.ok(out.includes('checkpoints'));
});

test('extractEntityTerms: question verbs (compare/show/list) are not entities', () => {
  // Without the verb stop-words, the first segment of "compare X and Y..."
  // would yield `compare` as the entity instead of `X`.
  const out = extractEntityTerms('compare sessions and checkpoints and memory')!;
  assert.ok(!out.includes('compare'));
});

// 2-entity compare queries have only ONE separator (` and `), which falls
// below the default ≥2 gate. The comparative-hint relaxation lets a single
// separator be sufficient when the query carries `compare`/`vs`/`versus`.
// Codex round-9 found these were the 1/3 → 400 cases on
// `Compare sessions and checkpoints in Hermes.`.
test('extractEntityTerms: 2-entity compare query triggers via comparative hint', () => {
  assert.deepEqual(
    extractEntityTerms('Compare sessions and checkpoints in Hermes.'),
    ['sessions', 'checkpoints'],
  );
});

test('extractEntityTerms: `vs` / `versus` count as separators and hints', () => {
  assert.deepEqual(extractEntityTerms('sessions vs checkpoints'), ['sessions', 'checkpoints']);
  assert.deepEqual(extractEntityTerms('memory versus sessions'), ['memory', 'sessions']);
});

test('extractEntityTerms: plain 2-entity question without compare hint still skipped', () => {
  // Without `compare`/`vs`, a single `and` is not enough — too easy to
  // accidentally trigger on generic phrases.
  assert.equal(extractEntityTerms('how does sessions and memory work?'), undefined);
});

// ---------------------------------------------------------------------------
// sanitize.ts
// ---------------------------------------------------------------------------

test('sanitizeFtsQuery: plain words wrapped as quoted tokens joined by OR', () => {
  assert.equal(sanitizeFtsQuery('how do I login'), '"login"');
});

test('sanitizeFtsQuery: strips MATCH operators', () => {
  // ", *, -, +, :, (, ), ^ are reserved; they get dropped before tokenization.
  assert.equal(sanitizeFtsQuery('foo*  +bar  -baz "qux"'), '"foo" OR "bar" OR "baz" OR "qux"');
});

test('sanitizeFtsQuery: drops AND/OR/NOT keywords (case-insensitive)', () => {
  assert.equal(sanitizeFtsQuery('foo AND bar or NOT baz'), '"foo" OR "bar" OR "baz"');
});

test('sanitizeFtsQuery: chinese punctuation acts as token boundary', () => {
  assert.equal(sanitizeFtsQuery('鉴权？怎么做'), '"鉴权" OR "怎么做"');
});

test('sanitizeFtsQuery: expands long zh signature phrases into searchable domain terms', () => {
  const query = sanitizeFtsQuery('Cregis API 签名应该怎么拼接参数？sign 字段本身要不要参与签名？');
  assert.ok(query?.includes('"签名"'));
  assert.ok(query?.includes('"拼接"'));
  assert.ok(query?.includes('"参数"'));
  assert.ok(query?.includes('"字段"'));
});

test('sanitizeFtsQuery: expands long zh error-code phrases into searchable domain terms', () => {
  const query = sanitizeFtsQuery(
    'Cregis API 返回不是 00000 时，我应该先看哪些错误码来判断是签名、白名单还是项目配置问题？',
  );
  assert.ok(query?.includes('"错误码"'));
  assert.ok(query?.includes('"签名"'));
  assert.ok(query?.includes('"白名单"'));
  assert.ok(query?.includes('"项目配置"'));
});

test('sanitizeFtsQuery: returns null when nothing useful survives', () => {
  assert.equal(sanitizeFtsQuery('   '), null);
  assert.equal(sanitizeFtsQuery('?!'), null);
  assert.equal(sanitizeFtsQuery('AND OR'), null);
});

// CamelCase identifiers expand to both the original token AND a phrase form
// so BM25 hits chunks that author the same concept as separate words.
// Regression for codex eval clarify follow-up: a query like `codeGroup`
// previously missed every chunk that wrote "code group" as two words.
test('sanitizeFtsQuery: camelCase token emits both literal and phrase form', () => {
  assert.equal(
    sanitizeFtsQuery('does Markdown support codeGroup?'),
    '"Markdown" OR "support" OR "codeGroup" OR "code Group"',
  );
});

test('sanitizeFtsQuery: deeper compound identifiers split too', () => {
  assert.equal(
    sanitizeFtsQuery('parse XMLHttpRequest body'),
    '"parse" OR "XMLHttpRequest" OR "XML Http Request" OR "body"',
  );
});

test('sanitizeFtsQuery: drops English stop words when content terms survive', () => {
  assert.equal(
    sanitizeFtsQuery('B0001 after signing: what are the first three Cregis checks I should make?'),
    '"B0001" OR "signing" OR "Cregis" OR "checks"',
  );
});

test('sanitizeFtsQuery: plain lowercase tokens are not duplicated', () => {
  assert.equal(sanitizeFtsQuery('plain login flow'), '"plain" OR "login" OR "flow"');
});

// ---------------------------------------------------------------------------
// prompt.detectFormatHint
// ---------------------------------------------------------------------------

test('detectFormatHint: zh comparison -> table', () => {
  assert.equal(detectFormatHint('A 和 B 的对比'), 'table');
  assert.equal(detectFormatHint('A vs B'), 'table');
});

test('detectFormatHint: zh how-to -> list', () => {
  assert.equal(detectFormatHint('如何鉴权？'), 'list');
  assert.equal(detectFormatHint('how do I do X'), 'list');
});

test('detectFormatHint: en concept -> concept', () => {
  assert.equal(detectFormatHint('what is JWT?'), 'concept');
  assert.equal(detectFormatHint('什么是 JWT'), 'concept');
});

test('detectFormatHint: default paragraph', () => {
  assert.equal(detectFormatHint('JWT 鉴权的常见错误码'), 'paragraph');
});

// ---------------------------------------------------------------------------
// intent-router.ts
// ---------------------------------------------------------------------------

class RouterTestLLM implements LLM {
  readonly model = 'router-test';
  readonly calls: LLMGenerateInput[] = [];
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    this.calls.push(input);
    return { text: this.text, modelUsed: this.model };
  }
}

test('LLMIntentRouter: follows the LLM route for checkout follow-up rewrites', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'follow_up',
    effective_question: '/api/v2/checkout checkout_url valid_time 那它过期时间怎么设置？',
    intent: 'api_reference',
    product: 'payment_engine',
    retrieval: {
      prefer_api_reference: true,
      api_reference_hints: ['checkout checkout_url valid_time', 'POST /api/v2/checkout'],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: ['v2'],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: '那它过期时间怎么设置？',
    lang: 'zh',
    history: [
      {
        question: '支付引擎创建订单接口返回的 checkout_url 是做什么用的？',
        answer_summary: '`POST /api/v2/checkout` 返回的 checkout_url 用于跳转支付页。',
      },
    ],
  });

  assert.equal(route.usesHistory, true);
  assert.equal(route.rewritten, true);
  assert.equal(route.effectiveQuestion, '/api/v2/checkout checkout_url valid_time 那它过期时间怎么设置？');
  assert.equal(route.apiIntent, true);
  assert.equal(route.signatureAuthIntent, false);
  assert.ok(route.apiReferenceHints.includes('checkout checkout_url valid_time'));
  assert.ok(route.apiReferenceHints.includes('POST /api/v2/checkout'));
  assert.ok(route.apiReferenceHints.includes('checkout'));
  assert.deepEqual(route.apiReferenceVersionPrefs, ['v2']);
  assert.match(llm.calls[0]!.systemPrompt, /ANYDOCS_INTENT_ROUTER_V1/);
  assert.match(llm.calls[0]!.userPrompt, /checkout_url/);
});

test('LLMIntentRouter: standalone signature route can ignore unrelated history', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'Cregis API 签名参数怎么拼接？',
    intent: 'signature_auth',
    product: 'general',
    retrieval: {
      prefer_api_reference: false,
      api_reference_hints: [],
      supplemental_context_hints: ['authentication signature API_KEY MD5 sign empty values lexicographical order'],
      supplemental_page_ids: ['authentication', 'webhook-mechanism'],
      api_versions: [],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'Cregis API 签名参数怎么拼接？',
    lang: 'zh',
    history: [
      {
        question: '那它过期时间怎么设置？',
        answer_summary: '`POST /api/v2/checkout` 的 valid_time 控制支付页有效期。',
      },
    ],
  });

  assert.equal(route.usesHistory, false);
  assert.equal(route.rewritten, false);
  assert.equal(route.effectiveQuestion, 'Cregis API 签名参数怎么拼接？');
  assert.equal(route.apiIntent, false);
  assert.equal(route.signatureAuthIntent, true);
  assert.deepEqual(route.supplementalContextHints, ['authentication signature API_KEY MD5 sign empty values lexicographical order']);
  assert.deepEqual(route.supplementalPageIds, ['authentication', 'webhook-mechanism']);
});

test('LLMIntentRouter: adds intent default pages when the LLM omits them', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'Can I use localhost as my callback_url while testing Cregis webhooks?',
    intent: 'webhook_status',
    product: 'payment_engine',
    retrieval: {
      prefer_api_reference: false,
      api_reference_hints: [],
      supplemental_context_hints: ['callback_url localhost success'],
      supplemental_page_ids: [],
      api_versions: [],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'Can I use localhost as my callback_url while testing Cregis webhooks?',
    lang: 'en',
  });

  assert.equal(route.apiIntent, false);
  assert.deepEqual(route.supplementalPageIds, [
    'webhook-mechanism',
    'waas-quickstart-30min',
    'payment-engine-quickstart-30min',
  ]);
});

test('LLMIntentRouter: does not turn generic error troubleshooting into API-reference intent', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'Cregis API 返回不是 00000 时应该先看哪些错误码？',
    intent: 'error_troubleshooting',
    product: 'general',
    retrieval: {
      prefer_api_reference: true,
      api_reference_hints: ['error codes', '00000', 'signature', 'whitelist'],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: [],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'Cregis API 返回不是 00000 时应该先看哪些错误码？',
    lang: 'zh',
  });

  assert.equal(route.apiIntent, false);
  assert.deepEqual(route.supplementalPageIds, [
    'error-codes',
    'authentication',
    'waas-setup',
    'payment-engine-setup',
  ]);
});

test('LLMIntentRouter: keeps endpoint-specific signature questions API-aware', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'For a WaaS /api/v1/payout request, show the ordered MD5 string.',
    intent: 'signature_auth',
    product: 'waas',
    retrieval: {
      prefer_api_reference: false,
      api_reference_hints: ['/api/v1/payout', 'third_party_id', 'MD5'],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: ['v1'],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'For a WaaS /api/v1/payout request, show the ordered MD5 string.',
    lang: 'en',
  });

  assert.equal(route.apiIntent, true);
  assert.deepEqual(route.supplementalPageIds, ['authentication', 'webhook-mechanism']);
});

test('LLMIntentRouter: keeps endpoint-specific webhook status questions API-aware', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'event_type and data.status mapping via POST /api/v2/order/info',
    intent: 'webhook_status',
    product: 'payment_engine',
    retrieval: {
      prefer_api_reference: false,
      api_reference_hints: ['order info', 'data.status', 'event_type', 'POST /api/v2/order/info'],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: ['v2'],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'event_type 和 data.status 为什么名字不一样？',
    lang: 'zh',
  });

  assert.equal(route.apiIntent, true);
  assert.ok(route.apiReferenceHints.includes('status'));
});

test('LLMIntentRouter: normalizes token identifier routes to include the coins endpoint', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'How do I find token_id and chain_id for USDT payouts?',
    intent: 'tokens_currencies',
    product: 'waas',
    retrieval: {
      prefer_api_reference: true,
      api_reference_hints: ['token_id', 'chain_id', 'currency'],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: ['v1'],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'How do I find token_id and chain_id for USDT payouts?',
    lang: 'en',
  });

  assert.ok(route.apiReferenceHints.includes('coins'));
  assert.ok(route.apiReferenceHints.includes('POST /api/v1/coins'));
  assert.equal(route.apiIntent, true);
});

test('LLMIntentRouter: expands bare API paths into searchable operation hints', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'For a WaaS /api/v1/payout request, show the ordered MD5 string.',
    intent: 'signature_auth',
    product: 'waas',
    retrieval: {
      prefer_api_reference: false,
      api_reference_hints: ['/api/v1/payout', 'MD5'],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: ['v1'],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'For a WaaS /api/v1/payout request, show the ordered MD5 string.',
    lang: 'en',
  });

  assert.ok(route.apiReferenceHints.includes('payout'));
  assert.ok(route.apiReferenceHints.includes('POST /api/v1/payout'));
});

test('LLMIntentRouter: maps valid_time questions back to the checkout endpoint', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'If a Payment Engine user does not pay before valid_time, how should I confirm final status?',
    intent: 'payment_flow',
    product: 'payment_engine',
    retrieval: {
      prefer_api_reference: true,
      api_reference_hints: ['order info', 'data.status', 'POST /api/v2/order/info'],
      supplemental_context_hints: ['valid_time', 'callback', 'order status'],
      supplemental_page_ids: ['payment-engine-quickstart-30min', 'pe-business-flow'],
      api_versions: ['v2'],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'If a Payment Engine user does not pay before `valid_time`, how should I confirm the final order status by callback or API?',
    lang: 'en',
  });

  assert.equal(route.apiIntent, true);
  assert.ok(route.apiReferenceHints.includes('POST /api/v2/order/info'));
  assert.ok(route.apiReferenceHints.includes('POST /api/v2/checkout'));
  assert.ok(route.apiReferenceHints.includes('checkout'));
});

test('LLMIntentRouter: normalizes user-deposit-address withdrawal routes to sub_address_withdrawal', async () => {
  const llm = new RouterTestLLM(JSON.stringify({
    conversation_mode: 'standalone',
    effective_question: 'Withdraw from a specific user deposit address instead of default payout wallet.',
    intent: 'api_reference',
    product: 'waas',
    retrieval: {
      prefer_api_reference: true,
      api_reference_hints: ['payout', 'from_address', 'user deposit address', 'POST /api/v1/payout'],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: ['v1'],
    },
  }));
  const router = new LLMIntentRouter(llm);
  const route = await router.route({
    question: 'Withdraw from a specific user deposit address instead of default payout wallet.',
    lang: 'en',
  });

  assert.ok(route.apiReferenceHints.includes('sub_address_withdrawal'));
  assert.ok(route.apiReferenceHints.includes('POST /api/v1/sub_address_withdrawal'));
  assert.equal(route.apiIntent, true);
});

test('LLMIntentRouter: malformed route falls back to standalone general docs', async () => {
  const router = new LLMIntentRouter(new RouterTestLLM('not json'));
  const route = await router.route({
    question: '怎么配置？',
    lang: 'zh',
    history: [{ question: '之前的问题', answer_summary: '之前的回答' }],
  });

  assert.equal(route.usesHistory, false);
  assert.equal(route.rewritten, false);
  assert.equal(route.effectiveQuestion, '怎么配置？');
  assert.equal(route.intent, 'general_docs');
  assert.equal(route.apiIntent, false);
});

// ---------------------------------------------------------------------------
// rerank.ts
// ---------------------------------------------------------------------------

function fakeRetrieved(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    page_id: 'p',
    lang: 'zh',
    in_page_path: 'h2/p[1]',
    text: 'body',
    is_code: 0,
    page_title: 'P',
    page_url: '/p',
    subtree_root: 'sub',
    nav_index: 0,
    breadcrumb: [{ id: 'sub', title: 'Sub', type: 'section' }],
    rrf_score: 0.1,
    ...over,
  };
}

test('buildPrompt: appends project-specific assistant identity and instructions after core rules', () => {
  const prompt = buildPrompt({
    question: '支付引擎和 WaaS 有什么区别？',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          page_id: 'payment-engine',
          page_title: '支付引擎',
          text: 'Payment Engine handles orders and checkout.',
          breadcrumb: [{ id: 'payment-engine', title: '支付引擎', type: 'section' }],
        }),
        final_score: 0.2,
      },
    ],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'table',
    promptConfig: {
      assistantName: 'Cregis AI 助手',
      systemInstructions: [
        'Payment Engine 主要用于订单、收款、托管收银台、支付回调和订单状态查询。',
        'WaaS 主要用于钱包、地址、充值、归集、提币和链上资产管理。',
      ],
    },
  });

  assert.match(prompt.system, /你是 Cregis AI 助手。/);
  assert.match(prompt.system, /答案必须基于下方提供的参考片段/);
  assert.match(prompt.system, /项目自定义说明：/);
  assert.match(prompt.system, /Payment Engine 主要用于订单/);
  assert.match(prompt.system, /WaaS 主要用于钱包/);
});

test('buildPrompt: adds API reference citation rule when context contains API reference chunks', () => {
  const prompt = buildPrompt({
    question: '创建订单返回哪些字段？',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          page_id: 'api-payment-engine-api-post-api-v2-checkout',
          page_title: 'POST /api/v2/checkout — 创建订单',
          page_url: '/zh/reference/payment-engine-api/post-api-v2-checkout',
          text: 'API reference: Payment Engine API\nEndpoint: POST `/api/v2/checkout`\nResponse fields: `cregis_id`, `checkout_url`',
          breadcrumb: [{ id: 'api', title: 'API Reference', type: 'section' }],
        }),
        final_score: 0.2,
      },
    ],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
  });

  assert.match(prompt.system, /API reference/);
  assert.match(prompt.system, /完整接口路径/);
  assert.match(prompt.system, /回答检查清单/);
});

test('buildPrompt: adds grounded answer checklist for API status and callback facts', () => {
  const prompt = buildPrompt({
    question: 'event_type 和 data.status 怎么映射？',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          page_id: 'api-payment-engine-api-post-api-v2-order-info',
          page_title: 'POST /api/v2/order/info — 查询订单信息',
          page_url: '/zh/reference/payment-engine-api/post-api-v2-order-info',
          text: 'API reference: Payment Engine API\nHTTP Request POST /api/v2/order/info\nResponse fields: data.status',
          breadcrumb: [{ id: 'api', title: 'API Reference', type: 'section' }],
        }),
        final_score: 0.2,
      },
      {
        ...fakeRetrieved({
          chunk_id: 2,
          page_id: 'payment-engine-quickstart-30min',
          page_title: '支付引擎 30 分钟接入实战',
          text: '回调外层关键字段：event_name 固定为 order，event_type 表示订单回调事件类型。请按事件流转处理并做好幂等。',
          breadcrumb: [{ id: 'payment-engine', title: '支付引擎', type: 'section' }],
        }),
        final_score: 0.18,
      },
    ],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
  });

  assert.match(prompt.user, /回答检查清单/);
  assert.match(prompt.user, /\/api\/v2\/order\/info/);
  assert.match(prompt.user, /data\.status/);
  assert.match(prompt.user, /event_type/);
  assert.match(prompt.user, /必须写出“回调事件类型”/);
  assert.match(prompt.user, /状态映射/);
  assert.match(prompt.user, /幂等/);
  assert.match(prompt.user, /\[cit_1\]/);
  assert.match(prompt.user, /\[cit_2\]/);
});

test('buildPrompt: zh signature checklist says sign is excluded explicitly', () => {
  const prompt = buildPrompt({
    question: 'Cregis API 签名应该怎么拼接参数？sign 字段本身要不要参与签名？',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          page_id: 'authentication',
          page_title: '认证与签名',
          text: '签名规则：将参数按字典序升序排列，sign 字段不参与签名计算，最后追加 API Key 做 MD5。',
          breadcrumb: [{ id: 'get-started', title: '快速入门', type: 'section' }],
        }),
        final_score: 0.2,
      },
    ],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
  });

  assert.match(prompt.user, /必须明确写出：排除 `sign` 字段/);
  assert.match(prompt.user, /`sign` 不参与签名计算/);
});

test('buildPrompt: adds grounded answer checklist for signature and webhook success facts', () => {
  const prompt = buildPrompt({
    question: 'How should I verify webhook retries and signature?',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          lang: 'en',
          page_id: 'authentication',
          page_title: 'Authentication & Signature',
          text: 'Signature rules: exclude the sign field before calculating the signature.',
          breadcrumb: [{ id: 'get-started', title: 'Get Started', type: 'section' }],
        }),
        final_score: 0.2,
      },
      {
        ...fakeRetrieved({
          chunk_id: 2,
          lang: 'en',
          page_id: 'webhook-mechanism',
          page_title: 'Webhook Callback Mechanism',
          text: 'Webhook handler must return HTTP 200 and the plain text success after processing idempotently.',
          breadcrumb: [{ id: 'get-started', title: 'Get Started', type: 'section' }],
        }),
        final_score: 0.18,
      },
    ],
    answerLang: 'en',
    isCrossLang: false,
    formatHint: 'paragraph',
  });

  assert.match(prompt.user, /Answer checklist/);
  assert.match(prompt.user, /exclude `sign`/i);
  assert.match(prompt.user, /HTTP 200/);
  assert.match(prompt.user, /`success`/);
});

test('buildPrompt: adds grounded answer checklist for direct crypto order amount behavior', () => {
  const prompt = buildPrompt({
    question: 'Can I create an order directly in USDT after calculating FX myself?',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          lang: 'en',
          page_id: 'supported-currencies',
          page_title: 'Supported Currencies',
          text: 'If the merchant passes a cryptocurrency order_currency and order_amount, the order can use that crypto amount directly instead of relying on the CoinMarketCap exchange rate.',
          breadcrumb: [{ id: 'payment-engine', title: 'Payment Engine', type: 'section' }],
        }),
        final_score: 0.2,
      },
    ],
    answerLang: 'en',
    isCrossLang: false,
    formatHint: 'paragraph',
  });

  assert.match(prompt.user, /Answer checklist/);
  assert.match(prompt.user, /crypto order currency and amount directly/);
  assert.doesNotMatch(prompt.user, /Mention the CoinMarketCap \/ CMC exchange-rate behavior/);
});

test('buildPrompt: adds grounded answer checklist for token identifier examples', () => {
  const prompt = buildPrompt({
    question: 'For USDT payouts on Ethereum versus Polygon, what changes in the WaaS payout request?',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          lang: 'en',
          page_id: 'api-waas-api-post-api-v1-payout',
          page_title: 'POST /api/v1/payout — Create Wallet Payout',
          page_url: '/en/reference/waas-api/post-api-v1-payout',
          text: 'API reference: WaaS API\nHTTP Request POST /api/v1/payout\nRequest Body Fields: currency is formatted as chain_id@token_id (for example, 195@195).',
          breadcrumb: [{ id: 'api', title: 'API Reference', type: 'section' }],
        }),
        final_score: 0.2,
      },
    ],
    answerLang: 'en',
    isCrossLang: false,
    formatHint: 'paragraph',
  });

  assert.match(prompt.user, /Answer checklist/);
  assert.match(prompt.user, /chain_id@token_id/);
  assert.match(prompt.user, /195@195/);
});

test('buildPrompt: adds grounded answer checklist for test-token environment limits', () => {
  const prompt = buildPrompt({
    question: '测试网代币能直接用于生产吗？',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          page_id: 'sdk-overview',
          page_title: 'SDK 与开发者工具',
          text: '获取测试网代币：测试代币只能在开发环境使用。',
          breadcrumb: [{ id: 'sdk', title: 'SDK & 工具', type: 'section' }],
        }),
        final_score: 0.2,
      },
    ],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
  });

  assert.match(prompt.user, /回答检查清单/);
  assert.match(prompt.user, /测试代币只能用于开发环境/);
  assert.match(prompt.user, /不能直接用于生产环境/);
});

test('rerank: lang_boost +0.30 applied when chunk.lang == query_lang', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, lang: 'zh', rrf_score: 0.1, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, lang: 'en', rrf_score: 0.1, nav_index: 1000 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: null },
  );
  // Find both by id; zh should score higher than en.
  const zh = out.find((c) => c.chunk_id === 1)!;
  const en = out.find((c) => c.chunk_id === 2)!;
  assert.ok(zh.final_score > en.final_score, 'zh chunk must beat en chunk under same RRF');
  assert.ok(zh.final_score >= 0.1 * (1 + 0.3), 'lang boost adds at least +0.30 multiplicatively');
});

test('rerank: same_subtree_boost +0.20 when current subtree matches', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, subtree_root: 'A', nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, subtree_root: 'B', nav_index: 1000 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: 'A' },
  );
  const a = out.find((c) => c.chunk_id === 1)!;
  const b = out.find((c) => c.chunk_id === 2)!;
  assert.ok(a.final_score > b.final_score);
});

test('rerank: current_page_boost prefers exact current page over same-subtree sibling', () => {
  const out = rerank(
    [
      fakeRetrieved({
        chunk_id: 1,
        page_id: 'authentication',
        page_title: 'Authentication & Signature',
        subtree_root: 'get-started',
        rrf_score: 0.1,
        nav_index: 1000,
      }),
      fakeRetrieved({
        chunk_id: 2,
        page_id: 'webhook-mechanism',
        page_title: 'Webhook Callback Mechanism',
        subtree_root: 'get-started',
        rrf_score: 0.12,
        nav_index: 1000,
      }),
    ],
    {
      queryLang: 'en',
      currentSubtreeRoot: 'get-started',
      currentPageId: 'authentication',
      query: 'How do I calculate sign?',
    },
  );

  assert.equal(out[0]?.page_id, 'authentication');
});

test('rerank: api_reference_boost prefers API reference chunks for API-intent questions', () => {
  const out = rerank(
    [
      fakeRetrieved({
        chunk_id: 1,
        page_id: 'payment-engine-quickstart-30min',
        page_title: '支付引擎 30 分钟接入实战',
        page_url: '/zh/payment-engine-quickstart-30min',
        text: '创建订单后跳转托管收银台。',
        rrf_score: 0.12,
        nav_index: 1000,
      }),
      fakeRetrieved({
        chunk_id: 2,
        page_id: 'api-payment-engine-api-post-api-v2-checkout',
        page_title: 'POST /api/v2/checkout — 创建订单',
        page_url: '/zh/reference/payment-engine-api/post-api-v2-checkout',
        text: 'API reference: Payment Engine API\nEndpoint: POST `/api/v2/checkout`',
        rrf_score: 0.1,
        nav_index: 1000,
      }),
    ],
    {
      queryLang: 'zh',
      currentSubtreeRoot: null,
      query: '创建订单接口 POST /api/v2/checkout 返回哪些字段？',
      apiIntent: true,
    },
  );

  assert.equal(out[0]?.page_id, 'api-payment-engine-api-post-api-v2-checkout');
});

test('rerank: api_reference_boost skips API chunks that miss hint terms or preferred version', () => {
  const out = rerank(
    [
      fakeRetrieved({
        chunk_id: 1,
        page_id: 'api-waas-api-post-api-v1-payout',
        page_title: 'POST /api/v1/payout — 发起钱包提币',
        text: 'API reference: WaaS API. HTTP Request POST /api/v1/payout.',
        rrf_score: 0.1,
        nav_index: 1000,
      }),
      fakeRetrieved({
        chunk_id: 2,
        page_id: 'api-waas-api-post-api-v2-payout',
        page_title: 'POST /api/v2/payout — 发起钱包提币',
        text: 'API reference: WaaS API. HTTP Request POST /api/v2/payout.',
        rrf_score: 0.1,
        nav_index: 1000,
      }),
      fakeRetrieved({
        chunk_id: 3,
        page_id: 'api-waas-api-post-api-v1-coins',
        page_title: 'POST /api/v1/coins — 查询币种',
        text: 'API reference: WaaS API. HTTP Request POST /api/v1/coins.',
        rrf_score: 0.1,
        nav_index: 1000,
      }),
    ],
    {
      queryLang: 'zh',
      currentSubtreeRoot: null,
      query: 'WaaS API 出款流程',
      apiIntent: true,
      apiReferenceHintTerms: ['api', 'v1', 'payout'],
      apiReferenceVersionPrefs: ['v1'],
      apiReferencePagePrefix: 'api-waas-',
    },
  );
  const v1 = out.find((c) => c.page_id === 'api-waas-api-post-api-v1-payout')!;
  const v2 = out.find((c) => c.page_id === 'api-waas-api-post-api-v2-payout')!;
  const coins = out.find((c) => c.page_id === 'api-waas-api-post-api-v1-coins')!;
  assert.ok(v1.final_score > v2.final_score);
  assert.ok(v1.final_score > coins.final_score);
});

test('rerank: nav_index_boost decays with depth', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, nav_index: 0 }),
      fakeRetrieved({ chunk_id: 2, nav_index: 100 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: null },
  );
  const shallow = out.find((c) => c.chunk_id === 1)!;
  const deep = out.find((c) => c.chunk_id === 2)!;
  assert.ok(shallow.final_score > deep.final_score, 'lower nav_index ranks higher');
});

test('rerank: title_match_boost +0.30 when query contains page_title (word-aligned)', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'home-assistant', page_title: 'Home Assistant', rrf_score: 0.04, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'mattermost', page_title: 'Mattermost', rrf_score: 0.045, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'How do I integrate Home Assistant?' },
  );
  const ha = out.find((c) => c.chunk_id === 1)!;
  const mm = out.find((c) => c.chunk_id === 2)!;
  // ha: 0.04 × (1+0.3 lang+0.3 title+~0 nav) = 0.064
  // mm: 0.045 × (1+0.3 lang) = 0.0585  → ha wins
  assert.ok(ha.final_score > mm.final_score, 'title-matched chunk wins despite lower rrf');
});

test('rerank: title_match_boost suppressed when longer matched title contains shorter', () => {
  // Both "Installation" and "Installation on Termux" appear in query;
  // only the longer-titled page should keep the boost.
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'install', page_title: 'Installation', rrf_score: 0.10, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'install-termux', page_title: 'Installation on Termux', rrf_score: 0.10, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'tell me about Installation on Termux please' },
  );
  const generic = out.find((c) => c.chunk_id === 1)!;
  const specific = out.find((c) => c.chunk_id === 2)!;
  assert.ok(specific.final_score > generic.final_score, 'specific (longer) title wins, generic suppressed');
});

// entity_match_boost: chunks whose page_id or page_title contains a known
// entity term get a +0.20 boost. This rescues compare-style queries where
// the verb (`compare`/`vs`) dominates vector ranking and entity-specific
// pages would otherwise drop below the prompt-context cap.
test('rerank: entity_match_boost +0.20 when chunk.page_id matches entity term', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'checkpoints', page_title: 'Filesystem Checkpoints', rrf_score: 0.05, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'random-page', page_title: 'Other Topic', rrf_score: 0.05, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'compare sessions and checkpoints', entityTerms: ['sessions', 'checkpoints'] },
  );
  const ckpt = out.find((c) => c.chunk_id === 1)!;
  const other = out.find((c) => c.chunk_id === 2)!;
  assert.ok(ckpt.final_score > other.final_score, 'entity-matched page wins');
});

test('rerank: entity_match_boost off when entityTerms not provided', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'checkpoints', page_title: 'Checkpoints', rrf_score: 0.05, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'random', page_title: 'Random', rrf_score: 0.05, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'something unrelated' },
  );
  // No entity terms → no entity boost; final_scores equal modulo nav_index_boost.
  const ckpt = out.find((c) => c.chunk_id === 1)!;
  const random = out.find((c) => c.chunk_id === 2)!;
  assert.equal(ckpt.final_score, random.final_score);
});

test('rerank: title_match_boost skipped for titles below min length', () => {
  // Title "TTS" (3 chars) is below TITLE_MATCH_MIN_LEN; no boost even on exact match.
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, page_id: 'tts', page_title: 'TTS', rrf_score: 0.05, nav_index: 1000 }),
      fakeRetrieved({ chunk_id: 2, page_id: 'voice', page_title: 'Voice', rrf_score: 0.05, nav_index: 1000 }),
    ],
    { queryLang: 'en', currentSubtreeRoot: null, query: 'how does TTS work' },
  );
  const tts = out.find((c) => c.chunk_id === 1)!;
  const voice = out.find((c) => c.chunk_id === 2)!;
  // No title-match boost on either; final_scores tie or differ only on lang_boost.
  assert.equal(tts.final_score, voice.final_score, 'short titles get no title boost');
});

// Singular/plural tolerance in title matching — query types "tool" but the
// title is "Tools Runtime" (or vice versa). Both directions should match.
// Regression for codex clarify follow-up: `tool` query failed to title-match
// `Tools Runtime` so the title-match tiebreaker never fired.
test('computeTitleMatches: query singular hits title plural via trailing -s', () => {
  const out = computeTitleMatches(
    [fakeRetrieved({ chunk_id: 1, page_id: 'tools-runtime', page_title: 'Tools Runtime' })],
    'how do I create a custom tool safely?',
  );
  assert.ok(out.has('tools-runtime'), 'expected `tool` query to match `Tools Runtime` title');
});

test('computeTitleMatches: query plural hits title singular via trailing -s', () => {
  const out = computeTitleMatches(
    [fakeRetrieved({ chunk_id: 1, page_id: 'session', page_title: 'Session Management' })],
    'how do sessions work?',
  );
  assert.ok(out.has('session'));
});

// Regression for codex codeGroup clarify case. Query `codeGroup` (camelCase,
// no whitespace) used to be opaque to word-boundary matching, so it never
// aligned with "Code Blocks and Code Groups". Normalizing the query by
// splitting on case boundaries lets `code` and `groups` words hit naturally.
test('computeTitleMatches: camelCase query token splits before word-boundary match', () => {
  const out = computeTitleMatches(
    [fakeRetrieved({ chunk_id: 1, page_id: 'code-blocks', page_title: 'Code Blocks and Code Groups' })],
    'does the Markdown conversion path support codeGroup?',
  );
  assert.ok(out.has('code-blocks'), 'expected `codeGroup` query to title-match `Code Blocks and Code Groups`');
});

test('rerank: sorted descending by final_score', () => {
  const out = rerank(
    [
      fakeRetrieved({ chunk_id: 1, rrf_score: 0.05 }),
      fakeRetrieved({ chunk_id: 2, rrf_score: 0.20 }),
      fakeRetrieved({ chunk_id: 3, rrf_score: 0.10 }),
    ],
    { queryLang: 'zh', currentSubtreeRoot: null, query: '' },
  );
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1]!.final_score >= out[i]!.final_score);
  }
});

// ---------------------------------------------------------------------------
// aggregate.ts
// ---------------------------------------------------------------------------

function fakeReranked(over: Partial<RerankedChunk> = {}): RerankedChunk {
  return { ...fakeRetrieved(), final_score: 0.1, ...over };
}

test('aggregate: empty input -> translate-fallback (no signal)', () => {
  const out = aggregate([], { queryLang: 'zh' });
  assert.equal(out.kind, 'translate-fallback');
});

test('aggregate: same-lang dominant subtree (≥0.55 share) -> answer-same-lang', () => {
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 2, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 3, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 4, lang: 'zh', subtree_root: 'B', rrf_score: 0.1, final_score: 0.5 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'answer-same-lang');
  if (out.kind === 'answer-same-lang') {
    assert.equal(out.dominantSubtree, 'A');
    // pick = sameLang (all same-lang chunks from top-K, across all subtrees).
    assert.equal(out.pick.length, 4);
  }
});

test('aggregate: same-lang split with Δ<0.25 -> answer from the leading subtree', () => {
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 2, lang: 'zh', subtree_root: 'B', rrf_score: 0.1, final_score: 1.0 }),
      fakeReranked({ chunk_id: 3, lang: 'zh', subtree_root: 'A', rrf_score: 0.1, final_score: 0.5 }),
      fakeReranked({ chunk_id: 4, lang: 'zh', subtree_root: 'B', rrf_score: 0.1, final_score: 0.5 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'answer-same-lang');
  if (out.kind === 'answer-same-lang') {
    assert.equal(out.dominantSubtree, 'A');
    assert.equal(out.pick.length, 4);
  }
});

test('aggregate: same-lang max RRF below floor -> translate-fallback', () => {
  // sameLang non-empty, but maxRrf 0.005 < SAME_LANG_FLOOR_RRF (0.01).
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'zh', rrf_score: 0.005 }),
      fakeReranked({ chunk_id: 2, lang: 'en', rrf_score: 0.5 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'translate-fallback');
});

test('aggregate: only en chunks for a zh query -> translate-fallback (PRD §8 #11)', () => {
  const out = aggregate(
    [
      fakeReranked({ chunk_id: 1, lang: 'en', rrf_score: 0.2 }),
      fakeReranked({ chunk_id: 2, lang: 'en', rrf_score: 0.15 }),
    ],
    { queryLang: 'zh' },
  );
  assert.equal(out.kind, 'translate-fallback');
});


// ---------------------------------------------------------------------------
// postprocess.ts
// ---------------------------------------------------------------------------

test('postprocess: legal citation markers survive; illegal ones stripped', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'JWT auth detail', page_title: 'Auth', breadcrumb: [{ id: 'p', title: 'Auth', type: 'page' }] })],
  ]);
  const out = postprocess({
    answerLang: 'zh',
    rawAnswer: '使用 JWT 鉴权 [cit_1] 而不是 [cit_99].',
    chunkById,
  });
  assert.match(out.answer_md, /\[cit_1\]/);
  assert.doesNotMatch(out.answer_md, /\[cit_99\]/);
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0]!.citation_id, 'cit_1');
  assert.equal(out.used_chunks, 1);
});

test('postprocess: source_lang filled only when chunk.lang != answer_lang', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ lang: 'zh' })],
    ['cit_2', fakeReranked({ chunk_id: 2, lang: 'en' })],
  ]);
  const out = postprocess({
    answerLang: 'zh',
    rawAnswer: 'A [cit_1] B [cit_2]',
    chunkById,
  });
  const c1 = out.citations.find((c) => c.citation_id === 'cit_1')!;
  const c2 = out.citations.find((c) => c.citation_id === 'cit_2')!;
  assert.equal(c1.source_lang, null);
  assert.equal(c2.source_lang, 'en');
});

test('postprocess: hallucinated inline-code identifier marked with ⚠', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'real identifier: getUser' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Use `getUser` and `madeUpFn` [cit_1]',
    chunkById,
  });
  assert.match(out.answer_md, /`getUser`/);            // present in context — kept clean
  assert.match(out.answer_md, /`madeUpFn⚠`/);          // not in context — flagged
});

// Regression for codex eval round-2 false-positives. The hallucination filter
// used to ⚠ legitimate technical identifiers (file paths, JSON file names,
// deeply-dotted config keys) when the chunk mentioned them with different
// separators or in surrounding prose. The softened-match exemption now
// recognises them as legitimate.
test('postprocess: file paths / JSON file names not ⚠ when chunk references them with prose separators', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      // Chunk talks about the same identifiers but with different separators
      // / surrounding prose — exactly the case where the old filter misfired.
      fakeReranked({
        text:
          'The openapi index lives at openapi index.json. Manifest is in imports manifest.json. ' +
          'The branding is configured via site theme branding key. Tools register in mcp pages.json. ' +
          'Search uses the search index.json file in the build output.',
      }),
    ],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'See `openapi/index.json`, `imports/manifest.json`, `site.theme.branding`, ' +
      '`mcp/pages.json`, and `search-index.json` [cit_1]',
    chunkById,
  });
  // None of these should carry the ⚠ marker — they're shaped like paths or
  // deeply-dotted config keys and the softened haystack contains them.
  assert.doesNotMatch(out.answer_md, /⚠/, `unexpected ⚠ in: ${out.answer_md}`);
});

// Scope-of-guard note: file-extension shapes, URLs, loopback endpoints,
// well-known no-ext files, AND dotted config keys (e.g. `site.theme.id`,
// `build.outputDir`) are all direct-allow regardless of haystack. The eval
// rounds showed that requiring haystack proof for every "shaped-like-tech"
// identifier produced too many false positives — we accept letting an
// occasional fabricated config key through (readers can verify against the
// docs anyway) in exchange for never polluting a legitimate one. The check
// that remains teeth-bearing is on plain single-token identifiers that
// don't match any of those shapes.

// Regression from local dogfood (codex round-3 follow-up): when the user
// asks "what's in `imports/manifest.json`?" and the docs DON'T mention that
// file, the LLM commonly replies "the context does not describe
// `imports/manifest.json`". The identifier is technically absent from any
// chunk, but it came verbatim from the user's question — flagging it as a
// hallucination misleads the user into thinking the answer itself is broken.
// Solution: the question is a trusted source alongside chunk text.
test('postprocess: identifier repeated from the user question is not ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'docs about anydocs.config.json and other unrelated topics' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    question: 'What is in imports/manifest.json? Is it required for the build?',
    rawAnswer:
      'The provided context does not describe `imports/manifest.json` at all [cit_1].',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Counter-test for the question-as-trusted-source rule: an identifier that
// appears NEITHER in chunks NOR in the question, AND is shaped as a generic
// code identifier (not a file extension / URL / loopback), must still be ⚠'d.
test('postprocess: generic identifier absent from both chunks and question still ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated content' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    question: 'How do I configure the system?',
    rawAnswer: 'You can call `definitelyHallucinatedFunction` to do it [cit_1].',
    chunkById,
  });
  assert.match(out.answer_md, /`definitelyHallucinatedFunction⚠`/);
});

// Regression for codex round-3 follow-up: `anydocs.config.json` and similar
// file-extensioned identifiers are now direct-allow (no haystack required).
// Previously chunks had to reference the literal filename verbatim, which
// failed often enough that legitimate config-file mentions polluted answers.
test('postprocess: filename-with-extension is exempt from ⚠ regardless of haystack', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'this chunk does not mention the file' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'See `anydocs.config.json`, `package.json`, `Dockerfile`, and `.env` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Regression for codex eval round-6: when the LLM accidentally wraps a
// table-cell description (a prose sentence) in backticks, the hallucination
// filter should not run on it. Otherwise descriptive copy gets ⚠'d at the
// sentence tail, polluting answers that are otherwise faithful to chunks.
test('postprocess: prose sentence wrapped in backticks is not ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'table of theme fields and their semantics' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'The fields are described as:\n' +
      '- `Theme identifier. Currently "classic-docs" is the standard theme.` [cit_1]\n' +
      '- `Site title shown in the browser tab and site header.` [cit_1]\n' +
      '- `Syntax highlighting theme for code blocks...` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Regression for codex round-8 dogfood: LLMs sometimes wrap a JSON / YAML
// key/value snippet in inline backticks (a formatting accident — should be a
// fenced code block) and the hallucination filter then ⚠'s the snippet
// because the literal whitespace/quote layout doesn't match the haystack
// verbatim. Snippets with a `:` / `=` followed by a quoted value are now
// recognized as data slices and exempted.
// Bare quoted string literals like `"API Reference"` or `'My Documentation'`
// are example values pulled from a doc, not code identifiers. With internal
// whitespace they can't be hallucinated identifier names, so exempt them
// before the haystack check. Without this guard, LLMs that backticked
// example label strings produced ⚠'d output even when the value came
// straight from the docs.
test('postprocess: bare quoted string with whitespace is not ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated chunk' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Common values are `"API Reference"`, `"User Guide"`, and `\'My Documentation\'` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

test('postprocess: JSON-like key/value snippet wrapped in backticks is not ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'config-reference example' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Configure like so:\n' +
      '- `siteTitle": "My Documentation"` [cit_1]\n' +
      '- `outputDir: "./dist"` [cit_1]\n' +
      '- `enabled = true` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Counter-test: short, identifier-shaped strings are still subject to the
// hallucination check (the prose exemption only kicks in for whitespace +
// sentence-ending punctuation + length).
test('postprocess: identifier-looking string (no sentence punctuation) still ⚠ when absent', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'real identifier: getUser' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Use `madeUpFn` to do it [cit_1]',
    chunkById,
  });
  assert.match(out.answer_md, /`madeUpFn⚠`/);
});

// LLMs often wrap JSON-style config keys in double quotes
// (`"site.theme.id"`). Codex round-5 flagged this — the quoted form was
// failing every shape check and getting ⚠'d. The fix strips surrounding
// quote/backtick characters before all whitelist + haystack lookups.
test('postprocess: quoted dotted config key matches as if unquoted', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      fakeReranked({
        text:
          'You configure site.theme.id, site.theme.branding.siteTitle, and site.theme.codeTheme in anydocs.config.json.',
      }),
    ],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Set `"site.theme.id"`, `"site.theme.branding.siteTitle"`, and `"site.theme.codeTheme"` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Counter-test for the quote-strip normalization: the strip itself is just
// equivalence — quoted/unquoted dotted keys take the same code path. With
// dotted-config-key direct-allow above, neither form is ⚠'d regardless of
// haystack. The single-segment fabricated-identifier counter-test (above)
// is what proves the filter still has teeth.

// Dotted config keys (2+ segments, segments ≥2 chars, lowercase/camelCase)
// are direct-allow regardless of haystack. Regression: `site.theme.id`
// reappeared with ⚠ when the relevant chunk wasn't in the prompt — the
// softened-haystack lookup failed because the chunk that has the literal
// string wasn't retrieved. Direct allow eliminates that brittleness.
test('postprocess: dotted config-key (≥2 segments) is direct-allow', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated content about authentication' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Set `site.theme.id`, `build.outputDir`, and `app.feature.enabled` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Directory paths with trailing slash (`dist/imports/`, `pages/en/`, `src/`)
// are direct-allow — docs reference output layouts without naming a
// specific file all the time, and they failed the file-extension rule.
test('postprocess: directory-shaped trailing-slash paths are direct-allow', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Artifacts live under `dist/imports/`, `pages/en/`, and `src/` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Boundary: single-segment fabricated identifiers (no dot, no extension)
// still get ⚠'d. The exemption is for "shaped like a config key", not for
// any inline-code body.
test('postprocess: single-segment fabricated identifier still ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'real identifier: getUser' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Use `definitelyHallucinatedFunction` [cit_1]',
    chunkById,
  });
  assert.match(out.answer_md, /`definitelyHallucinatedFunction⚠`/);
});

// 2-segment dotted config keys (`build.outputDir`, `site.theme.id`) — previous
// rule required ≥3 segments, leaving these polluted. Now allowed as long as
// the softened form shows up somewhere in the haystack.
test('postprocess: 2-segment dotted config key passes when softened-match hits', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      fakeReranked({
        text: 'the build output directory is set via build outputDir in the config',
      }),
    ],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Configure `build.outputDir` to change the destination [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Citation markers (`[cit_3]`) wrapped in backticks by the LLM as a
// formatting quirk should not get ⚠'d. Direct allow.
test('postprocess: backticked citation marker [cit_N] is not ⚠ flagged', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated chunk' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'See `[cit_1]` for details [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// Dash-connected compound names (theme names, npm packages, docker images,
// model ids like `bge-m3`) are direct-allow. Codex round-10 caught
// `blueprint-review` etc. still occasionally ⚠'ing under softened-haystack
// match when the relevant chunk wasn't retrieved. Promote to direct-allow.
test('postprocess: dash-connected compound names are direct-allow', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated chunk' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Themes include `blueprint-review`, `classic-docs`, `atlas-docs`, and the embedder is `bge-m3` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// API / URL paths without a scheme (`/v1/models`, `/api/v2/users`) are
// direct-allow. Codex round-9 caught Hermes API docs ⚠'ing these because
// the `://` URL_SCHEME_RE branch needed a full scheme.
test('postprocess: leading-slash API paths are direct-allow', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'unrelated chunk' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Call `/v1/models`, `/api/v2/users`, and `/health/ready` to verify [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

test('postprocess: HTTP method plus API path is direct-allow', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'HTTP Request POST /api/v2/checkout' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'Call `POST /api/v2/checkout` to create the order [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

// New whitelist class: URLs / loopback endpoints are direct-allow regardless
// of haystack. Codex eval round-3 explicitly called out the need so that
// `localhost:3100`, `https://example.com`, etc. are never ⚠'d.
test('postprocess: URLs and loopback endpoints are exempt from ⚠', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ text: 'configuration documentation' })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer:
      'Run on `localhost:3100` and `127.0.0.1:8080`; the docs live at `https://example.com/docs` [cit_1]',
    chunkById,
  });
  assert.doesNotMatch(out.answer_md, /⚠/);
});

test('postprocess: citation URL appends heading anchor when in_page_path encodes one', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      fakeReranked({
        in_page_path: 'bearer-token/p[1]',
        page_url: '/frontend/auth',
      }),
    ],
  ]);
  const out = postprocess({ answerLang: 'zh', rawAnswer: '... [cit_1]', chunkById });
  assert.equal(out.citations[0]!.url, '/frontend/auth#bearer-token');
});

test('postprocess: OpenAPI synthetic citations keep operation-level URL', () => {
  const chunkById = new Map<string, RerankedChunk>([
    [
      'cit_1',
      fakeReranked({
        page_id: 'api-payment-engine-api-post-api-v2-order-info',
        page_url: '/zh/reference/payment-engine-api/post-api-v2-order-info',
        in_page_path: 'response-fields/p[1]',
      }),
    ],
  ]);
  const out = postprocess({ answerLang: 'zh', rawAnswer: '... [cit_1]', chunkById });
  assert.equal(out.citations[0]!.url, '/zh/reference/payment-engine-api/post-api-v2-order-info#response-fields');
});

test('postprocess: cit_N markers renumbered to 1..K matching citations[] order', () => {
  // Prompt put 5 chunks in chunkById; LLM cited cit_4, cit_5, cit_4 (out of order
  // and with a duplicate). Output must have cit_1, cit_2 and citations[0/1].
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ chunk_id: 11 })],
    ['cit_2', fakeReranked({ chunk_id: 22 })],
    ['cit_3', fakeReranked({ chunk_id: 33 })],
    ['cit_4', fakeReranked({ chunk_id: 44 })],
    ['cit_5', fakeReranked({ chunk_id: 55 })],
  ]);
  const out = postprocess({
    answerLang: 'en',
    rawAnswer: 'See [cit_4] and [cit_5] but not [cit_4] again.',
    chunkById,
  });
  assert.match(out.answer_md, /\[cit_1\]/);
  assert.match(out.answer_md, /\[cit_2\]/);
  assert.doesNotMatch(out.answer_md, /\[cit_4\]/);
  assert.doesNotMatch(out.answer_md, /\[cit_5\]/);
  assert.equal(out.citations.length, 2);
  assert.equal(out.citations[0]!.citation_id, 'cit_1');
  assert.equal(out.citations[0]!.chunk_id, 44);
  assert.equal(out.citations[1]!.citation_id, 'cit_2');
  assert.equal(out.citations[1]!.chunk_id, 55);
});

test('postprocess: chunk_id propagates from RerankedChunk into Citation', () => {
  const chunkById = new Map<string, RerankedChunk>([
    ['cit_1', fakeReranked({ chunk_id: 7 })],
  ]);
  const out = postprocess({ answerLang: 'zh', rawAnswer: 'X [cit_1]', chunkById });
  assert.equal(out.citations[0]!.chunk_id, 7);
});

test('postprocess: truncation appends locale-specific notice', () => {
  const long = 'X'.repeat(5000);
  const out = postprocess({
    answerLang: 'zh',
    rawAnswer: `${long} [cit_1]`,
    chunkById: new Map([['cit_1', fakeReranked()]]),
  });
  assert.ok(out.answer_md.length <= 4000);
  assert.match(out.answer_md, /答案过长已截断/);
});

// ---------------------------------------------------------------------------
// RFC 0003 M2 — multi-turn system constraints + history block
// ---------------------------------------------------------------------------

function fakeChunkForPromptTest() {
  return {
    ...fakeRetrieved({
      chunk_id: 1,
      page_id: 'a',
      page_title: '配置',
      text: '系统配置说明。',
      breadcrumb: [{ id: 'a', title: '配置', type: 'section' as const }],
    }),
    final_score: 0.2,
  };
}

test('buildPrompt: no history → no multi-turn block in system, no history block in user (single-turn byte-equivalent)', () => {
  // alpha.0 regression guard: when history is omitted, neither the system
  // prompt (no "对话历史" constraints line) nor the user prompt (no "Qn:"
  // lines) should grow a single byte. Equivalence with the alpha.0
  // single-turn output is what makes the alpha.1 flip safely reversible.
  const prompt = buildPrompt({
    question: '怎么配置？',
    chunks: [fakeChunkForPromptTest()],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
  });
  assert.doesNotMatch(prompt.system, /对话历史/);
  assert.doesNotMatch(prompt.user, /对话历史/);
  assert.doesNotMatch(prompt.user, /Q1:/);
});

test('buildPrompt: empty history array → same as omitted (regression guard)', () => {
  const prompt = buildPrompt({
    question: '怎么配置？',
    chunks: [fakeChunkForPromptTest()],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
    history: [],
  });
  assert.doesNotMatch(prompt.system, /对话历史/);
  assert.doesNotMatch(prompt.user, /Q1:/);
});

test('buildPrompt zh: history populated → all 5 RFC §4.1 constraints in system + numbered Q/A block in user', () => {
  // Verbatim sync with RFC 0003 §4.1 — if any bullet is rephrased here
  // without updating the RFC (or vice-versa), this test fires.
  const prompt = buildPrompt({
    question: '它怎么改？',
    chunks: [fakeChunkForPromptTest()],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
    history: [
      { question: '什么是配置？', answer_summary: '配置是 ...' },
      { question: '配置在哪里？', answer_summary: '在 anydocs.json' },
    ],
  });

  // 5 RFC §4.1 constraints, verbatim.
  assert.match(prompt.system, /对话历史/);
  assert.match(prompt.system, /把当前问题里的指代解析为对话历史中最贴近的具体实体/);
  assert.match(prompt.system, /答案必须基于检索到的 chunks/);
  assert.match(prompt.system, /不要在答案里重述历史里已答过的内容/);
  assert.match(prompt.system, /如果对话历史与当前问题语义无关，忽略历史/);
  assert.match(prompt.system, /答案语言与"当前问题"一致/);

  // User prompt: numbered Q/A block precedes the user question.
  // Header substitutes concrete turn count (2 turns in this test) and the
  // 200-char cap from ANSWER_SUMMARY_MAX_CHARS.
  assert.match(prompt.user, /对话历史（最近 2 轮，每轮答案截断到前 200 字）：/);
  assert.match(prompt.user, /Q1: 什么是配置？/);
  assert.match(prompt.user, /A1: 配置是 \.\.\./);
  assert.match(prompt.user, /Q2: 配置在哪里？/);
  assert.match(prompt.user, /A2: 在 anydocs\.json/);
  // History block must come BEFORE the current question.
  const histIdx = prompt.user.indexOf('对话历史');
  const qIdx = prompt.user.indexOf('它怎么改？');
  assert.ok(histIdx >= 0 && qIdx > histIdx, 'history precedes current question');
});

test('buildPrompt en: history populated → 5 RFC §4.1 constraints rendered in English', () => {
  const prompt = buildPrompt({
    question: 'How do I change it?',
    chunks: [
      {
        ...fakeRetrieved({
          chunk_id: 1,
          lang: 'en',
          page_id: 'a',
          page_title: 'Config',
          text: 'System config notes.',
          breadcrumb: [{ id: 'a', title: 'Config', type: 'section' }],
        }),
        final_score: 0.2,
      },
    ],
    answerLang: 'en',
    isCrossLang: false,
    formatHint: 'paragraph',
    history: [{ question: 'What is config?', answer_summary: 'Config is ...' }],
  });
  assert.match(prompt.system, /Conversation history/);
  assert.match(prompt.system, /Resolve any pronoun/);
  assert.match(prompt.system, /grounded in the retrieved chunks/);
  assert.match(prompt.system, /Do not repeat content already covered/);
  assert.match(prompt.system, /unrelated to the current question, ignore it/);
  assert.match(prompt.system, /answer language must match the current question/);
  // 1-turn history → singular "turn" + concrete cap from ANSWER_SUMMARY_MAX_CHARS.
  assert.match(
    prompt.user,
    /Conversation history \(last 1 turn, each answer truncated to 200 chars\):/,
  );
  assert.match(prompt.user, /Q1: What is config\?/);
  assert.match(prompt.user, /A1: Config is \.\.\./);
});

test('buildPrompt: history turn with empty answer_summary still emits Qn line (clarify/error prior turn)', () => {
  // Prior clarify / error turns persist with answer_md_summary = ''. The
  // question side is still useful for pronoun resolution; the empty A line
  // is harmless context for Claude.
  const prompt = buildPrompt({
    question: '它怎么改？',
    chunks: [fakeChunkForPromptTest()],
    answerLang: 'zh',
    isCrossLang: false,
    formatHint: 'paragraph',
    history: [{ question: '什么是配置？', answer_summary: '' }],
  });
  assert.match(prompt.user, /Q1: 什么是配置？/);
  assert.match(prompt.user, /A1: /);
});
