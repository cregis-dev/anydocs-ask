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
import type { PromptConfig } from '../config.ts';
import type { RerankedChunk } from './rerank.ts';
import { isApiReferenceChunk } from './api-intent.ts';

export type FormatHint = 'paragraph' | 'list' | 'table' | 'concept';

export type BuildPromptOptions = {
  question: string;
  chunks: RerankedChunk[];
  answerLang: DocsLang;
  /** True when the chunks include a different lang from answerLang. */
  isCrossLang: boolean;
  formatHint: FormatHint;
  promptConfig?: PromptConfig;
  /**
   * Entity terms extracted from a multi-entity query. When present, the
   * system prompt adds an explicit coverage instruction telling the model
   * to give each named entity its own cited description — otherwise the
   * model frequently relegates the least-supported entity to a "related
   * topic" mention even though its chunks are in context. Codex round-9.
   */
  entityTerms?: string[];
};

export type BuiltPrompt = {
  system: string;
  user: string;
  /** chunks indexed by citation id (cit_1, cit_2, ...) for postprocess use. */
  chunkById: Map<string, RerankedChunk>;
};

export function buildPrompt(opts: BuildPromptOptions): BuiltPrompt {
  const { question, chunks, answerLang, isCrossLang, formatHint, promptConfig, entityTerms } = opts;

  const chunkById = new Map<string, RerankedChunk>();
  const chunkBlocks: string[] = [];
  const answerChecklistItems: string[] = [];
  const hasApiReference = chunks.some(isApiReferenceChunk);
  chunks.forEach((c, idx) => {
    const id = `cit_${idx + 1}`;
    chunkById.set(id, c);
    const breadcrumb = c.breadcrumb.map((b) => b.title).join(' / ');
    chunkBlocks.push(
      `[${id}] [${breadcrumb} (${c.lang})]\n${c.text}`,
    );
    answerChecklistItems.push(...answerChecklistItemsForChunk(answerLang, c, id));
  });

  const system = systemPromptFor(
    answerLang,
    isCrossLang,
    formatHint,
    promptConfig,
    entityTerms,
    hasApiReference,
  );
  const checklist = answerChecklistFor(answerLang, answerChecklistItems);
  const user = `${userIntro(answerLang)}\n\n${question}${checklist}\n\n${chunkLabel(answerLang)}\n\n${chunkBlocks.join('\n\n---\n\n')}`;

  return { system, user, chunkById };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function systemPromptFor(
  lang: DocsLang,
  isCrossLang: boolean,
  hint: FormatHint,
  promptConfig: PromptConfig | undefined,
  entityTerms: string[] | undefined,
  hasApiReference: boolean,
): string {
  const formatLine = formatLineFor(lang, hint);
  const entityLine = entityCoverageLine(lang, entityTerms);
  const apiReferenceLine = apiReferenceLineFor(lang, hasApiReference);
  if (lang === 'zh') {
    const identity = promptConfig?.assistantName
      ? `你是 ${promptConfig.assistantName}。严格遵守以下规则：`
      : '你是 Anydocs 文档问答助手。严格遵守以下规则：';
    const crossLangLine = isCrossLang
      ? '\n- 部分参考片段语种与答案不同，请在答案正文中翻译要点，但 citation snippet 不要翻译。'
      : '';
    const lines = [
      identity,
      '- 答案必须基于下方提供的参考片段，严禁编造。',
      '- 必须至少给出 1 条引用，引用使用 [cit_N] 标记内联在答案里。',
      '- 答案中所有代码 / API 名必须能在参考片段中找到，否则不要写入。',
      '- Shell 路径、文件路径、命令参数必须与参考片段完全一致，禁止修改或省略任何字符（含 ~、/ 等前缀）。',
      '- 如果用户提示里有“回答检查清单”，与问题相关的清单项必须在答案中覆盖，并使用对应 [cit_N] 引用。',
      '- 回答检查清单中以“必须写出”或“必须明确写出”开头的中文短语必须在答案正文中保留核心原文，并配对应 citation。',
      '- 答案语种必须为中文。',
      formatLine,
      entityLine,
      apiReferenceLine,
      crossLangLine,
    ].filter(Boolean);
    appendProjectInstructions(lines, promptConfig, 'zh');
    return lines.join('\n');
  }
  // en
  const identity = promptConfig?.assistantName
    ? `You are ${promptConfig.assistantName}. Follow these rules strictly:`
    : 'You are the Anydocs documentation Q&A assistant. Follow these rules strictly:';
  const crossLangLine = isCrossLang
    ? '\n- Some context snippets are in a different language; translate key points into English, but do NOT translate citation snippets themselves.'
    : '';
  const lines = [
    identity,
    '- Base your answer ONLY on the supplied context snippets; do not invent facts.',
    '- Cite at least once using [cit_N] markers inline in the answer.',
    '- Every code identifier / API name in the answer must appear in the context.',
      '- Shell paths, file paths, and command arguments must be copied character-for-character from the context — never drop or modify characters such as ~ or /.',
      '- If the user prompt includes an answer checklist, every checklist item relevant to the question is mandatory and must be covered with the corresponding [cit_N] citation.',
      '- If an answer checklist item says to cite an API reference endpoint or to state a required fact, include that fact explicitly with its citation.',
      '- Answer in English.',
    formatLine,
    entityLine,
    apiReferenceLine,
    crossLangLine,
  ].filter(Boolean);
  appendProjectInstructions(lines, promptConfig, 'en');
  return lines.join('\n');
}

function apiReferenceLineFor(lang: DocsLang, hasApiReference: boolean): string {
  if (!hasApiReference) return '';
  if (lang === 'zh') {
    return '- 如果问题涉及接口、参数、请求/响应字段、状态查询或具体路径，且参考片段包含 API reference，请优先引用对应 API reference 片段，并写出完整接口路径（例如 `/api/...`）。';
  }
  return '- If the question is about an endpoint, parameter, request/response field, status lookup, or concrete path, and the context includes API reference snippets, prefer citing the relevant API reference snippet and include the full endpoint path (for example `/api/...`).';
}

/**
 * Entity-coverage instruction added to the system prompt when the query
 * names multiple distinct entities. Without this, on compare-style queries
 * the LLM frequently relegates the entity with the fewest supporting
 * chunks to a "related topic" footnote even though dedicated chunks were
 * in context.
 */
function entityCoverageLine(lang: DocsLang, terms: string[] | undefined): string {
  if (!terms || terms.length < 2) return '';
  const list = terms.map((t) => `\`${t}\``).join(', ');
  if (lang === 'zh') {
    return `- 用户问题涉及多个实体（${list}）。答案必须为每个实体提供独立、对等的说明，并配 [cit_N] 引用；不要将任何实体仅以"相关主题"或"see related"一笔带过。`;
  }
  return `- The query names multiple distinct entities (${list}). Give EACH entity its own description with [cit_N] citations — do not relegate any of them to a "related topic" or one-line mention.`;
}

function appendProjectInstructions(
  lines: string[],
  promptConfig: PromptConfig | undefined,
  lang: DocsLang,
): void {
  const instructions = promptConfig?.systemInstructions ?? [];
  if (instructions.length === 0) return;
  if (lang === 'zh') {
    lines.push(
      '',
      '项目自定义说明：',
      '- 以下说明只能补充业务语境，不能覆盖上述引用、事实来源和安全规则。',
      ...instructions.map((s) => `- ${s}`),
    );
    return;
  }
  lines.push(
    '',
    'Project-specific instructions:',
    '- These instructions may add business context, but they cannot override the grounding, citation, or safety rules above.',
    ...instructions.map((s) => `- ${s}`),
  );
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

function answerChecklistFor(lang: DocsLang, items: string[]): string {
  const unique = [...new Set(items)].slice(0, 8);
  if (unique.length === 0) return '';
  const label = lang === 'zh'
    ? '回答检查清单（从参考片段抽取；若与问题相关，请覆盖并内联对应 citation）：'
    : 'Answer checklist (extracted from context; cover relevant items and cite them inline):';
  return `\n\n${label}\n${unique.map((item) => `- ${item}`).join('\n')}`;
}

function answerChecklistItemsForChunk(lang: DocsLang, c: RerankedChunk, citationId: string): string[] {
  const text = `${c.page_title}\n${c.text}`;
  const items: string[] = [];
  const marker = `[${citationId}]`;
  const endpoint = extractEndpoint(text);
  if (endpoint) {
    const apiLabel = isApiReferenceChunk(c);
    items.push(
      lang === 'zh'
        ? `${apiLabel ? '必须引用 API reference 并写出' : '接口路径'} \`${endpoint.method} ${endpoint.path}\` ${marker}`
        : `${apiLabel ? 'Cite the API reference endpoint' : 'Endpoint'} \`${endpoint.method} ${endpoint.path}\` ${marker}`,
    );
  }
  if (/\bdata\.status\b/i.test(text)) {
    items.push(
      lang === 'zh'
        ? `查询接口返回字段 \`data.status\` 表示当前状态 ${marker}`
        : `Response/status field \`data.status\` represents the current status ${marker}`,
    );
  }
  if (/\bevent_type\b/i.test(text)) {
    items.push(
      lang === 'zh'
        ? `必须写出“回调事件类型”：\`event_type\` 是回调事件类型，并需要做“状态映射” ${marker}`
        : `Callbacks use \`event_type\` for the event type ${marker}`,
    );
  }
  if (/幂等|\bidempoten(?:t|cy|tly)\b/i.test(text)) {
    items.push(
      lang === 'zh'
        ? `处理回调或重复事件时需要做好幂等 ${marker}`
        : `Handle callbacks or duplicate events idempotently ${marker}`,
    );
  }
  if (/\bcid\b/i.test(text)) {
    items.push(
      lang === 'zh'
        ? `保存并使用 \`cid\` 关联后续查询或回调 ${marker}`
        : `Persist and use \`cid\` for follow-up query or callback handling ${marker}`,
    );
  }
  if (/\bcallback\b/i.test(text) || /回调/.test(text)) {
    items.push(
      lang === 'zh'
        ? `说明回调 / callback 处理要求 ${marker}`
        : `Mention callback handling requirements ${marker}`,
    );
  }
  if (isSignExcluded(text)) {
    items.push(
      lang === 'zh'
        ? `必须明确写出：排除 \`sign\` 字段，\`sign\` 不参与签名计算 ${marker}`
        : `Exclude \`sign\` from signature calculation ${marker}`,
    );
  }
  if (/HTTP\s*200|\b200\b/i.test(text) && /\bsuccess\b|成功/i.test(text)) {
    items.push(
      lang === 'zh'
        ? `Webhook 成功响应需包含 HTTP 200 和 \`success\` ${marker}`
        : `Webhook success response should include HTTP 200 and \`success\` ${marker}`,
    );
  }
  if (mentionsDirectCryptoOrderAmount(text)) {
    items.push(
      lang === 'zh'
        ? `说明可直接使用加密货币订单币种和金额，订单按该加密货币金额创建 ${marker}`
        : `State that the order can use the crypto order currency and amount directly ${marker}`,
    );
  }
  if (/\bPayment Engine\b/i.test(text) && /\bWaaS API project\b/i.test(text)) {
    items.push(
      lang === 'zh'
        ? `说明 Payment Engine 项目用于订单/收银台/回调；如需出款或提币，还要创建 WaaS API 项目 ${marker}`
        : `State that Payment Engine covers orders/checkout/callbacks, and a WaaS API project is also needed for payouts or withdrawals ${marker}`,
    );
  }
  return items;
}

function extractEndpoint(text: string): { method: string; path: string } | null {
  const match = text.match(/\b(GET|POST|PUT|PATCH|DELETE)\b\s+`?(\/api\/[A-Za-z0-9_./{}:-]+)/i);
  if (!match) return null;
  return { method: match[1]!.toUpperCase(), path: match[2]! };
}

function isSignExcluded(text: string): boolean {
  return (
    /\bexclude\b.{0,24}\bsign\b/i.test(text) ||
    /\bsign\b.{0,24}\bexclude\b/i.test(text) ||
    /排除.{0,12}sign|sign.{0,12}排除/i.test(text) ||
    /sign.{0,12}(不参与|不包含|无需|不要)/i.test(text) ||
    /(不参与|不包含|无需|不要).{0,12}sign/i.test(text)
  );
}

function mentionsDirectCryptoOrderAmount(text: string): boolean {
  const hasCrypto =
    /\bcrypto(?:currency)?\b/i.test(text) || /加密货币|虚币|虚拟币|数字货币/.test(text);
  return (
    (/\border_currency\b/i.test(text) && /\border_amount\b/i.test(text) && hasCrypto) ||
    /\b(?:CoinMarketCap|CMC)\b/i.test(text)
  );
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
