import type { RetrievedChunk } from './retrieval.ts';

const API_PATH_RE = /(?:GET|POST|PUT|PATCH|DELETE)?\s*\/api\/[A-Za-z0-9_./{}:-]+/i;
const EN_API_TERMS_RE =
  /\b(endpoint|api reference|request|response|parameter|parameters|field|fields|payload|body|header|headers|status)\b/i;
const ZH_API_TERMS_RE = /接口|参数|字段|请求|响应|返回|状态|路径|报文|请求体|响应体/;
const IDENTIFIER_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+|\.[a-z0-9]+)\b/i;
const ZH_CREATE_ORDER_RE = /(?:创建|建立|新建).{0,12}订单|订单.{0,12}(?:创建|建立|新建)/;
const EN_CREATE_ORDER_RE =
  /\b(?:create|creating|created|open|start)\b.{0,40}\b(?:payment engine\s+)?order\b|\border\b.{0,40}\b(?:create|creating|created)\b/i;
const EN_PAYMENT_ENGINE_ORDER_CURRENCY_RE =
  /\bpayment engine\b.{0,80}\border\b.{0,80}\b(?:order currency|payment tokens?|accepted payment tokens?|priced in|denominated in|fx|conversion)\b|\border\b.{0,80}\b(?:order currency|payment tokens?|accepted payment tokens?|priced in|denominated in)\b.{0,80}\bpayment engine\b/i;
const ZH_PAYOUT_RE = /出款|提币|提现/;
const EN_SUB_ADDRESS_WITHDRAWAL_RE =
  /\b(?:sub[-_\s]?address|deposit address|specific (?:user )?(?:deposit )?address|from_address)\b/i;
const ZH_SUB_ADDRESS_WITHDRAWAL_RE =
  /子地址.{0,16}(?:出款|提币|提现)|(?:出款|提币|提现).{0,16}子地址|指定.{0,16}地址.{0,16}(?:出款|提币|提现)|from_address/;
const EN_SUB_ADDRESS_BALANCE_RE =
  /\bsub[-_\s]?address\b.{0,32}\bbalance\b|\bbalance\b.{0,32}\bsub[-_\s]?address\b|\bsub_address_balance\b/i;
const ZH_SUB_ADDRESS_BALANCE_RE =
  /子地址.{0,16}(?:余额|balance)|(?:余额|balance).{0,16}子地址|sub_address_balance/i;
const TOKEN_LOOKUP_RE =
  /\b(?:chain_id|token_id|supported[-_\s]?tokens?|token identifier|coins|currency)\b|支持的代币|支持币种|代币|币种标识|测试网|生产|正式|开发环境/i;

export function detectApiIntent(question: string): boolean {
  const q = question.trim();
  if (q.length === 0) return false;
  if (API_PATH_RE.test(q)) return true;
  if (/\b(?:data\.status|event_type|event_name)\b/i.test(q)) return true;
  if (detectSignatureAuthIntent(q)) return false;
  if (detectProjectSetupIntent(q)) return false;
  if (ZH_API_TERMS_RE.test(q)) return true;
  if (EN_API_TERMS_RE.test(q)) return true;
  if (ZH_CREATE_ORDER_RE.test(q)) return true;
  if (EN_CREATE_ORDER_RE.test(q) && /\b(?:checkout|order_currency|order_amount|USDT|USDC|BTC|ETH|crypto|cryptocurrency|FX)\b/i.test(q)) {
    return true;
  }
  if (ZH_PAYOUT_RE.test(q) && /流程|查询|状态|终态|接口|API/i.test(q)) return true;
  return IDENTIFIER_RE.test(q) && /\b(map|mapping|return|returns|send|query|create|lookup)\b/i.test(q);
}

export function detectSignatureAuthIntent(question: string): boolean {
  return /签名|验签|signature/i.test(question);
}

export function detectProjectSetupIntent(question: string): boolean {
  return (
    /\b(?:project|projects)\b/i.test(question) &&
      /\b(?:need|only|also|should|create|separate|separately|prepare|preparation)\b/i.test(question) &&
      /\b(?:Payment Engine|WaaS|payout|withdrawal|withdrawals)\b/i.test(question)
  ) || (
    /项目/.test(question) &&
      /需要|只|是否|应该|同时|创建|准备/.test(question) &&
      /支付引擎|WaaS|出款|提币|提现/.test(question)
  );
}

export function apiReferenceSearchHints(question: string): string[] {
  const q = question.trim();
  const hints: string[] = [];
  const subAddressBalanceIntent = detectSubAddressBalanceIntent(q);
  const subAddressWithdrawalIntent = !subAddressBalanceIntent && detectSubAddressWithdrawalIntent(q);
  const tokenLookupIntent = detectTokenLookupIntent(q);
  const checkoutIntent =
    /\bcheckout\b/i.test(q) ||
    /\border_(?:currency|amount)\b/i.test(q) ||
    ZH_CREATE_ORDER_RE.test(q) ||
    EN_CREATE_ORDER_RE.test(q) ||
    EN_PAYMENT_ENGINE_ORDER_CURRENCY_RE.test(q);
  if (checkoutIntent) {
    hints.push('checkout order_currency order_amount');
  }
  if (subAddressWithdrawalIntent) {
    hints.push('api v1 sub_address_withdrawal from_address to_address third_party_id');
  }
  if (subAddressBalanceIntent) {
    hints.push('api v1 sub_address_balance address currency chain_id token_id');
  }
  if (tokenLookupIntent && !subAddressBalanceIntent && !checkoutIntent) {
    hints.push('api v1 coins chain_id token_id currency');
  }
  if (!subAddressWithdrawalIntent && !subAddressBalanceIntent && (/\bpayout\b/i.test(q) || ZH_PAYOUT_RE.test(q))) {
    const versions = apiReferenceVersionPreferences(q);
    const defaultPayoutVersion = versions[0] ?? 'v1';
    hints.push(`api ${defaultPayoutVersion} payout cid callback`);
    if (/query|查询|状态|终态|最终/i.test(q)) {
      hints.push(`api ${defaultPayoutVersion} payout query`);
    }
  }
  if (detectOrderStatusLookupIntent(q)) {
    hints.push('order info data status');
  }
  return [...new Set(hints)];
}

