/**
 * RFC 0005 V1 — batch citation 校验单测。MockLLM 驱动，覆盖：
 *  - happy path：3-cit 批量 → 3 verdict 输出
 *  - 大批 → 分批；call count 正确；latencyMs 同批同值
 *  - 空 pairs → 不调 LLM
 *  - LLM 抛错 → 静默吞掉
 *  - 非 JSON 响应 / 非数组 / 字段缺失 → 静默 drop 该 item
 *  - ```json``` fence 包裹的合法 JSON 能恢复
 *  - reason 截断 + 自定义 reasonMaxChars
 *  - LLM 返回顺序乱序但能按 cit_id 找回
 *  - 输出里出现未请求的 cit_id 被丢弃
 *  - 未知 verdict 值被丢弃
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLM } from '../src/llm/mock.ts';
import { validateCitations } from '../src/query/citation-validator.ts';
import type { CitationClaimPair } from '../src/query/claim-extractor.ts';

function mkPair(id: string, claim = 'c', chunk = 'k'): CitationClaimPair {
  return { citationId: id, claim, chunkText: chunk };
}

test('validateCitations: 3-cit batch happy path 返回 3 verdict', async () => {
  const llm = new MockLLM({
    model: 'mock-validator',
    responder: () =>
      JSON.stringify([
        { cit_id: 'cit_1', verdict: 'supports', reason: 'matches' },
        { cit_id: 'cit_2', verdict: 'partially', reason: 'mostly matches' },
        { cit_id: 'cit_3', verdict: 'not_supports', reason: 'off-topic' },
      ]),
  });
  const out = await validateCitations({
    llm,
    pairs: [mkPair('cit_1'), mkPair('cit_2'), mkPair('cit_3')],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0]!.citationId, 'cit_1');
  assert.equal(out[0]!.verdict, 'supports');
  assert.equal(out[1]!.verdict, 'partially');
  assert.equal(out[2]!.verdict, 'not_supports');
  // 同批共用 latencyMs + checkedAt
  assert.equal(out[0]!.latencyMs, out[1]!.latencyMs);
  assert.equal(out[1]!.latencyMs, out[2]!.latencyMs);
  assert.equal(out[0]!.checkedAt, out[1]!.checkedAt);
  assert.equal(out[0]!.model, 'mock-validator');
  assert.equal(llm.calls.length, 1, 'should be a single batched LLM call');
});

test('validateCitations: empty pairs 不调 LLM', async () => {
  const llm = new MockLLM();
  const out = await validateCitations({ llm, pairs: [] });
  assert.equal(out.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('validateCitations: pairs > batchSize 拆批；call count 正确', async () => {
  // 7 cit / batchSize 3 → 3 批 (3 + 3 + 1)
  const ids = Array.from({ length: 7 }, (_, i) => 'cit_' + (i + 1));
  let callIdx = 0;
  const llm = new MockLLM({
    responder: (input) => {
      callIdx++;
      // 解出每批的 cit_id 列表并对应回 verdict
      const parsed = JSON.parse(input.userPrompt) as Array<{ cit_id: string }>;
      return JSON.stringify(
        parsed.map((p, i) => ({
          cit_id: p.cit_id,
          verdict: 'supports' as const,
          reason: 'batch ' + callIdx + ' item ' + i,
        })),
      );
    },
  });
  const out = await validateCitations({
    llm,
    pairs: ids.map((id) => mkPair(id)),
    batchSize: 3,
  });
  assert.equal(out.length, 7);
  assert.equal(llm.calls.length, 3, '7 / 3 → 3 batches');
  assert.deepEqual(
    out.map((r) => r.citationId),
    ids,
    'verdicts in input order across batches',
  );
});

test('validateCitations: LLM 抛错 → 该批静默吞掉返回空', async () => {
  // Fire-and-forget 语义：不能 bubble 异常给主请求路径。
  const llm = new MockLLM({
    responder: () => {
      throw new Error('upstream 503');
    },
  });
  const out = await validateCitations({
    llm,
    pairs: [mkPair('cit_1')],
  });
  assert.deepEqual(out, []);
});

test('validateCitations: 非 JSON 响应 → 静默 drop', async () => {
  const llm = new MockLLM({
    responder: () => 'Sure, here is the result: this is not valid JSON',
  });
  const out = await validateCitations({ llm, pairs: [mkPair('cit_1')] });
  assert.deepEqual(out, []);
});

test('validateCitations: 顶层 JSON 是对象而非数组 → 静默 drop', async () => {
  const llm = new MockLLM({
    responder: () => JSON.stringify({ cit_id: 'cit_1', verdict: 'supports', reason: '' }),
  });
  const out = await validateCitations({ llm, pairs: [mkPair('cit_1')] });
  assert.deepEqual(out, []);
});

test('validateCitations: ```json``` fence 包裹仍能解出', async () => {
  // 不少 LLM 即便被告知"只输出 JSON"也会加 markdown fence。
  const llm = new MockLLM({
    responder: () =>
      '```json\n' +
      '[{"cit_id":"cit_1","verdict":"supports","reason":"ok"}]\n' +
      '```',
  });
  const out = await validateCitations({ llm, pairs: [mkPair('cit_1')] });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, 'supports');
});

test('validateCitations: reason 超过 100 字符 → 截断 + 追加 "…"', async () => {
  const longReason = 'x'.repeat(150);
  const llm = new MockLLM({
    responder: () =>
      JSON.stringify([{ cit_id: 'cit_1', verdict: 'supports', reason: longReason }]),
  });
  const out = await validateCitations({ llm, pairs: [mkPair('cit_1')] });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.reason.length, 100);
  assert.ok(out[0]!.reason.endsWith('…'));
});

test('validateCitations: reasonMaxChars override 生效', async () => {
  const llm = new MockLLM({
    responder: () =>
      JSON.stringify([{ cit_id: 'cit_1', verdict: 'partially', reason: 'abcdefghij' }]),
  });
  const out = await validateCitations({
    llm,
    pairs: [mkPair('cit_1')],
    reasonMaxChars: 5,
  });
  assert.equal(out[0]!.reason, 'abcd…');
});

test('validateCitations: LLM 乱序返回 → 仍按 cit_id 匹配（不丢条目）', async () => {
  const llm = new MockLLM({
    responder: () =>
      JSON.stringify([
        { cit_id: 'cit_3', verdict: 'supports', reason: 'third' },
        { cit_id: 'cit_1', verdict: 'partially', reason: 'first' },
        { cit_id: 'cit_2', verdict: 'not_supports', reason: 'second' },
      ]),
  });
  const out = await validateCitations({
    llm,
    pairs: [mkPair('cit_1'), mkPair('cit_2'), mkPair('cit_3')],
  });
  assert.equal(out.length, 3);
  const byId = new Map(out.map((r) => [r.citationId, r] as const));
  assert.equal(byId.get('cit_1')!.reason, 'first');
  assert.equal(byId.get('cit_2')!.reason, 'second');
  assert.equal(byId.get('cit_3')!.reason, 'third');
});

test('validateCitations: 输出含未请求的 cit_id → 被丢弃', async () => {
  // 防 LLM 出错或注入 — 不在请求批次里的 cit_id 一律不进结果。
  const llm = new MockLLM({
    responder: () =>
      JSON.stringify([
        { cit_id: 'cit_1', verdict: 'supports', reason: 'ok' },
        { cit_id: 'cit_999', verdict: 'supports', reason: 'phantom' },
      ]),
  });
  const out = await validateCitations({ llm, pairs: [mkPair('cit_1')] });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.citationId, 'cit_1');
});

test('validateCitations: 未知 verdict 值 → 被丢弃', async () => {
  const llm = new MockLLM({
    responder: () =>
      JSON.stringify([
        { cit_id: 'cit_1', verdict: 'maybe', reason: '?' },
        { cit_id: 'cit_2', verdict: 'partially', reason: 'kinda' },
      ]),
  });
  const out = await validateCitations({
    llm,
    pairs: [mkPair('cit_1'), mkPair('cit_2')],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.citationId, 'cit_2');
});

test('validateCitations: 重复 cit_id 只保留第一条', async () => {
  const llm = new MockLLM({
    responder: () =>
      JSON.stringify([
        { cit_id: 'cit_1', verdict: 'supports', reason: 'first' },
        { cit_id: 'cit_1', verdict: 'not_supports', reason: 'second' },
      ]),
  });
  const out = await validateCitations({ llm, pairs: [mkPair('cit_1')] });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.reason, 'first');
});

test('validateCitations: system prompt + user prompt 形状合约', async () => {
  // Pin 一下 prompt 形状，避免后续 refactor 默默改了语义。
  const llm = new MockLLM({
    responder: () =>
      JSON.stringify([{ cit_id: 'cit_1', verdict: 'supports', reason: 'ok' }]),
  });
  await validateCitations({
    llm,
    pairs: [mkPair('cit_1', '某句声明', '文档原文')],
  });
  const call = llm.calls[0]!;
  // System prompt 包含核心约束词
  assert.match(call.systemPrompt, /引用校验助手/);
  assert.match(call.systemPrompt, /supports/);
  assert.match(call.systemPrompt, /partially/);
  assert.match(call.systemPrompt, /not_supports/);
  // User prompt 是合法 JSON 数组，含 cit_id / claim / chunk 三字段
  const parsed = JSON.parse(call.userPrompt) as Array<Record<string, unknown>>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.cit_id, 'cit_1');
  assert.equal(parsed[0]!.claim, '某句声明');
  assert.equal(parsed[0]!.chunk, '文档原文');
  // Temperature 钉为 0 — 校验是确定性任务
  assert.equal(call.temperature, 0);
});
