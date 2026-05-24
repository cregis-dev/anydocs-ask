# Dogfood 2026-05-24 — RFC 0004 Widget alpha.2b 真机回归

> 项目：hermes-docs（107 pages / 460 chunks）
> 范围：RFC 0004 alpha.0 → alpha.2b 全栈（W1 类型契约 + W3 MVP + W4 CORS/gate + chat polish SSE/β/history）
> 模型：deepseek-v4-flash（Anthropic gateway，`/Users/shawn/anydocs-ask-runtime/.env`）
> 工具：curl + chrome-devtools MCP

---

## 范围

新落地 PR 链合到 main 后的端到端 dogfood：

- `PR #77` RFC 0004 alignment + widget schema
- `PR #78` alpha.0 W1 协议规格 + TS 类型
- `PR #79` alpha.1 W3 MVP（host SDK + iframe chat + endpoints）
- `PR #80` alpha.2 W4（CORS + project-key + rate limit gate）
- `PR #81` alpha.2b（SSE + β + history namespace + bug fix）

执行路径：
1. flip hermes-docs anydocs.ask.json widget 段：`enabled=true`, `allowedOrigins=['http://127.0.0.1:8080']`
2. 起 anydocs-ask serve 在 :3201；起 python http.server 在 :8080 服务一个 host HTML（`/tmp/widget-dogfood/index.html`），里头 `<script src="http://127.0.0.1:3201/widget/v1.js">` + `anydocsAsk.init({projectKey:'pk_dogfood_demo'})`
3. chrome-devtools MCP 打开 `http://127.0.0.1:8080/index.html`，点 "?" bubble，提交问题，验证全链路

---

## 通过项

### F1 host bundle 加载 + 浮层挂载 ✅

`<script src="http://127.0.0.1:3201/widget/v1.js" async>` 拉到 207 行 IIFE，注册 `window.anydocsAsk.init()`。init 后右下角出现 "?" bubble；iframe 默认 hidden。 一次点击 bubble 即展开 380×560 px 浮层，iframe src 命中 `http://127.0.0.1:3201/widget/chat?projectKey=pk_dogfood_demo&locale=zh`。

截图：`img/widget-dogfood-01-host.png`（host 页面 + bubble）、`img/widget-dogfood-02-open.png`（浮层打开）。

### F2 CORS preflight + 真 SSE 调用 ✅

curl 预演：

```
OPTIONS http://127.0.0.1:3201/v1/ask/stream
  Origin: http://127.0.0.1:8080
  Access-Control-Request-Method: POST
→ 204
```

随后 POST 命中真 SSE：

```
HTTP/1.1 200 OK
access-control-allow-origin: http://127.0.0.1:8080  ← 反射 widget origin
content-type: text/event-stream
```

SSE 帧顺序符合 [src/server/app.ts](../src/server/app.ts) `streamSSE`：`status: received` → `status: retrieving` → `status: generating` (含心跳) → 多个 `delta` → `result` → `done`。

### F3 iframe 内 chat → /v1/ask/stream token-by-token ✅

浏览器侧：浮层文本框输入「hermes 怎么配置 model provider？」点 Send，答案区开始渲染。tokens 增量出现（非一次性弹出），约 6s 后 final result 帧落地，包含 5 个 citations + answer_id。

截图：`img/widget-dogfood-03-answer.png`。

answer_md 渲染样例（截前 200 字）：

> 您可以通过以下方式配置 Hermes 的 model provider：
>
> 1. **使用交互式设置**：运行 `hermes model` 命令，系统会引导您完成 provider 的选择和配置。[cit_1][cit_2]
>
> 2. **永久配置**：在 `config.yaml` 文件中直接设置 provider 和默认模型，这样配置会持久生效。[cit_2]
>
> 3. **（可选）配置 fallback providers**...

citations 渲染成 5 个可点击 link（标题 + 序号），点击触发 host 侧 `navigate` event（host 控制 `window.open` target）。

### F4 β 反馈栏 + 真写库 ✅

answer 区下挂三个按钮：「👍 helpful」「👎 not helpful」「answered wrong…」。点 👍 → POST `/v1/ask/feedback` → SQLite 落行：

```
feedback_id | signal_source | rating | question                              | session_id
         18 | explicit      |      1 | hermes 怎么配置 model provider？      | s_f21e486...
```

