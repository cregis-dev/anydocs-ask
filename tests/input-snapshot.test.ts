import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputCapture } from '../src/runs/input-snapshot.ts';

const input = () => ({ question: 'What is fee?', prompt_question: 'What is fee?', search_question: 'fee transaction', retrieve_question: 'fee transaction', current_page: 'history',
  history: [{ question: 'Previous question', answer_summary: 'Summary only' }],
  documents: [{ citation_id: 'cit_1', chunk_id: 1, page_id: 'history', title: 'History', lang: 'en', url: null, path: 'response', text: 'data.rows[].fee: Miner fee', parent_id: 4, content_hash: 'source-version', expanded_parent: { parent_id: 4, content_hash: 'parent-version', parent_path: 'response' } }],
});

test('input snapshots copy selected content and actual generation requests without reconstructing history', () => {
  const source = input();
  const capture = createInputCapture(source);
  const attempt = capture.addAttempt({ systemPrompt: 'system', userPrompt: 'actual complete user prompt' });
  attempt.outcome = 'returned'; attempt.accepted = true;
  source.history[0]!.answer_summary = 'changed'; source.documents[0]!.text = 'changed';
  assert.equal(capture.snapshot.history[0]!.answer_summary, 'Summary only');
  assert.equal(capture.snapshot.documents[0]!.text, 'data.rows[].fee: Miner fee');
  assert.equal(capture.snapshot.attempts[0]!.user_prompt, 'actual complete user prompt');
  assert.deepEqual(capture.snapshot.truncated_fields, []);
});

test('snapshot redacts secrets from history, docs and each prompt attempt before persisting', () => {
  const source = input();
  source.history[0]!.question = 'api_key=secret-history';
  source.documents[0]!.text = 'Authorization: Bearer secret-doc';
  const capture = createInputCapture(source);
  capture.addAttempt({ systemPrompt: 'token="secret-system"', userPrompt: 'sign=secret-user' });
  const saved = JSON.stringify(capture.snapshot);
  assert.doesNotMatch(saved, /secret-history|secret-doc|secret-system|secret-user/);
  assert.ok(capture.snapshot.redacted_fields.includes('documents.0.text'));
  assert.ok(capture.snapshot.redacted_fields.includes('attempts.0.system_prompt'));
});

test('storage truncation is explicit, bounded across attempts, and does not mutate model input', () => {
  const capture = createInputCapture(input(), 300);
  const request = { systemPrompt: 's'.repeat(1000), userPrompt: 'u'.repeat(1000) };
  capture.addAttempt(request);
  capture.addAttempt(request);
  assert.ok(capture.snapshot.truncated_fields.includes('attempts.0.system_prompt'));
  assert.ok(capture.snapshot.truncated_fields.includes('attempts.1.user_prompt'));
  assert.equal(capture.snapshot.attempts[1]!.user_prompt, '');
  assert.equal(request.userPrompt.length, 1000);
});
