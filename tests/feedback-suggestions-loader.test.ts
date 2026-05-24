/**
 * RFC 0006 A7 alpha.3 — suggestions-loader tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSuggestions, readSuggestionMarkdown } from '../src/feedback/suggestions-loader.ts';

function tmp(): { stateRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ask-aplus-loader-'));
  return {
    stateRoot: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeTrace(
  dir: string,
  clusterId: string,
  overrides: Partial<{
    size: number;
    density: number;
    members: number[];
    memberQuestions: string[];
    centerQuestion: string;
  }> = {},
): void {
  mkdirSync(dir, { recursive: true });
  const members = overrides.members ?? [1, 2, 3];
  const memberQuestions =
    overrides.memberQuestions ?? members.map((m) => `Q${m}`);
  const trace = {
    cluster_id: clusterId,
    size: overrides.size ?? members.length,
    density: overrides.density ?? 0.8,
    center_question: overrides.centerQuestion ?? memberQuestions[0],
    center_feedback_id: members[0],
    members,
    member_questions: memberQuestions,
    suggestion: { model: 'mock', latency_ms: 100 },
  };
  writeFileSync(join(dir, `${clusterId}.json`), JSON.stringify(trace, null, 2));
  writeFileSync(join(dir, `${clusterId}.md`), `# Suggestion for ${clusterId}\n`);
}

test('loadSuggestions returns empty snapshot when stateRoot is null', () => {
  const snap = loadSuggestions(null);
  assert.equal(snap.entries.length, 0);
  assert.equal(snap.hasEnabled, false);
  assert.equal(snap.hasShadow, false);
  assert.equal(snap.memberIndex.size, 0);
});

test('loadSuggestions returns empty snapshot when suggestions dir is missing', () => {
  const { stateRoot, cleanup } = tmp();
  try {
    const snap = loadSuggestions(stateRoot);
    assert.equal(snap.entries.length, 0);
    assert.equal(snap.hasEnabled, false);
    assert.equal(snap.hasShadow, false);
  } finally {
    cleanup();
  }
});

test('loadSuggestions parses enabled traces; sorts by size DESC then density DESC', () => {
  const { stateRoot, cleanup } = tmp();
  try {
    const dir = join(stateRoot, 'feedback', 'suggestions');
    writeTrace(dir, 'c_aaaaaaaaaaaa', { size: 3, density: 0.9, members: [10, 11, 12] });
    writeTrace(dir, 'c_bbbbbbbbbbbb', { size: 5, density: 0.7, members: [20, 21, 22, 23, 24] });
    writeTrace(dir, 'c_cccccccccccc', { size: 3, density: 0.95, members: [30, 31, 32] });

    const snap = loadSuggestions(stateRoot);

    assert.equal(snap.entries.length, 3);
    assert.equal(snap.hasEnabled, true);
    assert.equal(snap.hasShadow, false);

    // size 5 first; then size 3 entries by density DESC.
    assert.equal(snap.entries[0]!.clusterId, 'c_bbbbbbbbbbbb');
    assert.equal(snap.entries[1]!.clusterId, 'c_cccccccccccc');
    assert.equal(snap.entries[2]!.clusterId, 'c_aaaaaaaaaaaa');

    // memberIndex covers all 11 members.
    assert.equal(snap.memberIndex.size, 11);
    assert.equal(snap.memberIndex.get(20), 'c_bbbbbbbbbbbb');
    assert.equal(snap.memberIndex.get(10), 'c_aaaaaaaaaaaa');
  } finally {
    cleanup();
  }
});

test('loadSuggestions reads .shadow/ dir; enabled wins on clusterId collision', () => {
  const { stateRoot, cleanup } = tmp();
  try {
    const base = join(stateRoot, 'feedback', 'suggestions');
    writeTrace(base, 'c_enabled11111', { members: [1, 2] });
    writeTrace(join(base, '.shadow'), 'c_shadowwww11', { members: [3, 4] });
    // Collision — enabled should win.
    writeTrace(base, 'c_both11111111', { members: [10], memberQuestions: ['enabled Q'] });
    writeTrace(join(base, '.shadow'), 'c_both11111111', {
      members: [99],
      memberQuestions: ['shadow Q'],
    });

    const snap = loadSuggestions(stateRoot);

    assert.equal(snap.hasEnabled, true);
    assert.equal(snap.hasShadow, true);
    assert.equal(snap.entries.length, 3);

    const collision = snap.entries.find((e) => e.clusterId === 'c_both11111111')!;
    assert.deepEqual(collision.members, [10]);
    assert.equal(collision.shadow, false);

    const shadowOnly = snap.entries.find((e) => e.clusterId === 'c_shadowwww11')!;
    assert.equal(shadowOnly.shadow, true);
  } finally {
    cleanup();
  }
});

test('loadSuggestions skips malformed JSON + non-cluster files', () => {
  const { stateRoot, cleanup } = tmp();
  try {
    const dir = join(stateRoot, 'feedback', 'suggestions');
    mkdirSync(dir, { recursive: true });
    // Valid one.
    writeTrace(dir, 'c_valid1111111', { members: [1] });
    // Garbage.
    writeFileSync(join(dir, 'c_garbage12345.json'), 'not json {{');
    // Missing required fields.
    writeFileSync(join(dir, 'c_partial12345.json'), JSON.stringify({ cluster_id: 'x' }));
    // Non-cluster file (should be ignored, not warn).
    writeFileSync(join(dir, 'README.md'), '# notes');
    writeFileSync(join(dir, 'other.json'), '{}');

    const snap = loadSuggestions(stateRoot);
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0]!.clusterId, 'c_valid1111111');
  } finally {
    cleanup();
  }
});

test('loadSuggestions resolves markdownPath alongside trace', () => {
  const { stateRoot, cleanup } = tmp();
  try {
    const dir = join(stateRoot, 'feedback', 'suggestions');
    writeTrace(dir, 'c_pathcheck111');

    const snap = loadSuggestions(stateRoot);
    const entry = snap.entries[0]!;

    assert.equal(entry.markdownPath, join(dir, 'c_pathcheck111.md'));
    assert.equal(entry.tracePath, join(dir, 'c_pathcheck111.json'));

    const md = readSuggestionMarkdown(entry.markdownPath);
    assert.match(md ?? '', /Suggestion for c_pathcheck111/);
  } finally {
    cleanup();
  }
});

test('readSuggestionMarkdown returns null when file missing', () => {
  assert.equal(readSuggestionMarkdown('/nonexistent/path/c_x.md'), null);
});
