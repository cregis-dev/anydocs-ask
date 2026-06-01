/**
 * RFC 0006 A6 alpha.2 — A+ 失败查询诊断 / pipeline orchestrator.
 *
 * Reads candidate feedback rows from SQLite, embeds the queries (via cache
 * or fallback embedder), clusters via [[clusterFeedback]], generates补文档
 * suggestions via [[generateSuggestion]], and writes one markdown + one
 * json trace per cluster under
 * `<stateRoot>/feedback/suggestions/cluster_<id>.{md,json}` (or `.shadow/`
 * subdir when `shadow=true`).
 *
 * Pure side-effect surface (DB read + LLM + disk write + embedder); the
 * `clusterFeedback` / `generateSuggestion` modules stay pure. Tests inject
 * MockLLM + MockEmbedder + tmp stateRoot.
 *
 * Failure modes (RFC §4.8):
 *   - feedback < threshold AND no `shadow`        → noop, returns reason
 *   - aplus.enabled=false AND no `shadow`         → noop, returns reason
 *   - embedding cache miss                        → on-demand embed via embedder
 *   - generateSuggestion returns null             → cluster skipped + stderr warn
 *   - disk write failure                          → throws (operator must see it)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '../db/index.ts';
import type { Embedder } from '../embedding/types.ts';
import type { LLM } from '../llm/types.ts';
import { getOrEmbed } from '../embedding/cache.ts';
import { contentHash } from '../content/normalize.ts';
import {
  clusterFeedback,
  type FeedbackCluster,
  type FeedbackClusterInput,
} from './diagnose-cluster.ts';
import { generateSuggestion } from './diagnose-suggest.ts';
import type { AplusConfig } from '../config.ts';

export type DiagnoseRunInput = {
  db: DbHandle;
  embedder: Embedder;
  llm: LLM;
  stateRoot: string;
  aplus: AplusConfig;
  /** Override config threshold (CLI `--threshold`). */
  threshold?: number;
  /** Override config observationWindow (CLI `--observation-window`). */
  observationWindow?: string;
  /** Write to `suggestions/.shadow/` and bypass aplus.enabled gate. */
  shadow?: boolean;
  /** Don't write any files; just return what would be written. */
  dryRun?: boolean;
  /** Hard cap on output clusters (CLI `--limit`). Default 5 per RFC §4.6. */
  limit?: number;
  /** Injection point for deterministic clock in tests. */
  now?: () => Date;
};

export type DiagnoseRunOutcome =
  | {
      ok: true;
      candidateCount: number;
      clustersFormed: number;
      suggestionsWritten: number;
      suggestionsSkipped: number;
      outputDir: string;
      paths: string[];
    }
  | { ok: false; reason: 'feature_off' | 'data_insufficient' | 'invalid_window'; candidateCount: number };

const DEFAULT_LIMIT = 5;

