/**
 * RFC 0004 W1 — postMessage 协议守卫（alpha.0）。
 *
 * Pure functions. Widget bundle 和 host SDK 都用这套 guards 校验入站
 * 消息：先看 envelope 头，再 narrow 到具体 kind。任何不符合形状的消息
 * 都返回 null —— 上层把它当成异源噪音丢弃。
 *
 * 设计原则：
 *   - 零依赖。可被 widget bundle（运行在客户网站）和 ask server / Reader
 *     共享，不引入 runtime 依赖
 *   - 严格 narrow：消息字段的存在性 + 类型双重校验，给 attacker 一个
 *     字段也撬不开
 *   - 不在守卫里做 origin 校验。Origin 由调用方按部署形态决定（widget
 *     ↔ ask gateway 同源，host ↔ iframe 比 baseUrl）
 */

import type { WidgetClientEvent, WidgetHostEvent } from './types.ts';

const PROTOCOL = 'anydocs-ask';
const VERSION = 1;

const HOST_KINDS = new Set<WidgetHostEvent['kind']>([
  'init',
  'set-context',
  'open',
  'close',
  'destroy',
]);

const CLIENT_KINDS = new Set<WidgetClientEvent['kind']>([
  'ready',
  'session-id',
  'resize',
  'error',
  'navigate',
]);

/**
 * True when `value` has a valid widget envelope head. Cheaper than narrowing
 * to a specific event kind; useful for early-discarding noise from other
 * postMessage senders in the same window.
 */
export function hasWidgetEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.protocol === PROTOCOL && v.version === VERSION && typeof v.kind === 'string';
}

/**
 * Narrow an unknown `event.data` to a {@link WidgetHostEvent}, or null when
 * the shape doesn't match. Used by the widget bundle's iframe message
 * listener.
 */
export function parseHostEvent(value: unknown): WidgetHostEvent | null {
  if (!hasWidgetEnvelope(value)) return null;
  const v = value as Record<string, unknown>;
  if (!HOST_KINDS.has(v.kind as WidgetHostEvent['kind'])) return null;
  // Per-kind shape checks. Anything that looks structurally ok is passed
  // through with an `as` cast — runtime narrowing past TypeScript's reach
  // would balloon this file and the alpha.0 contract is intentionally
  // minimal.
  switch (v.kind) {
    case 'init':
      if (typeof v.options !== 'object' || v.options === null) return null;
      return v as unknown as WidgetHostEvent;
    case 'set-context':
      // `context` may be null (host clearing it) OR an object.
      if (v.context !== null && (typeof v.context !== 'object' || Array.isArray(v.context))) {
        return null;
      }
      return v as unknown as WidgetHostEvent;
    case 'open':
    case 'close':
    case 'destroy':
      return v as unknown as WidgetHostEvent;
    default:
      return null;
  }
}

/**
 * Narrow an unknown `event.data` to a {@link WidgetClientEvent}, or null
 * when the shape doesn't match. Used by host SDK's message listener.
 */
export function parseClientEvent(value: unknown): WidgetClientEvent | null {
  if (!hasWidgetEnvelope(value)) return null;
  const v = value as Record<string, unknown>;
  if (!CLIENT_KINDS.has(v.kind as WidgetClientEvent['kind'])) return null;
  switch (v.kind) {
    case 'ready':
      return v as unknown as WidgetClientEvent;
    case 'session-id':
      if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) return null;
      return v as unknown as WidgetClientEvent;
    case 'resize':
      if (typeof v.width !== 'number' || typeof v.height !== 'number') return null;
      if (!Number.isFinite(v.width) || !Number.isFinite(v.height)) return null;
      if (v.width < 0 || v.height < 0) return null;
      return v as unknown as WidgetClientEvent;
    case 'error':
      if (typeof v.error !== 'object' || v.error === null) return null;
      // The error must at minimum carry `code` + `message`. status is optional.
      {
        const e = v.error as Record<string, unknown>;
        if (typeof e.code !== 'string' || typeof e.message !== 'string') return null;
      }
      return v as unknown as WidgetClientEvent;
    case 'navigate':
      if (typeof v.href !== 'string' || v.href.length === 0) return null;
      if (v.target !== '_self' && v.target !== '_blank') return null;
      return v as unknown as WidgetClientEvent;
    default:
      return null;
  }
}

/**
 * Stamp the envelope head onto a kind-shaped payload. Used by both
 * widget bundle and host SDK to construct outbound postMessage payloads.
 * Returns a new object; never mutates input.
 *
 * Note: alpha.0 doesn't yet ship a widget bundle that calls this — the
 * helper lands so alpha.1's MVP can pick it up without re-tracing the
 * envelope spec.
 */
export function envelope<T extends { kind: string }>(payload: T): T & {
  protocol: 'anydocs-ask';
  version: 1;
} {
  return { protocol: PROTOCOL, version: VERSION, ...payload };
}
