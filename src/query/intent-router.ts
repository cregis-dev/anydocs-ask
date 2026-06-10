import type { DocsLang } from '../anydocs/types.ts';
import type { LLM } from '../llm/types.ts';

export type IntentRouterTurn = {
  question: string;
  answer_summary: string;
};

export type IntentName =
  | 'greeting'
  | 'api_reference'
  | 'signature_auth'
  | 'webhook_status'
  | 'payment_flow'
  | 'waas_payout'
  | 'project_setup'
  | 'tokens_currencies'
  | 'error_troubleshooting'
  | 'general_docs';

export type IntentProduct = 'payment_engine' | 'waas' | 'general' | 'unknown';

export type IntentRoute = {
  originalQuestion: string;
  effectiveQuestion: string;
  usesHistory: boolean;
  rewritten: boolean;
  intent: IntentName;
  product: IntentProduct;
  apiIntent: boolean;
  signatureAuthIntent: boolean;
  projectSetupIntent: boolean;
  apiReferenceHints: string[];
  supplementalContextHints: string[];
  supplementalPageIds: string[];
  apiReferenceVersionPrefs: string[];
  reason: string | null;
};

export type IntentRouterArgs = {
  question: string;
  lang: DocsLang;
  history?: IntentRouterTurn[];
};

export interface IntentRouter {
  route(args: IntentRouterArgs): Promise<IntentRoute>;
}

const ROUTER_SYSTEM_PROMPT = `ANYDOCS_INTENT_ROUTER_V1
You route documentation questions before retrieval. Return JSON only, no markdown.

Decide semantically. Do not use the presence of chat history by itself as proof
that the new question is a follow-up. Use history only when the current question
depends on pronouns, ellipsis, "above/previous", or omitted nouns.

Output this exact JSON shape:
{
  "conversation_mode": "standalone" | "follow_up",
  "effective_question": "standalone retrieval query in the user's language, preserving API paths and identifiers",
  "intent": "greeting" | "api_reference" | "signature_auth" | "webhook_status" | "payment_flow" | "waas_payout" | "project_setup" | "tokens_currencies" | "error_troubleshooting" | "general_docs",
  "product": "payment_engine" | "waas" | "general" | "unknown",
  "retrieval": {
    "prefer_api_reference": boolean,
    "api_reference_hints": ["short exact endpoint/field/status search hints"],
    "supplemental_context_hints": ["short non-API support-page search hints"],
    "supplemental_page_ids": ["known page ids when highly relevant"],
    "api_versions": ["v1" | "v2" | "v3"]
  },
  "reason": "short operator-facing reason"
}

Guidance:
- API reference questions ask about endpoint paths, request/response fields,
  status fields, parameters, payloads, or exact operations.
- Signature/authentication questions should usually prefer guide context, not
  API reference, unless the user asks about a specific endpoint field.
- For Payment Engine checkout/order creation, useful API hints include
  "checkout", "checkout_url", "cregis_id", "valid_time",
  "order_currency", "order_amount", and "POST /api/v2/checkout".
- For Payment Engine order status mapping, useful API hints include
  "order info", "data.status", "event_type", and "POST /api/v2/order/info".
- For WaaS payout, useful API hints include "payout", "cid",
  "third_party_id", "POST /api/v1/payout", and "POST /api/v1/payout/query".
- For token identifier questions, useful hints include "coins", "chain_id",
  "token_id", and "currency".
- Prefer these known support pages in supplemental_page_ids when relevant:
  authentication, webhook-mechanism, error-codes, sdk-overview, introduction,
  payment-engine-setup, payment-engine-quickstart-30min, pe-business-flow,
  supported-currencies, waas-setup, waas-quickstart-30min, business-flow,
  supported-tokens, environment.
- Webhook/callback success, localhost, and callback_url questions should
  usually prefer support pages, not API reference.
- Error-code triage questions should usually prefer error-codes plus
  authentication/setup pages, not API reference, unless a concrete endpoint
  path is named.
- SDK/language choice questions should prefer sdk-overview plus
  authentication/setup pages, not API reference.
- Specific WaaS withdrawal from a user deposit address/from_address should use
  the /api/v1/sub_address_withdrawal hint, not the generic /api/v1/payout
  hint.
- If the current question is standalone, effective_question must not include
  unrelated prior-turn terms.`;

