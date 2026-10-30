import { ABLATION_VARIANTS, type AblationVariant } from '../../src/eval/ablation.ts';

export type FullRequest = { case_id: string; variant: AblationVariant; repetition: number; order: number };

export function fullSchedule(ids: string[], repetitions = 3, seed = 20261020): FullRequest[] {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Unique nonempty case IDs required');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('Invalid repetition count');
  let state = seed;
  const shuffle = <T>(values: T[]): T[] => {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = Math.floor(state / 2 ** 32 * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };
  const blocks = shuffle(ids.flatMap((case_id) => Array.from({ length: repetitions }, (_, i) =>
    ({ case_id, repetition: i + 1 }))));
  return blocks.flatMap((block) => shuffle([...ABLATION_VARIANTS]).map((variant) => ({ ...block, variant })))
    .map((row, order) => ({ ...row, order }));
}

export function requestKey(row: Pick<FullRequest, 'case_id' | 'variant' | 'repetition'>): string {
  return `${row.repetition}:${row.variant}:${row.case_id}`;
}

export function validateCompleted(plan: FullRequest[], rows: Array<Pick<FullRequest, 'case_id' | 'variant' | 'repetition'>>): Set<string> {
  const allowed = new Set(plan.map(requestKey));
  const seen = new Set<string>();
  for (const row of rows) {
    const key = requestKey(row);
    if (!allowed.has(key) || seen.has(key)) throw new Error(`Unexpected or duplicate completed attempt: ${key}`);
    seen.add(key);
  }
  return seen;
}

// Conservative topic clusters, not an assertion that all members are translations.
export function caseAnalysis(id: string): { family_id: string; category: string; classification: string } {
  const patterns: Array<[RegExp, string, string]> = [
    [/a0403|trade-fee|coins-null/, 'documentation-boundary', 'documentation_boundary'],
    [/public-callback|callback-url-public/, 'callback-reachability', 'documentation_boundary'],
    [/auth-|signature|b0001|param-vs-signature|code-handling|e0001-e0003/, 'authentication', 'product_version'],
    [/crypto-order|cross-currency|stablecoin-rate/, 'order-currency', 'cross_page'],
    [/order-timeout|valid-time-expire/, 'order-timeout', 'cross_page'],
    [/callback-state|partial-payment|payment-event|duplicate-callback|idempotency/, 'webhook-state-idempotency', 'cross_page'],
    [/payout-flow|payout-failure|withdrawal-query/, 'payout-status', 'cross_page'],
    [/sub-address-withdrawal-fields|v2-payout-wallet/, 'withdrawal-source', 'product_version'],
    [/project-choice|api-project|collections-and-payouts|payments-plus|engine-vs-waas/, 'product-choice', 'product_version'],
    [/credential|base-url|api-key-pid/, 'project-credentials', 'product_version'],
    [/tokens-|token-network|supported-coins|e0042|invalid-token-name/, 'token-network', 'product_version'],
    [/sdk-/, 'sdk-choice', 'same_page'],
    [/batch-address/, 'batch-address', 'same_page'],
    [/create-sub-address|e0004-create/, 'create-address', 'same_page'],
    [/inner-address/, 'internal-address', 'product_version'],
    [/address-legal/, 'address-validation', 'same_page'],
    [/sub-address-balance/, 'sub-address-balance', 'same_page'],
    [/collection-|collection-vs-payout/, 'collection', 'same_page'],
    [/checkout-core|checkout-url|payment-info-address/, 'checkout-payment-entry', 'cross_page'],
    [/success-cancel|sub-merchant|payer-email|under-overpaid|order-amount-range/, 'checkout-fields', 'same_page'],
    [/query-order|cregis-id-order|e0019/, 'order-query', 'cross_page'],
    [/deposit.*callback|deposit-vs-payout/, 'deposit-callback', 'cross_page'],
  ];
  const found = patterns.find(([pattern]) => pattern.test(id));
  return { family_id: found?.[1] ?? id.replace(/-(en|zh)-/, '-'), category: found?.[2] ?? 'unclassified',
    classification: 'pre-generation code-assisted topic grouping; independent review pending' };
}
