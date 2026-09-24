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

  const hashing = {
    ...evidence('ev_22222222222222222222', 'hashing'),
    body: 'Calculate the result as lowercase MD5.',
  };
  const complete = checklist.snapshot([auth, hashing]);
  assert.equal(complete[0]?.covered, true);
  assert.deepEqual(complete[0]?.evidenceIds, [auth.evidenceId]);
  assert.equal(complete[1]?.covered, true);
  assert.deepEqual(complete[1]?.evidenceIds, [hashing.evidenceId]);

  checklist.capture([{ description: 'replacement plan', searchTerms: ['ignored'] }]);
  assert.equal(checklist.size, 2, 'later discovery calls cannot replace the original plan');
});
