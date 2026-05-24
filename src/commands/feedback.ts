/**
 * `anydocs-ask feedback <export | import | status> <projectRoot>`
 *
 * Mirrors PRD §11 F3 / ARCH §15.5.3 / RFC docs/rfcs/0001-feedback-loop-v0.2.md
 * §2.1 (S2). Self-contained CLI — does not boot the embedder, LLM, or
 * watcher. Only touches:
 *   - <stateRoot>/index.db (read for export/status, read+write for import)
 *   - <stateRoot>/feedback/{inbox,approved,rejected}/ (filesystem only)
 *
 * All three commands are no-ops when `feedback.enabled = false` — that's the
 * v1-equivalence guard from PRD §11.4 #6. We surface a friendly hint instead
 * of silently doing nothing.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, resolveTransformersCacheDir } from '../config.ts';
import { openDatabase, resolveDbPath } from '../db/index.ts';
import { ensureFeedbackDirs } from '../workspace.ts';
import { Bgem3Embedder } from '../embedding/bge-m3.ts';
import { MockEmbedder } from '../embedding/mock.ts';
import { buildDefaultLLM } from '../llm/factory.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM } from '../llm/types.ts';
import { runDiagnosePipeline } from '../feedback/diagnose-runner.ts';
import { clusterIdFor } from '../feedback/cluster-id.ts';
import { emitInbox, parseInbox, InboxParseError } from '../feedback/markdown.ts';
import {
  appendArchive,
  countCounts,
  deleteInboxFile,
  ensureSubdir,
  feedbackPaths,
  findById,
  insertCurated,
  listInboxFiles,
  listReviewable,
  markReviewed,
  monthKey,
  readInboxFile,
  writeInboxFileIfAbsent,
} from '../feedback/store.ts';
import type { InboxFile } from '../feedback/types.ts';

export type FeedbackCmdOptions = {
  projectRoot: string;
  stateRoot: string;
};

// ---------------------------------------------------------------------------
// `feedback export`
// ---------------------------------------------------------------------------

export async function runFeedbackExport(opts: FeedbackCmdOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const guard = await assertEnabled(projectRoot, stateRoot, 'export');
  if (guard !== 0) return guard;

  const paths = feedbackPaths(stateRoot);
  ensureFeedbackDirs(stateRoot);

  const db = openDatabase({ stateRoot, skipMigrations: true });
  try {
    const reviewable = listReviewable(db);
    if (reviewable.length === 0) {
      process.stdout.write(`feedback export: no reviewable rows in db.\n`);
      return 0;
    }

    let written = 0;
    let skipped = 0;
    for (const row of reviewable) {
      const clusterId = clusterIdFor({
        feedback_id: row.feedback_id,
        created_at_ms: row.created_at,
        question: row.question,
      });
      const filePath = join(paths.inbox, `${clusterId}.md`);
      const file: InboxFile = {
        frontmatter: {
          cluster_id: clusterId,
          created_at_iso: new Date(row.created_at).toISOString(),
          queries: [row.question],
          sample_answer_id: row.answer_id,
          current_page_id: row.current_page_id,
          signal_source: row.signal_source,
          // We don't compute aggregates yet (single-row clusters in 0.2); the
          // negative counts come from the row itself for forward-compat with
          // 0.3 multi-row clusters.
          explicit_negative: row.signal_source === 'explicit' && (row.rating ?? 0) <= 0 ? 1 : 0,
          implicit_negative: 0,
          bad_citation_ids: row.bad_citation_ids,
          decision: 'pending',
          notes: '',
        },
        body: {
          systemAnswer: row.generated,
          retrievedChunks: row.retrieved,
          correctedAnswer: '',
        },
      };
      const ok = writeInboxFileIfAbsent(filePath, emitInbox(file));
      if (ok) written += 1;
      else skipped += 1;
    }

    process.stdout.write(
      `feedback export: wrote ${written} file(s), skipped ${skipped} existing.\n` +
        `  inbox: ${paths.inbox}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// `feedback import`
// ---------------------------------------------------------------------------

export async function runFeedbackImport(opts: FeedbackCmdOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const guard = await assertEnabled(projectRoot, stateRoot, 'import');
  if (guard !== 0) return guard;

  const paths = feedbackPaths(stateRoot);
  ensureFeedbackDirs(stateRoot);
  ensureSubdir(paths.approved);
  ensureSubdir(paths.rejected);

  const inboxFiles = listInboxFiles(paths.inbox);
  if (inboxFiles.length === 0) {
    process.stdout.write(`feedback import: inbox/ is empty.\n`);
    return 0;
  }

  const db = openDatabase({ stateRoot, skipMigrations: true });
  let approved = 0;
  let rejected = 0;
  let pending = 0;
  let malformed = 0;
  const now = Date.now();
  const month = monthKey(new Date(now));

  try {
    for (const name of inboxFiles) {
      const path = join(paths.inbox, name);
      let inbox: InboxFile;
      try {
        inbox = parseInbox(readInboxFile(path));
      } catch (err) {
        const msg = err instanceof InboxParseError ? err.message : (err as Error).message;
        process.stderr.write(`  [skip] ${name}: ${msg}\n`);
        malformed += 1;
        continue;
      }

      const { frontmatter, body } = inbox;
      if (frontmatter.decision === 'pending') {
        pending += 1;
        continue;
      }

      // Cluster_id is the source identity for matching the original row when
      // the file was generated from a single-row cluster. cluster_id format
      // contains the feedback_id (NNN); we reparse rather than do a fuzzy
      // match so renaming the file (by accident or otherwise) fails loudly.
      const feedbackId = extractFeedbackIdFromClusterId(frontmatter.cluster_id);
      if (feedbackId === null) {
        process.stderr.write(`  [skip] ${name}: cannot extract feedback_id from cluster_id\n`);
        malformed += 1;
        continue;
      }
      const sourceRow = findById(db, feedbackId);
      if (!sourceRow) {
        process.stderr.write(
          `  [skip] ${name}: source feedback row ${feedbackId} no longer in db\n`,
        );
        malformed += 1;
        continue;
      }
      if (sourceRow.review_decision !== null) {
        // Already reviewed via a prior import (or manual db edit). Move the
        // file out of inbox/ without writing a new decision — keeps the
        // inbox queue accurate without corrupting earlier state.
        process.stderr.write(
          `  [skip] ${name}: feedback ${feedbackId} already reviewed (${sourceRow.review_decision}); removing duplicate inbox file\n`,
        );
        deleteInboxFile(path);
        malformed += 1;
        continue;
      }

      const archiveEntry = {
        ...frontmatter,
        reviewed_at: now,
        corrected_answer: body.correctedAnswer,
      };

      if (frontmatter.decision === 'approved') {
        markReviewed(db, feedbackId, frontmatter.cluster_id, 'approved', now);
        insertCurated(db, {
          sourceRow,
          clusterId: frontmatter.cluster_id,
          correctedAnswer: body.correctedAnswer,
          reviewedAtMs: now,
        });
        appendArchive(paths.approved, month, archiveEntry);
        approved += 1;
      } else {
        markReviewed(db, feedbackId, frontmatter.cluster_id, 'rejected', now);
        appendArchive(paths.rejected, month, archiveEntry);
        rejected += 1;
      }
      deleteInboxFile(path);
    }
  } finally {
    db.close();
  }

  process.stdout.write(
    `feedback import: ${approved} approved, ${rejected} rejected, ` +
      `${pending} pending (left in inbox), ${malformed} skipped (malformed/duplicate).\n`,
  );
  return malformed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// `feedback status`
// ---------------------------------------------------------------------------

export async function runFeedbackStatus(opts: FeedbackCmdOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);

  const { config } = await loadConfig(projectRoot);
  const dbPath = resolveDbPath(stateRoot);
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `no index DB at ${dbPath}; run 'anydocs-ask reindex ${projectRoot}' first.\n`,
    );
    return 1;
  }

  const db = openDatabase({ stateRoot, skipMigrations: true });
  try {
    const counts = countCounts(db, stateRoot);
    const paths = feedbackPaths(stateRoot);
    process.stdout.write(
      `anydocs-ask feedback status\n` +
        `  enabled:         ${config.feedback.enabled}\n` +
        `  implicit:        ${config.feedback.implicitSignals}\n` +
        `  feedback root:   ${paths.feedbackRoot}\n` +
        `  inbox files:     ${counts.pendingFiles}\n` +
        `  approved rows:   ${counts.approvedRows}\n` +
        `  rejected rows:   ${counts.rejectedRows}\n` +
        `  reviewable rows: ${counts.reviewableInDb}` +
        (counts.reviewableInDb > 0 && counts.pendingFiles === 0
          ? `   (run 'feedback export' to materialise)\n`
          : '\n'),
    );
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// `feedback diagnose` (RFC 0006 alpha.0 stub)
// ---------------------------------------------------------------------------

export type FeedbackDiagnoseOptions = FeedbackCmdOptions & {
  /** RFC 0006 §4.6 — override the PRD §10.3 threshold. */
  threshold?: number;
  /** RFC 0006 §4.6 — override the 4-week observation window. ISO-ish
   *  duration (`28d` / `48h` / `120m`). */
  observationWindow?: string;
  /** Skip threshold + aplus.enabled gates and write to suggestions/.shadow/. */
  shadow?: boolean;
  /** Don't write any files; just print what would be written. */
  dryRun?: boolean;
  /** Hard cap on output clusters (CLI `--limit`). Default 5 per RFC §4.6. */
  limit?: number;
  /** Inject LLM (tests use MockLLM). Falls back to `buildDefaultLLM(config)`. */
  llm?: LLM;
  /** Inject Embedder (tests use MockEmbedder). Falls back to
   *  `buildDefaultEmbedder(config)`. */
  embedder?: Embedder;
};