export async function runDiagnosePipeline(
  input: DiagnoseRunInput,
): Promise<DiagnoseRunOutcome> {
  const threshold = input.threshold ?? input.aplus.threshold;
  const windowSpec = input.observationWindow ?? input.aplus.observationWindow;
  const windowMs = parseDurationMs(windowSpec);
  if (windowMs === null) {
    return { ok: false, reason: 'invalid_window', candidateCount: 0 };
  }
  const sinceMs = (input.now ?? (() => new Date()))().getTime() - windowMs;

  // Candidate pool — β explicit negative only (PRD §11.4 + RFC §4.1).
  // alpha.2 keeps this narrow; alpha.3+ may add clarify-without-followup +
  // low-RRF cases from runs.jsonl.
  const candidates = input.db
    .prepare(
      `SELECT feedback_id, answer_id, question
         FROM feedback
        WHERE created_at >= ?
          AND signal_source = 'explicit'
          AND rating < 0
          AND length(question) > 0
        ORDER BY created_at DESC`,
    )
    .all(sinceMs) as Array<{ feedback_id: number; answer_id: string; question: string }>;

  const candidateCount = candidates.length;
  const featureOff = !input.aplus.enabled && !input.shadow;
  const dataShort = candidateCount < threshold && !input.shadow;
  if (featureOff) {
    return { ok: false, reason: 'feature_off', candidateCount };
  }
  if (dataShort) {
    return { ok: false, reason: 'data_insufficient', candidateCount };
  }

  if (candidateCount === 0) {
    return {
      ok: true,
      candidateCount: 0,
      clustersFormed: 0,
      suggestionsWritten: 0,
      suggestionsSkipped: 0,
      outputDir: resolveOutputDir(input.stateRoot, input.shadow === true),
      paths: [],
    };
  }

  // Embedding step — use the cache write-through path so subsequent
  // diagnose runs (and reranker / γ paths in 0.5+) get the values for free.
  const embedRequests = candidates.map((r) => ({
    content_hash: contentHash(r.question),
    text: r.question,
  }));
  const { vectors } = await getOrEmbed(input.db, input.embedder, embedRequests);

  // Build cluster input rows. Skip any row whose embedding lookup unexpectedly
  // failed (shouldn't happen — getOrEmbed throws on bad dim — but defensive).
  const rows: FeedbackClusterInput[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i]!;
    const hash = embedRequests[i]!.content_hash;
    const embedding = vectors.get(hash);
    if (!embedding) continue;
    rows.push({
      feedback_id: r.feedback_id,
      answer_id: r.answer_id,
      question: r.question,
      embedding,
    });
  }

  // Cluster.
  const clusters = clusterFeedback(rows, {
    threshold: input.aplus.embedSimilarityThreshold,
    minClusterSize: 2,
  });
  const capped = clusters.slice(0, input.limit ?? DEFAULT_LIMIT);

  // Build per-cluster context: pull answer markdown from `answers.payload`
  // (best-effort; absent rows just get empty answer_md).
  const answerLookup = buildAnswerLookup(input.db, capped);

  const outputDir = resolveOutputDir(input.stateRoot, input.shadow === true);
  const paths: string[] = [];
  let written = 0;
  let skipped = 0;

  // Pre-create the output dir even on dry-run for the path to be valid in
  // the response; we just don't writeFileSync when dryRun=true.
  if (!input.dryRun) ensureDir(outputDir);

  for (const cluster of capped) {
    const ctxRows = cluster.members.map((fid) => ({
      answer_md: answerLookup.get(fid) ?? '',
    }));
    const suggestion = await generateSuggestion({
      llm: input.llm,
      cluster,
      contextRows: ctxRows,
      navHints: [], // alpha.2 leaves nav lookup to a future polish step
      shadow: input.shadow === true,
      ...(input.now ? { now: input.now } : {}),
    });
    if (!suggestion) {
      skipped++;
      process.stderr.write(
        `[ask/diagnose] suggestion generation failed for cluster ${cluster.cluster_id}; skipping\n`,
      );
      continue;
    }
    const mdPath = join(outputDir, `${cluster.cluster_id}.md`);
    const jsonPath = join(outputDir, `${cluster.cluster_id}.json`);
    if (!input.dryRun) {
      writeFileSync(mdPath, suggestion.markdown, 'utf8');
      writeFileSync(jsonPath, JSON.stringify(buildTrace(cluster, suggestion), null, 2), 'utf8');
    }
    paths.push(mdPath, jsonPath);
    written++;
  }

  return {
    ok: true,
    candidateCount,
    clustersFormed: clusters.length,
    suggestionsWritten: written,
    suggestionsSkipped: skipped,
    outputDir,
    paths,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function resolveOutputDir(stateRoot: string, shadow: boolean): string {
  const base = join(stateRoot, 'feedback', 'suggestions');
  return shadow ? join(base, '.shadow') : base;
}

function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
}

function buildAnswerLookup(
  db: DbHandle,
  clusters: ReadonlyArray<FeedbackCluster>,
): Map<number, string> {
  // We have feedback_id → answer_id via the cluster's `members` lookup.
  // Pull all answer_ids referenced by any cluster, decode `payload.answer_md`.
  const answerIds = new Set<string>();
  const fbToAns = new Map<number, string>();
  if (clusters.length === 0) return fbToAns;
  const allFids = clusters.flatMap((c) => c.members);
  if (allFids.length === 0) return fbToAns;
  const placeholders = Array(allFids.length).fill('?').join(',');
  const fbRows = db
    .prepare(`SELECT feedback_id, answer_id FROM feedback WHERE feedback_id IN (${placeholders})`)
    .all(...allFids) as Array<{ feedback_id: number; answer_id: string }>;
  for (const r of fbRows) {
    fbToAns.set(r.feedback_id, r.answer_id);
    answerIds.add(r.answer_id);
  }
  if (answerIds.size === 0) return new Map();
  const ansPlaceholders = Array(answerIds.size).fill('?').join(',');
  const ansRows = db
    .prepare(`SELECT answer_id, payload FROM answers WHERE answer_id IN (${ansPlaceholders})`)
    .all(...answerIds) as Array<{ answer_id: string; payload: string }>;
  const ansToMd = new Map<string, string>();
  for (const r of ansRows) {
    try {
      const parsed = JSON.parse(r.payload) as { answer_md?: string };
      if (typeof parsed.answer_md === 'string') {
        ansToMd.set(r.answer_id, parsed.answer_md);
      }
    } catch {
      // ignore — best-effort
    }
  }
  const out = new Map<number, string>();
  for (const [fid, aid] of fbToAns) {
    const md = ansToMd.get(aid);
    if (md) out.set(fid, md);
  }
  return out;
}

function buildTrace(
  cluster: FeedbackCluster,
  suggestion: { model: string; latencyMs: number },
): unknown {
  return {
    cluster_id: cluster.cluster_id,
    size: cluster.size,
    density: cluster.density,
    center_question: cluster.center_question,
    center_feedback_id: cluster.center_feedback_id,
    members: cluster.members,
    member_questions: cluster.member_questions,
    suggestion: {
      model: suggestion.model,
      latency_ms: suggestion.latencyMs,
    },
  };
}

function parseDurationMs(spec: string): number | null {
  const m = /^(\d+)([dhm])$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'm') return n * 60 * 1000;
  return null;
}
