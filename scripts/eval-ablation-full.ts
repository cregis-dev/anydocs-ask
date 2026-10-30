#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, arch } from 'node:os';
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
import { ABLATION_LIMITS, ABLATION_VARIANTS, contentHash, runAblationVariant } from '../src/eval/ablation.ts';
import { startLangfuseObservability, traceAskTurn, recordTraceScores } from '../src/observability/langfuse.ts';
import { redactSensitiveText } from '../src/query/diagnostic-input.ts';
import { caseAnalysis, fullSchedule, requestKey, validateCompleted } from './lib/ablation-full-plan.ts';

const { values: flags } = parseArgs({ options: {
  project: { type: 'string' }, golden: { type: 'string' }, output: { type: 'string' },
  resume: { type: 'boolean', default: false }, 'prepare-only': { type: 'boolean', default: false },
  'embedding-cache-from': { type: 'string', multiple: true },
} });
const fileHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const save = (p: string, value: unknown) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value, null, 2) + '\n'); };
const append = (p: string, value: unknown) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(value) + '\n'); };
const readLines = (p: string): any[] => existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)) : [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const required = (name: 'project' | 'golden' | 'output') => {
  if (!flags[name]) throw new Error(`Required --${name}`);
  return resolve(flags[name]);
};
function usageTotals(calls: any[]) {
  return calls.reduce((a, c) => ({ calls: a.calls + 1,
    input_tokens: a.input_tokens + (c.usage?.inputTokens?.total ?? 0),
    output_tokens: a.output_tokens + (c.usage?.outputTokens?.total ?? 0),
    cache_read_tokens: a.cache_read_tokens + (c.usage?.inputTokens?.cacheRead ?? 0),
    cache_write_tokens: a.cache_write_tokens + (c.usage?.inputTokens?.cacheWrite ?? 0),
    missing_usage_calls: a.missing_usage_calls + (c.usage?.inputTokens?.total == null || c.usage?.outputTokens?.total == null ? 1 : 0),
  }), { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, missing_usage_calls: 0 });
}
const outcome = (r: any) => ({ case_id: r.case_id, variant: r.variant, repetition: r.repetition,
  result_type: r.result.type, error_code: r.result.type === 'error' ? r.result.code : null,
  latency_ms: r.raw_latency_ms, evidence_tokens: r.evidence_tokens, usage: r.all_call_usage,
  trace_id: r.langfuse_trace_id, observation_id: r.langfuse_observation_id,
  evidence_pages: [...new Set((r.trace.selected_context ?? []).map((x: any) => x.page_id))],
  finish_reason: r.finish_reason });

async function main() {
  const source = required('project'), golden = required('golden'), output = required('output');
  const engine = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const project = join(output, 'snapshot/project');
  const frozenGolden = join(output, 'dataset/cases.frozen.jsonl');
  const sourceCases = readLines(golden) as GoldenCase[];
  if (sourceCases.length !== 92 || new Set(sourceCases.map((c) => c.id)).size !== 92) throw new Error('Full contract requires 92 unique cases');
  if (sourceCases.filter((c) => c.lang === 'en').length !== 46 || sourceCases.filter((c) => c.lang === 'zh').length !== 46) throw new Error('Language distribution changed');
  const cases = sourceCases.map((c) => ({ ...c, context_pageId: null }));
  const plan = fullSchedule(cases.map((c) => c.id));
  const ledger = join(output, 'attempts.jsonl');
  const files = ['src/eval/ablation.ts', 'src/agent/runner.ts', 'scripts/eval-ablation-full.ts',
    'scripts/lib/ablation-full-plan.ts', 'scripts/score-ablation-full.py',
    'eval/ragas/src/anydocs_ragas/audited.py', 'eval/ragas/src/anydocs_ragas/scoring.py',
    'eval/ragas/src/anydocs_ragas/calibrated_judge.py', 'eval/ragas/src/anydocs_ragas/evidence_judge.py',
    'eval/ragas/src/anydocs_ragas/cli.py', 'eval/ragas/src/anydocs_ragas/models.py',
    'eval/ragas/src/anydocs_ragas/fact_rules.py', 'eval/ragas/src/anydocs_ragas/langfuse.py'];
  let manifest: any;
  if (flags.resume) {
    manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    if (manifest.golden_source_sha256 !== fileHash(golden) || manifest.golden_frozen_sha256 !== fileHash(frozenGolden)
      || contentHash(readLines(frozenGolden)) !== contentHash(cases)) throw new Error('Golden changed; refusing resume');
    for (const [path, hash] of Object.entries(manifest.adapter_files)) if (fileHash(join(engine, path)) !== hash) throw new Error(`Implementation changed: ${path}`);
    if (contentHash(JSON.parse(readFileSync(join(output, 'request-order.json'), 'utf8'))) !== contentHash(plan)) throw new Error('Schedule changed');
  } else {
    if (existsSync(output)) throw new Error('New output directory required; use --resume explicitly');
    mkdirSync(project, { recursive: true });
    for (const name of ['pages', 'navigation', 'api-sources', 'anydocs.config.json']) if (existsSync(join(source, name))) cpSync(join(source, name), join(project, name), { recursive: true });
    mkdirSync(dirname(frozenGolden), { recursive: true });
    writeFileSync(frozenGolden, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
    save(join(output, 'dataset/case-analysis.json'), cases.map((c) => ({ id: c.id, ...caseAnalysis(c.id) })));
    save(join(output, 'request-order.json'), plan);
    manifest = { schema_version: 1, experiment_id: `pc-agent-full-${new Date().toISOString().replace(/[-:.]/g, '')}`,
      status: 'prepared', engine_sha: git(engine, 'rev-parse', 'HEAD'), docs_sha: git(source, 'rev-parse', 'HEAD'),
      engine_dirty_status: git(engine, 'status', '--short'), docs_dirty_status: git(source, 'status', '--short'),
      adapter_files: Object.fromEntries(files.map((p) => [p, fileHash(join(engine, p))])),
      golden_source_sha256: fileHash(golden), golden_frozen_sha256: fileHash(frozenGolden),
      evaluation_input_sha256: contentHash(cases.map((c) => ({ id: c.id, question: c.query, lang: c.lang, current_page_id: null, history: [] }))),
      context_mode: 'no_page', variants: ABLATION_VARIANTS, repetitions: 3, planned_attempts: plan.length,
      outer_attempts: 1, candidate_timing: 'live', schedule_seed: 20261020, schedule_sha256: contentHash(plan),
      answer_model: 'deepseek-flash', judge_model: 'deepseek-v4-pro', limits: ABLATION_LIMITS,
      reranker_enabled: false, router_llm_enabled: false, answer_cache: false,
      planned_judge_profile: 'ablation-full-v1', metric_profiles: { reference_fact_recall: 'audited-v3', other_five: 'audited-v1' },
      strict_source_gate: false, label_review_status: 'independent business review pending',
      result_scope: 'exploratory offline regression comparison; not production acceptance or unseen evaluation',
      known_label_judge_boundaries: ['payout terminal-status grouping', 'v1 wallet inference from v2 definition', 'public URL inference'],
      acceptance_thresholds: 'not business-approved; descriptive comparisons only',
      node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpu_count: cpus().length,
      memory_bytes: totalmem(), lockfile_sha256: fileHash(join(engine, 'pnpm-lock.yaml')),
      sdk_retries: 2, static_postprocess_character_cap: 4000, started_at: new Date().toISOString() };
    for (const name of ['src', 'prompts', 'package.json', 'pnpm-lock.yaml', ...files.filter((f) => !f.startsWith('src/'))]) {
      if (!existsSync(join(engine, name))) continue;
      mkdirSync(dirname(join(output, 'source-archive', name)), { recursive: true });
      cpSync(join(engine, name), join(output, 'source-archive', name), { recursive: true });
    }
    save(join(output, 'manifest.json'), manifest);
  }
  process.env.ANYDOCS_ENGINE_RELEASE = manifest.engine_sha;
  process.env.ANYDOCS_RELEASE = manifest.docs_sha;
  const { config } = await loadConfig(source);
  config.llm.model = 'deepseek-flash'; config.reranker.enabled = false; config.router.enabled = false;
  config.feedback.enabled = false; config.multiTurn.enabled = false; config.agent.enabled = true; config.runs.enabled = false;
  const observability = await startLangfuseObservability();
  if (!observability.enabled) throw new Error('Original Langfuse tracing is required');
  const runtime = new Runtime({ projectRoot: project, stateRoot: join(output, 'state'), config, skipWatcher: true, reranker: null });
  try {
    for (const p of flags['embedding-cache-from'] ?? []) {
      const db = new Database(resolve(p), { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare('SELECT content_hash,model,embedding,created_at FROM embedding_cache WHERE model=?').all(runtime.embedder.model) as any[];
        const insert = runtime.db.prepare('INSERT OR IGNORE INTO embedding_cache(content_hash,model,embedding,created_at) VALUES(?,?,?,?)');
        runtime.db.transaction(() => { for (const r of rows) insert.run(r.content_hash, r.model, r.embedding, r.created_at); })();
      } finally { db.close(); }
    }
    const boot = await runtime.start();
    const index = {
      pages: runtime.db.prepare('SELECT page_id,lang,status,title,url FROM pages ORDER BY page_id,lang').all(),
      chunks: runtime.db.prepare(`SELECT c.page_id,c.lang,c.in_page_path,c.content_hash,c.token_count,p.parent_path
        FROM chunks c LEFT JOIN chunk_parents p ON c.parent_id=p.parent_id
        ORDER BY c.page_id,c.lang,c.in_page_path`).all(),
      parents: runtime.db.prepare('SELECT page_id,lang,parent_path,content_hash,token_count FROM chunk_parents ORDER BY page_id,lang,parent_path').all(),
    };
    if (manifest.index_content_sha256 && manifest.index_content_sha256 !== contentHash(index)) throw new Error('Logical index changed on resume');
    manifest.index_content_sha256 = contentHash(index); manifest.runtime_boot_ms = boot.boot_ms;
    manifest.index_counts = { pages: index.pages.length, chunks: index.chunks.length, parents: index.parents.length };
    manifest.embedding_model = runtime.embedder.model; manifest.tracing_enabled = true;
    save(join(output, 'index-content.json'), index);
    await runtime.embedder.embed([cases[0]!.query]);
    if (flags['prepare-only']) { manifest.status = 'prepared_only'; save(join(output, 'manifest.json'), manifest); return; }
    const previous = readLines(ledger);
    const completed = validateCompleted(plan, previous);
    const fingerprints = new Map<string, string>();
    const outcomes: any[] = previous.map(outcome);
    for (const r of previous) if (r.candidate_fingerprint) {
      const key = `${r.repetition}:${r.case_id}`;
      if (fingerprints.has(key) && fingerprints.get(key) !== r.candidate_fingerprint) throw new Error('Archived A/B mismatch');
      fingerprints.set(key, r.candidate_fingerprint);
    }
    // Rebuild derived views from the append-only ledger, including after a mid-write interruption.
    for (const variant of ABLATION_VARIANTS) for (let r = 1; r <= 3; r++) {
      const path = join(output, 'groups', variant, `r${String(r).padStart(2, '0')}`, 'raw.cases.jsonl');
      mkdirSync(dirname(path), { recursive: true });
      const rows = previous.filter((x) => x.variant === variant && x.repetition === r);
      writeFileSync(path, rows.length ? rows.map((x) => JSON.stringify(x)).join('\n') + '\n' : '');
    }
    const model = buildAgentLanguageModel(config);
    if (typeof model === 'string') throw new Error('Explicit provider instance required');
    const deps = { db: runtime.db, embedder: runtime.embedder, llm: runtime.llm, promptConfig: config.prompt,
      retrievalConfig: config.retrieval, reranker: null };
    manifest.status = 'running'; save(join(output, 'manifest.json'), manifest);
    for (const item of plan) {
      if (completed.has(requestKey(item))) continue;
      const c = cases.find((x) => x.id === item.case_id)!;
      const analysis = caseAnalysis(c.id);
      const request = { question: c.query, context: { current_page_id: null, history: [] } };
      const observed = await traceAskTurn({ requestId: `${manifest.experiment_id}:${requestKey(item)}`,
        sessionId: manifest.experiment_id, source: 'ablation-full', question: c.query, currentPageId: null,
        agentic: item.variant === 'agentic', traceName: `ablation-${item.variant}`, environment: 'evaluation',
        version: manifest.engine_sha, tags: ['ablation-full', item.variant, 'no_page', c.lang, `r${item.repetition}`],
        metadata: { experiment_id: manifest.experiment_id, variant: item.variant, case_id: c.id,
          context_mode: 'no_page', repetition: String(item.repetition), family_id: analysis.family_id,
          evaluation_input_sha256: manifest.evaluation_input_sha256 },
      }, () => runAblationVariant({ variant: item.variant, request, askDeps: deps, model, modelId: config.llm.model,
        agentConfig: config.agent, promptConfig: config.prompt }), (v) => ({ case_id: c.id, result: v.traced.result, evidence_tokens: v.evidence_tokens }));
      const v = observed.value;
      const score = scoreCase(c, v.traced.result, v.traced.trace); score.latency_ms = v.raw_latency_ms;
      const record = buildEvalCaseTraceRecord({ c, index: item.order, total: plan.length, caseResult: score,
        traced: v.traced, evalRunId: manifest.experiment_id, langfuseTraceId: observed.traceId, langfuseObservationId: observed.observationId });
      const row = { ...record, request, ...item, ...analysis, attempt: 1, experiment_id: manifest.experiment_id,
        context_mode: 'no_page', evaluation_input_sha256: manifest.evaluation_input_sha256,
        candidate_fingerprint: v.candidate_fingerprint, raw_latency_ms: v.raw_latency_ms,
        raw_response: v.raw_response, finish_reason: v.finish_reason, evidence_tokens: v.evidence_tokens,
        model_calls: v.model_calls, read_audit: v.read_audit, discovery_audit: v.discovery_audit,
        child_candidates: v.child_candidates, reader_prompt_sha256: v.reader_prompt_sha256, all_call_usage: usageTotals(v.model_calls) };
      append(ledger, row);
      append(join(output, 'groups', item.variant, `r${String(item.repetition).padStart(2, '0')}`, 'raw.cases.jsonl'), row);
      completed.add(requestKey(item)); outcomes.push(outcome(row));
      if (!observed.traceId || !observed.observationId) throw new Error('Missing source trace IDs');
      if (v.candidate_fingerprint) {
        const key = `${item.repetition}:${c.id}`, prior = fingerprints.get(key);
        if (prior && prior !== v.candidate_fingerprint) throw new Error(`A/B candidate mismatch: ${key}`);
        fingerprints.set(key, v.candidate_fingerprint);
      }
      if (v.evidence_tokens > 8000) throw new Error('Evidence budget exceeded');
      const prompts = v.traced.trace.input_snapshot?.attempts.flatMap((a) => [a.system_prompt, a.user_prompt]).join('\n') ?? '';
      if (c.expected.reference_facts?.some((f) => prompts.includes(f) && !record.ragas_sample.retrieved_contexts.some((b) => b.includes(f)))) throw new Error('Unexplained Golden wording outside evidence');
      await recordTraceScores({ traceId: observed.traceId, observationId: observed.observationId,
        scores: buildLangfuseEvalScores(score, v.traced.trace) });
      save(join(output, 'summary.json'), { status: 'running', completed: outcomes.length, planned: plan.length, outcomes });
      process.stdout.write(`${outcomes.length}/${plan.length} r${item.repetition} ${item.variant} ${c.id}: ${v.traced.result.type}, ${v.raw_latency_ms}ms\n`);
    }
    manifest.status = 'complete'; manifest.completed_attempts = completed.size; manifest.completed_at = new Date().toISOString();
    save(join(output, 'summary.json'), { status: 'complete', completed: outcomes.length, planned: plan.length,
      ab_candidate_pairs_verified: fingerprints.size, outcomes });
    save(join(output, 'manifest.json'), manifest);
  } catch (error) {
    manifest.status = 'failed'; manifest.error = redactSensitiveText(error instanceof Error ? error.message : 'Unknown full-run error');
    save(join(output, 'manifest.json'), manifest); throw error;
  } finally { await runtime.stop(); await observability.shutdown(); }
}
main().catch((e) => { process.stderr.write(`Full eval stopped: ${redactSensitiveText(e instanceof Error ? e.message : 'Unknown error')}\n`); process.exitCode = 1; });