/**
 * RFC 0006 alpha.2 — the full pipeline (cluster + suggest + write).
 *
 * Flow:
 *   1. Load config + open DB
 *   2. Build embedder + LLM (lazy; tests inject mocks)
 *   3. Delegate to {@link runDiagnosePipeline} with a parsed window + threshold
 *   4. Print a human summary based on the outcome (feature off / data
 *      insufficient / would diagnose / wrote N suggestions)
 *   5. Exit 0 on success, 1 on missing DB, 2 on invalid args
 *
 * Backwards-compatible with the alpha.0 stub: the same flag set + the
 * same output-line scaffold (added: per-path line, suggestion counts).
 */
export async function runFeedbackDiagnose(opts: FeedbackDiagnoseOptions): Promise<number> {
  const projectRoot = resolve(opts.projectRoot);
  const stateRoot = resolve(opts.stateRoot);
  const { config } = await loadConfig(projectRoot);

  const dbPath = resolveDbPath(stateRoot);
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `no index DB at ${dbPath}; run 'anydocs-ask reindex ${projectRoot}' first.\n`,
    );
    return 1;
  }

  const db = openDatabase({ stateRoot, skipMigrations: true });
  let llm: LLM;
  try {
    llm = opts.llm ?? buildDefaultLLM(config);
  } catch (err) {
    db.close();
    process.stderr.write(`feedback diagnose: LLM unavailable: ${(err as Error).message}\n`);
    return 2;
  }
  const embedder: Embedder = opts.embedder ?? buildEmbedderFor(config);

  let outcome;
  try {
    outcome = await runDiagnosePipeline({
      db,
      embedder,
      llm,
      stateRoot,
      aplus: config.aplus,
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.observationWindow !== undefined
        ? { observationWindow: opts.observationWindow }
        : {}),
      shadow: opts.shadow === true,
      dryRun: opts.dryRun === true,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
  } finally {
    db.close();
  }

  const threshold = opts.threshold ?? config.aplus.threshold;
  const window = opts.observationWindow ?? config.aplus.observationWindow;
  const candidateCount = outcome.ok ? outcome.candidateCount : outcome.candidateCount;
  const lines: string[] = [
    `anydocs-ask feedback diagnose`,
    `  aplus.enabled:                ${config.aplus.enabled}`,
    `  threshold:                    ${threshold} (config: ${config.aplus.threshold})`,
    `  observation window:           ${window}`,
    `  embed similarity threshold:   ${config.aplus.embedSimilarityThreshold} (RFC 0006 §4.2)`,
    `  candidate β feedback rows:    ${candidateCount}`,
    `  shadow flag:                  ${opts.shadow === true}`,
    `  dry-run flag:                 ${opts.dryRun === true}`,
    ``,
  ];

  if (!outcome.ok) {
    if (outcome.reason === 'feature_off') {
      lines.push(
        `aplus.enabled is false; nothing to do. Flip to true in anydocs.ask.json after the threshold is met, or re-run with --shadow to bypass.`,
      );
    } else if (outcome.reason === 'data_insufficient') {
      lines.push(
        `data insufficient: ${candidateCount} of ${threshold} β feedback rows in the last ${window}. Re-run after more reviews land, or pass --shadow to bypass the gate.`,
      );
    } else if (outcome.reason === 'invalid_window') {
      process.stderr.write(
        `feedback diagnose: invalid observationWindow '${window}'; expected duration like '28d' / '48h' / '120m'.\n`,
      );
      return 2;
    }
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  lines.push(
    `  clusters formed:              ${outcome.clustersFormed}`,
    `  suggestions written:          ${outcome.suggestionsWritten}`,
    `  suggestions skipped (LLM err):${outcome.suggestionsSkipped}`,
    `  output dir:                   ${outcome.outputDir}`,
  );
  if (outcome.paths.length > 0) {
    lines.push(``, `wrote:`);
    for (const p of outcome.paths) lines.push(`  ${p}`);
  } else if (opts.dryRun) {
    lines.push(``, `(dry-run: no files written)`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

/**
 * Build an embedder for the diagnose CLI. Mirrors `runtime.ts` mapping —
 * default `local` + `bge-m3` ⇒ real Bge-m3; anything else falls back to
 * MockEmbedder with a stderr warning so the CLI works offline.
 */
function buildEmbedderFor(config: { embedding: { provider: string; model: string; preferQuantized: boolean; cacheDir: string | null } }): Embedder {
  if (config.embedding.provider === 'local' && config.embedding.model === 'bge-m3') {
    return new Bgem3Embedder({
      preferQuantized: config.embedding.preferQuantized,
      cacheDir: resolveTransformersCacheDir(config as never),
    });
  }
  process.stderr.write(
    `[ask] feedback diagnose: embedding.model "${config.embedding.model}" not recognized; using MockEmbedder (suggestions will use deterministic vectors and will not be useful)\n`,
  );
  return new MockEmbedder();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function assertEnabled(
  projectRoot: string,
  _stateRoot: string,
  verb: string,
): Promise<number> {
  const { config } = await loadConfig(projectRoot);
  if (!config.feedback.enabled) {
    process.stderr.write(
      `feedback ${verb}: feedback.enabled is false. ` +
        `Set "feedback": { "enabled": true } in anydocs.ask.json to opt in.\n`,
    );
    return 2;
  }
  return 0;
}

/**
 * cluster_id format is `<YYYY>-W<II>-<NNN>-<slug>` where NNN is the feedback
 * row's id (zero-padded to ≥3 digits). The id segment is the only one we
 * need to recover for import.
 */
function extractFeedbackIdFromClusterId(clusterId: string): number | null {
  const m = /^\d{4}-W\d{2}-(\d+)-/.exec(clusterId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
