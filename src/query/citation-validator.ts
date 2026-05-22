/**
 * RFC 0005 V1 — citation 批量语义校验。复用现有主 LLM 通道（B.2 路径），
 * 一次调用判一答案的所有 citations。
 *
 * 输入：一批 (citationId, claim, chunkText) pair；输出：每个 cit 的 verdict +
 * reason + 模型 + 时戳。Pure-async：不写 DB / 不写 runs.jsonl，调用方决定怎
 * 么持久化（V3 alpha.2 才接通 runs.jsonl）。
 *
 * 失败模式（RFC §4.6）：所有解析 / 调用错误都**静默吞掉**，对应的 cit 不进
 * 输出。这与"shadow 模式静默缺数据"的产品语义一致；alpha.2 接入主路径时
 * 调用方将异步触发本函数，任何噪音都不该污染 /v1/ask 响应。
 */

import type { LLM } from '../llm/types.ts';
import type { CitationClaimPair } from './claim-extractor.ts';

export type SemanticVerdict = 'supports' | 'partially' | 'not_supports';

export type CitationCheckResult = {
  citationId: string;
  verdict: SemanticVerdict;
  /** ≤ `reasonMaxChars` 字符；超过截断 + 追加 "…"。 */
  reason: string;
  /** LLM 实际响应里报出的 model id（与 AskAnswer.model 同源）。 */
  model: string;
  /** 本 cit 所在批次完成的时间戳，ISO 8601。同批次共用。 */
  checkedAt: string;
  /** 本 cit 所在批次的 LLM 调用耗时，毫秒。同批次共用——批量本身的成本不
   *  归因到单个 cit。 */
  latencyMs: number;
};

export type ValidateCitationsInput = {
  llm: LLM;
  pairs: readonly CitationClaimPair[];
  /** RFC §4.1 — reason 长度上限。默认 100 字符。 */
  reasonMaxChars?: number;
  /** RFC §4.3 — 单批最多 cit 数。默认 10。> 10 拆批；每批一次 LLM 调用。 */
  batchSize?: number;
  /** Inject for tests; defaults to Date.now / performance.now hybrid. */
  now?: () => number;
};

const DEFAULT_REASON_MAX = 100;
const DEFAULT_BATCH_SIZE = 10;
const VERDICT_VALUES = new Set<SemanticVerdict>(['supports', 'partially', 'not_supports']);

const SYSTEM_PROMPT =
  '你是引用校验助手。判断一组"答案句子"是否能由对应的"文档片段"语义支撑。\n' +
  '\n' +
  '输入是一个 JSON 数组，每个元素含 { cit_id, claim, chunk }。\n' +
  '逐条判断，输出严格 JSON 数组，保持顺序，长度等于输入：\n' +
  '\n' +
  '[\n' +
  '  {\n' +
  '    "cit_id": "cit_1",\n' +
  '    "verdict": "supports" | "partially" | "not_supports",\n' +
  '    "reason": "...一句话（≤ 100 字符）..."\n' +
  '  },\n' +
  '  ...\n' +
  ']\n' +
  '\n' +
  '判断准则：\n' +
  '- supports: 答案句子的每个事实点都能在文档片段里找到对应\n' +
  '- partially: 大部分能找到，但有 1 个事实点缺失或偏差\n' +
  '- not_supports: 关键事实点找不到，或片段在讲另一件事\n' +
  '\n' +
  '只输出 JSON 数组，不要任何额外文本。';

export async function validateCitations(
  input: ValidateCitationsInput,
): Promise<CitationCheckResult[]> {
  const pairs = input.pairs ?? [];
  if (pairs.length === 0) return [];
  const reasonMax = clampPositiveInt(input.reasonMaxChars, DEFAULT_REASON_MAX);
  const batchSize = clampPositiveInt(input.batchSize, DEFAULT_BATCH_SIZE);
  const now = input.now ?? Date.now;

  const results: CitationCheckResult[] = [];
  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize);
    const batchResults = await runBatch({ llm: input.llm, batch, reasonMax, now });
    for (const r of batchResults) results.push(r);
  }
  return results;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function runBatch(args: {
  llm: LLM;
  batch: readonly CitationClaimPair[];
  reasonMax: number;
  now: () => number;
}): Promise<CitationCheckResult[]> {
  const { llm, batch, reasonMax, now } = args;
  const userPrompt = JSON.stringify(
    batch.map((p) => ({ cit_id: p.citationId, claim: p.claim, chunk: p.chunkText })),
  );
  const t0 = now();
  let raw: { text: string; modelUsed: string };
  try {
    raw = await llm.generate({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      // 一段 JSON 数组 + 每个 reason ≤ 100 字符；100 cit 上限给得很宽。
      maxTokens: Math.max(256, batch.length * 80),
      // 校验是确定性任务，去随机性。
      temperature: 0,
    });
  } catch {
    // Silent — see file header. fire-and-forget caller must not see noise.
    return [];
  }
  const latencyMs = Math.max(0, now() - t0);
  const checkedAt = new Date().toISOString();
  const parsed = parseLlmJsonArray(raw.text);
  if (parsed === null) return [];

  // Build a lookup so we can match by cit_id regardless of LLM's emitted order.
  const inputIds = new Set(batch.map((p) => p.citationId));
  const out: CitationCheckResult[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const citId = typeof o.cit_id === 'string' ? o.cit_id : null;
    if (citId === null || !inputIds.has(citId)) continue;
    if (seen.has(citId)) continue; // dedupe accidental repeats
    const verdict = o.verdict;
    if (typeof verdict !== 'string' || !VERDICT_VALUES.has(verdict as SemanticVerdict)) {
      continue;
    }
    const reasonRaw = typeof o.reason === 'string' ? o.reason : '';
    const reason = capReason(reasonRaw, reasonMax);
    seen.add(citId);
    out.push({
      citationId: citId,
      verdict: verdict as SemanticVerdict,
      reason,
      model: raw.modelUsed,
      checkedAt,
      latencyMs,
    });
  }
  return out;
}

/**
 * Try to recover a JSON array from arbitrary LLM text. Returns null on any
 * shape mismatch — caller treats this as a silent drop.
 *
 * The LLM has been told to emit ONLY the array, but providers often wrap it
 * in ```json fences or prepend "Here is the result:" prose. Strip a single
 * ```...``` fence and trim, then JSON.parse.
 */
function parseLlmJsonArray(text: string): unknown[] | null {
  const stripped = stripCodeFence(text).trim();
  if (stripped.length === 0) return null;
  try {
    const parsed = JSON.parse(stripped);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripCodeFence(text: string): string {
  // Match ```json ... ``` or just ``` ... ```. Non-greedy on the inside,
  // anchored to a single fence — if the LLM emitted multiple fences we'd
  // rather fail parse than guess.
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1]! : text;
}

function capReason(s: string, maxChars: number): string {
  const t = s.trim();
  if (t.length <= maxChars) return t;
  // Append a single-char ellipsis to make truncation visible without
  // inflating the length above the cap.
  return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
