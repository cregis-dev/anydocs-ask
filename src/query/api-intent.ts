import type { RetrievedChunk } from './retrieval.ts';

const API_PATH_RE = /(?:GET|POST|PUT|PATCH|DELETE)?\s*\/api\/[A-Za-z0-9_./{}:-]+/i;
const EN_API_TERMS_RE =
  /\b(endpoint|api reference|request|response|parameter|parameters|field|fields|payload|body|header|headers|status)\b/i;
const ZH_API_TERMS_RE = /接口|参数|字段|请求|响应|返回|状态|路径|报文|请求体|响应体/;
const IDENTIFIER_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+|\.[a-z0-9]+)\b/i;
const ZH_CREATE_ORDER_RE = /(?:创建|建立|新建).{0,12}订单|订单.{0,12}(?:创建|建立|新建)/;
const EN_CREATE_ORDER_RE =
  /\b(?:create|creating|created|open|start)\b.{0,40}\b(?:payment engine\s+)?order\b|\border\b.{0,40}\b(?:create|creating|created)\b/i;
const ZH_PAYOUT_RE = /出款|提币|提现/;

export function detectApiIntent(question: string): boolean {
  const q = question.trim();
  if (q.length === 0) return false;
  if (API_PATH_RE.test(q)) return true;
  if (/\b(?:data\.status|event_type|event_name)\b/i.test(q)) return true;
  if (isSignatureAuthQuestion(q)) return false;
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

function isSignatureAuthQuestion(question: string): boolean {
  return /签名|signature/i.test(question) && /\bsign\b|API Key|MD5|排序|字典序|升序/i.test(question);
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
  if (
    /\bcheckout\b/i.test(q) ||
    /\border_(?:currency|amount)\b/i.test(q) ||
    ZH_CREATE_ORDER_RE.test(q) ||
    EN_CREATE_ORDER_RE.test(q)
  ) {
    hints.push('checkout order_currency order_amount');
  }
  if (/\bpayout\b/i.test(q) || ZH_PAYOUT_RE.test(q)) {
    const versions = apiReferenceVersionPreferences(q);
    const defaultPayoutVersion = versions[0] ?? 'v1';
    hints.push(`api ${defaultPayoutVersion} payout cid callback`);
    if (/query|查询|状态|终态|最终/i.test(q)) {
      hints.push(`api ${defaultPayoutVersion} payout query`);
    }
  }
  if (/data\.status|order info|查询.{0,8}订单|订单.{0,8}查询/i.test(q)) {
    hints.push('order info data status');
  }
  return [...new Set(hints)];
}

export function apiReferenceVersionPreferences(question: string): string[] {
  const q = question.trim();
  const versions: string[] = [];
  if (/(?:\/api\/v2\b|\bv2\b|（v2）|\(v2\))/i.test(q)) versions.push('v2');
  if (/(?:\/api\/v1\b|\bv1\b|（v1）|\(v1\))/i.test(q)) versions.push('v1');
  if (versions.length === 0 && (/\bpayout\b/i.test(q) || ZH_PAYOUT_RE.test(q))) {
    versions.push('v1');
  }
  return [...new Set(versions)];
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
