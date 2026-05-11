/**
 * console/ops.ts unit tests — findLatestReport, isReportFilename,
 * listReports. Defaults wrappers (defaultOps.eval / .analyzeRuns / etc.)
 * are exercised indirectly via console-server tests with stubs; here we
 * cover the pure helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestReport,
  isReportFilename,
  listReports,
} from '../src/console/ops.ts';

async function withTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await fs.mkdtemp(join(tmpdir(), 'anydocs-console-ops-'));
  return { path, cleanup: () => fs.rm(path, { recursive: true, force: true }) };
}

async function writeReport(stateRoot: string, filename: string, body = '# stub'): Promise<void> {
  const dir = join(stateRoot, 'reports');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, filename), body);
}

test('isReportFilename: accepts canonical pattern', () => {
  assert.equal(isReportFilename('2026-05-08-eval.md'), true);
  assert.equal(isReportFilename('2026-12-31-analyze.md'), true);
  assert.equal(isReportFilename('2026-01-01-baseline.md'), true);
});

test('isReportFilename: rejects path traversal + wrong shapes', () => {
  assert.equal(isReportFilename('../etc/passwd'), false);
  assert.equal(isReportFilename('2026-05-08-eval.md.bak'), false);
  assert.equal(isReportFilename('eval-2026-05-08.md'), false);
  assert.equal(isReportFilename('2026-5-8-eval.md'), false);
  assert.equal(isReportFilename('2026-05-08-other.md'), false);
});

test('findLatestReport: returns null when no reports/ dir', async () => {
  const { path: state, cleanup } = await withTmpDir();
  try {
    assert.equal(findLatestReport(state, 'eval'), null);
  } finally {
    await cleanup();
  }
});

test('findLatestReport: picks highest date for the requested kind', async () => {
  const { path: state, cleanup } = await withTmpDir();
  try {
    await writeReport(state, '2026-05-01-eval.md');
    await writeReport(state, '2026-05-08-eval.md');
    await writeReport(state, '2026-05-08-analyze.md');
    await writeReport(state, '2026-05-09-baseline.md');
    assert.equal(
      findLatestReport(state, 'eval'),
      join(state, 'reports', '2026-05-08-eval.md'),
    );
    assert.equal(
      findLatestReport(state, 'analyze'),
      join(state, 'reports', '2026-05-08-analyze.md'),
    );
    assert.equal(
      findLatestReport(state, 'baseline'),
      join(state, 'reports', '2026-05-09-baseline.md'),
    );
  } finally {
    await cleanup();
  }
});

test('listReports: returns [] when reports/ missing', async () => {
  const { path: state, cleanup } = await withTmpDir();
  try {
    assert.deepEqual(listReports(state), []);
  } finally {
    await cleanup();
  }
});

test('listReports: lists matching files newest first, ignores non-matches', async () => {
  const { path: state, cleanup } = await withTmpDir();
  try {
    await writeReport(state, '2026-05-01-eval.md', 'A');
    await writeReport(state, '2026-05-08-eval.md', 'B');
    await writeReport(state, '2026-05-08-analyze.md', 'CC');
    await writeReport(state, 'README.md');
    await writeReport(state, 'logs.log');
    const out = listReports(state);
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((r) => r.filename),
      ['2026-05-08-eval.md', '2026-05-08-analyze.md', '2026-05-01-eval.md'],
    );
    assert.equal(out[0]!.kind, 'eval');
    assert.equal(out[1]!.kind, 'analyze');
    assert.equal(out[0]!.date, '2026-05-08');
    assert.equal(out[1]!.sizeBytes, 2);
  } finally {
    await cleanup();
  }
});
