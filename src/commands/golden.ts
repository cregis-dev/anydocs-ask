/**
 * `anydocs-ask golden generate|review <projectRoot>` — manage the project's
 * golden case set under `<workspace>/state/<projectId>/golden/`.
 *
 *   golden generate <projectRoot> [--from structure|runs|inbox]
 *                                 [--limit N]
 *                                 [--no-llm-rewrite]
 *                                 [--force]
 *   golden review   <projectRoot> [--reviewer <name>]
 *
 * v1 ships only `--from structure`; the runs / inbox sources are stubbed
 * with a clear "next phase" error so the CLI surface is final.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { loadProject } from '../anydocs/loader.ts';
import { generateFromStructure } from '../golden/generator.ts';
import { generateFromRuns } from '../golden/generator-from-runs.ts';
import { rewriteCandidatesWithLLM } from '../golden/llm-rewrite.ts';
import { reviewCandidates } from '../golden/reviewer.ts';
import { goldenPaths, readApproved, writeCandidates } from '../golden/store.ts';
import { buildDefaultLLM } from '../llm/factory.ts';
import { iterateRunsSince } from '../runs/writer.ts';
import { parseSince } from './runs.ts';
import type { RunRecord, RunsLine } from '../runs/types.ts';

export type GoldenGenerateOptions = {
  projectRoot: string;
  stateRoot: string;
  from: 'structure' | 'runs' | 'inbox';
  limit?: number;
  /** --since flag for `--from runs`. Parsed via runs.ts:parseSince.
   *  Default 14d (PRD §12.4). */
  since?: string;
  llmRewrite: boolean;
  force: boolean;
};

const FROM_RUNS_DEFAULT_SINCE = '14d';

export async function runGoldenGenerate(opts: GoldenGenerateOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const paths = goldenPaths(stateRoot);

  if (existsSync(paths.candidates) && !opts.force) {
    process.stderr.write(
      `error: ${paths.candidates} already exists.\n` +
        `       Run 'anydocs-ask golden review ${opts.projectRoot}' to flush ` +
        `decided candidates first, or pass --force to overwrite.\n`,
    );
    return 1;
  }

  if (opts.from === 'inbox') {
    process.stderr.write(
      `error: --from inbox is v1.5 (depends on §15 feedback inbox); ` +
        `use --from structure or --from runs in v1.\n`,
    );
    return 2;
  }

  if (opts.from === 'runs') {
    return await runFromRuns(projectRoot, stateRoot, opts);
  }

  const project = await loadProject(projectRoot);
  for (const w of project.warnings) process.stderr.write(`[ask] ${w}\n`);

  let candidates = generateFromStructure(project, { limit: opts.limit });
  if (candidates.length === 0) {
    process.stderr.write(
      `error: navigation produced 0 candidate questions; check that ${projectRoot}/navigation/*.json reference published pages.\n`,
    );
    return 1;
  }

  if (opts.llmRewrite) {
    const { config } = await loadConfig(projectRoot);
    let llm;
    try {
      llm = buildDefaultLLM(config);
    } catch (err) {
      process.stderr.write(
        `error: LLM rewrite requires Anthropic credentials.\n` +
          `       ${(err as Error).message}\n` +
          `       Pass --no-llm-rewrite to fall back to template-only candidates ` +
          `(lower quality but no API call).\n`,
      );
      return 1;
    }
    process.stdout.write(
      `anydocs-ask: rewriting ${candidates.length} candidates via ${config.llm.provider}/${config.llm.model}...\n`,
    );
    try {
      candidates = await rewriteCandidatesWithLLM(candidates, { llm });
    } catch (err) {
      process.stderr.write(
        `error: LLM rewrite failed: ${(err as Error).message}\n` +
          `       Pass --no-llm-rewrite to skip this step.\n`,
      );
      return 1;
    }
  }

  const written = writeCandidates(stateRoot, candidates);
  process.stdout.write(
    `anydocs-ask golden generate: wrote ${candidates.length} candidates to ${written}\n` +
      `  next: edit decision: "approved" / "rejected" inline, then run 'anydocs-ask golden review ${opts.projectRoot}'.\n`,
  );
  return 0;
}

async function runFromRuns(
  projectRoot: string,
  stateRoot: string,
  opts: GoldenGenerateOptions,
): Promise<number> {
  const sinceArg = opts.since ?? FROM_RUNS_DEFAULT_SINCE;
  const sinceMs = parseSince(sinceArg);
  if (sinceMs === null) {
    process.stderr.write(
      `invalid --since '${sinceArg}'; expected ISO date or duration (7d / 48h / 30m).\n`,
    );
    return 2;
  }

  // Collect run records from the window (drop feedback-update tails).
  const records: RunRecord[] = [];
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if ('type' in line && line.type === 'feedback-update') continue;
    records.push(line as RunRecord);
  }
  if (records.length === 0) {
    process.stderr.write(
      `error: no runs since ${sinceArg}. serve the project, answer ≥1 query, ` +
        `then retry — or pass --since 30d to widen.\n`,
    );
    return 1;
  }

  const { rows: existingCases } = readApproved(stateRoot);
  process.stdout.write(
    `anydocs-ask golden generate --from runs: ${records.length} runs since ${sinceArg}, ` +
      `${existingCases.length} approved cases for dedup\n`,
  );

  const { candidates, stats } = generateFromRuns(records, {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    existingCases,
  });

  process.stdout.write(
    `  filter: total=${stats.total} ` +
      `non-answer=${stats.droppedNonAnswer} ` +
      `low-conf=${stats.droppedLowConf} ` +
      `long-answer=${stats.droppedLongAnswer} ` +
      `reasked=${stats.droppedReask}\n` +
      `  cluster: ${stats.clusters} clusters, ${stats.droppedDuplicate} dropped as dup of existing cases\n`,
  );

  if (candidates.length === 0) {
    process.stderr.write(
      `(no candidates produced; loosen --since or check that runs have confidence ≥0.7 ` +
        `and answer.md ≤600 chars.)\n`,
    );
    return 0;
  }

  const written = writeCandidates(stateRoot, candidates);
  process.stdout.write(
    `anydocs-ask golden generate: wrote ${candidates.length} candidates to ${written}\n` +
      `  next: edit decision: "approved"/"rejected" inline (verify must_cite_pages — ` +
      `they reflect what the system did, not necessarily what was correct), then ` +
      `'anydocs-ask golden review ${opts.projectRoot}'.\n`,
  );
  return 0;
}

export type GoldenReviewOptions = {
  projectRoot: string;
  stateRoot: string;
  reviewer?: string;
};

export function runGoldenReview(opts: GoldenReviewOptions): number {
  const stateRoot = resolve(opts.stateRoot);
  const paths = goldenPaths(stateRoot);
  if (!existsSync(paths.candidates)) {
    process.stderr.write(
      `no candidate file at ${paths.candidates}; run 'anydocs-ask golden generate ${opts.projectRoot}' first.\n`,
    );
    return 1;
  }
  const summary = reviewCandidates(stateRoot, { reviewer: opts.reviewer ?? null });
  process.stdout.write(
    `anydocs-ask golden review:\n` +
      `  approved: ${summary.approved} -> ${paths.cases}\n` +
      `  rejected: ${summary.rejected}\n` +
      `  pending:  ${summary.pending} (left in ${paths.candidates})\n` +
      (summary.malformed > 0 ? `  malformed: ${summary.malformed} (skipped)\n` : ''),
  );
  return 0;
}
