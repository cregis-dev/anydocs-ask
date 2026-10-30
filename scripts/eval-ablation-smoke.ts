#!/usr/bin/env node

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, cpus, totalmem, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Runtime } from '../src/server/runtime.ts';
import { loadConfig } from '../src/config.ts';
import { buildAgentLanguageModel } from '../src/agent/provider.ts';
import { buildEvalCaseTraceRecord, buildLangfuseEvalScores } from '../src/commands/eval.ts';
import { scoreCase } from '../src/eval/scoring.ts';
import type { GoldenCase } from '../src/golden/types.ts';
import {
  ABLATION_LIMITS, ABLATION_VARIANTS, contentHash, runAblationVariant,
  type AblationVariant, type ContextMode,
} from '../src/eval/ablation.ts';
import { startLangfuseObservability, traceAskTurn, recordTraceScores } from '../src/observability/langfuse.ts';
import { redactSensitiveText } from '../src/query/diagnostic-input.ts';

type Selection = { cases: Array<{ id: string; family_id: string; category: string; reason: string }> };
type RequestRow = { case_id: string; variant: AblationVariant; order: number };

const parsed = parseArgs({ options: {
  project: { type: 'string' }, golden: { type: 'string' }, selection: { type: 'string' },
  output: { type: 'string' }, 'context-mode': { type: 'string', default: 'no_page' },
  'prepare-only': { type: 'boolean', default: false },
  'allow-without-tracing': { type: 'boolean', default: false },
  'embedding-cache-from': { type: 'string', multiple: true },
} });
const flags = parsed.values;
const required = (name: 'project' | 'golden' | 'selection' | 'output') => {
  const value = flags[name];
  if (!value) throw new Error(`Required --${name}`);
  return resolve(value);
};

function shaFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function save(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function jsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + '\n');
}

function schedule(ids: string[]): RequestRow[] {
  let state = 20261020;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const shuffle = <T>(values: T[]) => {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };
  return shuffle(ids).flatMap((id) => shuffle([...ABLATION_VARIANTS]).map((variant) => ({ case_id: id, variant })))
    .map((row, order) => ({ ...row, order }));
}

function tokenTotals(calls: Array<{ usage?: unknown }>) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, missing = 0;
  for (const call of calls) {
    const usage = call.usage as {
      inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
      outputTokens?: { total?: number };
    } | undefined;
    if (usage?.inputTokens?.total == null || usage?.outputTokens?.total == null) missing++;
    input += usage?.inputTokens?.total ?? 0;
    output += usage?.outputTokens?.total ?? 0;
    cacheRead += usage?.inputTokens?.cacheRead ?? 0;
    cacheWrite += usage?.inputTokens?.cacheWrite ?? 0;
  }
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite, missing_usage_calls: missing, calls: calls.length };
}

function uniquePages(trace: { page_id: string }[]): string[] {
  return [...new Set(trace.map((row) => row.page_id))];
}

