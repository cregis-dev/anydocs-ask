import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { generateText, wrapLanguageModel, type LanguageModel } from 'ai';
import { AgenticRagRunner } from '../agent/runner.ts';
import { EvidenceService, EvidenceToolError, type EvidenceRecord } from '../agent/evidence.ts';
import type { AgentConfig, PromptConfig } from '../config.ts';
import type { DocsLang } from '../anydocs/types.ts';
import type { DbHandle } from '../db/index.ts';
import {
  searchWithTrace, selectContextWithParents,
  type AskDeps, type AskTrace, type AskTraceContextChunk, type AskWithTraceResult,
} from '../query/answer.ts';
import { fallbackRoute } from '../query/intent-router.ts';
import { detectLangFromText } from '../query/lang.ts';
import { buildPrompt, detectFormatHint } from '../query/prompt.ts';
import { postprocess } from '../query/postprocess.ts';
import type { RerankedChunk } from '../query/rerank.ts';
import type { AskRequest, SearchHit } from '../query/types.ts';
import { createInputCapture } from '../runs/input-snapshot.ts';

export const ABLATION_VARIANTS = ['child_only', 'parent_child', 'page_static', 'agentic'] as const;
export type AblationVariant = typeof ABLATION_VARIANTS[number];
export type ContextMode = 'no_page' | 'original_page';

export const ABLATION_LIMITS = {
  childCandidates: 20, pageCandidates: 20, contextItems: 8,
  evidenceTokens: 8000, readTokens: 3300, readCalls: 3,
  outputTokens: 1800, deadlineMs: 60_000, temperature: 0,
} as const;

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function estimateEvidenceTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  return Math.max(1, cjk + Math.ceil(text.replace(/[\u3400-\u9fff]/gu, '').length / 4));
}

export function candidateFingerprint(chunks: RerankedChunk[]): string {
  return contentHash(chunks.map((chunk) => ({
    page: chunk.page_id, lang: chunk.lang, path: chunk.in_page_path,
    body: contentHash(chunk.text), score: chunk.final_score,
  })));
}

export type ReadAudit = {
  page_id: string; lang: string | null; mode: string; selector: string | null;
  max_tokens: number; ok: boolean; evidence_id?: string;
  estimated_tokens?: number; repeated?: boolean; truncated?: boolean; error_code?: string;
};

/** Refuse an oversized unit before it can reach the Agent or the evidence ledger. */
export class BudgetedEvidenceService extends EvidenceService {
  readonly reads: ReadAudit[] = [];
  readonly discoveries: Array<{ tool: string; query: string | null; candidates: unknown }> = [];
  readonly records = new Map<string, EvidenceRecord>();
  private readonly requestCache = new Map<string, EvidenceRecord>();
  private usedTokens = 0;
  private readonly base: EvidenceService;
  private readonly limits: { totalTokens: number; readTokens: number; readCalls: number };
  private readonly signal?: AbortSignal;

  constructor(
    base: EvidenceService,
    deps: ConstructorParameters<typeof EvidenceService>[0],
    limits = { totalTokens: 8000, readTokens: 3300, readCalls: 3 },
    signal?: AbortSignal,
  ) { super(deps); this.base = base; this.limits = limits; this.signal = signal; }

  get evidenceTokens(): number { return this.usedTokens; }

  override async searchDocs(input: Parameters<EvidenceService['searchDocs']>[0]) {
    this.signal?.throwIfAborted();
    const result = await this.base.searchDocs(input);
    this.discoveries.push({ tool: 'searchDocs', query: input.query, candidates: result.candidates });
    return result;
  }

  override lookupExact(input: Parameters<EvidenceService['lookupExact']>[0]) {
    this.signal?.throwIfAborted();
    const result = this.base.lookupExact(input);
    this.discoveries.push({ tool: 'lookupExact', query: input.identifier, candidates: result });
    return result;
  }

  override browseCatalog(input: Parameters<EvidenceService['browseCatalog']>[0]) {
    this.signal?.throwIfAborted();
    const result = this.base.browseCatalog(input);
    this.discoveries.push({ tool: 'browseCatalog', query: null, candidates: result });
    return result;
  }

