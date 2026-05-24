/**
 * RFC 0004 W1 — 嵌入式 Ask Widget 协议规格（alpha.0）。
 *
 * 范围：仅 TypeScript 接口类型 + JSDoc 协议详解。alpha.0 不接 endpoint、
 * 不动 server、不写 runtime；alpha.1 才落 MVP Widget bundle + /v1/ask
 * 转发链路。本文件是 host 和 widget bundle 之间、widget 和 anydocs-ask
 * server 之间所有契约的单一来源。
 *
 * 部署形态（RFC §4.1）：
 *
 *   <script src="https://cdn.anydocs.ai/ask-widget/v1.js" async></script>
 *   <script>
 *     anydocsAsk.init({
 *       projectKey: 'pk_live_xxx',
 *       position: 'bottom-right',
 *       locale: 'auto',
 *     });
 *
 *     anydocsAsk.setContext({
 *       page: 'invoice-detail',
 *       data: { invoiceId: 'inv_123' },
 *     });
 *   </script>
 *
 * 三层契约：
 *   1. Host API   — host 页面调 `anydocsAsk.init()` / `setContext()` 等
 *      （[[WidgetInitOptions]] / [[WidgetSetContextInput]] / [[WidgetHandle]]）
 *   2. postMessage — host ↔ iframe widget 异步消息（[[WidgetClientEvent]]）
 *   3. Server API — widget → ask 服务的 HTTP 请求扩展（[[WidgetAskRequestExt]]）
 *
 * 安全 / 隐私边界（RFC §5 + PRD §10.7 第 7 条）：
 *   - SDK 永不自动抓 host DOM；数据上下文必须由 host 显式 setContext()
 *   - URL + title 自动采，但可在 init contextSources 关闭
 *   - Widget 不访问 host cookie / localStorage —— session 存自己的 namespace
 *   - 默认走 iframe（样式隔离 + CSP 友好），shadow DOM 留接口
 */

import type { DocsLang } from '../anydocs/types.ts';

// ---------------------------------------------------------------------------
// 1. Host API — `anydocsAsk.init()` 之类的 entry points
// ---------------------------------------------------------------------------

/**
 * `anydocsAsk.init(options)` 的入参。Host 页面调用此 API 把 Widget 挂载
 * 到当前页。
 *
 * 必填：仅 `projectKey`。其余均有合理默认。
 */
export type WidgetInitOptions = {
  /**
   * Project-scoped public key（`pk_live_xxx` / `pk_test_xxx` 形态）。
   * Server 侧按此 key 校验 Origin 在 `widget.allowedOrigins` 白名单内
   * （RFC §4.4）。客户端永不嵌入 secret key —— 走宿主后端的企业接入是
   * 0.5+ Phase 4 独立 RFC。
   */
  projectKey: string;

  /**
   * Ask 服务的 base URL。默认 `https://api.anydocs.ai`；自部署客户改成
   * 自己的 ask 服务地址（同源 / 跨域均可，跨域走 §4.4 鉴权链）。
   */
  baseUrl?: string;

  /**
   * Widget 浮层位置。`inline` = 把 Widget 渲染到 host 提供的 mount 节点
   * 里（host 必须提供 `mountSelector`）；其余三个 = 视口浮层。
   */
  position?: WidgetPosition;

  /**
   * 当 `position: 'inline'` 时必填。CSS selector 指向 host 准备好的
   * 容器（widget bundle 会清空该容器后注入自己）。
   */
  mountSelector?: string;

  /**
   * 答案语言。`auto` = 跟随 `navigator.language` 推断；显式 `'zh'` /
   * `'en'` 锁定。Server 仍用 anydocs lang detection 兜底（PRD §4.8）。
   */
  locale?: WidgetLocale;

  /**
   * 容器形态（RFC §4.2）。`iframe`（默认）= 完整样式隔离；`shadow` =
   * shadow DOM，主题可继承但 CSP 偶发踩坑。alpha.0/alpha.1 仅落 iframe；
   * shadow 路径留接口、0.5+ 视客户需求启用。
   */
  mode?: WidgetMode;

  /**
   * 上下文采集源开关（RFC §4.3）。空数组 = 不自动采任何源（仅 host
   * 显式 setContext 的 data 进 prompt）；省略 = 采 `url` + `title`。
   *
   *   - `'url'`    : `window.location.href`
   *   - `'title'`  : `document.title`
   *   - `'topic-tag'`: 命中 `data-anydocs-topic="<topic>"` 的元素文本
   *   - `'selection'`: 用户在 host 页选中文本，点 Widget 的 "ask about
   *                    selection" 触发；非自动采集
   *
   * 安全提示：四源都"opt-in"，无任何一项是隐式抓取宿主 DOM。
   */
  contextSources?: ReadonlyArray<WidgetContextSource>;

  /**
   * 主题（颜色 / 圆角 / 字体）。alpha.0 留接口，alpha.1 才接 design
   * tokens；当前仅 `themeBaseColor` 单字段，host 通常不用。
   */
  theme?: WidgetTheme;

  /**
   * Server 给 Widget 的 session_id 落到 host 通知。Host 可持久化到自己
   * 的 storage（绝不写 host cookie / localStorage —— PRD §10.7 第 7 条）
   * 以便用户跨页保留对话上下文。
   */
  onSessionId?: (sessionId: string) => void;

  /**
   * Widget 内部错误回调。**不**用于答案级反馈（那是 RFC 0001 β 信号，
   * Widget 内置 UI 收集）；这里只通报"无法接通 ask 服务 / 鉴权失败"
   * 之类的 host-可见故障。
   */
  onError?: (err: WidgetError) => void;
};

