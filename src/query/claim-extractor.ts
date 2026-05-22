/**
 * RFC 0005 V2 — claim 句抽取。从 LLM 生成的 answer_md 里找出每个 `[cit_N]`
 * 标记前面的句子（即"被该 citation 支撑的 claim"），与 citation 对应的 chunk
 * 文本配成 pair，喂给批量校验模块（citation-validator）。
 *
 * 纯函数：不调 LLM、不读 IO、不依赖任何 runtime 状态。可独立单测。
 *
 * 设计取舍：
 * - 句界判定先用句号 / 问号 / 叹号（中英文）+ 段落断（`\n\n`）+ markdown
 *   结构（行首 # / -/数字列表）做切分，硬上限 200 字符防长 prefix 误吞。
 * - claim 内部其它 `[cit_M]` 标记一律剥掉，否则会污染语义。
 * - 同句多 cit 是允许的——每个 cit 各自产 pair（同 claim 文本、不同 chunk
 *   文本），让校验层各自判断；这与 §4.3 批量调用语义一致。
 * - chunk 文本默认取 citation.snippet（postprocess 已截到一段一句级别）；调
 *   用方需要拿完整 chunk 时通过 chunkTextById override。
 */

import type { Citation } from './types.ts';

export type CitationClaimPair = {
  /** "cit_1" / "cit_2"... — RFC 0005 V4 trace 用这个 id 关联校验结果。 */
  citationId: string;
  /** 紧邻 [cit_N] 之前的一段文本（≤ 200 字符），去掉所有 inline cit 标记。 */
  claim: string;
  /** 用于校验的文档片段。默认取 Citation.snippet。 */
  chunkText: string;
};

export type ExtractClaimsInput = {
  answerMd: string;
  citations: readonly Citation[];
  /**
   * 可选的 chunk 文本来源 override，用于未来想用完整 chunk 而非 snippet 做
   * 校验时切换数据源。返回 null/undefined 时该 cit 被跳过（视作"chunk 无法
   * 解析"，校验对它无意义）。
   */
  chunkTextById?: (citationId: string) => string | null | undefined;
};

const CLAIM_MAX_CHARS = 200;
const CIT_MARKER_RE = /\[cit_[A-Za-z0-9_]+\]/g;

/**
 * Sentence-boundary characters. **Only CJK fullwidth terminators** —
 * ASCII `.` / `!` / `?` are deliberately excluded:
 *   - `.` matches numeric literals (`v1.0`), ellipsis (`...`), abbreviations
 *     (`e.g.`), URLs and config keys → too noisy
 *   - English-only answers fall back to the `\n` line-break boundary or the
 *     200-char hard cap, which is informative enough for the validator
 *     (它不需要完整句法句子，只要语义自包含的 prefix)
 */
const SENTENCE_TERMINATORS = new Set(['。', '！', '？']);

export function extractClaimChunkPairs(input: ExtractClaimsInput): CitationClaimPair[] {
  const { answerMd, citations, chunkTextById } = input;
  if (!answerMd || answerMd.length === 0) return [];
  if (!Array.isArray(citations) || citations.length === 0) return [];

  const citIndex = new Map<string, Citation>();
  for (const c of citations) {
    citIndex.set(c.citation_id, c);
  }

  const out: CitationClaimPair[] = [];
  // Single forward scan: every `[cit_N]` match becomes (at most) one pair.
  // Using exec() keeps lastIndex correctly even when the regex spans the
  // entire string, and avoids materializing the whole match array up front.
  const re = new RegExp(CIT_MARKER_RE.source, 'g');
  for (let m = re.exec(answerMd); m !== null; m = re.exec(answerMd)) {
    const marker = m[0]; // "[cit_3]"
    const markerStart = m.index;
    const citationId = marker.slice(1, -1); // "cit_3"

    const claim = extractClaimBefore(answerMd, markerStart);
    if (claim.length === 0) continue; // marker at start / pure whitespace

    const chunkText = resolveChunkText(citationId, citIndex, chunkTextById);
    if (chunkText === null) continue; // missing citation or override returned null

    out.push({ citationId, claim, chunkText });
  }

  return out;
}

/**
 * Walk backwards from `markerStart` to the nearest sentence boundary, then
 * return the slice in between (trimmed + cit markers stripped). Capped at
 * `CLAIM_MAX_CHARS` to prevent a marker-less paragraph from swallowing an
 * entire prose block.
 */
function extractClaimBefore(text: string, markerStart: number): string {
  const lo = Math.max(0, markerStart - CLAIM_MAX_CHARS);
  let start = lo;
  // Walk from markerStart-1 down to `lo`, stopping at the first terminator
  // or paragraph break we see. Boundary itself is excluded from the claim.
  for (let i = markerStart - 1; i >= lo; i--) {
    const ch = text[i]!;
    if (SENTENCE_TERMINATORS.has(ch)) {
      start = i + 1;
      break;
    }
    // Any line break is a soft boundary — markdown answers separate list
    // items / sub-paragraphs with `\n`, and we'd rather take the immediate
    // line than wander into the previous one.
    if (ch === '\n') {
      start = i + 1;
      break;
    }
  }
  let claim = text.slice(start, markerStart);
  // Strip any inline cit markers from the claim (a sentence may carry
  // multiple cits — we don't want them in the claim text).
  claim = claim.replace(CIT_MARKER_RE, '');
  // Strip markdown list bullets / numbering at line start so claims read
  // as plain prose. Match the common patterns the answer prompt produces:
  //   "- item ..."   /   "* item ..."   /   "1. item ..."
  claim = claim.replace(/^\s*(?:[-*]\s+|\d+\.\s+)/, '');
  return claim.trim();
}

function resolveChunkText(
  citationId: string,
  citIndex: Map<string, Citation>,
  chunkTextById: ExtractClaimsInput['chunkTextById'],
): string | null {
  if (chunkTextById) {
    const override = chunkTextById(citationId);
    if (override === null || override === undefined) return null;
    const trimmed = override.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const cit = citIndex.get(citationId);
  if (!cit) return null;
  const trimmed = (cit.snippet ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
