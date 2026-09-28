import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../src/config.ts';
import {
  AgentBudget,
  AgentBudgetExceededError,
  EvidenceChecklist,
  EvidenceLedger,
} from '../src/agent/state.ts';
import type { EvidenceRecord } from '../src/agent/evidence.ts';

const config: AgentConfig = {
  enabled: true,
  maxSteps: 5,
  maxDiscoveryCalls: 2,
  maxReadCalls: 2,
  maxSupplementalSearchCalls: 1,
  readTokenLimit: 3300,
};

function evidence(id: string, pageId: string): EvidenceRecord {
  return {
    evidenceId: id,
    pageId,
    lang: 'en',
    title: pageId,
    url: `/en/${pageId}`,
    breadcrumb: [],
    mode: 'page',
    selector: null,
    inPagePath: 'root',
    body: `Evidence for ${pageId}`,
    tokenCount: 8,
    truncated: false,
    availableLangs: ['en'],
    chunkIds: [1],
    contentHash: `hash-${pageId}`,
  };
}

test('AgentBudget enforces independent execution limits', () => {
  const budget = new AgentBudget(config);
  budget.consume('discovery');
  budget.consume('discovery');
  budget.consume('read');
  budget.consume('supplemental');
  assert.equal(budget.canUse('discovery'), false);
  assert.equal(budget.canUse('read'), true);
  assert.equal(budget.canUse('supplemental'), false);
  assert.throws(
    () => budget.consume('discovery'),
    (error) => error instanceof AgentBudgetExceededError && error.kind === 'discovery',
  );
  assert.deepEqual(budget.snapshot().read, { used: 1, limit: 2 });
});

test('EvidenceLedger deduplicates reads and binds only known evidence ids', () => {
  const ledger = new EvidenceLedger();
  const first = evidence('ev_11111111111111111111', 'auth');
  ledger.add(first);
  ledger.add(first);
  const duplicateContent = {
    ...first,
    evidenceId: 'ev_33333333333333333333',
    mode: 'section' as const,
    selector: 'signature',
  };
  assert.equal(ledger.add(duplicateContent), first);
  ledger.add(evidence('ev_22222222222222222222', 'payout'));
  assert.equal(ledger.size, 2);

  const resolved = ledger.resolveCitations(
    'Use the auth rule [ev_11111111111111111111], then submit [ev_22222222222222222222]. ' +
      'Ignore [ev_ffffffffffffffffffff].',
  );
  assert.equal(resolved.answer, 'Use the auth rule [cit_1], then submit [cit_2]. Ignore .');
  assert.deepEqual(resolved.records.map((record) => record.pageId), ['auth', 'payout']);
  assert.deepEqual(resolved.unknownIds, ['ev_ffffffffffffffffffff']);
});

test('EvidenceChecklist reports missing terms and combines coverage across read evidence', () => {
  const checklist = new EvidenceChecklist();
  checklist.capture([
    {
      description: 'parameters are sorted lexicographically',
      searchTerms: ['lexicographical order', 'dictionary order'],
    },
    {
      description: 'the digest is lowercase MD5',
      searchTerms: ['lowercase MD5'],
    },
    {
      description: 'callback notification content',
      searchTerms: ['回调通知内容'],
    },
    {
      description: 'localhost callback support',
      searchTerms: ['localhost callback url'],
    },
    {
      description: 'Payment Engine callback identity',
      searchTerms: ['callback identity', 'cregis_id'],
      requiredTerms: ['Payment Engine', 'cregis_id'],
    },
    {
      description: 'webhook signature verification procedure',
      searchTerms: ['webhook signature verification algorithm'],
    },
  ]);
  const auth = {
    ...evidence('ev_11111111111111111111', 'auth'),
    body: 'Sort parameter names in lexicographical order and prepend the API Key.',
  };
  const first = checklist.snapshot([auth]);
  assert.equal(first[0]?.covered, true);
  assert.deepEqual(first[0]?.missingTerms, []);
  assert.equal(first[1]?.covered, false);
  assert.deepEqual(first[1]?.missingTerms, ['lowercase MD5']);
  assert.equal(first[2]?.covered, false);
  assert.equal(first[3]?.covered, false);
  assert.equal(first[4]?.covered, false);
  assert.equal(first[5]?.covered, false);

  const hashing = {
    ...evidence('ev_22222222222222222222', 'hashing'),
    body: 'Calculate the result as lowercase MD5.',
  };
  const callback = {
    ...evidence('ev_44444444444444444444', 'callback'),
    body: '收到充值后，系统会发送回调通知。',
  };
  const complete = checklist.snapshot([auth, hashing, callback]);
  assert.equal(complete[0]?.covered, true);
  assert.deepEqual(complete[0]?.evidenceIds, [auth.evidenceId]);
  assert.equal(complete[1]?.covered, true);
  assert.deepEqual(complete[1]?.evidenceIds, [hashing.evidenceId]);
  assert.equal(complete[2]?.covered, true, 'CJK aliases tolerate a partial phrase match');
  assert.deepEqual(complete[2]?.evidenceIds, [callback.evidenceId]);
  assert.equal(complete[3]?.covered, false, 'technical aliases require every distinctive token');
  assert.equal(complete[4]?.covered, false, 'an identifier without its product scope is insufficient');
  assert.equal(complete[5]?.covered, false);

  const scopedCallback = {
    ...evidence('ev_55555555555555555555', 'payment-callback'),
    body: 'Payment Engine webhook callbacks use cregis_id as the callback identity. ' +
      'The signature verification procedure is documented here.',
  };
  const scoped = checklist.snapshot([auth, hashing, callback, scopedCallback]);
  assert.equal(scoped[4]?.covered, true);
  assert.deepEqual(scoped[4]?.evidenceIds, [scopedCallback.evidenceId]);
  assert.equal(scoped[5]?.covered, true, 'natural-language aliases tolerate one framing word');

  checklist.capture([{ description: 'replacement plan', searchTerms: ['ignored'] }]);
  assert.equal(checklist.size, 6, 'later discovery calls cannot replace the original plan');
});

test('EvidenceChecklist discards speculative exact anchors not present in the question', () => {
  const checklist = new EvidenceChecklist();
  checklist.capture([
    {
      description: 'hash algorithm used for callback verification',
      searchTerms: ['SHA256', 'MD5', 'hash algorithm'],
      requiredTerms: ['SHA256', 'MD5', 'webhook'],
    },
  ], 'Which hash algorithm does the webhook use?');

  const callback = {
    ...evidence('ev_66666666666666666666', 'webhook'),
    body: 'Webhook signatures use lowercase MD5.',
  };
  const [status] = checklist.snapshot([callback]);
  assert.deepEqual(status?.requiredTerms, ['webhook']);
  assert.equal(status?.covered, true);
});