  override readDoc(input: Parameters<EvidenceService['readDoc']>[0]): EvidenceRecord {
    const audit: ReadAudit = {
      page_id: input.pageId, lang: input.lang ?? null,
      mode: input.mode ?? 'page', selector: input.selector ?? null,
      max_tokens: 0, ok: false,
    };
    const priorReads = this.reads.length;
    this.reads.push(audit);
    try {
      this.signal?.throwIfAborted();
      if (priorReads >= this.limits.readCalls) {
        throw new EvidenceToolError('read_budget_exceeded', 'Evaluation read-call budget exhausted');
      }
      const requestKey = contentHash({ ...input, maxTokens: undefined });
      const cached = this.requestCache.get(requestKey);
      if (cached) {
        Object.assign(audit, { ok: true, evidence_id: cached.evidenceId, repeated: true,
          estimated_tokens: estimateEvidenceTokens(cached.body), truncated: cached.truncated });
        return cached;
      }
      const remaining = this.limits.totalTokens - this.usedTokens;
      const limit = Math.min(input.maxTokens ?? this.limits.readTokens, this.limits.readTokens, remaining);
      audit.max_tokens = limit;
      if (limit < 1) throw new EvidenceToolError('evidence_budget_exceeded', 'Evaluation evidence budget exhausted');
      const record = this.base.readDoc({ ...input, maxTokens: limit });
      const tokens = estimateEvidenceTokens(record.body);
      const repeated = this.records.has(record.evidenceId);
      if (tokens > limit || (!repeated && tokens > remaining)) {
        throw new EvidenceToolError('evidence_budget_exceeded', 'Read unit exceeds the remaining evaluation budget');
      }
      if (!repeated) { this.records.set(record.evidenceId, record); this.usedTokens += tokens; }
      this.requestCache.set(requestKey, record);
      Object.assign(audit, { ok: true, evidence_id: record.evidenceId, estimated_tokens: tokens,
        repeated, truncated: record.truncated });
      return record;
    } catch (error) {
      audit.error_code = error instanceof EvidenceToolError ? error.code : 'read_failed';
      throw error;
    }
  }
}

export type ModelCallAudit = {
  call: number; duration_ms: number; ok: boolean; temperature?: number;
  max_output_tokens?: number; tool_choice: unknown; prompt_sha256: string;
  usage?: unknown; finish_reason?: unknown; response_id?: string; response_model?: string;
  output_text?: string;
};

export function auditLanguageModel(
  model: Exclude<LanguageModel, string>, calls: ModelCallAudit[],
): Exclude<LanguageModel, string> {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        const started = performance.now();
        const audit: ModelCallAudit = {
          call: calls.length + 1, duration_ms: 0, ok: false,
          temperature: params.temperature, max_output_tokens: params.maxOutputTokens,
          tool_choice: params.toolChoice ?? null, prompt_sha256: contentHash(params.prompt),
        };
        calls.push(audit);
        try {
          const result = await doGenerate();
          Object.assign(audit, { ok: true, usage: result.usage, finish_reason: result.finishReason,
            response_id: result.response?.id, response_model: result.response?.modelId,
            output_text: result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('') });
          return result;
        } finally { audit.duration_ms = Math.round(performance.now() - started); }
      },
    },
  });
}

export type AblationOutput = {
  traced: AskWithTraceResult;
  candidate_fingerprint: string | null;
  child_candidates: RerankedChunk[];
  read_audit: ReadAudit[];
  discovery_audit: BudgetedEvidenceService['discoveries'];
  model_calls: ModelCallAudit[];
  raw_response: string | null;
  finish_reason: string | null;
  evidence_tokens: number;
  reader_prompt_sha256: string | null;
  raw_latency_ms: number;
};

const UNUSED_LLM = {
  model: 'ablation-discovery-no-llm',
  async generate(): Promise<never> { throw new Error('Discovery must not invoke an answer model'); },
};

export function controlledSearchDeps(deps: AskDeps): AskDeps {
  return {
    ...deps, llm: UNUSED_LLM, reranker: null,
    retrievalConfig: { topK: 20, maxChunksHardCap: 20, rrfK: 60 },
    intentRouter: { async route({ question }) {
      return { ...fallbackRoute(question), reason: 'controlled_ablation_no_llm_router' };
    } },
  };
}

