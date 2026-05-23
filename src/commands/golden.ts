/**
 * `anydocs-ask golden generate|review <projectRoot>` — manage the project's
 * golden case set under `<workspace>/state/<projectId>/golden/`.
 *
 *   golden generate <projectRoot> [--from structure|runs|inbox]
 *                                 [--limit N]
 *                                 [--no-llm-rewrite]
 *                                 [--force]
 *   golden review   <projectRoot> [--reviewer <name>]
 *   golden import   <projectRoot> --file <jsonl> [--replace]
 *
 * v1 ships only `--from structure`; the runs / inbox sources are stubbed
 * with a clear "next phase" error so the CLI surface is final.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { loadProject } from '../anydocs/loader.ts';
import { generateFromStructure } from '../golden/generator.ts';
import { generateFromRuns } from '../golden/generator-from-runs.ts';
import { rewriteCandidatesWithLLM } from '../golden/llm-rewrite.ts';
import { reviewCandidates } from '../golden/reviewer.ts';
import {
  appendCases,
  goldenPaths,
  readApproved,
  writeCandidates,
  writeCases,
} from '../golden/store.ts';
import { buildDefaultLLM } from '../llm/factory.ts';
import { iterateRunsSince } from '../runs/writer.ts';
import { parseSince } from './runs.ts';
import { isRunRecord, runSource, type RunRecord, type RunsLine } from '../runs/types.ts';
import type { GoldenCase } from '../golden/types.ts';

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
  /**
   * Include source=console runs as golden candidates. Defaults to false:
   * author dogfood traffic shouldn't auto-promote into the regression set
   * without explicit opt-in. ARCH §17.8.
   */
  includeConsole?: boolean;
  /**
   * When llmRewrite is true and the LLM step fails (missing creds, network,
   * malformed response), downgrade to template-only candidates instead of
   * exiting non-zero. CLI keeps the strict "report don't fudge" behavior
   * (PRD §12.9 verdict #7); Console flips this on so the one-click button
   * stays usable when keys are absent.
   */
  fallbackOnLlmError?: boolean;
  /**
   * Progress reporter for long-running phases (load_project, template_gen,
   * llm_rewrite per batch, final write). Lines are newline-terminated. The
   * CLI uses the default (write to process.stdout); the Console streams the
   * same lines as NDJSON via /golden/generate/stream so the UI shows real
   * batch-level progress instead of a frozen spinner.
   *
   * Actionable errors (file already exists, no runs in window, 0 candidates)
   * also go through this channel so the streaming UI surfaces a helpful
   * message instead of "exited with code 1". They additionally write to
   * stderr so CLI users still get them through `2>` redirection.
   */
  reporter?: (line: string) => void;
};

const FROM_RUNS_DEFAULT_SINCE = '14d';

/**
 * Emit an actionable error: through `report` so the streaming console UI
 * sees it as a log line, AND to stderr so CLI users still get it on the
 * usual error channel for `2>` redirection / exit-code-paired logging.
 */
function emitError(report: (s: string) => void, msg: string): void {
  report(msg);
  process.stderr.write(msg);
}

