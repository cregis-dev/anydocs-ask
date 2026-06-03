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
- If the current question is standalone, effective_question must not include
  unrelated prior-turn terms.`;

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
  const product = normalizeProduct(raw.product);
  const usesHistory = raw.conversation_mode === 'follow_up' && history.length > 0;
  const rawEffective = typeof raw.effective_question === 'string' ? raw.effective_question.trim() : '';
  const effectiveQuestion = rawEffective.length > 0 ? rawEffective : question;
  const retrieval = raw.retrieval ?? {};
  const apiReferenceHints = cleanList(retrieval.api_reference_hints, 8, 96);
  const supplementalContextHints = cleanList(retrieval.supplemental_context_hints, 6, 120);
  const supplementalPageIds = cleanList(retrieval.supplemental_page_ids, 6, 80)
    .filter((id) => /^[A-Za-z0-9_.:-]+$/.test(id));
  const apiReferenceVersionPrefs = cleanList(retrieval.api_versions, 3, 8)
    .map((v) => v.toLowerCase())
    .filter((v) => /^v[0-9]+$/.test(v));
  const preferApiReference = retrieval.prefer_api_reference === true;
  const apiIntent = intent === 'api_reference' || preferApiReference || apiReferenceHints.length > 0;

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
