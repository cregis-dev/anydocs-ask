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
import { loadConfig } from '../config.ts';
import { openDatabase, resolveDbPath } from '../db/index.ts';
import { ensureFeedbackDirs } from '../workspace.ts';
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
