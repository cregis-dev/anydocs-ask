import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullSchedule, requestKey, validateCompleted, caseAnalysis } from '../scripts/lib/ablation-full-plan.ts';

test('full schedule has all 92x4x3 independent requests in deterministic case blocks', () => {
  const ids = Array.from({ length: 92 }, (_, i) => `case-${i}`);
  const plan = fullSchedule(ids);
  assert.equal(plan.length, 1104);
  assert.equal(new Set(plan.map(requestKey)).size, 1104);
  assert.deepEqual(plan, fullSchedule(ids));
  assert.notDeepEqual(plan, fullSchedule(ids, 3, 42));
  for (let i = 0; i < plan.length; i += 4) {
    const block = plan.slice(i, i + 4);
    assert.equal(new Set(block.map((r) => `${r.case_id}:${r.repetition}`)).size, 1);
    assert.equal(new Set(block.map((r) => r.variant)).size, 4);
  }
});
test('resume validates attempt identity, not just number of rows', () => {
  const plan = fullSchedule(['one', 'two']);
  assert.equal(validateCompleted(plan, plan.slice(0, 5)).size, 5);
  assert.throws(() => validateCompleted(plan, [plan[0]!, plan[0]!]));
  assert.throws(() => validateCompleted(plan, [{ ...plan[0]!, repetition: 4 }]));
  assert.throws(() => fullSchedule(['one', 'one']));
});
test('conservative families group related translations and paraphrases before scoring', () => {
  assert.equal(caseAnalysis('cregis-auth-en-sign-exclude-field').family_id,
    caseAnalysis('cregis-auth-zh-signature-rules').family_id);
  assert.equal(caseAnalysis('cregis-waas-en-create-sub-address-single').family_id,
    caseAnalysis('cregis-waas-zh-create-sub-address-single').family_id);
});
