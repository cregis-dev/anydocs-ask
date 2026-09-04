import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunDetail } from '../src/console/run-detail-state.ts';
import type { RunCitationCheckUpdate, RunFeedbackUpdate, RunRecord } from '../src/runs/types.ts';

test('loadRunDetail folds append-only feedback and citation updates', async () => {
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-run-detail-'));
  try {
    const runsDir = join(stateRoot, 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const run: RunRecord = {
      ts: '2026-09-04T04:00:00.000Z',
      request_id: 'run-detail-1',
      session_id: 'session-1',
      query: 'What is A0400?',
      filters: {},
      context_pageId: null,
      source: 'reader',
      retrieval: { fused: [], selected_context: [], subtree_ask_triggered: false },
      answer: {
        kind: 'answer', answer_id: 'answer-1', md: 'Invalid amount [cit_1].',
        citations: [{ chunk_id: 7, page: 'errors', quote: 'Invalid amount', citation_id: 'cit_1' }],
        latency_ms: 100, tokens_in: null, tokens_out: null, model: 'mock', error_code: null,
      },
      feedback: { beta: null, gamma: null },
    };
    const feedback: RunFeedbackUpdate = {
      type: 'feedback-update', ts: '2026-09-04T04:01:00.000Z', request_id: run.request_id,
      feedback: { beta: 'positive' },
    };
    const citation: RunCitationCheckUpdate = {
      type: 'citation-check-update', ts: '2026-09-04T04:02:00.000Z', request_id: run.request_id,
      citations: [{ citation_id: 'cit_1', semantic_check: {
        verdict: 'supports', reason: 'Direct match', model: 'judge',
        checked_at: '2026-09-04T04:02:00.000Z', latency_ms: 20,
      } }],
    };
    await fs.writeFile(join(runsDir, '2026-W36.jsonl'), [run, feedback, citation].map((line) => JSON.stringify(line)).join('\n') + '\n');

    const loaded = loadRunDetail(stateRoot, run.request_id);
    assert.equal(loaded?.feedback.beta, 'positive');
    assert.equal(loaded?.answer.citations[0]?.semantic_check?.verdict, 'supports');
    assert.equal(loadRunDetail(stateRoot, 'missing'), null);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