const DEFAULT_SUPPLEMENTAL_PAGE_IDS: Record<IntentName, string[]> = {
  greeting: [],
  api_reference: [],
  signature_auth: ['authentication', 'webhook-mechanism'],
  webhook_status: ['webhook-mechanism', 'waas-quickstart-30min', 'payment-engine-quickstart-30min'],
  payment_flow: ['payment-engine-quickstart-30min', 'pe-business-flow', 'supported-currencies'],
  waas_payout: ['waas-quickstart-30min', 'business-flow', 'supported-tokens'],
  project_setup: ['introduction', 'payment-engine-setup', 'waas-setup', 'environment'],
  tokens_currencies: ['supported-tokens', 'supported-currencies'],
  error_troubleshooting: ['error-codes', 'authentication', 'waas-setup', 'payment-engine-setup'],
  general_docs: [],
};

export class LLMIntentRouter implements IntentRouter {
  private readonly llm: LLM;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  async route(args: IntentRouterArgs): Promise<IntentRoute> {
    const question = args.question.trim();
    if (!question) return fallbackRoute(question);

    let raw: string;
    try {
      const out = await this.llm.generate({
        systemPrompt: ROUTER_SYSTEM_PROMPT,
        userPrompt: JSON.stringify({
          question,
          lang: args.lang,
          history: (args.history ?? []).slice(-3),
        }),
        temperature: 0,
        maxTokens: 700,
      });
      raw = out.text;
    } catch {
      return fallbackRoute(question);
    }

    const parsed = parseRouterJson(raw);
    if (!parsed) return fallbackRoute(question);
    return normalizeRoute(question, parsed, args.history ?? []);
  }
}

export function fallbackRoute(question: string): IntentRoute {
  return {
    originalQuestion: question,
    effectiveQuestion: question,
    usesHistory: false,
    rewritten: false,
    intent: 'general_docs',
    product: 'unknown',
    apiIntent: false,
    signatureAuthIntent: false,
    projectSetupIntent: false,
    apiReferenceHints: [],
    supplementalContextHints: [],
    supplementalPageIds: [],
    apiReferenceVersionPrefs: [],
    reason: 'router_fallback',
  };
}

type RawRoute = {
  conversation_mode?: unknown;
  effective_question?: unknown;
  intent?: unknown;
  product?: unknown;
  retrieval?: {
    prefer_api_reference?: unknown;
    api_reference_hints?: unknown;
    supplemental_context_hints?: unknown;
    supplemental_page_ids?: unknown;
    api_versions?: unknown;
  };
  reason?: unknown;
};

function parseRouterJson(text: string): RawRoute | null {
  const trimmed = text.trim();
  const json = trimmed.startsWith('{')
    ? trimmed
    : trimmed.match(/\{[\s\S]*\}/)?.[0] ?? '';
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RawRoute;
  } catch {
    return null;
  }
}

function normalizeRoute(
  question: string,
  raw: RawRoute,
  history: IntentRouterTurn[],
): IntentRoute {
  const intent = normalizeIntent(raw.intent);
  const usesHistory = raw.conversation_mode === 'follow_up' && history.length > 0;
  const rawEffective = typeof raw.effective_question === 'string' ? raw.effective_question.trim() : '';
  const effectiveQuestion = rawEffective.length > 0 ? rawEffective : question;
  const retrieval = raw.retrieval ?? {};
  const initialApiReferenceHints = cleanList(retrieval.api_reference_hints, 8, 96);
  const supplementalContextHints = cleanList(retrieval.supplemental_context_hints, 6, 120);
  const product = inferProduct(
    question,
    effectiveQuestion,
    intent,
    normalizeProduct(raw.product),
    initialApiReferenceHints,
    supplementalContextHints,
  );
  // When the user literally types an API endpoint path in the question
  // (e.g. "for a WaaS `/api/v1/payout` request …"), that is an unambiguous
  // API-reference signal. The LLM router sometimes buckets such queries'
  // hints into supplemental_context_hints and leaves api_reference_hints
  // empty, which keeps apiIntent=false and skips reference-citation injection.
  // Promote explicit endpoints from the question text so the deterministic
  // gate doesn't depend on the LLM remembering to fill the right bucket.
  const questionEndpointHints = extractEndpointHintsFromQuestion(question, effectiveQuestion);
  const apiReferenceHints = normalizeApiReferenceHints(
    intent,
    product,
    [...questionEndpointHints, ...initialApiReferenceHints],
    supplementalContextHints,
  );
  const inferredSupplementalPageIds = inferSupplementalPageIds(
    intent,
    product,
    question,
    effectiveQuestion,
    apiReferenceHints,
    supplementalContextHints,
  );
  const supplementalPageIds = mergeSupplementalPageIds(
    cleanList(retrieval.supplemental_page_ids, 6, 80)
      .filter((id) => /^[A-Za-z0-9_.:-]+$/.test(id)),
    [
      ...inferredSupplementalPageIds,
      ...defaultSupplementalPageIds(intent, product),
    ],
  );
  const apiReferenceVersionPrefs = cleanList(retrieval.api_versions, 3, 8)
    .map((v) => v.toLowerCase())
    .filter((v) => /^v[0-9]+$/.test(v));
  const preferApiReference = retrieval.prefer_api_reference === true;
  const hasEndpointHint = apiReferenceHints.some(hasApiEndpointHint);
  const hasApiFieldHint = apiReferenceHints.some(hasApiFieldHintForIntent);
  const apiIntent =
    intent === 'api_reference' ||
    (intent === 'signature_auth' && hasEndpointHint) ||
    (intent === 'webhook_status' && hasEndpointHint) ||
    (intent === 'payment_flow' && (preferApiReference || hasEndpointHint || hasApiFieldHint)) ||
    (intent === 'waas_payout' && (preferApiReference || hasEndpointHint || hasApiFieldHint)) ||
    (intent === 'tokens_currencies' && (preferApiReference || hasEndpointHint || hasApiFieldHint));

  return {
    originalQuestion: question,
    effectiveQuestion,
    usesHistory,
    rewritten: effectiveQuestion !== question,
    intent,
    product,
    apiIntent,
    signatureAuthIntent: intent === 'signature_auth',
    projectSetupIntent: intent === 'project_setup',
    apiReferenceHints,
    supplementalContextHints,
    supplementalPageIds,
    apiReferenceVersionPrefs: [...new Set(apiReferenceVersionPrefs)],
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 160) : null,
  };
}

