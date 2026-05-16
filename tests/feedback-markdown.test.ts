/**
 * Inbox markdown round-trip — emit → parse → recover frontmatter + body
 * sections. Retrieved-chunk rendering is one-way (lossy by design), so we
 * only assert structured fields round-trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitInbox, parseInbox, InboxParseError } from '../src/feedback/markdown.ts';
import type { InboxFile } from '../src/feedback/types.ts';

function makeFile(over: Partial<InboxFile['frontmatter']> = {}, body?: Partial<InboxFile['body']>): InboxFile {
  return {
    frontmatter: {
      cluster_id: '2026-W20-001-how-to-authenticate',
      created_at_iso: '2026-05-16T10:24:00.000Z',
      queries: ['how to authenticate'],
      sample_answer_id: 'ans_abc',
      current_page_id: 'p_intro',
      signal_source: 'explicit',
      explicit_negative: 1,
      implicit_negative: 0,
      bad_citation_ids: ['cit_2'],
      decision: 'pending',
      notes: '',
      ...over,
    },
    body: {
      systemAnswer: 'You authenticate with a JWT bearer token.',
      retrievedChunks: [
        { chunk_id: 1, breadcrumb: 'Docs › Auth › JWT', snippet: 'send Authorization: Bearer …' },
      ],
      correctedAnswer: '',
      ...body,
    },
  };
}

test('round-trip: pending frontmatter recovers identity', () => {
  const file = makeFile();
  const md = emitInbox(file);
  const back = parseInbox(md);
  assert.deepEqual(back.frontmatter, file.frontmatter);
});

test('round-trip: corrected_answer body section preserved verbatim', () => {
  const correction = 'No, the correct flow uses session cookies.\n\nSee §5.';
  const file = makeFile({ decision: 'approved' }, { correctedAnswer: correction });
  const back = parseInbox(emitInbox(file));
  assert.equal(back.body.correctedAnswer, correction);
});

test('round-trip: system answer body section preserved', () => {
  const ans = '# Auth\n\nUse a bearer token.';
  const file = makeFile({}, { systemAnswer: ans });
  const back = parseInbox(emitInbox(file));
  assert.equal(back.body.systemAnswer, ans);
});

test('round-trip: bad_citation_ids array preserved across decision change', () => {
  // Simulates author flipping decision in their editor before re-import.
  const file = makeFile({ bad_citation_ids: ['cit_2', 'cit_7'] });
  const md = emitInbox(file).replace('decision: pending', 'decision: approved');
  const back = parseInbox(md);
  assert.deepEqual(back.frontmatter.bad_citation_ids, ['cit_2', 'cit_7']);
  assert.equal(back.frontmatter.decision, 'approved');
});

test('parse: rejects unknown decision value', () => {
  const md = emitInbox(makeFile()).replace('decision: pending', 'decision: maybe');
  assert.throws(() => parseInbox(md), InboxParseError);
});

test('parse: rejects missing required field', () => {
  const md = emitInbox(makeFile()).replace(/queries:.*/, '');
  assert.throws(() => parseInbox(md), InboxParseError);
});

test('parse: rejects missing leading fence', () => {
  assert.throws(() => parseInbox('cluster_id: x\n---'), /leading '---' fence/);
});

test('parse: rejects unterminated frontmatter', () => {
  assert.throws(() => parseInbox('---\ncluster_id: x\n'), /unterminated frontmatter/);
});

test('parse: queries with embedded commas survive (inline-array quoting)', () => {
  const file = makeFile({ queries: ['hello, world', 'again'] });
  const back = parseInbox(emitInbox(file));
  assert.deepEqual(back.frontmatter.queries, ['hello, world', 'again']);
});

test('parse: chinese question text survives the round-trip', () => {
  const file = makeFile({
    cluster_id: '2026-W20-001-如何鉴权',
    queries: ['如何鉴权', '鉴权怎么搞'],
  });
  const back = parseInbox(emitInbox(file));
  assert.deepEqual(back.frontmatter.queries, ['如何鉴权', '鉴权怎么搞']);
  assert.equal(back.frontmatter.cluster_id, '2026-W20-001-如何鉴权');
});

test('emit: produces a valid section ordering (frontmatter → System → Retrieved → Corrected)', () => {
  const md = emitInbox(makeFile());
  const idxSys = md.indexOf('## System answer');
  const idxRet = md.indexOf('## Retrieved chunks');
  const idxCor = md.indexOf('## Corrected answer');
  assert.ok(idxSys > 0 && idxRet > idxSys && idxCor > idxRet);
});
