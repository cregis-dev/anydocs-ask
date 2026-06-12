# RFC 0007 — MCP 知识库接口（Streamable HTTP）

> Status: Implemented（K1–K5 已于 0.4.0-alpha.5 发版 + 测试；K6 / GA flip 待续）
> 实装状态（2026-06-13）：K1–K5 已于 **0.4.0-alpha.5**（2026-06-12）发版（非原标的 v2）—— `/mcp` Streamable HTTP stateless + `search`/`ask`/`fetch_page` + bearer/origin 限流 + loopback Host 守卫，并随包发到 npm（next tag）。见 CHANGELOG 0.4.0-alpha.5 / PR #109/#110/#111。剩 = K6 真机 dogfood 常态化 + operator GA flip（enabled=true）。
> Author: @shawndslee
> Date: 2026-06-12
> 范围版本: K1–K5 已发版于 `@anydocs/ask` **0.4.0-alpha.5**（原标的 v2；实际提前并入 0.4，仅 HTTP）
> 设计依据: [ARCHITECTURE.md §13](../../ARCHITECTURE.md)（「MCP 接口 | 仅 HTTP | v2，预留 `@anydocs/ask-mcp` 包名」）/ [PRD §7](../../PRD.md)（「MCP / agent 调用接口 | v2 | 与 v1 用户场景正交」）
> 阻塞依赖: 无硬阻塞。[RFC 0005](./0005-citation-semantic-validation.md)（让 `ask` tool 的引用可信）+ [RFC 0004](./0004-embedded-ask-widget.md) 的 server-gate（鉴权 / 限流基建可复用）是软依赖，均已在 main。

---

## 0. TL;DR

把 anydocs-ask 从"给人用的问答服务"扩展到**"给 agent 用的知识库（knowledge base）服务"**：在现有 Hono app 上挂一个 `/mcp` 端点，用官方 `@modelcontextprotocol/sdk` 的 **Streamable HTTP 传输 + 无状态（stateless）模式**，把已经导出的 `ask()` / `retrieve()` 包成 `search` / `ask`（+ 可选 `fetch_page`）三个 MCP tool。

整个实现是 `createApp` 的一个**薄适配层**——跟当年加 Widget（RFC 0004）是同一种加法：不碰索引、不碰嵌入、不碰生命周期，只读 warm 之后的 Runtime。**进程内挂载，不单独起进程**；预留的 `@anydocs/ask-mcp` 独立包暂不需要，改作未来 stdio 垫片的占位。

---

## 1. 为什么现在做

### 1.1 商业价值

- **新载体**：v1 的 ask 黏住"人在文档站点 / 产品 UI 里提问"的场景；MCP 让 ask 进入"**其他 agent 把某个 anydocs 项目当成可调用的知识源**"的场景。客户的 Claude Code / Cursor / 内部 agent 可以直接把"我们的产品文档"作为一个 MCP server 接进去，检索 + 引用全自动。
- **与 Widget 正交、互补**：Widget（RFC 0004）是"把 ask 嵌进人用的 UI"；MCP 是"把 ask 接进机器用的 agent 编排"。两者共享同一个 ask 后端、同一套鉴权 / 限流基建，边际成本低。
- **闭环数据更广**：agent 发起的查询是真实工程任务里的查询，vocabulary 与人的提问不同，喂回 RFC 0002 Studio 反馈闭环后是文档质量信号的新维度（需在数据上标 `source=mcp` 与 reader / widget 区分）。

### 1.2 为什么技术上现在阻力很小（这是本 RFC 的核心论据）

三件事在调研中已核实，使得"现在做"从 v2 远期变成可立即起步的薄封装：

