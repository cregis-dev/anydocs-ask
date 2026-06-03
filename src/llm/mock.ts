/**
 * MockLLM — deterministic LLM stand-in used by tests.
 *
 * The default responder echoes back a tiny markdown answer that cites every
 * `[cit_N]` marker found in the user prompt. That's enough to exercise the
 * citation-legality, lang-fill, and hallucination-filter postprocessing
 * branches without coupling tests to actual LLM behavior.
 *
 * Tests can install a custom responder for branch-specific behavior
 * (e.g. simulate cross-lang fallback by replying in the answer_lang).
 */

import type { LLM, LLMGenerateInput, LLMGenerateOutput, LLMStreamOptions } from './types.ts';

export type MockResponder = (input: LLMGenerateInput) => string | LLMGenerateOutput;

export class MockLLM implements LLM {
  readonly model: string;
  /** Every call observed, in order. Tests assert prompt shape via this. */
  readonly calls: LLMGenerateInput[] = [];
  /** Intent-router calls are tracked separately so answer-path call counts stay stable. */
  readonly routerCalls: LLMGenerateInput[] = [];
  private responder: MockResponder;

  constructor(opts: { model?: string; responder?: MockResponder } = {}) {
    this.model = opts.model ?? 'mock-llm';
    this.responder = opts.responder ?? defaultResponder;
  }

  setResponder(responder: MockResponder): void {
    this.responder = responder;
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    if (input.systemPrompt.includes('ANYDOCS_INTENT_ROUTER_V1')) {
      this.routerCalls.push(input);
      return { text: mockIntentRoute(input.userPrompt), modelUsed: this.model };
    }
    this.calls.push(input);
    const out = this.responder(input);
    if (typeof out === 'string') {
      return { text: out, modelUsed: this.model };
    }
    return out;
  }

  async streamGenerate(
    input: LLMGenerateInput,
    options: LLMStreamOptions,
  ): Promise<LLMGenerateOutput> {
    const out = await this.generate(input);
    for (const chunk of chunkForMockStream(out.text)) {
      if (options.signal?.aborted) break;
      await options.onDelta(chunk);
    }
    return out;
  }
}