export async function runAblationVariant(input: {
  variant: AblationVariant; request: AskRequest; askDeps: AskDeps;
  model: Exclude<LanguageModel, string>; modelId: string;
  agentConfig: AgentConfig; promptConfig?: PromptConfig; deadlineMs?: number;
}): Promise<AblationOutput> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Evaluation request deadline exceeded')),
    input.deadlineMs ?? ABLATION_LIMITS.deadlineMs);
  const deps = controlledSearchDeps(input.askDeps);
  const serviceDeps = { db: deps.db, searchDeps: deps };
  const evidence = new BudgetedEvidenceService(new EvidenceService(serviceDeps), serviceDeps,
    { totalTokens: 8000, readTokens: 3300, readCalls: 3 }, controller.signal);
  const modelCalls: ModelCallAudit[] = [];
  const model = auditLanguageModel(input.model, modelCalls);
  const output: AblationOutput = {
    traced: { result: { type: 'error', code: 'evaluation_failed', message: 'Evaluation did not finish' },
      trace: emptyTrace(), queryVector: null },
    candidate_fingerprint: null, child_candidates: [], read_audit: evidence.reads,
    discovery_audit: evidence.discoveries, model_calls: modelCalls,
    raw_response: null, finish_reason: null, evidence_tokens: 0,
    reader_prompt_sha256: null, raw_latency_ms: 0,
  };
  try {
    if (input.variant === 'agentic') {
      const runner = new AgenticRagRunner({
        model, modelId: input.modelId, config: { ...input.agentConfig,
          maxSteps: 5, maxDiscoveryCalls: 2, maxReadCalls: 3,
          maxSupplementalSearchCalls: 1, readTokenLimit: 3300 },
        promptConfig: input.promptConfig, askDeps: deps, evidence,
      });
      output.traced = await runner.ask(input.request, { signal: controller.signal });
      output.evidence_tokens = evidence.evidenceTokens;
      output.raw_response = modelCalls.at(-1)?.output_text ?? null;
      output.finish_reason = modelCalls.at(-1)?.finish_reason == null ? null
        : JSON.stringify(modelCalls.at(-1)!.finish_reason);
      return output;
    }

    const lang = detectLangFromText(input.request.question);
    let selected: ReturnType<typeof selectContextWithParents> = [];
    if (input.variant === 'page_static') {
      const searched = await evidence.searchDocs({ query: input.request.question, limit: 20,
        currentPageId: input.request.context?.current_page_id ?? null });
      output.traced.trace = { ...emptyTrace(), timings: { ...emptyTrace().timings, ...searched.timings } };
      for (const candidate of searched.candidates) {
        if (evidence.reads.length >= 3) break;
        const total = input.askDeps.db.prepare(
          `SELECT COALESCE((SELECT token_count FROM chunk_parents WHERE page_id=? AND lang=? AND parent_path='$page'),
            SUM(token_count)) AS tokens FROM chunks WHERE page_id = ? AND lang = ?`,
        ).get(candidate.page_id, candidate.lang, candidate.page_id, candidate.lang) as { tokens: number };
        const selector = candidate.in_page_path?.replace(/\/p\[\d+\]$/, '') || null;
        try {
          const record = evidence.readDoc({ pageId: candidate.page_id, lang: candidate.lang,
            mode: total.tokens > 3300 && selector ? 'section' : 'page',
            selector: total.tokens > 3300 ? selector : null, maxTokens: 3300 });
          const chunk = hydrateChunk(deps.db, record.chunkIds[0]!);
          selected.push({ ...chunk, text: record.body, content_hash: record.contentHash,
            in_page_path: record.inPagePath, expanded_parent: null,
            context_token_count: estimateEvidenceTokens(record.body) });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (!(error instanceof EvidenceToolError)) throw error;
        }
      }
      output.traced.trace.fused = searched.candidates.map(hitTrace);
      output.evidence_tokens = evidence.evidenceTokens;
    } else {
      const searched = await searchWithTrace(deps, input.request, 20);
      output.traced.trace = searched.trace;
      if (searched.result.type === 'error') { output.traced.result = searched.result; return output; }
      const chunks = searched.result.hits.map((hit) => ({
        ...hydrateChunk(deps.db, hit.chunk_id), rrf_score: hit.score, final_score: hit.score,
      }));
      output.child_candidates = chunks;
      output.candidate_fingerprint = candidateFingerprint(chunks);
      selected = selectContextWithParents(deps.db, chunks, {
        maxItems: 8, maxTotalTokens: 8000,
        maxParentTokens: input.variant === 'child_only' ? 0 : 3300,
      });
      output.evidence_tokens = selected.reduce((n, chunk) => n + estimateEvidenceTokens(chunk.text), 0);
    }
    controller.signal.throwIfAborted();
    output.traced.trace.selected_context = selected.map(contextTrace);
    if (!selected.length) {
      output.traced.result = { type: 'error', code: 'no_evidence', message: 'No evidence was selected' };
      return output;
    }
    const prompt = buildPrompt({ question: input.request.question, chunks: selected,
      answerLang: lang, isCrossLang: selected.some((chunk) => chunk.lang !== lang),
      formatHint: detectFormatHint(input.request.question), promptConfig: input.promptConfig });
    output.reader_prompt_sha256 = contentHash(prompt.system);
    const capture = createInputCapture({ question: input.request.question,
      prompt_question: input.request.question, search_question: input.request.question,
      retrieve_question: input.request.question, current_page: input.request.context?.current_page_id ?? null,
      history: [], documents: selected.map((chunk, index) => ({
        citation_id: `cit_${index + 1}`, chunk_id: chunk.chunk_id, page_id: chunk.page_id,
        title: chunk.page_title, lang: chunk.lang, url: chunk.page_url, path: chunk.in_page_path,
        text: chunk.text, content_hash: chunk.content_hash, parent_id: chunk.parent_id,
        expanded_parent: chunk.expanded_parent,
      })) });
    output.traced.trace.input_snapshot = capture.snapshot;
    const attempt = capture.addAttempt({ systemPrompt: prompt.system, userPrompt: prompt.user });
    const generated = await generateText({ model, system: prompt.system, prompt: prompt.user,
      temperature: 0, maxOutputTokens: 1800, maxRetries: 2, abortSignal: controller.signal,
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
      telemetry: { functionId: 'ablation-static-reader' } });
    attempt.outcome = 'returned';
    attempt.model = generated.response.modelId;
    output.raw_response = generated.text;
    output.finish_reason = generated.finishReason;
    const post = postprocess({ answerLang: lang, rawAnswer: generated.text,
      chunkById: prompt.chunkById, question: input.request.question });
    attempt.accepted = post.used_chunks > 0;
    output.traced.trace.tokens_in = generated.totalUsage.inputTokens ?? null;
    output.traced.trace.tokens_out = generated.totalUsage.outputTokens ?? null;
    output.traced.result = post.used_chunks === 0
      ? { type: 'error', code: 'no_citations', message: 'Static reader returned no valid citations' }
      : { type: 'answer', answer_id: randomUUID(), answer_lang: lang,
          answer_md: post.answer_md, translation_notice: null, citations: post.citations,
          used_chunks: post.used_chunks, model: generated.response.modelId,
          latency_ms: Math.round(performance.now() - started) };
    return output;
  } catch (error) {
    const attempt = output.traced.trace.input_snapshot?.attempts.at(-1);
    if (attempt?.outcome === 'pending') attempt.outcome = 'error';
    output.traced.result = { type: 'error',
      code: controller.signal.aborted ? 'evaluation_timeout' : 'evaluation_failed',
      message: error instanceof EvidenceToolError ? error.code : 'Evaluation request failed; inspect trace' };
    return output;
  } finally {
    clearTimeout(timer);
    output.raw_latency_ms = Math.round(performance.now() - started);
    if (controller.signal.aborted) {
      output.traced.result = { type: 'error', code: 'evaluation_timeout', message: 'Evaluation request deadline exceeded' };
    }
    const generations = modelCalls.reduce((sum, call) => sum + call.duration_ms, 0);
    output.traced.trace.timings.generation_ms = generations;
    if (output.traced.result.type === 'answer') output.traced.result.latency_ms = output.raw_latency_ms;
  }
}