1. **现有 `ask()` 早已是干净的纯函数式入口**，MCP 直接复用即可：

   | 现有能力 | 位置 | 映射的 MCP tool |
   |---|---|---|
   | `ask(deps, req)` — 完整 RAG，带 citations / 多语言降级 / 引用语义校验 | [src/query/answer.ts:168](../../src/query/answer.ts) | `ask` |
   | `retrieve(db, opts)` — 纯混合检索（向量 + BM25 + RRF），返回 chunk | [src/query/retrieval.ts:117](../../src/query/retrieval.ts) | `search` |
   | warm 后的 `Runtime` 已持有 `db / embedder / llm / reranker / config` 只读字段 | [src/server/runtime.ts:68](../../src/server/runtime.ts) | server 直接读，零额外状态 |

   `ask()` 需要的依赖正好是 Runtime 暴露的字段——MCP server 跟 `createApp({ runtime })` 一样，只是 Runtime 的又一个表现层。

2. **传输标准已收敛到 Streamable HTTP**。MCP 2025-03 起以 Streamable HTTP 取代旧的 HTTP+SSE 双端点传输（后者已废弃）；当前 spec 版本 2025-11-25。单端点三动词：`POST` 发 JSON-RPC、`GET` 开 SSE 推送、`DELETE` 关会话。这正是用户要的 HTTP 模式。

3. **官方 SDK 稳定且与本项目栈契合**（2026-06-12 在 npm 核实）：

   | 包 | 版本 | 取舍 |
   |---|---|---|
   | `@modelcontextprotocol/sdk` | **1.29.0（latest 稳定）** | ✅ 选用 |
   | `@modelcontextprotocol/server` / `@modelcontextprotocol/hono` | 仅 `2.0.0-alpha.2`（v2 重组 pre-alpha） | ❌ 暂不依赖，但印证 Hono 集成是官方方向 |

   `@modelcontextprotocol/sdk@1.29.0` 的运行时依赖里**已带 `hono ^4.11.4` + `@hono/node-server`**，本项目就是 Hono `^4.12.17` 栈，版本兼容、集成无摩擦。唯一新增依赖是 `zod`（SDK 用它定义 tool `inputSchema`）。

### 1.3 为什么仍标 v2 / 设计先行

- ARCH §13 / PRD §7 一直把 MCP 定为 v2，与 v1 用户场景正交，应单独成版本，避免冲淡 0.4 收尾（RFC 0006 Studio + 0.4.0 flip）的焦点；
- 先以 Draft 评审锁定 tool 边界与鉴权方案，再按全项目惯例走 **alignment PR（Status 升档 + `mcp` schema 留位 + 零行为变化）**，随后 alpha.0/.1/.2 落地。

---

## 2. 范围拆分

### 2.1 in-scope（本 RFC 落地目标）

| # | 项 | 备注 |
|---|---|---|
| K1 | **`/mcp` 端点 + Streamable HTTP stateless 传输骨架**；`config.mcp` 被消费 | 每请求 new 一个 McpServer + transport，`sessionIdGenerator: undefined` |
| K2 | **`search` tool**：语义/混合检索，返回 top-K 片段 + `page_id` + `url` + breadcrumb | 包 `retrieve()`；不触发 LLM，零增量成本 |
| K3 | **`ask` tool**：合成答案 + 校验过的 citations | 包 `ask()`；消耗 LLM 配额，受配额/限流约束 |
| K4 | **鉴权 + 限流**：bearer / project-key + origin 白名单 + token bucket | 复用 [src/widget/server-gate.ts](../../src/widget/server-gate.ts) 的 `InProcessRateLimiter` |
| K5 | **`fetch_page` tool（可选）**：按 `page_id` 取整页原文，作 `search` 的下钻补全 | search + fetch 是 agent 知识库的标准一对 |
| K6 | **真实 MCP 客户端 dogfood**：用 Claude Code / Cursor 接本仓自己的文档 | 本仓 docs 即现成知识库 |

### 2.2 暂不做（留后续子 RFC / 远期）