async function main() {
  const sourceProject = required('project');
  const goldenPath = required('golden');
  const selectionPath = required('selection');
  const output = required('output');
  const contextMode = flags['context-mode'] as ContextMode;
  if (!['no_page', 'original_page'].includes(contextMode)) throw new Error('Invalid context mode');
  if (existsSync(output)) throw new Error('Output must be a new directory; refusing to overwrite prior evidence');
  const selection = JSON.parse(readFileSync(selectionPath, 'utf8')) as Selection;
  if (selection.cases.length !== 12 || new Set(selection.cases.map((row) => row.id)).size !== 12) {
    throw new Error('Smoke runner requires exactly 12 explicitly selected unique cases; no full-eval mode');
  }
  const allCases = readFileSync(goldenPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as GoldenCase);
  const cases = selection.cases.map((item) => {
    const found = allCases.find((row) => row.id === item.id);
    if (!found) throw new Error(`Unknown selected case ${item.id}`);
    return { ...found, context_pageId: contextMode === 'no_page' ? null : found.context_pageId };
  });
  if (cases.filter((row) => row.lang === 'en').length !== 6 || cases.filter((row) => row.lang === 'zh').length !== 6) {
    throw new Error('Smoke selection must contain 6 English and 6 Chinese cases');
  }
  const engineRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const { config } = await loadConfig(sourceProject);
  config.llm.model = 'deepseek-flash';
  config.reranker.enabled = false;
  config.router.enabled = false;
  config.feedback.enabled = false;
  config.multiTurn.enabled = false;
  config.agent.enabled = true;
  config.runs.enabled = false;
  const experiment = `pc-agent-smoke-${new Date().toISOString().replace(/[-:.]/g, '')}`;
  const engineSha = git(engineRoot, 'rev-parse', 'HEAD');
  const docsSha = git(sourceProject, 'rev-parse', 'HEAD');
  process.env.ANYDOCS_ENGINE_RELEASE = engineSha;
  process.env.ANYDOCS_RELEASE = docsSha;
  const project = join(output, 'snapshot', 'project');
  mkdirSync(project, { recursive: true });
  for (const name of ['pages', 'navigation', 'api-sources', 'anydocs.config.json']) {
    const from = join(sourceProject, name);
    if (existsSync(from)) cpSync(from, join(project, name), { recursive: true });
  }
  save(join(output, 'dataset', 'selection.json'), selection);
  writeFileSync(join(output, 'dataset', 'cases.frozen.jsonl'), cases.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const requestOrder = schedule(cases.map((row) => row.id));
  save(join(output, 'request-order.json'), requestOrder);
  const packageJson = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8'));
  const manifest: Record<string, unknown> = {
    schema_version: 1, experiment_id: experiment, status: 'prepared',
    engine_sha: engineSha, docs_sha: docsSha, engine_dirty_status: git(engineRoot, 'status', '--short'),
    adapter_files: Object.fromEntries(['src/eval/ablation.ts', 'src/agent/runner.ts', 'scripts/eval-ablation-smoke.ts',
      'scripts/score-ablation-smoke.py', 'scripts/analyze-ablation-smoke.py',
      'eval/ragas/src/anydocs_ragas/audited.py', 'eval/ragas/src/anydocs_ragas/scoring.py',
      'eval/ragas/src/anydocs_ragas/cli.py', 'eval/ragas/src/anydocs_ragas/models.py',
      'eval/ragas/src/anydocs_ragas/langfuse.py']
      .map((name) => [name, shaFile(join(engineRoot, name))])),
    engine_diff_sha256: contentHash(git(engineRoot, 'diff', '--', 'src', 'scripts')),
    golden_source_sha256: shaFile(goldenPath), golden_frozen_sha256: shaFile(join(output, 'dataset', 'cases.frozen.jsonl')),
    selection_sha256: shaFile(selectionPath), evaluation_input_sha256: contentHash(cases.map((row) => ({
      id: row.id, question: row.query, lang: row.lang, current_page_id: row.context_pageId, history: [],
    }))),
    context_mode: contextMode, variants: ABLATION_VARIANTS, repetitions: 1, planned_attempts: 48,
    outer_attempts: 1, candidate_timing: 'live', schedule_seed: 20261020,
    answer_model: config.llm.model, judge_model: 'deepseek-v4-pro', limits: ABLATION_LIMITS,
    planned_judge_profile: 'audited-v1',
    reranker_enabled: false, router_llm_enabled: false, feedback_enabled: false,
    label_review_status: 'code-assisted audit; independent business review pending',
    result_scope: 'smoke only; not an unbiased or statistically confirmed quality gain',
    node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    cpu_count: cpus().length, memory_bytes: totalmem(), host: hostname(),
    direct_dependencies: packageJson.dependencies, lockfile_sha256: shaFile(join(engineRoot, 'pnpm-lock.yaml')),
    implementation_differences: {
      static_reader: 'Shared buildPrompt/postprocess; one generation, SDK retries; no citation repair loop',
      agentic: 'Native Agent prompt/tools/stopping/repair; budgeted evidence adapter',
      static_postprocess_character_cap: 4000, dynamic_prompt_conditionals: 'Production template may vary with selected evidence',
    },
  };
  save(join(output, 'manifest.json'), manifest);
  for (const name of Object.keys(manifest.adapter_files as Record<string, string>)) {
    const destination = join(output, 'source-archive', name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(engineRoot, name), destination);
  }
  const observability = await startLangfuseObservability();
  if (!observability.enabled && !flags['allow-without-tracing']) {
    throw new Error('Source tracing is required for this smoke run');
  }
  const runtime = new Runtime({ projectRoot: project, stateRoot: join(output, 'state'), config,
    skipWatcher: true, reranker: null });
  try {
    const cacheSources = [];
    for (const cachePath of flags['embedding-cache-from'] ?? []) {
      const sourcePath = resolve(cachePath);
      const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
      try {
        const rows = source.prepare('SELECT content_hash, model, embedding, created_at FROM embedding_cache WHERE model=?')
          .all(runtime.embedder.model) as Array<{ content_hash: string; model: string; embedding: Buffer; created_at: number }>;
        const insert = runtime.db.prepare('INSERT OR IGNORE INTO embedding_cache (content_hash,model,embedding,created_at) VALUES (?,?,?,?)');
        runtime.db.transaction(() => { for (const row of rows) insert.run(row.content_hash, row.model, row.embedding, row.created_at); })();
        cacheSources.push({ path: sourcePath, model: runtime.embedder.model, matching_rows: rows.length,
          cache_content_sha256: contentHash(rows.map((row) => [row.content_hash, row.model,
            createHash('sha256').update(row.embedding).digest('hex')]).sort()) });
      } finally { source.close(); }
    }
    manifest.embedding_cache_sources = cacheSources;
    const warmed = await runtime.start();
    const pages = runtime.db.prepare('SELECT page_id,lang,status,title,url FROM pages ORDER BY page_id,lang').all();
    const chunks = runtime.db.prepare('SELECT page_id,lang,in_page_path,content_hash,token_count,parent_id FROM chunks ORDER BY page_id,lang,in_page_path').all();
    const parents = runtime.db.prepare('SELECT page_id,lang,parent_path,content_hash,token_count FROM chunk_parents ORDER BY page_id,lang,parent_path').all();
    const evidenceIndex = { pages, chunks, parents };
    save(join(output, 'index-content.json'), evidenceIndex);
    Object.assign(manifest, { index_content_sha256: contentHash(evidenceIndex), runtime_boot_ms: warmed.boot_ms,
      index_counts: { pages: pages.length, chunks: chunks.length, parents: parents.length },
      tracing_enabled: observability.enabled });
    // Warm only retrieval. No extra paid answer request is hidden in setup.
    await runtime.embedder.embed([cases[0]!.query]);
    if (flags['prepare-only']) {
      manifest.status = 'prepared_only'; save(join(output, 'manifest.json'), manifest); return;
    }
    const model = buildAgentLanguageModel(config);
    if (typeof model === 'string') throw new Error('Smoke requires an explicit provider model instance');
    const deps = { db: runtime.db, embedder: runtime.embedder, llm: runtime.llm,
      promptConfig: config.prompt, retrievalConfig: config.retrieval, reranker: null };
    const fingerprints = new Map<string, string>();
    const outcomes: Array<Record<string, unknown>> = [];
    manifest.status = 'running'; save(join(output, 'manifest.json'), manifest);
    for (const item of requestOrder) {
      const c = cases.find((row) => row.id === item.case_id)!;
      const analysis = selection.cases.find((row) => row.id === item.case_id)!;
      const request = { question: c.query, context: { current_page_id: c.context_pageId, history: [] } };
      const requestId = `${experiment}:${item.variant}:${c.id}`;
      const observed = await traceAskTurn({ requestId, sessionId: experiment, source: 'ablation-smoke',
        question: c.query, currentPageId: c.context_pageId, agentic: item.variant === 'agentic',
        traceName: `ablation-${item.variant}`, environment: 'evaluation', version: engineSha,
        tags: ['ablation-smoke', item.variant, contextMode, c.lang],
        metadata: { experiment_id: experiment, variant: item.variant, case_id: c.id,
          context_mode: contextMode, repetition: '1', family_id: analysis.family_id,
          evaluation_input_sha256: manifest.evaluation_input_sha256 as string },
      }, () => runAblationVariant({ variant: item.variant, request, askDeps: deps,
        model, modelId: config.llm.model, agentConfig: config.agent, promptConfig: config.prompt }),
      (value) => ({ case_id: c.id, result: value.traced.result, evidence_tokens: value.evidence_tokens }));
      const value = observed.value;
      const score = scoreCase(c, value.traced.result, value.traced.trace);
      score.latency_ms = value.raw_latency_ms;
      const record = buildEvalCaseTraceRecord({ c, index: item.order, total: 48, caseResult: score,
        traced: value.traced, evalRunId: experiment, langfuseTraceId: observed.traceId,
        langfuseObservationId: observed.observationId });
      record.request = request;
      const extra = { ...record, experiment_id: experiment, variant: item.variant, context_mode: contextMode,
        repetition: 1, family_id: analysis.family_id, category: analysis.category, attempt: 1,
        candidate_fingerprint: value.candidate_fingerprint, raw_latency_ms: value.raw_latency_ms,
        raw_response: value.raw_response, finish_reason: value.finish_reason,
        evidence_tokens: value.evidence_tokens, model_calls: value.model_calls,
        read_audit: value.read_audit, discovery_audit: value.discovery_audit,
        child_candidates: value.child_candidates, reader_prompt_sha256: value.reader_prompt_sha256,
        all_call_usage: tokenTotals(value.model_calls), evaluation_input_sha256: manifest.evaluation_input_sha256 };
      jsonl(join(output, 'groups', item.variant, 'raw.cases.jsonl'), extra);
      jsonl(join(output, 'attempts.jsonl'), extra);
      if (value.candidate_fingerprint) {
        const previous = fingerprints.get(c.id);
        if (previous && previous !== value.candidate_fingerprint) {
          throw new Error(`A/B candidate mismatch for ${c.id}; stopping before further model requests`);
        }
        fingerprints.set(c.id, value.candidate_fingerprint);
      }
      if (value.evidence_tokens > 8000) throw new Error('Evidence token cap violated');
      const promptFacts = value.traced.trace.input_snapshot?.attempts.flatMap((row) => [row.system_prompt, row.user_prompt]).join('\n') ?? '';
      const leaked = c.expected.reference_facts?.filter((fact) =>
        promptFacts.includes(fact) && !record.ragas_sample.retrieved_contexts.some((body) => body.includes(fact)));
      // Reference wording may occur verbatim in real docs. Only unexplained injection is suspicious.
      if (leaked?.length) throw new Error(`Unexpected reference text outside evidence in ${c.id}`);
      await recordTraceScores({ traceId: observed.traceId, observationId: observed.observationId,
        scores: buildLangfuseEvalScores(score, value.traced.trace) });
      const evidencePages = uniquePages(value.traced.trace.selected_context ?? []);
      const targets = new Set(c.expected.must_cite_pages);
      const firstHit = evidencePages.findIndex((page) => targets.has(page));
      outcomes.push({ case_id: c.id, variant: item.variant, result_type: value.traced.result.type,
        latency_ms: value.raw_latency_ms, evidence_tokens: value.evidence_tokens,
        evidence_page_hit_at_5: evidencePages.slice(0, 5).some((page) => targets.has(page)),
        evidence_page_mrr: firstHit < 0 ? 0 : 1 / (firstHit + 1), evidence_pages: evidencePages,
        trace_id: observed.traceId, observation_id: observed.observationId,
        usage: tokenTotals(value.model_calls), finish_reason: value.finish_reason });
      save(join(output, 'summary.json'), { status: 'running', completed: outcomes.length, planned: 48, outcomes });
      process.stdout.write(`${outcomes.length}/48 ${item.variant} ${c.id}: ${value.traced.result.type}, ${value.raw_latency_ms}ms\n`);
    }
    const byVariant = Object.fromEntries(ABLATION_VARIANTS.map((variant) => {
      const rows = outcomes.filter((row) => row.variant === variant);
      return [variant, { attempted: rows.length, answers: rows.filter((row) => row.result_type === 'answer').length,
        failures_or_nonanswers: rows.filter((row) => row.result_type !== 'answer').length }];
    }));
    save(join(output, 'summary.json'), { status: 'complete', completed: outcomes.length, planned: 48,
      ab_candidate_pairs_verified: fingerprints.size, by_variant: byVariant, outcomes });
    manifest.status = 'complete'; manifest.completed_attempts = outcomes.length;
    save(join(output, 'manifest.json'), manifest);
    process.stdout.write(`Smoke complete: ${output}\n`);
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = redactSensitiveText(error instanceof Error ? error.message : 'Unknown smoke failure');
    save(join(output, 'manifest.json'), manifest);
    throw error;
  } finally { await runtime.stop(); await observability.shutdown(); }
}

main().catch((error) => {
  process.stderr.write(`Ablation smoke stopped: ${redactSensitiveText(error instanceof Error ? error.message : 'Unknown error')}\n`);
  process.exitCode = 1;
});
