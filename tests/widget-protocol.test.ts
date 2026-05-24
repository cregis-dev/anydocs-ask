/**
 * RFC 0004 W1 alpha.0 — postMessage 协议守卫单测。Pure functions，无 DOM
 * 依赖；nodejs --test 直接跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  envelope,
  hasWidgetEnvelope,
  parseClientEvent,
  parseHostEvent,
} from '../src/widget/protocol.ts';

test('hasWidgetEnvelope: 正确识别完整 envelope', () => {
  assert.equal(
    hasWidgetEnvelope({ protocol: 'anydocs-ask', version: 1, kind: 'ready' }),
    true,
  );
});

test('hasWidgetEnvelope: 拒绝 wrong protocol / version / 缺 kind', () => {
  // 异源 / 异协议
  assert.equal(hasWidgetEnvelope({ protocol: 'other-mcp', version: 1, kind: 'x' }), false);
  // 版本不匹配
  assert.equal(hasWidgetEnvelope({ protocol: 'anydocs-ask', version: 2, kind: 'x' }), false);
  // 缺 kind
  assert.equal(hasWidgetEnvelope({ protocol: 'anydocs-ask', version: 1 }), false);
  // 非对象
  assert.equal(hasWidgetEnvelope(null), false);
  assert.equal(hasWidgetEnvelope('hi'), false);
  assert.equal(hasWidgetEnvelope(42), false);
});

test('parseHostEvent: init / set-context / open / close / destroy 全部识别', () => {
  const init = parseHostEvent({
    protocol: 'anydocs-ask',
    version: 1,
    kind: 'init',
    options: { projectKey: 'pk_test_x' },
  });
  assert.ok(init);
  assert.equal(init.kind, 'init');

  const setCtx = parseHostEvent({
    protocol: 'anydocs-ask',
    version: 1,
    kind: 'set-context',
    context: { page: 'invoice' },
  });
  assert.ok(setCtx);

  // set-context 允许 null（host 清空意图）
  const clearCtx = parseHostEvent({
    protocol: 'anydocs-ask',
    version: 1,
    kind: 'set-context',
    context: null,
  });
  assert.ok(clearCtx);

  for (const kind of ['open', 'close', 'destroy'] as const) {
    const ev = parseHostEvent({ protocol: 'anydocs-ask', version: 1, kind });
    assert.ok(ev, `expected ${kind} to parse`);
    assert.equal(ev.kind, kind);
  }
});

test('parseHostEvent: init 缺 options / options 非对象 → null', () => {
  // 缺 options
  assert.equal(
    parseHostEvent({ protocol: 'anydocs-ask', version: 1, kind: 'init' }),
    null,
  );
  // options 是 string
  assert.equal(
    parseHostEvent({ protocol: 'anydocs-ask', version: 1, kind: 'init', options: 'x' }),
    null,
  );
});

test('parseHostEvent: set-context context 数组 → null（必须 object 或 null）', () => {
  assert.equal(
    parseHostEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'set-context',
      context: ['a', 'b'],
    }),
    null,
  );
});

test('parseHostEvent: 未知 kind → null（防 future widget 给 old host 发新事件）', () => {
  assert.equal(
    parseHostEvent({ protocol: 'anydocs-ask', version: 1, kind: 'teleport' }),
    null,
  );
});

test('parseClientEvent: ready / session-id / resize / error / navigate 全部识别', () => {
  assert.ok(parseClientEvent({ protocol: 'anydocs-ask', version: 1, kind: 'ready' }));
  assert.ok(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'session-id',
      sessionId: 's_abc',
    }),
  );
  assert.ok(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'resize',
      width: 400,
      height: 600,
    }),
  );
  assert.ok(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'error',
      error: { code: 'rate_limited', message: 'slow down' },
    }),
  );
  assert.ok(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'navigate',
      href: 'https://docs.example.com/x',
      target: '_blank',
    }),
  );
});

test('parseClientEvent: session-id 空字符串 → null', () => {
  assert.equal(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'session-id',
      sessionId: '',
    }),
    null,
  );
});

test('parseClientEvent: resize 负数 / NaN / 缺字段 → null', () => {
  // 缺 width
  assert.equal(
    parseClientEvent({ protocol: 'anydocs-ask', version: 1, kind: 'resize', height: 100 }),
    null,
  );
  // 负数
  assert.equal(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'resize',
      width: -1,
      height: 100,
    }),
    null,
  );
  // NaN
  assert.equal(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'resize',
      width: Number.NaN,
      height: 100,
    }),
    null,
  );
});

test('parseClientEvent: error 缺 code / message → null', () => {
  assert.equal(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'error',
      error: { code: 'rate_limited' },
    }),
    null,
  );
  assert.equal(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'error',
      error: { message: 'no code' },
    }),
    null,
  );
  // error 非对象
  assert.equal(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'error',
      error: 'simple message',
    }),
    null,
  );
});

test('parseClientEvent: navigate target 非 _self/_blank → null', () => {
  assert.equal(
    parseClientEvent({
      protocol: 'anydocs-ask',
      version: 1,
      kind: 'navigate',
      href: 'https://x',
      target: '_parent',
    }),
    null,
  );
});

test('envelope: 注入 protocol + version 头', () => {
  const out = envelope({ kind: 'ready' });
  assert.equal(out.protocol, 'anydocs-ask');
  assert.equal(out.version, 1);
  assert.equal(out.kind, 'ready');
});

test('envelope: 不污染输入对象', () => {
  const input = { kind: 'session-id' as const, sessionId: 's_x' };
  const out = envelope(input);
  // 输出独立
  assert.notEqual(out, input);
  // 输入未被加 protocol / version
  assert.equal((input as Record<string, unknown>).protocol, undefined);
});

test('envelope output round-trips through parseClientEvent', () => {
  // 守住"envelope 出的消息守卫一定能解"的不变量。
  const e = envelope({ kind: 'session-id' as const, sessionId: 's_round' });
  const parsed = parseClientEvent(e);
  assert.ok(parsed);
  if (parsed && parsed.kind === 'session-id') {
    assert.equal(parsed.sessionId, 's_round');
  }
});
