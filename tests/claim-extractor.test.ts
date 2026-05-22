/**
 * RFC 0005 V2 — claim 句抽取单测。Pure function, no LLM / IO. Covers:
 *  - 单 cit 单句的基本路径
 *  - 同句多 cit → 每个 cit 各产 pair（同 claim）
 *  - 多段：[cit_N] 出现在不同句子里
 *  - 边界：marker 在串首 / claim 跨段落 / 整段没标点
 *  - markdown 列表行首 bullet 剥除
 *  - 200 字符 hard cap
 *  - citation 不存在 / snippet 空 / chunkTextById override 返回 null
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClaimChunkPairs,
  type CitationClaimPair,
} from '../src/query/claim-extractor.ts';
import type { Citation } from '../src/query/types.ts';

function makeCitation(id: string, snippet: string): Citation {
  return {
    citation_id: id,
    chunk_id: 1,
    page_id: 'p',
    lang: 'zh',
    source_lang: null,
    title: 't',
    breadcrumb: [],
    url: null,
    snippet,
    in_page_path: '',
  };
}

test('extractClaimChunkPairs: 单 cit 单句', () => {
  const out = extractClaimChunkPairs({
    answerMd: 'Hermes 是一个命令行 AI 助手 [cit_1]。',
    citations: [makeCitation('cit_1', 'Hermes is a CLI AI assistant.')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.citationId, 'cit_1');
  assert.equal(out[0]!.claim, 'Hermes 是一个命令行 AI 助手');
  assert.equal(out[0]!.chunkText, 'Hermes is a CLI AI assistant.');
});

test('extractClaimChunkPairs: 同句多 cit 各产 pair（同 claim, 不同 chunk）', () => {
  // 同一句话引用两个 chunk 时校验层应分别判断；claim 文本一致，chunk
  // 不同。也验证 inline cit 标记从 claim 里剥掉。
  const out = extractClaimChunkPairs({
    answerMd: '安装命令是 curl ... [cit_1] [cit_2]。',
    citations: [
      makeCitation('cit_1', '一键安装脚本 install.sh'),
      makeCitation('cit_2', 'Android Termux 适配'),
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.citationId, 'cit_1');
  assert.equal(out[1]!.citationId, 'cit_2');
  // 第二个 pair 的 claim 里不应残留 [cit_1]。
  assert.equal(out[0]!.claim, '安装命令是 curl ...');
  assert.equal(out[1]!.claim, '安装命令是 curl ...');
  assert.equal(out[0]!.chunkText, '一键安装脚本 install.sh');
  assert.equal(out[1]!.chunkText, 'Android Termux 适配');
});

test('extractClaimChunkPairs: 多段（每个 [cit_N] 在自己句子里）', () => {
  const out = extractClaimChunkPairs({
    answerMd:
      '配置模型使用 hermes model 命令 [cit_1]。' +
      '支持 Anthropic 和 OpenAI [cit_2]。' +
      '完成后执行 hermes 开始聊天 [cit_3]。',
    citations: [
      makeCitation('cit_1', 'hermes model'),
      makeCitation('cit_2', 'providers'),
      makeCitation('cit_3', 'start chat'),
    ],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0]!.claim, '配置模型使用 hermes model 命令');
  assert.equal(out[1]!.claim, '支持 Anthropic 和 OpenAI');
  assert.equal(out[2]!.claim, '完成后执行 hermes 开始聊天');
});

test('extractClaimChunkPairs: markdown 列表行首 bullet 剥除', () => {
  const out = extractClaimChunkPairs({
    answerMd: '- 运行一键安装命令 [cit_1]\n- 配置环境变量 [cit_2]',
    citations: [
      makeCitation('cit_1', 'install'),
      makeCitation('cit_2', 'env'),
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.claim, '运行一键安装命令');
  assert.equal(out[1]!.claim, '配置环境变量');
});

test('extractClaimChunkPairs: markdown 数字列表行首 "1." 剥除', () => {
  const out = extractClaimChunkPairs({
    answerMd: '1. 第一步：下载 [cit_1]\n2. 第二步：解压 [cit_2]',
    citations: [
      makeCitation('cit_1', 'download'),
      makeCitation('cit_2', 'extract'),
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.claim, '第一步：下载');
  assert.equal(out[1]!.claim, '第二步：解压');
});

test('extractClaimChunkPairs: marker 紧邻串首 → 跳过', () => {
  // 没有可作为 claim 的前文 → 不产 pair。
  const out = extractClaimChunkPairs({
    answerMd: '[cit_1] 这其实是一个分号开头的奇怪例子',
    citations: [makeCitation('cit_1', 'X')],
  });
  assert.equal(out.length, 0);
});

test('extractClaimChunkPairs: 200 字符 hard cap', () => {
  // 整段没标点 → claim 不能吞超过 200 字符。
  const longPrefix = '一'.repeat(300);
  const out = extractClaimChunkPairs({
    answerMd: longPrefix + ' [cit_1]',
    citations: [makeCitation('cit_1', 'X')],
  });
  assert.equal(out.length, 1);
  assert.ok(out[0]!.claim.length <= 200, `claim length ${out[0]!.claim.length} > 200`);
});

test('extractClaimChunkPairs: 段落断 `\\n\\n` 视为句界', () => {
  const out = extractClaimChunkPairs({
    answerMd: 'first paragraph.\n\nsecond paragraph claim [cit_1]',
    citations: [makeCitation('cit_1', 'X')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.claim, 'second paragraph claim');
});

test('extractClaimChunkPairs: citation_id 在 citations 列表里找不到 → 跳过该 cit', () => {
  const out = extractClaimChunkPairs({
    answerMd: '有效引用 [cit_1] 与无效引用 [cit_99]。',
    citations: [makeCitation('cit_1', 'X')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.citationId, 'cit_1');
});

test('extractClaimChunkPairs: snippet 为空字符串 → 跳过', () => {
  // postprocess 偶尔会产出空 snippet（chunk 内容仅空白）；校验对空 chunk 没
  // 有意义，整条直接放弃。
  const out = extractClaimChunkPairs({
    answerMd: '某句话 [cit_1]。',
    citations: [makeCitation('cit_1', '   ')],
  });
  assert.equal(out.length, 0);
});

test('extractClaimChunkPairs: chunkTextById override 优先于 citation.snippet', () => {
  const out = extractClaimChunkPairs({
    answerMd: '某句话 [cit_1]。',
    citations: [makeCitation('cit_1', 'snippet text')],
    chunkTextById: (id) => (id === 'cit_1' ? 'full chunk text via override' : null),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.chunkText, 'full chunk text via override');
});

test('extractClaimChunkPairs: chunkTextById 返回 null → 跳过（即使 citation 存在）', () => {
  const out = extractClaimChunkPairs({
    answerMd: '某句话 [cit_1]。',
    citations: [makeCitation('cit_1', 'snippet text')],
    chunkTextById: () => null,
  });
  assert.equal(out.length, 0);
});

test('extractClaimChunkPairs: answer_md 为空字符串 → 空数组', () => {
  const out = extractClaimChunkPairs({ answerMd: '', citations: [] });
  assert.deepEqual(out, [] as CitationClaimPair[]);
});

test('extractClaimChunkPairs: 答案无 [cit_N] 标记 → 空数组', () => {
  // postprocess 在 no_citations 路径会产生纯文本答案；抽取应直接返回空。
  const out = extractClaimChunkPairs({
    answerMd: 'No citations were emitted on this answer.',
    citations: [],
  });
  assert.deepEqual(out, []);
});