`question` 列正确回填（F7 修后行为）；`session_id` 列正确写入（PR #61 修后行为）。

截图：`img/widget-dogfood-04-thumbs-up.png` —— 👍 按钮变为绿色 sticky 状态。

### F5 widget gate 旁路 iframe 自流量（alpha.2b bug fix 验证）✅

iframe → /v1/ask/stream 调用**不发** `X-Project-Key`（alpha.2b 修复），所以 widget gate `isWidgetRequest` 返回 false，整段 bypass。Reader / Console 一样的同源路径。原因：iframe origin 是 ask server 自己，发 X-Project-Key 会触发 gate 的 origin allowlist 检查 → ask server origin 不在 host allowedOrigins 里 → 403 origin_not_allowed。这条 latent bug 在 alpha.2b PR 修复 + 文档。

### F6 RFC 0005 citation-check 在 widget 流量上同样起作用 ✅

widget 的 ask 写了 RunRecord 后，fire-and-forget 的 validator 异步跟进。10s+ 后 runs.jsonl 落 `citation-check-update` tail，例如 "hermes 怎么登录？" 这条：

```
tail: req=6f5d308f cits=2 verdicts=['supports', 'partially']
  cit_1      supports — 文档中明确列出'hermes | Start chatting'，可直接开始对话，无需登录。
  cit_2     partially — 文档提到有本地web仪表盘，但未提及运行'hermes gateway'命令来启动。
```

V5 Studio Feedback tab 会消费同一条 tail（在 Studio 看 widget 来源的反馈时，verdict 信号已就位）。

---

## 发现的瑕疵

无 P0/P1。alpha.2b 的 X-Project-Key bug 已经在落 PR 时同步修了。chat-page 第一次问答的 5-cit 答案的 verdicts 在本次 dogfood 截止窗口内还没完成（5 cit batch 一次 LLM 调用 + 网关延迟），不算瑕疵，是 shadow 模式预期行为。

### F10【UX, P3】"?" bubble 视觉粗糙

当前 "?" bubble 是黑底白字 56×56 px 圆形，文字 22px 不带 icon。能用，但跟 host 页面风格冲撞概率高。**修法（alpha.3 候选）**：换成 SVG icon (e.g. chat bubble)，theme 接口接通 RFC §4.2 的 \`themeBaseColor\` token 让客户改主色。

### F11【UX, P3】iframe history restore 缺 β 状态

iframe 重载时 `loadStored()` 还原历史 turn，但 β 反馈按钮重新挂上去全是未提交状态（即便 `turns[i].fb` 在 localStorage 里）。**修法**：appendFeedbackBar 接受 `priorFb` 参数，渲染时若有就 lock + 高亮。

### F12【UX, P3】iframe 内点 citation link 还没有 doc-deeplink

cit link 直接打开 ask server 的 `/en/<page-id>#<anchor>` URL。这是 anydocs reader 自带的 doc 站，本地启动时是 404（reader 站没起）。在 dogfood 场景下展示为黑色失败链接没意义。**修法**：alpha.3 给 host SDK 接 `docsBaseUrl` init option，让 client 显式指定客户 doc 站基础地址；如果未指定，cit link 显示为纯文本 + 工具提示。

---

## 还没真机验过

- **直接 cross-origin SDK 调用模式**（不走 iframe）—— RFC §4.2 留口，0.5+ Phase 4 才接通；widget gate 准备好了但暂无消费者
- **shadow DOM 形态**（RFC Q1）—— 接口留位，alpha.1 仅落 iframe
- **多 host 同时接入**（不同 allowedOrigins）—— rate limit per (project_key, origin) 在单测验过，未真打多 host 场景
- **rate limit 真触发 429**—— dogfood 量级远低于 60/min，单测已覆盖

---

## 行动建议

- ✅ alpha.0 → alpha.2b 五个 PR 已全部合 main，可演示
- F10 / F11 / F12 进 alpha.3 排队
- 下一步候选：
  1. **0.3.0 release**：把 main 上累计的 RFC 0005 alpha.2 全链 + RFC 0004 widget MVP alpha.2b 打 minor 发；design partner 拉到自带 widget
  2. **W5 SaaS design partner 联调**：找一家做嵌入；RFC §5 Q6 的目标
  3. **alpha.3 polish**：解 F10-F12 + 接 docsBaseUrl + theme tokens