function hydrateChunk(db: DbHandle, chunkId: number): RerankedChunk {
  const row = db.prepare(`SELECT c.*, p.title AS page_title, p.url AS page_url,
    p.subtree_root, p.nav_index, p.breadcrumb FROM chunks c JOIN pages p
    ON c.page_id=p.page_id AND c.lang=p.lang WHERE c.chunk_id=?`).get(chunkId) as
    RerankedChunk & { breadcrumb: string };
  if (!row) throw new Error('Candidate chunk not found in frozen index');
  const identifiers = db.prepare('SELECT identifier FROM chunk_identifiers WHERE chunk_id=? ORDER BY normalized')
    .all(chunkId) as Array<{ identifier: string }>;
  return { ...row, breadcrumb: JSON.parse(row.breadcrumb),
    identifiers: identifiers.map((x) => x.identifier), rrf_score: 0, final_score: 0 };
}

function hitTrace(hit: SearchHit): AskTrace['fused'][number] {
  return { chunk_id: hit.chunk_id, page_id: hit.page_id, lang: hit.lang,
    page_title: hit.title, page_url: hit.url, in_page_path: hit.in_page_path,
    text_preview: hit.snippet, rrf_score: hit.score, final_score: hit.score,
    vec_rank: null, bm25_rank: null, exact_rank: null, nav_index: null };
}

function contextTrace(chunk: ReturnType<typeof selectContextWithParents>[number], index: number): AskTraceContextChunk {
  return { chunk_id: chunk.chunk_id, page_id: chunk.page_id, lang: chunk.lang,
    page_title: chunk.page_title, page_url: chunk.page_url, in_page_path: chunk.in_page_path,
    text_preview: chunk.text, content_hash: chunk.content_hash, parent_id: chunk.parent_id,
    expanded_parent: chunk.expanded_parent, context_rank: index + 1,
    context_token_count: estimateEvidenceTokens(chunk.text), rrf_score: chunk.rrf_score,
    final_score: chunk.final_score, vec_rank: null, bm25_rank: null, exact_rank: null, nav_index: chunk.nav_index };
}

function emptyTrace(): AskTrace {
  return { fused: [], subtree_ask_triggered: false, top_final_score: 0,
    timings: { router_ms: 0, embedding_ms: 0, retrieval_ms: 0, rerank_ms: 0, generation_ms: 0 },
    tokens_in: null, tokens_out: null };
}