export async function runGoldenGenerate(opts: GoldenGenerateOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const paths = goldenPaths(stateRoot);
  // CLI keeps the historical `anydocs-ask: ` / `anydocs-ask golden generate: `
  // prefixes on its launch + summary lines so existing scripts that grep them
  // keep working. Streaming context (reporter set) drops the prefix because
  // the UI log box already labels the operation.
  const report = opts.reporter ?? ((s: string) => void process.stdout.write(s));
  const cliPrefix = opts.reporter === undefined ? 'anydocs-ask: ' : '';
  const cliSummaryPrefix =
    opts.reporter === undefined ? 'anydocs-ask golden generate: ' : '';

  if (existsSync(paths.candidates) && !opts.force) {
    emitError(
      report,
      `error: ${paths.candidates} already exists.\n` +
        `       Run 'anydocs-ask golden review ${opts.projectRoot}' to flush ` +
        `decided candidates first, or pass --force to overwrite.\n`,
    );
    return 1;
  }

  if (opts.from === 'inbox') {
    emitError(
      report,
      `error: --from inbox is v1.5 (depends on §15 feedback inbox); ` +
        `use --from structure or --from runs in v1.\n`,
    );
    return 2;
  }

  if (opts.from === 'runs') {
    return await runFromRuns(projectRoot, stateRoot, opts);
  }

  report(`loading project ${projectRoot}...\n`);
  const project = await loadProject(projectRoot);
  // Project-load warnings (duplicate page id, broken nav ref, etc.) — useful
  // signal whether you're in CLI or streaming UI, route through both channels.
  for (const w of project.warnings) emitError(report, `[ask] ${w}\n`);
  const pageCount = Array.from(project.pagesByLangAndId.values()).reduce(
    (acc, m) => acc + m.size,
    0,
  );
  report(`  ${pageCount} pages, ${project.navigationsByLang.size} navigation(s)\n`);

  report(`generating template candidates...\n`);
  let candidates = generateFromStructure(project, { limit: opts.limit });
  if (candidates.length === 0) {
    emitError(
      report,
      `error: navigation produced 0 candidate questions; check that ${projectRoot}/navigation/*.json reference published pages.\n`,
    );
    return 1;
  }
  report(`  ${candidates.length} template candidates emitted\n`);

  if (opts.llmRewrite) {
    const { config } = await loadConfig(projectRoot);
    let llm;
    try {
      llm = buildDefaultLLM(config);
    } catch (err) {
      if (opts.fallbackOnLlmError) {
        report(
          `LLM rewrite unavailable (${(err as Error).message}); falling back to template-only candidates.\n`,
        );
      } else {
        process.stderr.write(
          `error: LLM rewrite requires Anthropic credentials.\n` +
            `       ${(err as Error).message}\n` +
            `       Pass --no-llm-rewrite to fall back to template-only candidates ` +
            `(lower quality but no API call).\n`,
        );
        return 1;
      }
    }
    if (llm) {
      report(
        `${cliPrefix}rewriting ${candidates.length} candidates via ${config.llm.provider}/${config.llm.model}...\n`,
      );
      try {
        candidates = await rewriteCandidatesWithLLM(candidates, { llm, reporter: report });
      } catch (err) {
        if (opts.fallbackOnLlmError) {
          report(
            `LLM rewrite failed (${(err as Error).message}); keeping template-only candidates.\n`,
          );
        } else {
          process.stderr.write(
            `error: LLM rewrite failed: ${(err as Error).message}\n` +
              `       Pass --no-llm-rewrite to skip this step.\n`,
          );
          return 1;
        }
      }
    }
  }

  const written = writeCandidates(stateRoot, candidates);
  report(
    `${cliSummaryPrefix}wrote ${candidates.length} candidates to ${written}\n` +
      `next: edit decision "approved" / "rejected" inline, then run 'anydocs-ask golden review ${opts.projectRoot}'.\n`,
  );
  return 0;
}

