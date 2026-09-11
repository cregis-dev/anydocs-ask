import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupConversations, matchesConversationRun } from '../src/runs/conversations.ts';
import { loadConversation } from '../src/console/conversation-state.ts';
import { RunsWriter } from '../src/runs/writer.ts';
import type { RunRecord } from '../src/runs/types.ts';
import { renderTranscriptMarkdown } from '../src/console-ui/transcript-markdown.ts';
import { createInputCapture } from '../src/runs/input-snapshot.ts';
import { loadTrafficWindow } from '../src/console/traffic-state.ts';
import { loadRunDetail } from '../src/console/run-detail-state.ts';

function run(id: number, session: string | null = 's1'): RunRecord {
  return { request_id: `r${id}`, session_id: session, source: 'reader', ts: new Date(Date.UTC(2026, 8, 1, 0, id)).toISOString(),
    query: `Question ${id}`, filters: {}, context_pageId: null,
    retrieval: { fused: [], subtree_ask_triggered: false },
    answer: { kind: 'answer', answer_id: null, md: 'Saved answer', citations: [], latency_ms: 100, tokens_in: null, tokens_out: null, model: 'test', error_code: null },
    feedback: { beta: null, gamma: null } };
}

test('groups by session and source; missing IDs stay independent; chronological turns and latest sessions', () => {
  const records = [run(2), run(1), run(3, null), run(4, null), run(5, ''), { ...run(6), source: 'console' as const }, run(7, 'other'), run(2)];
  const groups = groupConversations(records);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups[groups.length - 1]!.map((r) => r.request_id), ['r1', 'r2']);
  assert.equal(groups[0]![0]!.request_id, 'r7');
  assert.equal(records[0]!.request_id, 'r2');
});

test('group before filtering and paging retains non-matching turns; conditions match the same run', () => {
  const first = run(1); const second = run(2); second.answer.kind = 'error';
  const groups = groupConversations([first, second, ...Array.from({ length: 30 }, (_, i) => run(i + 10, `s${i + 10}`))]);
  const filter = { query: 'Question 2', source: 'reader', kind: 'error' };
  const matched = groups.filter((runs) => runs.some((r) => matchesConversationRun(r, filter))).slice(0, 25);
  assert.deepEqual(matched[0]!.map((r) => r.request_id), ['r1', 'r2']);
  assert.equal(matchesConversationRun(first, { ...filter, query: 'Question 1' }), false);
  assert.equal(matchesConversationRun(first, { query: 'saved ANSWER', source: '', kind: '' }), true);
});

test('conversation reads all retained dates, paginates turns, excludes other sources and missing sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-conversations-'));
  try {
    const records = Array.from({ length: 53 }, (_, i) => run(i));
    records[0]!.ts = '2025-01-01T00:00:00.000Z';
    records[0]!.input_snapshot = createInputCapture({ question: 'old input', prompt_question: 'old input', search_question: '', retrieve_question: '', current_page: null, history: [], documents: [] }).snapshot;
    records[0]!.input_snapshot_status = 'captured';
    for (const record of [...records, { ...run(60), source: 'console' as const }, run(61, null), run(62, null)]) {
      new RunsWriter({ stateRoot: root, enabled: true, now: () => new Date(record.ts) }).append(record);
    }
    const page = loadConversation(root, 'r52')!;
    assert.equal(page.total, 53);
    assert.equal(page.turns[0]!.request_id, 'r0');
    assert.equal(page.turns.length, 50);
    assert.equal(page.nextOffset, 50);
    assert.equal('retrieval' in page.turns[0]!, false);
    assert.equal('input_snapshot' in page.turns[0]!, false);
    assert.equal(loadTrafficWindow(root, 'all').records.some((record) => record.input_snapshot !== undefined), false);
    assert.equal(loadRunDetail(root, 'r0')!.input_snapshot?.question, 'old input');
    const policyRun = { ...records[0]!, request_id: 'limited', session_id: null, query: 'private query' };
    new RunsWriter({ stateRoot: root, enabled: true, truncateQueryChars: 3 }).append(policyRun);
    const limited = loadRunDetail(root, 'limited')!;
    assert.equal(limited.query, 'pri');
    assert.equal(limited.input_snapshot_status, 'omitted_by_policy');
    assert.equal(limited.input_snapshot, undefined);
    const last = loadConversation(root, 'r52', 50)!;
    assert.equal(last.turns.length, 3);
    assert.equal(last.nextOffset, null);
    assert.equal(loadConversation(root, 'r61')!.total, 1);
    assert.equal(loadConversation(root, 'not-found'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transcript markdown renders formatting but never executes HTML, unsafe links, or remote images', () => {
  const html = renderTranscriptMarkdown('**bold**\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29) ![remote](https://evil.example/track) [docs](https://example.com)');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('href="https://example.com"'));
});
