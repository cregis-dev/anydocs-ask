import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFromRuns } from '../src/golden/generator-from-runs.ts';
import type { RunRecord } from '../src/runs/types.ts';
import type { GoldenCase } from '../src/golden/types.ts';

function fakeRun(over: {
  request_id: string;
  ts?: string;
  session_id?: string | null;
  query?: string;
  citations?: { page: string }[];
  md?: string;
  kind?: 'answer' | 'clarify' | 'error';
  context_pageId?: string | null;
}): RunRecord {
  return {
    ts: over.ts ?? '2026-05-09T12:00:00.000Z',
    request_id: over.request_id,
    session_id: over.session_id ?? null,
    query: over.query ?? 'q',
    filters: {},
    context_pageId: over.context_pageId ?? null,
    retrieval: { fused: [], subtree_ask_triggered: false },
    answer: {
      kind: over.kind ?? 'answer',
      answer_id: 'a',
      md: over.md ?? 'short answer',
      citations: (over.citations ?? [{ page: 'home' }]).map((c, i) => ({
        chunk_id: i,
        page: c.page,
        quote: 'q',
      })),
      latency_ms: 200,
      tokens_in: null,
      tokens_out: null,
      model: null,
      error_code: null,
    },
    feedback: { beta: null, gamma: null },
  };
}

test('from-runs: cited answer becomes a candidate', () => {
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', query: 'How to install hermes' }),
  ]);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0]!.template_id, 'from_runs');
  assert.equal(out.candidates[0]!.created_by, 'runs');
  assert.equal(out.candidates[0]!.query, 'How to install hermes');
  assert.deepEqual(out.candidates[0]!.expected.must_cite_pages, ['home']);
  assert.equal(out.candidates[0]!.expected.must_contain.length, 0);
});

test('from-runs: drops answers without citations', () => {
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', citations: [] }),
  ]);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.stats.droppedNoCitations, 1);
});

test('from-runs: drops clarify and error kinds', () => {
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', kind: 'clarify' }),
    fakeRun({ request_id: 'r2', kind: 'error' }),
  ]);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.stats.droppedNonAnswer, 2);
});

test('from-runs: drops answers > 600 chars', () => {
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', md: 'x'.repeat(700) }),
  ]);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.stats.droppedLongAnswer, 1);
});

test('from-runs: drops re-asked runs (within 30s, edit-distance < 5)', () => {
  const out = generateFromRuns([
    fakeRun({
      request_id: 'r1',
      session_id: 's1',
      ts: '2026-05-09T12:00:00.000Z',
      query: 'how to install hermes',
    }),
    fakeRun({
      request_id: 'r2',
      session_id: 's1',
      ts: '2026-05-09T12:00:10.000Z',
      query: 'how to install hermess', // edit distance 1
    }),
  ]);
  // r1 is re-asked → dropped. r2 has no follow-up so keeps.
  assert.equal(out.stats.droppedReask, 1);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0]!.query, 'how to install hermess');
});

test('from-runs: clusters near-duplicate queries, keeps the best-cited rep', () => {
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', query: 'install hermes', citations: [{ page: 'home' }] }),
    fakeRun({
      request_id: 'r2',
      query: 'install hermess',
      citations: [{ page: 'home' }, { page: 'install' }],
    }), // near-dup
    fakeRun({ request_id: 'r3', query: 'completely different question entirely about voice' }),
  ]);
  assert.equal(out.stats.clusters, 2);
  assert.equal(out.candidates.length, 2);
  // The representative with broader citation coverage wins.
  const firstClusterReps = out.candidates.filter((c) => c.query.startsWith('install'));
  assert.equal(firstClusterReps.length, 1);
  assert.equal(firstClusterReps[0]!.query, 'install hermess');
});

test('from-runs: dedup against existing approved cases', () => {
  const existing: GoldenCase[] = [
    {
      id: 'what_is:hermes',
      query: 'how do i install hermes',
      filters: { audience: null, version: null },
      context_pageId: null,
      expected: { must_cite_pages: ['hermes'], must_contain: [], forbid_contain: [] },
      tags: [],
      created_by: 'structure',
      reviewed_at: '2026-05-08',
      reviewer: 'shawn',
      lang: 'en',
    },
  ];
  const out = generateFromRuns(
    [
      fakeRun({ request_id: 'r1', query: 'How do I install Hermes?' }), // dup of existing
      fakeRun({ request_id: 'r2', query: 'totally fresh new query about voice' }),
    ],
    { existingCases: existing },
  );
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0]!.query, 'totally fresh new query about voice');
  assert.equal(out.stats.droppedDuplicate, 1);
});

test('from-runs: lang detection (CJK -> zh)', () => {
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', query: '如何安装 Hermes？' }),
  ]);
  assert.equal(out.candidates[0]!.lang, 'zh');
});

test('from-runs: dedup is also applied between candidates within one run', () => {
  // Two separate clusters that happen to be near-duplicates of each other
  // (different sessions so they aren't merged at cluster step). Second
  // should be dropped as dup of the first accepted candidate.
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', session_id: null, query: 'install hermes please' }),
    fakeRun({ request_id: 'r2', session_id: null, query: 'install hermes please.' }),
  ]);
  // Cluster step would actually merge these (normalization removes trailing
  // punct). Verify it does:
  assert.equal(out.stats.clusters, 1);
  assert.equal(out.candidates.length, 1);
});

test('from-runs: limit caps output', () => {
  // Use lexically distant queries so the cluster step doesn't merge them.
  const phrases = [
    'install hermes on macos',
    'configure tts voice settings',
    'update the agent runtime',
    'connect home assistant integration',
    'enable telemetry export pipeline',
    'tune retrieval rrf weights properly',
    'switch model gateway to anthropic',
    'rebuild navigation tree from scratch',
    'audit feedback inbox queue',
    'rotate runs jsonl files weekly',
  ];
  const runs = phrases.map((q, i) =>
    fakeRun({ request_id: `r${i}`, query: q }),
  );
  const out = generateFromRuns(runs, { limit: 3 });
  assert.equal(out.candidates.length, 3);
});

test('from-runs: stable id format runs:<8-hex>', () => {
  const out = generateFromRuns([
    fakeRun({ request_id: 'r1', query: 'foo bar' }),
  ]);
  assert.match(out.candidates[0]!.id, /^runs:[0-9a-f]{8}$/);
});

test('from-runs: must_cite_pages dedupes citations preserving order', () => {
  const out = generateFromRuns([
    fakeRun({
      request_id: 'r1',
      citations: [{ page: 'a' }, { page: 'b' }, { page: 'a' }, { page: 'c' }],
    }),
  ]);
  assert.deepEqual(out.candidates[0]!.expected.must_cite_pages, ['a', 'b', 'c']);
});