| # | 项 | 推迟理由 |
|---|---|---|
| — | **Stateful session 模式**（`Mcp-Session-Id` + 服务端会话） | 知识库只读、每调用独立，stateless 已够；多轮由调用方 agent 自管 |
| — | **MCP Resources / Prompts**（把页面暴露成资源、把提问模板暴露成 prompt） | tool 是 agent 主接口；Resources 价值次要，可在 K5 之后增量 |
| — | **OAuth 2.1 授权流** | 自托管内部知识库用 bearer / project-key 更务实；OAuth 等企业多租户需求驱动 |
| — | **stdio 传输 / `@anydocs/ask-mcp` 独立包** | HTTP-first；只支持 stdio 的客户端出现时，用预留包名做薄垫片代理到 `/mcp` |
| — | **多项目联邦**（一个 MCP server 聚合多个 anydocs 项目） | 受 v1 硬约束「一进程一项目」限制，与 v2「多项目托管」同批解 |
| — | **MCP 层 token 级流式**（把答案 delta 经 MCP 进度通知推） | 多数 MCP 客户端只等最终 tool 结果；v1 返回完整答案，需要时再上 |

### 2.3 永不做

- ❌ **绕过 `ask()` / `retrieve()` 直查 DB 或自建第二套检索**——MCP 必须是同一管线的表现层，否则 reader / widget / mcp 三路答案不一致。
- ❌ **`ask` tool 把 LLM key 透传给调用方**——LLM 调用永远在 ask 服务端，调用方只看到答案。
- ❌ **审过的 QA 进检索**（PRD §11 决策 1 红线，与 v1 一致）——MCP 不改变这条。

---

## 3. 实现里程碑

> ✅ **已实装**：K1–K5 实际**提前**并入 **0.4.0-alpha.5**（非下方原标的 v2-alpha.*）一次发版。下表保留作原始规划参照。

```
alignment PR   (升档时)        Status Draft→Accepted + mcp schema 留位        零行为变化       ✅ → 0.4.0-alpha.5
v2-alpha.0     原 ≈ 升档后     K1 /mcp 骨架 + config.mcp 消费 + stateless     端点可握手        ✅ → 0.4.0-alpha.5
v2-alpha.1                     K2 search tool（包 retrieve）                  内部 dogfood     ✅ → 0.4.0-alpha.5
v2-alpha.2                     K3 ask tool（包 ask）+ K4 鉴权/限流            带配额           ✅ → 0.4.0-alpha.5
v2-alpha.3                     K5 fetch_page（可选）+ K6 真机客户端 dogfood   Claude Code 接本仓 docs  K5 ✅ → 0.4.0-alpha.5 / K6 🔄 dogfood 常态化中
v2.0.0                         operator flip enabled=true                     GA              ⏳ 待 operator flip
```

绝对日期不预设；里程碑顺序锁定。**alignment PR 范围严格限于**:

- 本文档 Status: Draft → Accepted；
- `anydocs.ask.json` 增 `mcp` 段，默认 `{ enabled:false, tools:['search','ask'], rateLimitPerMinute:60, allowedOrigins:[] }`；
- 四字段都不被任何代码路径消费（pipeline / server / console 全不读）；
- 配套 config 测试覆盖（mirror [RFC 0004 widget schema 留位](./0004-embedded-ask-widget.md#31-04-设计--原型阶段) 的 5 个测试）；
- 后续 alpha.0 才落地 K1（端点 + 消费）。

---

## 4. 设计要点

### 4.1 传输与无状态模式

知识库只读、每调用独立，与现有 `/v1/ask`（多轮历史由请求体携带、服务端不存 session）一致 → 选 **stateless**：

```ts
// src/mcp/server.ts —— 思路示意，非最终代码
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

app.post('/mcp', async (c) => {
  const gated = mcpGate(c);                       // K4：复用 widget server-gate 思路
  if (gated && !gated.ok) return c.json({ error: gated.code }, gated.status);

  const server = buildMcpServer(runtime);         // 注册 enabled 的 tools（按 config.mcp.tools）
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,                // 无状态：不发 Mcp-Session-Id
    enableDnsRebindingProtection: true,           // 本地绑 127.0.0.1 时必须，防浏览器打本地端口
    allowedHosts: runtime.config.mcp.allowedOrigins,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);      // Hono Request → SDK，SDK Response → Hono
});
```

- 端点位置：现有 Hono app 内，`buildCorsMiddleware` 之后（[src/server/app.ts:73](../../src/server/app.ts)）；
- `GET /mcp`（SSE 推送）在 stateless 下可直接 405——我们无服务端主动通知；只保留 `POST`。

### 4.2 tool 边界（最该评审的产品决策）

给 agent 当知识库，业界（含 Anthropic / OpenAI deep-research 范式）通常是 **`search` + `fetch` 一对** + 一个可选合成入口。本 RFC：

```
search(query, scope_id?, top_k?) → [{ page_id, title, url, breadcrumb, snippet, score }]
  · 包 retrieve()；调用方拿"事实出处"自己用它的模型合成；不花我们的 LLM
  · 默认主推：对 agent 最自然的原语，边际成本 ≈ 0

ask(question, scope_id?) → { answer_md, citations[], answer_lang, model }
  · 包 ask()；anydocs-ask 的差异化价值（意图分流 + 引用语义校验 + 多语言降级）
  · 消耗我们的 LLM 配额 → 带 per-key 配额，默认可在 config.mcp.tools 里关掉

fetch_page(page_id) → { page_id, title, url, markdown }    # K5 可选
  · search 的下钻补全；只读已索引页面原文，不触发检索/LLM
```

**关键张力**：`search` 近乎零成本、`ask` 烧我们的 LLM。默认 `tools: ['search','ask']` 都开，但文档明确建议成本敏感的 operator 可只开 `search`。

### 4.3 鉴权与安全（复用 RFC 0004 基建）

```
默认（self-host 同源 / 内网 agent）:
  Client → POST /mcp
    Header: Authorization: Bearer <token>   或   X-Project-Key: pk_xxx
  mcp-gate 校验 token / project-key + Origin 白名单，不通过 401/403
  复用 widget 的 InProcessRateLimiter 做 (key, IP) 维度 token bucket

强制项:
  · enableDnsRebindingProtection + Host/Origin 校验（SDK 内置）——本地端口防 DNS rebinding
  · ask tool 单独配额，防止单个 agent 把 LLM 预算打爆
```

OAuth 2.1（MCP spec 支持）留给企业多租户场景的后续子 RFC。

### 4.4 多轮 / session

stateless 下多轮由调用方 agent 自管（它本就有自己的上下文）。`ask` / `search` 可在后续把 `history` 做成**可选入参**（复用 [AskRequest.context.history](../../src/query/types.ts) 形态），v1 先不做——避免把 caller 的对话状态搬到我们这。

### 4.5 与现有 HTTP API 的关系

`/mcp` 与 `/v1/ask` **并存、共用同一 Runtime 与同一 ask 管线**。不弃用 REST：REST 面向"自己写集成的客户"，MCP 面向"用标准 agent 框架的客户"。两者答案必须逐字一致（同 `ask()` 调用）。

---

## 5. 决策记录（2026-06-12 起草，待评审确认）

| # | 问题 | 提议决策 |
|---|---|---|
| Q1 | 传输：Streamable HTTP stateless vs stateful session | **stateless**（§4.1）；知识库只读、多轮 caller 自管 |
| Q2 | SDK：`@modelcontextprotocol/sdk@1.x` 稳定 vs v2 alpha vs 手搓 | **1.29.0 稳定**（§1.2）；v2 alpha 未就绪、手搓维护成本高 |
| Q3 | 打包：进程内挂 Hono vs 独立 `@anydocs/ask-mcp` 包 | **进程内挂 `/mcp`**；预留包名改作未来 stdio 垫片 |
| Q4 | tool 边界 | **`search` + `ask` + 可选 `fetch_page`**（§4.2）；默认两者都开 |
| Q5 | `ask` 烧 LLM 怎么办 | 带 **per-key 配额**；operator 可只开 `search`；`search` 默认免费 |
| Q6 | 鉴权 | **bearer / project-key + origin 白名单 + 限流**，复用 widget gate；OAuth 后置 |
| Q7 | 多轮 | caller-managed，stateless；`history` 作可选入参，v1 不做 |
| Q8 | 是否同时弃用 REST `/v1/ask` | **不**，并存，共用 ask 管线，答案逐字一致 |
| Q9 | dogfood 客户端 | Claude Code（本仓 docs 即现成知识库），其次 Cursor |

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| MCP spec 仍在演进（2025-11-25 版），SDK v2 重组在途 | 锁定 `sdk@1.x` 稳定线；适配层薄（§4.1），v2 迁移面集中在 `src/mcp/` 一处 |
| `ask` tool 被 agent 高频调用打爆 LLM 预算 | per-key 配额 + 默认可只开 `search`；监控 `source=mcp` 流量 |
| 本地端口被浏览器内恶意页 DNS rebinding 攻击 | `enableDnsRebindingProtection` + Host/Origin 校验（SDK 内置，强制开） |
| MCP 来源数据混入文档站点反馈信号、污染 Studio 闭环 | 数据上打 `source=mcp` 标，Studio 可筛选/隔离（复用 RFC 0002 来源区分） |
| 新增 `zod` 依赖 | SDK 必需、生态标准、体积小；锁版本 `^3.25 || ^4` 与 SDK peer 对齐 |
| agent 的 vocabulary 与人不同导致检索差 | 同 Widget：靠 RFC 0006 A+ 诊断 + 反馈回路驱动；显著则触发 PRD §10.6「query 理解增强」线 |

---

## 7. 与其他 RFC 的关系

| RFC | 关系 |
|---|---|
| [0002](./0002-console-studio-feedback-loop.md) | Studio Feedback tab 是 MCP 来源反馈的消费端；MCP 来源需在数据上与 reader / widget 区分 |
| [0003](./0003-multi-turn-session-rewrite.md) | 软关系：stateless MCP 下多轮 caller 自管；`history` 入参可复用其 request 形态，非阻塞 |
| [0004](./0004-embedded-ask-widget.md) | **基建复用**：server-gate（鉴权 / origin 白名单 / `InProcessRateLimiter`）直接拿来用；MCP 与 Widget 正交互补 |
| [0005](./0005-citation-semantic-validation.md) | 软依赖：让 `ask` tool 返回的 citations 经语义校验，agent 拿到可信引用；已在 main |

---

## 8. 未涉及

- 移动端 / 边缘环境的 MCP 客户端适配——传输无关，不特化
- MCP Resources / Prompts 的完整建模——K5 之后增量评估
- 多项目联邦的 MCP 聚合 server——与 v2「多项目托管」同批
- MCP 层独立可观测性 dashboard——可复用 Console Studio Traffic tab + `source=mcp` 筛选
- 与 LangGraph / CrewAI 等具体 agent 框架的官方示例集成——文档侧补，不入核心

---

## 9. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-06-12 | 起草（Draft）。范围：在现有 Hono app 挂 `/mcp`，Streamable HTTP stateless，`search` + `ask`（+ 可选 `fetch_page`）三 tool 复用 `ask()` / `retrieve()`；进程内挂载、复用 widget server-gate；SDK 锁 `@modelcontextprotocol/sdk@1.29.0`（npm 核实）。待评审升档 Accepted + alignment PR（`mcp` schema 留位、零行为变化） | @shawndslee |
| 2026-06-12 | **审核通过 + alpha.0 落地**。K1-K5 一并实现（非仅 schema 留位）：`src/mcp/{server,tools,gate,types}.ts` + 查询层 `search()`（`src/query/answer.ts`，注入静态 `fallbackRoute` → 真正 LLM-free）+ `searchHitFromChunk()`（`postprocess.ts`，与 citation 同源映射）。`config.mcp` schema + 校验落地。安全实现偏离 §4.3 一处并记录：DNS-rebinding 改为**端口无关的 loopback Host 守卫**（自实现，而非 SDK 的精确 `allowedHosts`），因为实际服务端口可被 `serve --port` 覆盖、且 rebinding 威胁在 hostname 不在 port；SDK 的 Origin 白名单仍保留。传输用 `enableJsonResponse`（单 JSON 响应，非 SSE）。配 3 个测试文件共 29 例（config 9 / gate 7 / e2e 13）+ 全量 917 测试绿 | @shawndslee |