export function supplementalContextSearchHints(question: string): string[] {
  const q = question.trim();
  const hints: string[] = [];
  if (detectTokenEnvironmentIntent(q)) {
    hints.push('测试代币 开发环境 testnet tokens development environments');
  }
  if (detectPaymentEngineCallbackStatusIntent(q)) {
    hints.push('支付引擎 业务流程 回调机制 event_type 状态映射 幂等 partial_paid paid_remain');
  }
  return [...new Set(hints)];
}

export function supplementalContextPageIds(question: string): string[] {
  const q = question.trim();
  const pageIds: string[] = [];
  if (detectTokenEnvironmentIntent(q)) pageIds.push('sdk-overview');
  if (detectPaymentEngineCallbackStatusIntent(q)) pageIds.push('webhook-mechanism', 'pe-business-flow');
  return [...new Set(pageIds)];
}

export function apiReferenceVersionPreferences(question: string): string[] {
  const q = question.trim();
  const versions: string[] = [];
  if (/(?:\/api\/v2\b|\bv2\b|（v2）|\(v2\))/i.test(q)) versions.push('v2');
  if (/(?:\/api\/v1\b|\bv1\b|（v1）|\(v1\))/i.test(q)) versions.push('v1');
  if (
    versions.length === 0 &&
    (
      /\bpayout\b/i.test(q) ||
      ZH_PAYOUT_RE.test(q) ||
      detectSubAddressWithdrawalIntent(q) ||
      detectSubAddressBalanceIntent(q) ||
      detectTokenLookupIntent(q)
    )
  ) {
    versions.push('v1');
  }
  return [...new Set(versions)];
}

function detectSubAddressWithdrawalIntent(question: string): boolean {
  if (ZH_SUB_ADDRESS_WITHDRAWAL_RE.test(question)) return true;
  return (
    EN_SUB_ADDRESS_WITHDRAWAL_RE.test(question) &&
    /\b(?:withdraw|withdrawal|payout|endpoint|field|fields|request|from|source)\b/i.test(question)
  );
}

function detectSubAddressBalanceIntent(question: string): boolean {
  return ZH_SUB_ADDRESS_BALANCE_RE.test(question) || EN_SUB_ADDRESS_BALANCE_RE.test(question);
}

function detectTokenLookupIntent(question: string): boolean {
  return TOKEN_LOOKUP_RE.test(question);
}

function detectTokenEnvironmentIntent(question: string): boolean {
  return (
    /测试网|测试代币|开发环境|生产|正式|testnet|test token|test tokens|development environment|production/i.test(question) &&
    /token|tokens|代币|币种|chain_id|token_id|supported[-_\s]?tokens?/i.test(question)
  );
}

function detectOrderStatusLookupIntent(question: string): boolean {
  if (/data\.status|order info|查询.{0,8}订单|订单.{0,8}查询/i.test(question)) return true;

  return detectPaymentEngineCallbackStatusIntent(question);
}

function detectPaymentEngineCallbackStatusIntent(question: string): boolean {
  const hasOrderScope = /payment engine|order|支付引擎|订单/i.test(question);
  const hasCallbackScope = /callback|webhook|event_type|回调/i.test(question);
  const hasStatusMappingTerms =
    /状态映射|状态机|流转|幂等|partial_paid|paid_remain|paid_partial|paid_over|部分支付|补款|补足|重复/i.test(question);
  return hasOrderScope && hasCallbackScope && hasStatusMappingTerms;
}

export function isApiReferenceChunk(c: Pick<RetrievedChunk, 'page_id' | 'page_url' | 'text'>): boolean {
  if (c.page_id.startsWith('api-')) return true;
  if ((c.page_url ?? '').includes('/reference/')) return true;
  return /\bAPI reference:/i.test(c.text) || /\bHTTP Request\b/i.test(c.text);
}

export function apiReferenceChunkMatchesVersion(
  c: Pick<RetrievedChunk, 'page_id' | 'page_url' | 'page_title' | 'text'>,
  versions: string[] | undefined,
): boolean {
  if (!versions?.length) return true;
  const haystack = `${c.page_id} ${c.page_url ?? ''} ${c.page_title} ${c.text}`.toLowerCase();
  const match = haystack.match(/(?:\/api\/|api-)(v[0-9]+)\b/);
  if (!match) return true;
  return versions.includes(match[1]!);
}

export function apiReferencePagePrefixFor(currentSubtreeRoot: string | null): string | null {
  if (!currentSubtreeRoot) return null;
  return `api-${currentSubtreeRoot}-`;
}
