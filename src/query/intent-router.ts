import { createHash } from 'node:crypto';
import type { DocsLang } from '../anydocs/types.ts';
import type { LLM } from '../llm/types.ts';
import {
  diagnosticRetrievalHints,
  mergeLlmDiagnostic,
  prepareDiagnosticInput,
  redactSensitiveText,
  type DiagnosticContext,
  type PreparedDiagnosticInput,
} from './diagnostic-input.ts';

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
  /** Sensitive values redacted before any external LLM call. */
  safeQuestion?: string;
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
  /** Structured troubleshooting context for long JSON/log questions. */
  diagnostic?: DiagnosticContext;
  /** How this route was resolved. Useful for latency and cache diagnostics. */
  routerStrategy?: 'fast_path' | 'cache' | 'llm' | 'fallback' | 'disabled';
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

export type LLMIntentRouterOptions = {
  enabled?: boolean;
  fastPathMaxChars?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  now?: () => number;
};

const ROUTER_SYSTEM_PROMPT = `ANYDOCS_INTENT_ROUTER_V2
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
  "diagnostic": {
    "summary": "short factual description of the observed failure",
    "endpoints": ["verbatim endpoint paths present in the question"],
    "error_codes": ["verbatim error codes or HTTP statuses"],
    "exception_names": ["verbatim exception class names"],
    "important_fields": ["verbatim request/response field names"],
    "exact_clues": ["short verbatim excerpts copied from the question"]
  },
  "reason": "short operator-facing reason"
}

Guidance:
- API reference questions ask about endpoint paths, request/response fields,
  status fields, parameters, payloads, or exact operations.
- When the question contains JSON, HTTP transcripts, or logs, rewrite
  effective_question into a concise documentation retrieval query. Preserve
  endpoint paths, error codes, exception names, and relevant field names.
- diagnostic.summary may interpret the symptom, but every array item must be
  copied verbatim from the question. Never invent an exact clue.
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
  private readonly resolveLlm: () => LLM;
  private readonly enabled: boolean;
  private readonly fastPathMaxChars: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expiresAt: number; route: IntentRoute }>();

  constructor(llm: LLM | (() => LLM), opts: LLMIntentRouterOptions = {}) {
    this.resolveLlm = typeof llm === 'function' ? llm : () => llm;
    this.enabled = opts.enabled ?? true;
    this.fastPathMaxChars = opts.fastPathMaxChars ?? 240;
    this.cacheTtlMs = opts.cacheTtlMs ?? 300_000;
    this.cacheMaxEntries = opts.cacheMaxEntries ?? 512;
    this.now = opts.now ?? Date.now;
  }

  async route(args: IntentRouterArgs): Promise<IntentRoute> {
    const question = args.question.trim();
    if (!question) return fallbackRoute(question, undefined, 'router_empty', 'fallback');
    const prepared = prepareDiagnosticInput(question);
    if (!this.enabled) {
      return fallbackRoute(question, prepared, 'router_disabled', 'disabled');
    }
    if (shouldUseRouterFastPath(args, prepared, this.fastPathMaxChars)) {
      return fallbackRoute(question, prepared, 'router_fast_path', 'fast_path');
    }

    const cacheKey = this.cacheKey(args, prepared.safeQuestion);
    const cached = this.readCache(cacheKey);
    if (cached) return cached;

    let raw: string;
    try {
      const out = await this.resolveLlm().generate({
        systemPrompt: ROUTER_SYSTEM_PROMPT,
        userPrompt: JSON.stringify({
          question: prepared.safeQuestion,
          lang: args.lang,
          history: (args.history ?? []).slice(-3).map((turn) => ({
            question: redactSensitiveText(turn.question),
            answer_summary: redactSensitiveText(turn.answer_summary),
          })),
        }),
        temperature: 0,
        maxTokens: 500,
      });
      raw = out.text;
    } catch {
      return fallbackRoute(question, prepared, 'router_fallback', 'fallback');
    }

    const parsed = parseRouterJson(raw);
    if (!parsed) {
      return fallbackRoute(question, prepared, 'router_fallback', 'fallback');
    }
    return this.remember(
      cacheKey,
      { ...normalizeRoute(question, parsed, args.history ?? [], prepared), routerStrategy: 'llm' },
    );
  }

  private cacheKey(args: IntentRouterArgs, safeQuestion: string): string {
    const history = (args.history ?? []).slice(-3).map((turn) => ({
      question: redactSensitiveText(turn.question),
      answer_summary: redactSensitiveText(turn.answer_summary),
    }));
    return createHash('sha256')
      .update(JSON.stringify({ lang: args.lang, question: safeQuestion, history }))
      .digest('hex');
  }

  private readCache(key: string): IntentRoute | null {
    if (this.cacheTtlMs === 0) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return { ...entry.route, routerStrategy: 'cache', reason: 'router_cache_hit' };
  }

  private remember(key: string, route: IntentRoute): IntentRoute {
    if (this.cacheTtlMs === 0) return route;
    this.cache.delete(key);
    this.cache.set(key, { expiresAt: this.now() + this.cacheTtlMs, route });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    return route;
  }
}

export function fallbackRoute(
  question: string,
  prepared: PreparedDiagnosticInput = prepareDiagnosticInput(question),
  reason = 'router_fallback',
  routerStrategy: IntentRoute['routerStrategy'] = 'fallback',
): IntentRoute {
  const diagnostic = prepared.diagnostic;
  return {
    originalQuestion: question,
    safeQuestion: prepared.safeQuestion,
    effectiveQuestion: prepared.fallbackRetrievalQuestion,
    usesHistory: false,
    rewritten: prepared.fallbackRetrievalQuestion !== prepared.safeQuestion,
    intent: diagnostic.structured ? 'error_troubleshooting' : 'general_docs',
    product: inferProduct(
      prepared.safeQuestion,
      prepared.fallbackRetrievalQuestion,
      diagnostic.structured ? 'error_troubleshooting' : 'general_docs',
      'unknown',
      diagnostic.endpoints,
      diagnosticRetrievalHints(diagnostic),
    ),
    apiIntent: diagnostic.endpoints.length > 0,
    signatureAuthIntent: false,
    projectSetupIntent: false,
    apiReferenceHints: diagnostic.endpoints,
    supplementalContextHints: diagnosticRetrievalHints(diagnostic),
    supplementalPageIds: diagnostic.structured ? ['error-codes'] : [],
    apiReferenceVersionPrefs: [],
    ...(diagnostic.structured ? { diagnostic } : {}),
    routerStrategy,
    reason,
  };
}

function shouldUseRouterFastPath(
  args: IntentRouterArgs,
  prepared: PreparedDiagnosticInput,
  fastPathMaxChars: number,
): boolean {
  if (fastPathMaxChars <= 0) return false;
  const diagnostic = prepared.diagnostic;
  const hasExactDiagnosticAnchor = diagnostic.endpoints.length > 0
    || diagnostic.errorCodes.length > 0
    || diagnostic.exceptionNames.length > 0;
  if (hasExactDiagnosticAnchor) return true;
  if ((args.history?.length ?? 0) > 0) return false;
  return prepared.safeQuestion.length <= fastPathMaxChars && !diagnostic.structured;
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
  diagnostic?: unknown;
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
  prepared: PreparedDiagnosticInput,
): IntentRoute {
  const intent = normalizeIntent(raw.intent);
  const usesHistory = raw.conversation_mode === 'follow_up' && history.length > 0;
  const rawEffective = typeof raw.effective_question === 'string' ? raw.effective_question.trim() : '';
  const unusableStructuredRewrite = prepared.diagnostic.structured
    && (rawEffective === prepared.safeQuestion || rawEffective.length > 600);
  const effectiveQuestion = rawEffective.length > 0 && !unusableStructuredRewrite
    ? rawEffective
    : prepared.fallbackRetrievalQuestion;
  const retrieval = raw.retrieval ?? {};
  const initialApiReferenceHints = cleanList(retrieval.api_reference_hints, 8, 96);
  const diagnostic = mergeLlmDiagnostic(prepared, raw.diagnostic);
  const supplementalContextHints = cleanList(
    [
      ...cleanList(retrieval.supplemental_context_hints, 6, 120),
      ...diagnosticRetrievalHints(diagnostic),
    ],
    20,
    160,
  );
  const product = inferProduct(
    prepared.safeQuestion,
    effectiveQuestion,
    intent,
    normalizeProduct(raw.product),
    initialApiReferenceHints,
    supplementalContextHints,
  );
  // When the user literally types an API endpoint path in the question
  // (e.g. "for a WaaS `/api/v1/payout` request …"), that is an unambiguous
  // API-reference signal. Preserve explicit endpoints in route diagnostics
  // even when the LLM places them under supplemental_context_hints. Ranking
  // does not consume these hints; exact endpoint extraction happens locally.
  const questionEndpointHints = extractEndpointHintsFromQuestion(prepared.safeQuestion, effectiveQuestion);
  const apiReferenceHints = normalizeApiReferenceHints(
    intent,
    product,
    [...questionEndpointHints, ...initialApiReferenceHints],
    supplementalContextHints,
  );
  const inferredSupplementalPageIds = inferSupplementalPageIds(
    intent,
    product,
    prepared.safeQuestion,
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
    (diagnostic.structured && hasEndpointHint) ||
    (intent === 'signature_auth' && hasEndpointHint) ||
    (intent === 'webhook_status' && hasEndpointHint) ||
    (intent === 'error_troubleshooting' && hasEndpointHint) ||
    (intent === 'payment_flow' && (preferApiReference || hasEndpointHint || hasApiFieldHint)) ||
    (intent === 'waas_payout' && (preferApiReference || hasEndpointHint || hasApiFieldHint)) ||
    (intent === 'tokens_currencies' && (preferApiReference || hasEndpointHint || hasApiFieldHint));

  return {
    originalQuestion: question,
    safeQuestion: prepared.safeQuestion,
    effectiveQuestion,
    usesHistory,
    rewritten: effectiveQuestion !== prepared.safeQuestion,
    intent,
    product,
    apiIntent,
    signatureAuthIntent: intent === 'signature_auth',
    projectSetupIntent: intent === 'project_setup',
    apiReferenceHints,
    supplementalContextHints,
    supplementalPageIds,
    apiReferenceVersionPrefs: [...new Set(apiReferenceVersionPrefs)],
    ...(diagnostic.structured ? { diagnostic } : {}),
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