export type WidgetPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'inline';

export type WidgetLocale = DocsLang | 'auto';

export type WidgetMode = 'iframe' | 'shadow';

export type WidgetContextSource = 'url' | 'title' | 'topic-tag' | 'selection';

export type WidgetTheme = {
  /** 主色调（CSS color string）。Widget 会派生 hover / active 等次级色。 */
  baseColor?: string;
};

/**
 * `anydocsAsk.init()` 的返回。Host 可持有此句柄做后续控制（更新上下文、
 * 程序化打开关闭、销毁）。
 */
export type WidgetHandle = {
  /** RFC §4.3 — host 显式注入业务数据上下文。每次调覆盖上一次（不
   *  merge）；想清空传 `null`。 */
  setContext(input: WidgetSetContextInput | null): void;

  /** 程序化打开浮层（默认初始关闭）。inline 模式下此调用 no-op。 */
  open(): void;

  /** 程序化关闭浮层。 */
  close(): void;

  /** 拆掉 Widget。卸载所有事件监听 + 销毁 iframe / shadow root。host SPA
   *  路由跳走时建议调一次以避免泄漏。 */
  destroy(): void;

  /** 当前 session_id（首次回包前为 null）。供调试 / 反查用。 */
  readonly sessionId: string | null;
};

/**
 * 数据上下文注入（RFC §4.3 顶层数据源）。Host 选择性把业务数据传给
 * Widget；这部分会被 Widget 转发到 server，server 拼进 prompt（带项目
 * 级 system instructions 的同一条管线）。
 *
 * 隐私边界：**host 自负责数据脱敏**。schema validator 在 alpha.2 落地，
 * 限制每个字段大小 + 字段总数（防止 host 误塞整张 invoice）。
 */
export type WidgetSetContextInput = {
  /** Host 自定义的"当前页面是什么"标签。用于 server 端聚合 + Studio
   *  Feedback tab 按 page 切片。 */
  page?: string;

  /** 任意 JSON-可序列化对象，作为答案 prompt 的额外上下文。alpha.0 不
   *  限制 shape；alpha.2 会引入 size cap + 字段白名单（host 在 init
   *  时声明）。 */
  data?: Record<string, unknown>;

  /** Host 标注的 topic 字符串（也可走 DOM `data-anydocs-topic`）。比
   *  `page` 更细，例如 "billing.subscription.cancel-flow"。 */
  topic?: string;
};

// ---------------------------------------------------------------------------
// 2. postMessage 协议 — host ↔ iframe widget 异步消息
// ---------------------------------------------------------------------------

/**
 * 当 widget 跑在 iframe 里时，host 和 iframe 之间通过 `postMessage`
 * 通信。两端各自发**带 envelope 的事件**，receiver 用 `kind` 判别。
 *
 * Envelope 头：
 *   - `protocol: 'anydocs-ask'`  幂常量，用于在多 widget / 多源场景下过滤
 *   - `version: 1`               协议版本，alpha.0/alpha.1 = 1
 *   - `kind: ...`                事件类型
 *
 * 安全：iframe 侧必须严格校验 `event.origin` 等于 init 时配置的 baseUrl
 * 的 origin；host 侧必须校验 `event.source === iframeContentWindow`。
 */
