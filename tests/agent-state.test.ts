import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../src/config.ts';
import { AgentBudget, AgentBudgetExceededError, EvidenceLedger } from '../src/agent/state.ts';
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