function mockIntentRoute(userPrompt: string): string {
  let question = '';
  let historyText = '';
  try {
    const payload = JSON.parse(userPrompt) as {
      question?: unknown;
      history?: Array<{ question?: unknown; answer_summary?: unknown }>;
    };
    question = typeof payload.question === 'string' ? payload.question : '';
    historyText = (payload.history ?? [])
      .map((turn) => `${String(turn.question ?? '')}\n${String(turn.answer_summary ?? '')}`)
      .join('\n');
  } catch {
    question = userPrompt;
  }

  const q = question.toLowerCase();
  const historyLower = historyText.toLowerCase();
  const followUpCheckoutExpiry =
    /过期|有效期|超时|expire|expiration|timeout|valid_time|payment window/i.test(question) &&
    /checkout_url|\/api\/v2\/checkout|valid_time/i.test(historyText) &&
    /^(那|那么|这个|那个|它)|\bit\b|\bthat\b|\bthis\b/i.test(question);
  if (followUpCheckoutExpiry) {
    return JSON.stringify({
      conversation_mode: 'follow_up',
      effective_question: `/api/v2/checkout checkout_url valid_time ${question}`.trim(),
      intent: 'api_reference',
      product: 'payment_engine',
      retrieval: {
        prefer_api_reference: true,
        api_reference_hints: ['checkout checkout_url valid_time', 'POST /api/v2/checkout'],
        supplemental_context_hints: [],
        supplemental_page_ids: [],
        api_versions: ['v2'],
      },
      reason: 'mock checkout expiry follow-up',
    });
  }

  if (/签名|验签|signature|b0001|auth|authentication|鉴权|认证/i.test(question)) {
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'signature_auth',
      product: 'general',
      retrieval: {
        prefer_api_reference: false,
        api_reference_hints: [],
        supplemental_context_hints: ['authentication signature API_KEY MD5 sign empty values lexicographical order'],
        supplemental_page_ids: ['authentication', 'webhook-mechanism'],
        api_versions: [],
      },
      reason: 'mock signature/auth route',
    });
  }

  if (
    /project|项目/.test(q) &&
    /payment engine|waas|支付引擎|出款|提币|提现|payout|withdrawal|withdrawals/i.test(question) &&
    /need|only|also|should|create|separate|prepare|需要|只|是否|应该|同时|创建|准备/i.test(question)
  ) {
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'project_setup',
      product: 'general',
      retrieval: {
        prefer_api_reference: false,
        api_reference_hints: [],
        supplemental_context_hints: ['Payment Engine setup WaaS setup project preparation'],
        supplemental_page_ids: ['payment-engine-setup', 'waas-setup', 'introduction'],
        api_versions: [],
      },
      reason: 'mock project setup route',
    });
  }

  if (
    /\/api\/v2\/checkout|checkout|checkout_url|cregis_id|order_currency|order_amount|valid_time/i.test(question) ||
    /创建.{0,10}订单|订单.{0,10}创建|让用户去付款|支付页|收银台/.test(question) ||
    (/payment engine/i.test(question) && /\border\b/i.test(question) && /usdt|usdc|btc|eth|crypto|fx|priced|denominated|calculated/i.test(question))
  ) {
    const hints = ['checkout checkout_url cregis_id order_currency order_amount', 'POST /api/v2/checkout'];
    if (/valid_time|过期|有效期|超时|expire|expiration|timeout/i.test(question)) {
      hints.unshift('checkout checkout_url valid_time');
    }
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'api_reference',
      product: 'payment_engine',
      retrieval: {
        prefer_api_reference: true,
        api_reference_hints: hints,
        supplemental_context_hints: [],
        supplemental_page_ids: [],
        api_versions: ['v2'],
      },
      reason: 'mock checkout route',
    });
  }

  if (/event_type|data\.status|order info|状态映射|partial_paid|paid_remain/i.test(question)) {
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'api_reference',
      product: 'payment_engine',
      retrieval: {
        prefer_api_reference: true,
        api_reference_hints: ['order info data status event_type', 'POST /api/v2/order/info'],
        supplemental_context_hints: ['支付引擎 业务流程 回调机制 event_type 状态映射 幂等 partial_paid paid_remain'],
        supplemental_page_ids: ['webhook-mechanism', 'pe-business-flow'],
        api_versions: ['v2'],
      },
      reason: 'mock payment status mapping route',
    });
  }

  if (/sub_address_withdrawal|from_address|specific user deposit address|子地址.{0,16}(出款|提币|提现)/i.test(question)) {
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'api_reference',
      product: 'waas',
      retrieval: {
        prefer_api_reference: true,
        api_reference_hints: ['api v1 sub_address_withdrawal from_address to_address third_party_id'],
        supplemental_context_hints: [],
        supplemental_page_ids: [],
        api_versions: ['v1'],
      },
      reason: 'mock sub-address withdrawal route',
    });
  }

  if (/sub_address_balance|子地址.{0,16}余额|余额.{0,16}子地址/i.test(question)) {
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'api_reference',
      product: 'waas',
      retrieval: {
        prefer_api_reference: true,
        api_reference_hints: ['api v1 sub_address_balance address currency chain_id token_id'],
        supplemental_context_hints: [],
        supplemental_page_ids: [],
        api_versions: ['v1'],
      },
      reason: 'mock sub-address balance route',
    });
  }

  if (/payout|withdraw|withdrawal|出款|提币|提现/i.test(question)) {
    const hints = ['api v1 payout cid callback'];
    if (/query|查询|状态|终态|最终/i.test(question)) hints.push('api v1 payout query');
    if (/coins|token|chain_id|token_id|currency|币种|代币/i.test(question)) {
      hints.unshift('api v1 coins chain_id token_id currency');
    }
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'waas_payout',
      product: 'waas',
      retrieval: {
        prefer_api_reference: true,
        api_reference_hints: hints,
        supplemental_context_hints: [],
        supplemental_page_ids: [],
        api_versions: ['v1'],
      },
      reason: 'mock waas payout route',
    });
  }

  if (
    /chain_id|token_id|supported[-_\s]?tokens?|测试网|测试代币|开发环境|production|testnet|币种|代币/i.test(question)
  ) {
    return JSON.stringify({
      conversation_mode: 'standalone',
      effective_question: question,
      intent: 'tokens_currencies',
      product: q.includes('payment') || question.includes('支付引擎') ? 'payment_engine' : 'waas',
      retrieval: {
        prefer_api_reference: true,
        api_reference_hints: ['api v1 coins chain_id token_id currency'],
        supplemental_context_hints: ['测试代币 开发环境 testnet tokens development environments'],
        supplemental_page_ids: ['sdk-overview'],
        api_versions: ['v1'],
      },
      reason: 'mock token route',
    });
  }

  return JSON.stringify({
    conversation_mode: historyLower && /^(那|那么|这个|那个|它)|\bit\b|\bthat\b|\bthis\b/i.test(question)
      ? 'follow_up'
      : 'standalone',
    effective_question: question,
    intent: 'general_docs',
    product: 'unknown',
    retrieval: {
      prefer_api_reference: false,
      api_reference_hints: [],
      supplemental_context_hints: [],
      supplemental_page_ids: [],
      api_versions: [],
    },
    reason: 'mock general route',
  });
}

/**
 * Default mock: pull every `[cit_N]` marker from the user prompt and emit a
 * trivial answer that references them all. Output is intentionally short
 * and stable so tests can reason about it.
 */
function defaultResponder(input: LLMGenerateInput): string {
  const markers = Array.from(new Set(input.userPrompt.match(/\[cit_\d+\]/g) ?? []));
  if (markers.length === 0) {
    return 'No relevant context found.';
  }
  return `Based on the documentation: ${markers.join(' ')}`;
}

function chunkForMockStream(text: string): string[] {
  const parts = text.match(/\S+\s*/g);
  return parts && parts.length > 0 ? parts : text.length > 0 ? [text] : [];
}