export type WidgetEnvelope = {
  protocol: 'anydocs-ask';
  version: 1;
};

/** Host → Widget 事件（host 主动驱动 widget 状态）。 */
export type WidgetHostEvent =
  | WidgetEnvelope & { kind: 'init'; options: WidgetInitOptions }
  | WidgetEnvelope & { kind: 'set-context'; context: WidgetSetContextInput | null }
  | WidgetEnvelope & { kind: 'open' }
  | WidgetEnvelope & { kind: 'close' }
  | WidgetEnvelope & { kind: 'destroy' };

/** Widget → Host 事件（widget 通报状态 / 请求 host 决策）。 */
export type WidgetClientEvent =
  | WidgetEnvelope & { kind: 'ready' }
  | WidgetEnvelope & { kind: 'session-id'; sessionId: string }
  | WidgetEnvelope & { kind: 'resize'; width: number; height: number }
  | WidgetEnvelope & { kind: 'error'; error: WidgetError }
  /** 用户在 widget 内点了 deeplink，host 决定是 in-place 跳转还是开新
   *  tab。href 已经过 widget 一侧的 URL 安全校验（http/https + 同
   *  baseUrl origin 或 host 显式 allowlist）。 */
  | WidgetEnvelope & { kind: 'navigate'; href: string; target: '_self' | '_blank' };

// ---------------------------------------------------------------------------
// 3. Server API — widget → ask 服务的 HTTP 请求扩展
// ---------------------------------------------------------------------------

/**
 * Widget 调用 `POST /v1/ask` 时携带的 widget-specific 字段。和现有
 * AskRequest 结构合并（context 字段下挂 `widget` 子节）。Server 在
 * alpha.1 才真正消费这些字段；alpha.0 仅类型契约。
 */
export type WidgetAskRequestExt = {
  /** Widget 端推断的 host 页面元信息。Server 用于 Studio Feedback tab
   *  的来源拆分（widget vs reader）。 */
  host: {
    /** `window.location.href` 截到 query 之前。alpha.2 schema validator
     *  会过滤掉 hash + query 中的敏感 token。 */
    url?: string;
    /** `document.title`。 */
    title?: string;
    /** host 显式 setContext 的 page 标签。 */
    page?: string;
    /** host 显式 setContext 的 topic（细于 page）。 */
    topic?: string;
  };
  /** Host setContext 的业务数据（alpha.2 加 size cap）。 */
  data?: Record<string, unknown>;
};

/**
 * Server 校验 widget 请求的失败码。Widget 拿到这些会通过 `WidgetError`
 * 上抛给 host 的 `onError`。
 *
 *   - `widget_disabled`     widget.enabled = false（alpha.x 默认）
 *   - `invalid_project_key` key 不存在或格式错
 *   - `origin_not_allowed`  Origin header 不在 widget.allowedOrigins 白名单
 *   - `rate_limited`        触发 widget.rateLimitPerMinute
 *   - `payload_too_large`   data 上下文超 alpha.2 cap
 */
export type WidgetServerErrorCode =
  | 'widget_disabled'
  | 'invalid_project_key'
  | 'origin_not_allowed'
  | 'rate_limited'
  | 'payload_too_large';

/** 客户端 / 服务端 widget 错误的统一形状，回传给 host `onError`。 */
export type WidgetError = {
  /** server 域的稳定错误码；客户端域错误用 `client_<x>`（如
   *  `client_network`, `client_bundle_load`）。 */
  code: WidgetServerErrorCode | `client_${string}`;
  /** 给 host 看的简短描述（一行，可英文）。 */
  message: string;
  /** 触发该错误的 HTTP 状态（client_network 等无 HTTP 上下文时省略）。 */
  status?: number;
};

// ---------------------------------------------------------------------------
// 4. Global runtime namespace
// ---------------------------------------------------------------------------

/**
 * Host 页面 `<script>` 加载完 widget bundle 后挂在 `window` 的全局
 * namespace。声明此接口让 TypeScript host 工程直接用：
 *
 *   declare global { interface Window { anydocsAsk: WidgetGlobal } }
 */
export type WidgetGlobal = {
  /** Bootstrap 入口。多次调 init 会拆掉前一个实例。 */
  init(options: WidgetInitOptions): WidgetHandle;
  /** 当前已挂载的实例（init 后才有），null 表示未挂或已 destroy。 */
  readonly current: WidgetHandle | null;
  /** Widget bundle 的 semver 版本号，方便客户报问题 / 调试。 */
  readonly version: string;
};
