import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEvalReport } from '../src/console/eval-state.ts';

test('parseEvalReport reads the current eval summary metrics', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'anydocs-eval-state-'));
  try {
    const reports = join(stateRoot, 'reports');
    await mkdir(reports);
    await writeFile(
      join(reports, '2026-09-16-eval.md'),
      '<!-- EVAL_SUMMARY {"date":"2026-09-16","summary":{"n":12,"mrr":0.75,"hit_at_5":0.92,"context_precision_at_5":0.68,"citation_anchor_pass":0.83,"kind_pass":1,"api_rule_pass":0.9}} -->\n',
    );

    const summary = parseEvalReport(stateRoot, '2026-09-16-eval.md');

    assert.equal(summary.cases, 12);
    assert.equal(summary.mrr, 0.75);
    assert.equal(summary.hit_at_5, 0.92);
    assert.equal(summary.context_precision_at_5, 0.68);
    assert.equal(summary.citation_anchor_pass, 0.83);
    assert.equal(summary.kind_pass, 1);
    assert.equal(summary.api_rule_pass, 0.9);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('parseEvalReport maps legacy r_at_5 to hit_at_5', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'anydocs-eval-state-legacy-'));
  try {
    const reports = join(stateRoot, 'reports');
    await mkdir(reports);
    await writeFile(
      join(reports, '2026-09-15-eval.md'),
      '<!-- EVAL_SUMMARY {"date":"2026-09-15","summary":{"n":10,"mrr":0.7,"r_at_5":0.8,"context_precision_at_5":0.6,"citation_anchor_pass":0.9,"kind_pass":1,"api_rule_pass":null}} -->\n',
    );

    const summary = parseEvalReport(stateRoot, '2026-09-15-eval.md');

    assert.equal(summary.hit_at_5, 0.8);
    assert.equal(summary.api_rule_pass, null);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