async function runFromRuns(
  projectRoot: string,
  stateRoot: string,
  opts: GoldenGenerateOptions,
): Promise<number> {
  const report = opts.reporter ?? ((s: string) => void process.stdout.write(s));
  const cliSummaryPrefix =
    opts.reporter === undefined ? 'anydocs-ask golden generate: ' : '';
  const sinceArg = opts.since ?? FROM_RUNS_DEFAULT_SINCE;
  const sinceMs = parseSince(sinceArg);
  if (sinceMs === null) {
    emitError(
      report,
      `invalid --since '${sinceArg}'; expected ISO date or duration (7d / 48h / 30m).\n`,
    );
    return 2;
  }

  // Collect run records from the window (drop all update tails — feedback,
  // citation-check, future kinds). Console-origin runs are excluded by
  // default — promoting author dogfood queries into the regression set
  // without opt-in would let test prompts leak into golden (ARCH §17.8).
  report(`scanning runs since ${sinceArg}...\n`);
  const records: RunRecord[] = [];
  let consoleSkipped = 0;
  for (const line of iterateRunsSince({ stateRoot, sinceMs }) as Iterable<RunsLine>) {
    if (!isRunRecord(line)) continue;
    const r = line;
    if (!opts.includeConsole && runSource(r) === 'console') {
      consoleSkipped++;
      continue;
    }
    records.push(r);
  }
  if (records.length === 0) {
    emitError(
      report,
      `error: no runs since ${sinceArg}. serve the project, answer ≥1 query, ` +
        (consoleSkipped > 0
          ? `\n       (skipped ${consoleSkipped} console runs; pass --include-console to include them)`
          : '') +
        `\n       then retry — or pass --since 30d to widen.\n`,
    );
    return 1;
  }

  const { rows: existingCases } = readApproved(stateRoot);
  report(
    `${records.length} runs since ${sinceArg}` +
      (consoleSkipped > 0 ? ` (excluded ${consoleSkipped} console-origin)` : '') +
      `, ${existingCases.length} approved cases for dedup\n`,
  );

  const { candidates, stats } = generateFromRuns(records, {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    existingCases,
  });

  report(
    `  filter: total=${stats.total} ` +
      `non-answer=${stats.droppedNonAnswer} ` +
      `low-conf=${stats.droppedLowConf} ` +
      `long-answer=${stats.droppedLongAnswer} ` +
      `reasked=${stats.droppedReask}\n` +
      `  cluster: ${stats.clusters} clusters, ${stats.droppedDuplicate} dropped as dup of existing cases\n`,
  );

  if (candidates.length === 0) {
    // return 0 (success: nothing to do), but still surface the explanation so
    // a streaming UI doesn't show ✓ done with an empty log.
    emitError(
      report,
      `(no candidates produced; loosen --since or check that runs have confidence ≥0.7 ` +
        `and answer.md ≤600 chars.)\n`,
    );
    return 0;
  }

  const written = writeCandidates(stateRoot, candidates);
  report(
    `${cliSummaryPrefix}wrote ${candidates.length} candidates to ${written}\n` +
      `next: edit decision "approved"/"rejected" inline (verify must_cite_pages — ` +
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

export type GoldenImportOptions = {
  projectRoot: string;
  stateRoot: string;
  file: string;
  replace?: boolean;
};

export function runGoldenImport(opts: GoldenImportOptions): number {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const importPath = isAbsolute(opts.file) ? opts.file : resolve(projectRoot, opts.file);
  if (!existsSync(importPath)) {
    process.stderr.write(`error: import file does not exist: ${importPath}\n`);
    return 1;
  }

  const { rows, malformed, invalid } = readGoldenCasesFile(importPath);
  if (malformed > 0 || invalid > 0) {
    process.stderr.write(
      `error: ${importPath} has ${malformed} malformed JSON line(s) and ${invalid} invalid golden case line(s)\n`,
    );
    return 1;
  }
  if (rows.length === 0) {
    process.stderr.write(`error: import file has no cases: ${importPath}\n`);
    return 1;
  }

  const written = opts.replace ? writeCases(stateRoot, rows) : appendCases(stateRoot, rows);
  process.stdout.write(
    `anydocs-ask golden import: ${opts.replace ? 'replaced' : 'appended'} ${rows.length} cases in ${written}\n`,
  );
  return 0;
}

function readGoldenCasesFile(path: string): {
  rows: GoldenCase[];
  malformed: number;
  invalid: number;
} {
  const rows: GoldenCase[] = [];
  let malformed = 0;
  let invalid = 0;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!isGoldenCaseLike(parsed)) {
      invalid++;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, malformed, invalid };
}

function isGoldenCaseLike(v: unknown): v is GoldenCase {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (typeof o.query !== 'string' || o.query.length === 0) return false;
  if (o.lang !== 'zh' && o.lang !== 'en') return false;
  if (!o.expected || typeof o.expected !== 'object' || Array.isArray(o.expected)) return false;
  const expected = o.expected as Record<string, unknown>;
  return (
    Array.isArray(expected.must_cite_pages) &&
    Array.isArray(expected.must_contain) &&
    Array.isArray(expected.forbid_contain)
  );
}
