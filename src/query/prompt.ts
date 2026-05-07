/**
 * LLM prompt construction (ARCH §6 step 6) — splits into system + user.
 *
 * - System prompt: invariant rules (cite from context only, language pin,
 *   structured output hint).
 * - User prompt: question + numbered chunks each prefixed with breadcrumb +
 *   source lang. Each chunk gets a `[cit_N]` marker that the model should
 *   reference inline; postprocess parses those markers back to citations.
 *
 * The format hint (paragraph / list / table) comes from a bilingual word
 * scan against the question (PRD §4.3).
 */

import type { DocsLang } from '../anydocs/types.ts';
import type { RerankedChunk } from './rerank.ts';

export type FormatHint = 'paragraph' | 'list' | 'table' | 'concept';

export type BuildPromptOptions = {
  question: string;
  chunks: RerankedChunk[];
  answerLang: DocsLang;
  /** True when the chunks include a different lang from answerLang. */
  isCrossLang: boolean;
  formatHint: FormatHint;
};

export type BuiltPrompt = {
  system: string;
  user: string;
  /** chunks indexed by citation id (cit_1, cit_2, ...) for postprocess use. */
  chunkById: Map<string, RerankedChunk>;
};

export function buildPrompt(opts: BuildPromptOptions): BuiltPrompt {
  const { question, chunks, answerLang, isCrossLang, formatHint } = opts;

  const chunkById = new Map<string, RerankedChunk>();
  const chunkBlocks: string[] = [];
  chunks.forEach((c, idx) => {
    const id = `cit_${idx + 1}`;
    chunkById.set(id, c);
    const breadcrumb = c.breadcrumb.map((b) => b.title).join(' / ');
    chunkBlocks.push(
      `[${id}] [${breadcrumb} (${c.lang})]\n${c.text}`,
    );
  });

  const system = systemPromptFor(answerLang, isCrossLang, formatHint);
  const user = `${userIntro(answerLang)}\n\n${question}\n\n${chunkLabel(answerLang)}\n\n${chunkBlocks.join('\n\n---\n\n')}`;

  return { system, user, chunkById };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function systemPromptFor(lang: DocsLang, isCrossLang: boolean, hint: FormatHint): string {
  const formatLine = formatLineFor(lang, hint);
  if (lang === 'zh') {
    const crossLangLine = isCrossLang
      ? '\n- 部分参考片段语种与答案不同，请在答案正文中翻译要点，但 citation snippet 不要翻译。'
      : '';
    return [
      '你是 Anydocs 文档问答助手。严格遵守以下规则：',
      '- 答案必须基于下方提供的参考片段，严禁编造。',
      '- 必须至少给出 1 条引用，引用使用 [cit_N] 标记内联在答案里。',
      '- 答案中所有代码 / API 名必须能在参考片段中找到，否则不要写入。',
      '- 答案语种必须为中文。',
      formatLine,
      crossLangLine,
    ]
      .filter(Boolean)
      .join('\n');
  }
  // en
  const crossLangLine = isCrossLang
    ? '\n- Some context snippets are in a different language; translate key points into English, but do NOT translate citation snippets themselves.'
    : '';
  return [
    'You are the Anydocs documentation Q&A assistant. Follow these rules strictly:',
    '- Base your answer ONLY on the supplied context snippets; do not invent facts.',
    '- Cite at least once using [cit_N] markers inline in the answer.',
    '- Every code identifier / API name in the answer must appear in the context.',
    '- Answer in English.',
    formatLine,
    crossLangLine,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatLineFor(lang: DocsLang, hint: FormatHint): string {
  if (lang === 'zh') {
    switch (hint) {
      case 'table': return '- 这是比较类问题，使用 Markdown 表格作答。';
      case 'list': return '- 这是步骤类问题，使用有序列表作答。';
      case 'concept': return '- 这是概念类问题，先一段定义，再列关键术语。';
      default: return '- 输出 Markdown 段落即可。';
    }
  }
  switch (hint) {
    case 'table': return '- This is a comparison question — answer with a Markdown table.';
    case 'list': return '- This is a how-to question — answer with an ordered list.';
    case 'concept': return '- This is a concept question — start with a one-paragraph definition, then list key terms.';
    default: return '- Reply in Markdown paragraphs.';
  }
}

// ---------------------------------------------------------------------------
// User prompt scaffolding
// ---------------------------------------------------------------------------

function userIntro(lang: DocsLang): string {
  return lang === 'zh' ? '用户问题：' : 'User question:';
}

function chunkLabel(lang: DocsLang): string {
  return lang === 'zh' ? '参考片段：' : 'Context snippets:';
}

// ---------------------------------------------------------------------------
// Format hint detection
// ---------------------------------------------------------------------------

const TABLE_PATTERNS = [
  /对比|差异|区别|哪个更好|与.+?的不同/,
  /\b(compare|comparison|difference|differences|vs\.?|differ)\b/i,
];
const LIST_PATTERNS = [
  /如何|步骤|怎么|怎样|流程/,
  /\b(how|step|steps|guide|walkthrough|tutorial)\b/i,
];
const CONCEPT_PATTERNS = [
  /什么是|是什么|介绍|概念/,
  /\b(what is|overview|introduction|intro|definition)\b/i,
];

export function detectFormatHint(question: string): FormatHint {
  for (const re of TABLE_PATTERNS) if (re.test(question)) return 'table';
  for (const re of LIST_PATTERNS) if (re.test(question)) return 'list';
  for (const re of CONCEPT_PATTERNS) if (re.test(question)) return 'concept';
  return 'paragraph';
}