function normalizeIntent(value: unknown): IntentName {
  const v = typeof value === 'string' ? value : '';
  switch (v) {
    case 'greeting':
    case 'api_reference':
    case 'signature_auth':
    case 'webhook_status':
    case 'payment_flow':
    case 'waas_payout':
    case 'project_setup':
    case 'tokens_currencies':
    case 'error_troubleshooting':
    case 'general_docs':
      return v;
    default:
      return 'general_docs';
  }
}

function normalizeProduct(value: unknown): IntentProduct {
  const v = typeof value === 'string' ? value : '';
  switch (v) {
    case 'payment_engine':
    case 'waas':
    case 'general':
    case 'unknown':
      return v;
    default:
      return 'unknown';
  }
}

function inferProduct(
  question: string,
  effectiveQuestion: string,
  intent: IntentName,
  product: IntentProduct,
  apiHints: string[],
  supplementalHints: string[],
): IntentProduct {
  if (product === 'payment_engine' || product === 'waas') return product;
  const haystack = [
    question,
    effectiveQuestion,
    ...apiHints,
    ...supplementalHints,
  ].join(' ').toLowerCase();
  const mentionsPaymentEngine =
    /payment engine|支付引擎|checkout_url|cregis_id|order_currency|order_amount|hosted checkout|托管收银台|收银台/.test(haystack) ||
    (intent === 'payment_flow' && /checkout|order|订单|付款|支付/.test(haystack));
  const mentionsWaas =
    /\bwaas\b|payout|withdrawal|withdraw|sub[-_ ]?address|from_address|to_address|chain_id|token_id|trc20|erc20|polygon|bep20|coins|钱包|出款|提币|子地址|链|网络/.test(haystack) ||
    intent === 'waas_payout';

  if (intent === 'project_setup' && mentionsPaymentEngine && mentionsWaas) return 'general';
  if (intent === 'tokens_currencies' && mentionsWaas && !mentionsPaymentEngine) return 'waas';
  if (mentionsPaymentEngine && !mentionsWaas) return 'payment_engine';
  if (mentionsWaas && !mentionsPaymentEngine) return 'waas';
  if (intent === 'payment_flow') return 'payment_engine';
  if (intent === 'waas_payout') return 'waas';
  return product;
}

function defaultSupplementalPageIds(intent: IntentName, product: IntentProduct): string[] {
  if (intent === 'signature_auth') {
    return ['authentication', 'webhook-mechanism'];
  }
  if (intent === 'webhook_status') {
    if (product === 'payment_engine') return ['webhook-mechanism', 'payment-engine-quickstart-30min', 'pe-business-flow'];
    if (product === 'waas') return ['webhook-mechanism', 'waas-quickstart-30min', 'business-flow'];
  }
  if (intent === 'waas_payout') return ['waas-quickstart-30min', 'business-flow', 'waas-setup', 'supported-tokens'];
  if (intent === 'tokens_currencies') {
    if (product === 'payment_engine') return ['supported-currencies', 'payment-engine-quickstart-30min'];
    if (product === 'waas') return ['supported-tokens', 'supported-currencies'];
  }
  return DEFAULT_SUPPLEMENTAL_PAGE_IDS[intent];
}

