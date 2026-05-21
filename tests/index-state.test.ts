/**
 * Coverage for `loadAskUsageStats` — RFC 0002 T4 reverse-mark aggregation.
 *
 * Verifies the three boundaries that drive the §5.3 chip semantics:
 *   • dedupe per (run, page) so multi-chunk hits don't inflate the count;
 *   • drop pages below ASK_STATS_MIN_COUNT (noise floor);
 *   • median confidence math + null-confidence handling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASK_STATS_MIN_COUNT,
  loadAskUsageStats,
} from '../src/console/index-state.ts';

async function withTmpStateRoot(): Promise<{ stateRoot: string; cleanup: () => Promise<void> }> {
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-index-stats-'));
  return { stateRoot, cleanup: () => fs.rm(stateRoot, { recursive: true, force: true }) };
}

async function writeRuns(stateRoot: string, lines: Array<Record<string, unknown>>): Promise<void> {
  const dir = join(stateRoot, 'runs');
  await fs.mkdir(dir, { recursive: true });
  const now = new Date();
  const isoWeek = String(
    Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      Date.UTC(now.getUTCFullYear(), 0, 1)) / 86_400_000 / 7) + 1,
  ).padStart(2, '0');
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await fs.writeFile(join(dir, `${now.getUTCFullYear()}-W${isoWeek}.jsonl`), content);
}

function run(
  answerId: string,
  pages: string[],
  opts: { confidence?: number | null; tsOffsetMs?: number } = {},
): Record<string, unknown> {
  const ts = new Date(Date.now() - (opts.tsOffsetMs ?? 0)).toISOString();
  return {
    ts,
    request_id: 'req_' + answerId,
    session_id: null,
    query: 'q',
    filters: {},
    context_pageId: null,
    source: 'reader',
    retrieval: {
      fused: pages.map((page, i) => ({
        chunk_id: i + 1,
        page,
        rrf_score: 0.5,
        final_score: 0.5,
        vec_rank: i + 1,
        bm25_rank: i + 1,
        nav_index: null,
        nav_index_boost: 0,
      })),
      subtree_ask_triggered: false,
    },
    answer: {
      kind: 'answer',
      answer_id: answerId,
      md: 'a',
      citations: [],
      confidence: 'confidence' in opts ? opts.confidence : 0.7,
      latency_ms: 100,
      tokens_in: null,
      tokens_out: null,
      model: 'mock',
      error_code: null,
    },
    feedback: { beta: null, gamma: null },
  };
}

test('loadAskUsageStats: drops pages below the noise floor', async () => {
  const { stateRoot, cleanup } = await withTmpStateRoot();
  try {
    // 2 hits on pageA, 4 on pageB. Only B should appear (MIN_COUNT = 3).
    await writeRuns(stateRoot, [
      run('a1', ['pageA']),
      run('a2', ['pageA']),
      run('b1', ['pageB']),
      run('b2', ['pageB']),
      run('b3', ['pageB']),
      run('b4', ['pageB']),
    ]);
    const stats = loadAskUsageStats(stateRoot, 7);
    assert.equal(stats.byPageId.has('pageA'), false, 'pageA below MIN_COUNT must be absent');
    assert.equal(stats.byPageId.get('pageB')?.count, 4);
    assert.ok(ASK_STATS_MIN_COUNT === 3, 'sanity: MIN_COUNT is 3 by RFC');
  } finally {
    await cleanup();
  }
});

test('loadAskUsageStats: dedupes pages within a single run (multi-chunk hits = 1 ask)', async () => {
  const { stateRoot, cleanup } = await withTmpStateRoot();
  try {
    // One run with three chunks all from pageX, plus two other runs hitting
    // pageX. The page should report count=3, not 5.
    await writeRuns(stateRoot, [
      run('a1', ['pageX', 'pageX', 'pageX']),
      run('a2', ['pageX']),
      run('a3', ['pageX']),
    ]);
    const stats = loadAskUsageStats(stateRoot, 7);
    assert.equal(stats.byPageId.get('pageX')?.count, 3);
  } finally {
    await cleanup();
  }
});

test('loadAskUsageStats: median confidence is robust to nulls', async () => {
  const { stateRoot, cleanup } = await withTmpStateRoot();
  try {
    // Three runs hitting pageY: confidences 0.2, 0.8, null.
    // Median should be of the non-null values → median(0.2, 0.8) = 0.5.
    await writeRuns(stateRoot, [
      run('a1', ['pageY'], { confidence: 0.2 }),
      run('a2', ['pageY'], { confidence: 0.8 }),
      run('a3', ['pageY'], { confidence: null }),
    ]);
    const entry = loadAskUsageStats(stateRoot, 7).byPageId.get('pageY');
    assert.ok(entry);
    assert.equal(entry!.count, 3);
    assert.equal(entry!.medianConfidence, 0.5);
  } finally {
    await cleanup();
  }
});

test('loadAskUsageStats: medianConfidence is null when every hit had null confidence', async () => {
  const { stateRoot, cleanup } = await withTmpStateRoot();
  try {
    await writeRuns(stateRoot, [
      run('a1', ['pageZ'], { confidence: null }),
      run('a2', ['pageZ'], { confidence: null }),
      run('a3', ['pageZ'], { confidence: null }),
    ]);
    const entry = loadAskUsageStats(stateRoot, 7).byPageId.get('pageZ');
    assert.equal(entry!.count, 3);
    assert.equal(entry!.medianConfidence, null);
  } finally {
    await cleanup();
  }
});

test('loadAskUsageStats: ignores runs outside the window', async () => {
  const { stateRoot, cleanup } = await withTmpStateRoot();
  try {
    // 3 fresh hits + 3 old hits (10 days back). Window default 7d should
    // only count the fresh ones.
    await writeRuns(stateRoot, [
      run('fresh1', ['pageW']),
      run('fresh2', ['pageW']),
      run('fresh3', ['pageW']),
      run('old1', ['pageW'], { tsOffsetMs: 10 * 86_400_000 }),
      run('old2', ['pageW'], { tsOffsetMs: 10 * 86_400_000 }),
      run('old3', ['pageW'], { tsOffsetMs: 10 * 86_400_000 }),
    ]);
    assert.equal(loadAskUsageStats(stateRoot, 7).byPageId.get('pageW')?.count, 3);
  } finally {
    await cleanup();
  }
});

test('loadAskUsageStats: missing runs/ directory returns empty stats', async () => {
  const { stateRoot, cleanup } = await withTmpStateRoot();
  try {
    const stats = loadAskUsageStats(stateRoot, 7);
    assert.equal(stats.byPageId.size, 0);
    assert.equal(stats.days, 7);
  } finally {
    await cleanup();
  }
});

test('loadAskUsageStats: skips feedback-update tail records', async () => {
  const { stateRoot, cleanup } = await withTmpStateRoot();
  try {
    await writeRuns(stateRoot, [
      run('a1', ['pageQ']),
      run('a2', ['pageQ']),
      run('a3', ['pageQ']),
      // The reader skips `type='feedback-update'` records; if the loader
      // accidentally treated them as RunRecords, it'd crash on
      // `rec.retrieval.fused`.
      { type: 'feedback-update', ts: new Date().toISOString(), request_id: 'r', feedback: {} },
    ]);
    const entry = loadAskUsageStats(stateRoot, 7).byPageId.get('pageQ');
    assert.equal(entry!.count, 3);
  } finally {
    await cleanup();
  }
});
