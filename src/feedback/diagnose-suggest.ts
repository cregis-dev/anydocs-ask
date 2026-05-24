/**
 * RFC 0006 A5 alpha.2 — A+ 失败查询诊断 / 补文档建议生成。
 *
 * 输入一个 {@link FeedbackCluster}（来自 alpha.1 聚类）+ 关联 answer
 * markdown 片段 + 候选 nav 挂载点提示，输出一份 markdown 补文档建议草稿。
 *
 * 复用现有 Anthropic 通道（B.2 路径，与 RFC 0003/0005 一致）；不引入小
 * 模型。RFC §4.4 prompt 强约束「只能基于输入 query + answer + nav；不
 * 引入外部知识」防止 LLM 推测事实点。
 *
 * 失败模式同 RFC 0005 V1：所有解析 / 调用错误**静默吞掉**，对应 cluster
 * 跳过；CLI 顶层统计跳过数 + stderr warn。
 *
 * Pure-async：不写 DB / 不写 disk；调用方决定怎么持久化（runner alpha.2
 * 才接通文件写入）。
 */

import type { LLM } from '../llm/types.ts';
import type { FeedbackCluster } from './diagnose-cluster.ts';

export type SuggestionContextRow = {
  /** Tied to `members[i]` of the cluster. Same length as `cluster.members`. */
  answer_md: string;
};

export type GenerateSuggestionInput = {
  llm: LLM;
  cluster: FeedbackCluster;
  /** Per-member answer markdown excerpts (已截到 ≤ 200 字). Optional —
   *  if absent the prompt only carries question text. Order MUST mirror
   *  `cluster.members`. */
  contextRows?: readonly SuggestionContextRow[];
  /**
   * Candidate nav mount points the LLM may pick from when suggesting where
   * the补文档 should sit. alpha.2 keeps this list shallow — pass page-level
   * breadcrumbs like `"Getting Started > Quickstart"`. Empty array → LLM
   * outputs "(determine mount point manually)" placeholder.
   */
  navHints?: readonly string[];
  /** ISO 8601 timestamp written into the markdown frontmatter. Injected
   *  for test determinism; defaults to current time. */
  now?: () => Date;
  /** Force shadow flag into the frontmatter. Falsy = production. */
  shadow?: boolean;
};

export type SuggestionOutput = {
  /** The generated markdown (frontmatter + body). Ready to write to disk. */
  markdown: string;
  /** LLM model id (from `LLMGenerateOutput.modelUsed`). */
  model: string;
  /** Generation latency in ms. */
  latencyMs: number;
};

const MAX_SUGGESTION_CHARS = 2_000;

const SYSTEM_PROMPT =
  '你是文档诊断助手。下面是用户对 anydocs 项目提的一组失败 query（同主题）。\n' +
  '基于现有 navigation（已注入）+ 失败的答案片段，生成一份补文档建议草稿。\n' +
  '\n' +
  '硬约束：\n' +
  '- 只能基于输入 query + answer + nav；不引入外部知识\n' +
  '- 不推测未在输入中出现的事实点\n' +
  '- 不自动写文档；输出只是建议草稿\n' +
  '- ≤ 1500 字符；超出会被截断\n' +
  '\n' +
  '输出严格 markdown：\n' +
  '```\n' +
  '# 建议：在 <nav> 下新增/补充 "<topic>" 章节\n' +
  '## 当前用户的痛点（脱敏抽样）\n' +
  '- <query 1>\n' +
  '- <query 2>\n' +
  '...\n' +
  '## 建议覆盖的事实点\n' +
  '- <事实点 1>\n' +
  '- <事实点 2>\n' +
  '## 建议挂载位置\n' +
  '<nav 路径 + 锚点>\n' +
  '```\n' +
  '\n' +
  '只输出 markdown，不要任何额外文本（如 "Here is your suggestion:"）。';

export async function generateSuggestion(
  input: GenerateSuggestionInput,
): Promise<SuggestionOutput | null> {
  const { llm, cluster } = input;
  const now = input.now ?? (() => new Date());
  const navHints = input.navHints ?? [];

  // Build the user prompt JSON — mirrors RFC §4.4 schema.
  const memberPayload = cluster.member_questions.map((q, i) => ({
    question: q,
    answer_md: input.contextRows?.[i]?.answer_md?.slice(0, 200) ?? '',
  }));
  const userPrompt = JSON.stringify({
    cluster_id: cluster.cluster_id,
    center_question: cluster.center_question,
    member_count: cluster.size,
    density: cluster.density,
    members: memberPayload,
    nav_hints: navHints,
  });

  const t0 = Date.now();
  let raw;
  try {
    raw = await llm.generate({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 1_500,
      temperature: 0.2,
    });
  } catch {
    // Silent — runner handles per-cluster failures by skipping + stderr warn.
    return null;
  }
  const latencyMs = Math.max(0, Date.now() - t0);
  const body = stripCodeFence(raw.text).trim();
  if (body.length === 0) return null;
  const capped = body.length <= MAX_SUGGESTION_CHARS
    ? body
    : body.slice(0, MAX_SUGGESTION_CHARS - 1) + '…';

  const frontmatter = buildFrontmatter({
    cluster,
    model: raw.modelUsed,
    generatedAt: now().toISOString(),
    shadow: input.shadow === true,
  });

  return {
    markdown: frontmatter + '\n' + capped + '\n',
    model: raw.modelUsed,
    latencyMs,
  };
}

function buildFrontmatter(args: {
  cluster: FeedbackCluster;
  model: string;
  generatedAt: string;
  shadow: boolean;
}): string {
  // YAML-ish frontmatter — git-friendly per PRD §11.4 / §11.3 F3. Escape
  // double quotes in center_question; otherwise pass through (markdown UI
  // tools handle the wide unicode characters fine).
  const center = args.cluster.center_question.replace(/"/g, '\\"');
  return [
    '---',
    `cluster_id: ${args.cluster.cluster_id}`,
    `center_question: "${center}"`,
    `member_count: ${args.cluster.size}`,
    `density: ${args.cluster.density.toFixed(4)}`,
    `model: ${args.model}`,
    `generated_at: ${args.generatedAt}`,
    `shadow: ${args.shadow}`,
    '---',
  ].join('\n');
}

function stripCodeFence(text: string): string {
  // Some providers wrap markdown output in ```markdown ... ``` despite
  // the system prompt asking for plain markdown. Strip exactly one fence
  // (the outermost) to avoid mangling intentional inline code blocks.
  const m = /^\s*```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1]! : text;
}