function inferSupplementalPageIds(
  intent: IntentName,
  product: IntentProduct,
  question: string,
  effectiveQuestion: string,
  apiHints: string[],
  supplementalHints: string[],
): string[] {
  const haystack = [
    question,
    effectiveQuestion,
    ...apiHints,
    ...supplementalHints,
  ].join(' ').toLowerCase();
  const out: string[] = [];
  if (product === 'waas' && /sub_address_balance|sub[-_ ]?address balance|子地址.*余额|余额|balance/.test(haystack)) {
    out.push('supported-tokens', 'waas-quickstart-30min');
  }
  if (product === 'payment_engine' && /order_currency|order_amount|usdt|crypto|cryptocurrency|fx|虚币|加密货币/.test(haystack)) {
    out.push('supported-currencies', 'payment-engine-quickstart-30min');
  }
  if (intent === 'webhook_status' && product === 'payment_engine') {
    out.push('webhook-mechanism', 'payment-engine-quickstart-30min', 'pe-business-flow');
  }
  if (intent === 'webhook_status' && product === 'waas') {
    out.push('webhook-mechanism', 'waas-quickstart-30min', 'business-flow');
  }
  return out;
}

function cleanList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function mergeSupplementalPageIds(primary: string[], defaults: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...primary, ...defaults]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeApiReferenceHints(
  intent: IntentName,
  product: IntentProduct,
  hints: string[],
  supplementalHints: string[],
): string[] {
  const out = [...hints];
  const haystack = [...hints, ...supplementalHints].join(' ').toLowerCase();
  if (/\/api\/v1\/payout\b/.test(haystack)) {
    pushUnique(out, 'payout');
    pushUnique(out, 'POST /api/v1/payout');
  }
  if (
    /\/api\/v2\/checkout\b/.test(haystack) ||
    /\b(valid_time|checkout_url|cregis_id|hosted checkout)\b/.test(haystack)
  ) {
    pushUnique(out, 'checkout');
    pushUnique(out, 'POST /api/v2/checkout');
  }
  if (/\/api\/v2\/order\/info\b/.test(haystack)) {
    pushUnique(out, 'order info');
    pushUnique(out, 'status');
    pushUnique(out, 'POST /api/v2/order/info');
  }
  if (
    product === 'waas' &&
    (intent === 'tokens_currencies' || /\b(token_id|chain_id|token identifier|currency)\b/.test(haystack))
  ) {
    pushUnique(out, 'coins');
    pushUnique(out, 'POST /api/v1/coins');
  }
  if (
    product === 'waas' &&
    /(sub_address_balance|sub[-_ ]?address balance|子地址.*余额|余额|balance)/i.test(haystack)
  ) {
    pushUnique(out, 'sub_address_balance');
    pushUnique(out, 'POST /api/v1/sub_address_balance');
  }
  if (
    product === 'waas' &&
    /(from_address|user deposit address|specific deposit address|sub[-_ ]?address)/i.test(haystack) &&
    /(withdraw|withdrawal|payout|from_address)/i.test(haystack)
  ) {
    pushUnique(out, 'sub_address_withdrawal');
    pushUnique(out, 'POST /api/v1/sub_address_withdrawal');
  }
  return out.slice(0, 8);
}

/**
 * Extract explicit `/api/vN/...` endpoint paths the user typed in the question
 * (across the original + effective phrasing) and return them as hint strings.
 * Only fires on a literal endpoint path, so it never mislabels a topical
 * question as API-reference intent.
 */
function extractEndpointHintsFromQuestion(...questions: string[]): string[] {
  const out: string[] = [];
  const re = /\/api\/v[0-9]+\/[a-z0-9_]+(?:\/[a-z0-9_]+)*/gi;
  for (const q of questions) {
    if (!q) continue;
    for (const m of q.matchAll(re)) {
      pushUnique(out, m[0].toLowerCase());
    }
  }
  return out;
}

function pushUnique(out: string[], value: string): void {
  const key = value.toLowerCase();
  if (out.some((item) => item.toLowerCase() === key)) return;
  out.push(value);
}

function hasApiEndpointHint(hint: string): boolean {
  return /\b(GET|POST|PUT|PATCH|DELETE)\s+\/api\/|\/api\/v[0-9]+\//i.test(hint);
}

function hasApiFieldHintForIntent(hint: string): boolean {
  return /\b(checkout_url|cregis_id|valid_time|order_currency|order_amount|data\.status|event_type|cid|third_party_id|from_address|to_address|chain_id|token_id|currency|coins|payout|checkout|order info|sub_address_withdrawal|sub_address_balance)\b/i.test(hint);
}
