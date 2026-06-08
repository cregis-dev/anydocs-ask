# 更新日志

`@anydocs/ask` 的所有重要变更均记录于此。格式大体遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 semver 语义（`0.1.0` 起脱离 alpha 预发布；0.1.x 阶段允许 minor 内的 API 增量演进）。

## Unreleased

（待下一版收集）

## 0.4.0-alpha.4 — 2026-06-08

第一个挂 0.4 版本号的 alpha — 把累积 9 个 PR（自 v0.3.1 起的 #93–#102，跳已发的 #91）一并打包。重点是 **ask 主路径质量改造**（intent router + greetings 短路 + 当前页面去偏 + reranker stage）+ **Studio A+ 视图接通**。还无 0.4.0 GA 的 flip enabled —— `aplus.enabled` / `reranker` 默认仍 off。

### 新增

- **RFC 0006 0.4.0-alpha.3 — Studio A+ 视图接通**（[#93](https://github.com/cregis-dev/anydocs-ask/pull/93)，A7）—— `feedback/suggestions-loader.ts` 扫 `<stateRoot>/feedback/suggestions/{c_*.json,.shadow/c_*.json}` + 解析为 UI VM。Console Feedback tab 三件事：
  - KPI tile `A+ candidates` 从硬编码 "—" 接通真数；区分 `shadow mode` vs `live · operator flipped`（aplus.enabled=true 时）；无 suggestions 时回退到 `unlocks at 50` 占位
  - 新增 `aplus_candidates` filter chip，过滤到出现在任意 cluster 的 feedback 行（chip 计数 + 列表 narrowing 与 no_citations / cit-check 同形态）
  - Drawer 新增 SUGGESTION 段：cluster_id + center question + peer queries（≤ 8 条）+ shadow/live 徽章 + suggestion markdown 预览（≤ 1600 chars 折叠）+ 绝对文件路径（operator 在编辑器里打开）

  **不依赖反馈量门槛** —— 即使 hermes-docs ≤ 15 条反馈，operator 跑 `feedback diagnose --shadow` 后 Studio 就能看到效果。`aplus.enabled=true` flip 留给 0.4.0 GA（≥ 50 反馈 + 4 周观察窗后由 operator 决定）。

- **LLM intent router**（[#99](https://github.com/cregis-dev/anydocs-ask/pull/99)）—— 新增 `src/query/intent-router.ts`（474 行）+ 重写 `src/query/answer.ts`（+904 行）。ask 主路径在 retrieval 之前先用 LLM 判定 query intent，决定走完整检索 / 短路返回 / clarify 分支。降低 conceptual / chitchat 类问题的无谓检索开销。零配置变化、默认启用。

- **Reranker stage（cross-encoder）**（[#102](https://github.com/cregis-dev/anydocs-ask/pull/102)）—— 新增 `src/reranker/` 模块：`bge-cross-encoder.ts`（BGE 跨编码器实现）+ `factory.ts` + `mock.ts` + `types.ts`。可选的 retrieval 后处理阶段，**默认 off**（`anydocs.ask.json` 加 `reranker.{type:'none'|'bge-cross-encoder', ...}` 段）。golden cases 同步扩展（`eval/cregis-developer-docs/cases.jsonl` +80 行）。

- **Eval metric reporting 改造**（[#101](https://github.com/cregis-dev/anydocs-ask/pull/101)）—— `src/commands/eval.ts` + `src/eval/scoring.ts` 重写，输出更细的指标（rank 度量、variance baseline）。新增 `docs/eval-golden-set-curation.md` + `docs/eval-variance-baseline.md` 两份评测文档。

- **CI: publish 前 dump OIDC claims 取证**（[#95](https://github.com/cregis-dev/anydocs-ask/pull/95)）—— `release.yml` 在 `npm publish` 之前用 `actions/github-script@v7` + `core.getIDToken('npm:registry.npmjs.org')` dump 14 个关键 OIDC claim 字段（sub / repository / workflow_ref / environment / 等）到日志。`continue-on-error: true` 兜底，故障不阻断真实 publish。背景：v0.3.1 三次 OIDC publish 全 E404，本字段已用 debug 分支验证假设 2（claim mismatch）排除；这条嵌入是为下次 publish 仍 E404 时省一次 debug 分支。

### 修复

- **fix(query): answer greetings without retrieval & near-tie subtrees**（[#98](https://github.com/cregis-dev/anydocs-ask/pull/98)）—— 寒暄类 query 不再走完整检索；near-tie subtrees 不强制 clarify，直接给答案。
- **fix: avoid current page context biasing ask answers**（[#97](https://github.com/cregis-dev/anydocs-ask/pull/97)）—— widget 内嵌时不让当前 page 的内容污染 retrieval ranking。
- **fix: improve api reference retrieval citations**（[#100](https://github.com/cregis-dev/anydocs-ask/pull/100)）—— `src/query/sanitize.ts` + `retrieval.ts` 调整，API reference 类 query 的 citation URL 更准。
- **fix(eval): improve cregis api retrieval coverage**（[#96](https://github.com/cregis-dev/anydocs-ask/pull/96)）—— 提升 cregis-developer-docs golden set 的 API 召回覆盖。

### 文档

- **docs(backlog): 新增 docs/backlog.md**（[#94](https://github.com/cregis-dev/anydocs-ask/pull/94)）—— 记录两条 ask 主路径轻量化候选。

## 0.3.1 — 2026-05-24

补丁版：**RFC 0006 A+ 失败查询诊断 alpha 链路（alignment + alpha.1 + alpha.2）+ npm publish 准备**。无 breaking change（aplus 段默认 off）；纯加 alpha 通道 + 发布前手续修整。

5 个 PR / commit 自 v0.3.0（[#86 release wf](https://github.com/cregis-dev/anydocs-ask/pull/86) / [#87 RFC 0006 draft](https://github.com/cregis-dev/anydocs-ask/pull/87) / [#88 alignment](https://github.com/cregis-dev/anydocs-ask/pull/88) / [#89 cluster pure](https://github.com/cregis-dev/anydocs-ask/pull/89) / [#90 suggest + CLI pipeline](https://github.com/cregis-dev/anydocs-ask/pull/90)）。

### 新增

- **`anydocs-ask feedback diagnose` CLI** —— [RFC 0006](docs/rfcs/0006-failure-query-diagnostic-aplus.md) A+ 失败查询诊断的完整管道接通。
  - **alignment (PR #87, #88)**：RFC Status: Draft → Accepted；`anydocs.ask.json` 增 `aplus.{enabled:false, threshold:50, observationWindow:'28d', embedSimilarityThreshold:0.65}` 段（PRD §10.3 双门槛 + RFC §4.2 聚类阈值）。CLI 注册 `feedback diagnose <projectRoot> [--threshold N] [--observation-window 28d] [--shadow] [--dry-run]`。零行为变化。
  - **alpha.1 聚类 (PR #89)**：`src/feedback/diagnose-cluster.ts` `clusterFeedback(rows, options?)` —— threshold-based union-find on bge-m3 cosine；`cluster_id` sha256-12 hex of center question 跨次稳定；`synthesize60()` simulator 用 4 主题 × 15 query 验证管道 + 默认阈值精确 4 簇。
  - **alpha.2 建议生成 + pipeline (PR #90)**：`src/feedback/diagnose-suggest.ts` 调主 LLM (B.2 复用 Anthropic 通道) 按 RFC §4.4 prompt 生成补文档建议草稿；`src/feedback/diagnose-runner.ts` orchestrator 串 feedback 表读 → embedding_cache (write-through `getOrEmbed`) → clusterFeedback → generateSuggestion → 写 `<stateRoot>/feedback/suggestions/cluster_<id>.{md,json}` 或 `.shadow/` 子目录。CLI 从 stub 升级到真跑：feature_off / data_insufficient / invalid_window 三个守卫 + `--dry-run` 跑全流程不写盘。
  - **未启用门槛**：`aplus.enabled=false` 默认 + 无 `--shadow` 整段不跑 LLM；PRD §10.3 启动门槛 ≥ 50 反馈 + 4 周观察窗未到时由 operator 决定。Studio Feedback tab `aplusCandidates` 接通是 alpha.3。

- **GitHub Actions release workflow (PR #86)** —— `.github/workflows/release.yml` tag-triggered (`v*`) + manual workflow_dispatch；OIDC trusted publishing + `--provenance` + `npm-publish` GitHub environment 人工 Approve 闸门 + tag/version match check + typecheck + test + build 串好。`engines.pnpm` 已从 package.json 移除（仅作用于本仓库开发，对 consumer 误导）。

### 修复

- **LICENSE 文件补充** —— package.json 声明 `license: "MIT"` 但仓库根无 LICENSE 文件；本版本补上标准 MIT 文本。
- **package.json `files` 收敛** —— 不再把 `PRD.md` + `ARCHITECTURE.md` 进 npm tarball（内部决策文档对 consumer 无价值；包尺寸虚大）。文件保留：`dist/` + `README.md` + `CHANGELOG.md` + `LICENSE`。

## 0.3.0 — 2026-05-24

主线：**RFC 0005 citation 语义校验全链路接通（alpha.2 pipeline + V5 Studio 展示）+ RFC 0004 嵌入式 Ask Widget MVP（alpha.0→alpha.3 完整栈）**。次主线：**0.2.0 dogfood 留下的 F7 + F9 follow-up + RFC 0005 maxTokens CJK 修复**。两轮 dogfood（[2026-05-23 alpha.2 真机](docs/dogfood-2026-05-23-alpha2.md) / [2026-05-24 widget 真机](docs/dogfood-2026-05-24-widget.md)）锚定真实信号。

13 个 PR / commit 自 v0.2.0（[#72-#84](https://github.com/cregis-dev/anydocs-ask/issues?q=is%3Apr+merged%3A%3E2026-05-23)）。

`/v1/ask` / `/v1/ask/feedback` / `/v1/ask/stream` 协议向后兼容；新增 `GET /widget/v1.js` + `GET /widget/chat` 两个 endpoint（默认 gate 在 `widget.enabled=false`）；runs.jsonl 新增 `citation-check-update` tail 行（schema 向后兼容，`isRunRecord(line)` 守卫一处处理新旧两种行）。

### 新增

- **RFC 0005 alpha.2 — citation 语义校验 pipeline 接通（V3 + V4 + V6）**（PR [#72](https://github.com/cregis-dev/anydocs-ask/pull/72)）—— `finalizeAskCall` 在主响应返回后异步、批量、fire-and-forget 触发 [src/query/citation-validator.ts](src/query/citation-validator.ts)；校验结果以 `citation-check-update` tail 行追加进 runs.jsonl，按 `request_id` + `citations[].citation_id` 与原 RunRecord join。`anydocs.ask.json` 的 `citationSemanticCheck.enabled` 现在真接通——`false`（默认）整段不触发任何 LLM 调用；`true` 时每个 answer 多 1 次 Claude 调用，shadow 模式不阻塞主答案延迟。dry_run / 无 citations / 校验抛错均自然降级。配套：`RunCitation` schema 加 optional `citation_id` + `semantic_check`；新增 `RunCitationCheckUpdate` tail record 类型 + `isRunRecord(line)` 守卫；所有 runs.jsonl 读端（analyze / golden / runs export / Console feedback-state / index-state / traffic-state）切到守卫。

- **RFC 0005 V5 — Console Studio 展示 verdict**（PR [#74](https://github.com/cregis-dev/anydocs-ask/pull/74)）—— Feedback tab 新增 `semantic_check_failed` 筛选 chip（"⚠ cit-check"，匹配任一 cit verdict !== `supports` 的行）+ 第 6 个 KPI tile（"cit-check failed"，feature off 时显示 "—" 区别于 "0 failures"）。Drawer CITATIONS 抽屉每个 cit 后挂彩色 verdict 徽章（supports=ok / partially=warn / not_supports=err）+ LLM 给出的 ≤100 字 reason 行。读端通过 `request_id` 把 `citation-check-update` tail merge 进 `runIndex`，按 `citation_id` 把 verdict 落到对应 cit；feature off / 无 tail / pre-alpha.2 行 → 全部 null 自然降级。

- **RFC 0004 嵌入式 Ask Widget MVP（alpha.0→alpha.3 完整栈）**（PR [#77](https://github.com/cregis-dev/anydocs-ask/pull/77) / [#78](https://github.com/cregis-dev/anydocs-ask/pull/78) / [#79](https://github.com/cregis-dev/anydocs-ask/pull/79) / [#80](https://github.com/cregis-dev/anydocs-ask/pull/80) / [#81](https://github.com/cregis-dev/anydocs-ask/pull/81) / [#83](https://github.com/cregis-dev/anydocs-ask/pull/83)）—— 从 RFC Accepted 升档一路到可演示原型 + 跨域安全 + chat 体验补完 + 三项 polish 真机验完。
  - **alignment + alpha.0**：RFC 0004 Status: Draft → Accepted；`anydocs.ask.json` 新增 `widget` 段（默认 `{ enabled:false, rateLimitPerMinute:60, allowedOrigins:[] }`）；`src/widget/types.ts` 落 Host API + postMessage envelope + server-side error codes + global namespace 全套 TS 类型；`src/widget/protocol.ts` 落 zero-dependency postMessage 守卫。
  - **alpha.1 W3 MVP**：`src/widget/host-sdk.ts` 渲染 `GET /widget/v1.js`（IIFE bundle，注册 `window.anydocsAsk.init()` + 右下角浮层 + 380×560 px iframe）；`src/widget/chat-page.ts` 渲染 `GET /widget/chat`（textarea + send + answer + citations）。两端都 gate 在 `widget.enabled`，关闭时 404 `widget_disabled`。
  - **alpha.2 W4 跨域安全**：`src/widget/server-gate.ts` 三层守卫（widget_disabled / invalid_project_key / origin_not_allowed / rate_limited），`InProcessRateLimiter` token bucket per (project_key, origin)，capacity 配置变更即生效，10 min 无活动 key auto-evict。CORS 接 `widget.allowedOrigins` + `allowHeaders` 加 `X-Project-Key`。所有 `/v1/ask*` 路径在 widget-flavoured 调用（带 `X-Project-Key`）时跑该 gate；不带 header 的 Reader / Console 调用一律 bypass。
  - **alpha.2b chat polish**：chat-page 升 SSE 流式（POST `/v1/ask/stream` + parseSseFrame token-by-token），β 反馈栏（👍/👎/"answered wrong…" inline correction），widget-namespaced localStorage 历史持久化（`anydocs-ask:widget:history:v1`），重载 iframe 自动恢复最近 20 turn。
  - **alpha.3 polish**：bubble 从 "?" 文字换 SVG 对话气泡 icon + 接通 `theme.baseColor` 让客户改主色；history restore 装回 β locked + 染色状态；新增 `WidgetInitOptions.docsBaseUrl` 让客户文档站基础 URL 作为 citation 相对路径的前缀。
  - **真机回归**（[docs/dogfood-2026-05-24-widget.md](docs/dogfood-2026-05-24-widget.md)）：hermes-docs flip widget.enabled=true 后浏览器侧 F1-F6 + F10/F11/F12 全过：bubble SVG 紫色 / SSE 流式 / 5-cit 答案 / β 真写库 / iframe 跨源 widget gate 行为 / RFC 0005 verdict 同样作用在 widget 流量上。

### 修复

- **F6 — citation-validator maxTokens 对 CJK reason 不足（dogfood 2026-05-23 follow-up）**（PR [#73](https://github.com/cregis-dev/anydocs-ask/pull/73)）—— alpha.1 用 `Math.max(256, batch.length * 80)` 算 maxTokens；6-cit batch 仅 480 tokens 预算，中文 reason 一个 verdict 真实占 ~200 tokens，输出截在 cit_1 中间 → `parseLlmJsonArray` null → 整批静默 `[]`。修后 `Math.max(1024, batch.length * 300)`，CJK 充足余量；hermes-docs 真打 10 query × 32 verdicts 全部落库。回归测试加 maxTokens 下限断言守住。

- **F7 — `validateCitations` 入口处按 `citationId` 去重（dogfood 2026-05-23 follow-up）**（PR [#75](https://github.com/cregis-dev/anydocs-ask/pull/75)）—— `extractClaimChunkPairs` 给同一答案里多次出现的 `[cit_N]` 标记各产一 pair（同 chunk、不同 claim 句）。alpha.1 这些 pair 会被分布到多批 LLM 调用：(1) 白烧 token，(2) 跨批共有 `cit_id` 时输出含重复 verdict 行，(3) V5 reader `applyTail` 按 last-write-wins 折叠，verdict 随机被选。修后：入口前 dedupe（first-write-wins，与既有 within-batch `seen` 语义一致），LLM 看到的每 batch 都唯一 `cit_id`、tail 行无重复。Token 节省与 claim 数成正比。

- **F9 — Reader HISTORY 抽屉延迟刷新（0.2.0 dogfood follow-up）**（PR [#76](https://github.com/cregis-dev/anydocs-ask/pull/76)）—— 用户在第一次问答前打开 HISTORY 抽屉时显示 "No conversations yet"；答案落下后 `upsertCurrent` 写入 localStorage 但抽屉保留陈旧空态。修法：`upsertCurrent` 在 localStorage 写入后检查 `histDrawer.hidden`，若抽屉处于打开状态立刻 `renderHistory()` 触发重渲染。

## 0.2.0 — 2026-05-23

主线：**反馈回路铺通（RFC 0001）+ Console → Studio 升级（RFC 0002）**。次主线：**Query 质量回归**（基于 hermes-docs / cregis-developer-docs / anydocs-user-manual 三轮 dogfood + eval round-1 至 round-7）。同时落地：**早期多轮对话（RFC 0003 M1-M6）默认开启** + **citation 语义校验 schema 留位（RFC 0005 alpha.0/alpha.1）**——后两条本属于 0.3 / 0.4 的预告主线，但代码已经在 main 上跑过 dogfood 真证，作为本版本"early in-scope"一并发布。

`/v1/ask` / `/v1/ask/feedback` / `/v1/ask/stream` 协议向后兼容；新增**可选** `session_id` round-trip 字段（首发由 Reader 客户端的 localStorage 维护），不传走单轮路径。

### 新增

- **β 显式反馈采集（RFC 0001 §3）**（PR [#30](https://github.com/cregis-dev/anydocs-ask/pull/30) / [#42](https://github.com/cregis-dev/anydocs-ask/pull/42) / [#48](https://github.com/cregis-dev/anydocs-ask/pull/48) / [#61](https://github.com/cregis-dev/anydocs-ask/pull/61)）—— `POST /v1/ask/feedback` 落 SQLite `feedback` 表（含 `signal_source` / `session_id` / `cluster_id` v1.5 schema），question 文本从 answers 表回填或从请求体兜底；Reader Ask UI 加 👍/👎/答错按钮 + 文本补正。Console Ask 体验台同款。配套 CLI：`feedback export / import / status` 走 `state/<projectId>/feedback/{inbox,approved,rejected,exports}` 目录，git 友好。

- **γ 隐式信号 + session table（RFC 0001 §3 / ARCH §15.2.2）**（PR [#30](https://github.com/cregis-dev/anydocs-ask/pull/30)）—— 进程内 `SessionTable`（30min TTL + LRU 上限），每轮 ask 记 `{session_id, question, queryVector, answer_id, used_chunks}`。同 session 5min 内的"重问"如果与上一轮 query embedding cosine 相似度 ≥ 0.85，则写一条 `signal_source='implicit'` 的 implicit-negative 反馈行指向**上一轮** answer，喂 reranker 先验。`feedback.enabled = false` 默认关闭整段。

- **`POST /v1/ask` 响应携带 `session_id`** —— 客户端按需 round-trip；Reader localStorage 维护，CLI / curl 用户可不理会。

- **Console Feedback tab（RFC 0002 T1-a/b/c/d + close 尾）**（PR [#46](https://github.com/cregis-dev/anydocs-ask/pull/46) / [#47](https://github.com/cregis-dev/anydocs-ask/pull/47) / [#49](https://github.com/cregis-dev/anydocs-ask/pull/49) / [#50](https://github.com/cregis-dev/anydocs-ask/pull/50) / [#52](https://github.com/cregis-dev/anydocs-ask/pull/52)）—— 完整反馈视图：4 状态（disabled / enabled-empty / onboarding < 10 / healthy）+ 5 KPI tile（feedback·7d / explicit% / mean confidence / non-answer rate / A+ candidates 占位）+ 5 filter chip（all / 👍 / 👎 / implicit / no_citations）+ 每行 breadcrumb cell + 右侧 detail drawer（META / ANSWER / CORRECTION / CITATIONS / RETRIEVAL fused top-8 / ACTIONS replay-in-Ask + add-to-golden + jump-to-doc）。Drawer 含 stale-response token 防漂移。

- **Console Index tab — ask-usage 反向标注（RFC 0002 T4）**（PR [#51](https://github.com/cregis-dev/anydocs-ask/pull/51)）—— Index 行末显示"近 7 天命中 N 次 + 中位 confidence"，page 级 ≥ 3 命中起；warn tint when median confidence < 0.5；page → 跳 Traffic 过滤同 page。

- **Console 跨 journey jump**（PR [#44](https://github.com/cregis-dev/anydocs-ask/pull/44)）—— Traffic 行 / Feedback drawer 一键加 golden 候选；hash routing #index?focus=&lt;pageId&gt; / #ask?q=&lt;query&gt; 通用打通。

- **Reader 公网 Ask UI**（`GET /ask`）（PR [#45](https://github.com/cregis-dev/anydocs-ask/pull/45) / [#63](https://github.com/cregis-dev/anydocs-ask/pull/63)）—— 单文件 SSR + 内嵌 SSE 客户端 + marked.esm.js；localStorage 维护 session_id；β 反馈按钮内置；citation 视觉去重（同 page 多 chunk 加 `· §<section>` 后缀）；可 iframe 嵌入（`position:fixed; inset:0`）。

- **Console 项目级 prompt 配置**（commit e77fc10）—— `anydocs.ask.json` 的 `prompt.{assistantName, systemInstructions[]}` 在 Console Config drawer 可编辑；assistant 友好名 + 项目特定 system instructions 注入答案 prompt。

- **早期多轮对话（RFC 0003 M1-M6）默认开启**（PR [#56](https://github.com/cregis-dev/anydocs-ask/pull/56) / [#57](https://github.com/cregis-dev/anydocs-ask/pull/57) / [#59](https://github.com/cregis-dev/anydocs-ask/pull/59) / [#60](https://github.com/cregis-dev/anydocs-ask/pull/60) / [#64](https://github.com/cregis-dev/anydocs-ask/pull/64)）—— 复用现有 Anthropic LLM 通道（B.2 单次消化路径，不引入小模型 / 本地推理服务）。M1 history-aware retrieve query（embedding query 拼最近 N 轮 question / BM25 query 不拼）；M2 multi-turn system prompt 加 5 条 zh+en 双语约束；M3 SessionEntry 增 `answer_md_summary`（200 字硬截断）；M4 接口 `history_window?: number`（AskAnswer / AskTrace / runs.jsonl 透出）；M6 Console Feedback tab 把连续同 session 行折叠成 dialogue 块（turn `T<N>/<M>` 徽章 + drawer SESSION 段列 peer turns + history_window 标记）。默认 `multiTurn.enabled=true / historyTurns=3`。

- **citation 语义校验 schema 留位（RFC 0005 alpha.0/alpha.1）**（PR [#65](https://github.com/cregis-dev/anydocs-ask/pull/65) / [#66](https://github.com/cregis-dev/anydocs-ask/pull/66)）—— `anydocs.ask.json` 加 `citationSemanticCheck.{enabled:false, mode:'shadow'}`。两个 pure helper 落地：`src/query/claim-extractor.ts` 抽 `[cit_N]` 标记前的 claim 句；`src/query/citation-validator.ts` 批量调主 LLM 输出 verdict + reason JSON。**未接 pipeline**——alpha.2 才挂到 finalizeAskCall + 扩 RunRecord schema。

- **Eval foundation + golden workshop 增强**（PR [#54](https://github.com/cregis-dev/anydocs-ask/pull/54)）—— Codex/cregis 评测基线脚本与 fixtures；`golden generate --from runs` / `--include-console` / `--since` 完善。

### 修复

- **Query 质量 — eval round-1 至 round-7 系列**（PR [#32](https://github.com/cregis-dev/anydocs-ask/pull/32) / [#33](https://github.com/cregis-dev/anydocs-ask/pull/33) / [#34](https://github.com/cregis-dev/anydocs-ask/pull/34) / [#35](https://github.com/cregis-dev/anydocs-ask/pull/35) / [#36](https://github.com/cregis-dev/anydocs-ask/pull/36) / [#37](https://github.com/cregis-dev/anydocs-ask/pull/37) / [#38](https://github.com/cregis-dev/anydocs-ask/pull/38) / [#39](https://github.com/cregis-dev/anydocs-ask/pull/39) / [#41](https://github.com/cregis-dev/anydocs-ask/pull/41)）—— `clarify` 子树阈值从 `0.65/0.15` 调到 `0.55/0.25`；clarify follow-up camelCase BM25 + 单复数 title 匹配；zh lang detection — CJK 阈值下调 + CJK 标点信号 + answer-text sanity 检查；JSON / YAML / config snippet 不再误标 ⚠ hallucination；no_citations 路径增加"加固 prompt 重试 1 次"；citation retry 1 → 2 + trace 记 attempts；multi-entity recall — query 中的 "/" "、" 分隔符 + additive injection + context cap；用户可见 message + `<lang>` 占位符规范化。

- **RunRecord.session_id 真填（dogfood 2026-05-22）**（PR [#64](https://github.com/cregis-dev/anydocs-ask/pull/64)）—— runs.jsonl 每行 `session_id=null` 即使 multi-turn 正常工作；`appendRun` 硬编码 null + gamma 自己解析 id 但不对齐。修法：`finalizeAskCall` 顶部一次性 `sessionTable.getOrCreate`，thread 给 appendRun + observeAsk 复用。

- **β explicit 反馈插入持久化 session_id**（PR [#61](https://github.com/cregis-dev/anydocs-ask/pull/61)）—— γ + curated 路径一直在写 `feedback.session_id` 列；β explicit (`POST /v1/ask/feedback`) 路径不写。修后接受 `session_id` 与 `sessionId` 双别名，空串当 NULL，与 γ 路径列层对齐。

- **Reader 公网 citation 视觉去重（F4-analog）**（PR [#63](https://github.com/cregis-dev/anydocs-ask/pull/63)）—— Console 的 same-page 多 chunk citation 已在 0.1.0 修；Reader 仍是 dogfood 前形态。同步把 `citeSectionLabel()` 移植到 `web-ask.ts`，title 后追加 `· §<sectionLabel>`。

- **Feedback 行的 question 文本回填**（PR [#48](https://github.com/cregis-dev/anydocs-ask/pull/48)）—— 0.1.0–0.2.0-alpha.1 的 feedback 行 question 列总是空字符串；Studio Feedback tab 上线后需要每行可读问句。fix：从 `answers` 表 SELECT question 列；找不到则用请求体 `question` 兜底。

### 删除

- **`clarify.dominantThreshold` / `clarify.ambiguousGap` 配置字段**（PR [#55](https://github.com/cregis-dev/anydocs-ask/pull/55)）—— 自 0.1.0-alpha.0 引入起从未被读取，且与 `aggregate.ts` 内的硬编码 `SUBTREE_DOMINANCE / SUBTREE_SPREAD` 在 eval round-1 之后值已分歧。同步删除 `ClarifyConfig` 类型 / Console Config drawer Clarify 字段组 / ARCH §9 / ask-overview §5.1 指引。无运行时行为变化。

- **`ask.local.json` 4-th source**（PR [#31](https://github.com/cregis-dev/anydocs-ask/pull/31)）—— Console Config drawer 列了 4 个配置源但运行时只读 3 个；移除 UI 上的 4-th 源，等真正接 backend 时一并恢复。

### 文档

- **roadmap 重写为 Studio + 反馈闭环主线**（PR [#43](https://github.com/cregis-dev/anydocs-ask/pull/43)）—— ask-overview / PRD §10 全面对齐；Console Studio 升级为 Journey 6；reranker 加权改"先量再加"三档前置（≥200 反馈 + ≥30 显式负 + shadow ≥ 2 周）。
- **Journey 6 storyboard walkthrough**（PR [#53](https://github.com/cregis-dev/anydocs-ask/pull/53)）—— demo 站完整闭环走通；dogfood-caught 一处 regression 顺手修。
- **dogfood F4/F5 状态同步**（PR [#62](https://github.com/cregis-dev/anydocs-ask/pull/62)）—— `docs/ask-overview.md §5.4` 表格里 F4 / F5 从 🔧 待修 同步为 ✅，跟 dogfood-2026-05-14.md 一致。

### 测试

- 共 ~713 用例（0.1.0 → 0.2.0 累计新增 ~270 个），typecheck + test + build + CI（Node 22 + 24）全过。

### 未变更

- HTTP API 协议向后兼容：`/v1/ask` / `/v1/ask/stream` / `/v1/ask/feedback` 形状不变；新增**可选** `session_id` 字段（不传走单轮）。
- CLI 子命令签名保持不变；新增 `feedback export / import / status` 三个子命令。
- runs.jsonl schema 向后兼容（新增 optional 字段 `session_id` + `answer.history_window`，旧行 absent 视作 null / 单轮）。
- anydocs 主仓 schema 完全不动（PRD §6.5 红线）。

### 已知遗留

- **RFC 0005 alpha.2 未接通**：`citationSemanticCheck.enabled=true` 在本版本无运行时效果（仅 schema + helper 模块）。alpha.2 才挂 pipeline。
- **A+ 失败查询诊断（PRD §11 F2）**：等反馈量 ≥ 50 条 + ≥ 4 周观察。当前 hermes-docs 9 条 β。
- **Reranker A 路径加权**：等 ≥ 200 反馈 + ≥ 30 显式负 + shadow ≥ 2 周（PRD §10.5）。
- **RFC 0004 嵌入式 Widget**：仍 Draft，落地 0.5+。
- **F6 / O1（alpha.3 遗留）**：召回敏感度 / LLM single-call timeout 继续观察。

---

## 0.1.0 — 2026-05-16

毕业 alpha。本版聚焦三件大事：**Ask SSE 流式（token-by-token）** + **控制台重设计** + **项目删除 / Eval 流式进度 / Clarify 可点击建议**。面向作者侧的 Web 控制台、SSE 流式 ask、运行时与 dogfood 通道经过完整迭代；对 `/v1/ask` HTTP API 保持向后兼容（`/v1/ask/stream` 是新增端点）。

### 新增

- **`POST /v1/ask/stream` — Ask SSE 流式**（PR [#27](https://github.com/cregis-dev/anydocs-ask/pull/27)）—— LLM 生成阶段（占 Ask 总延迟 ~80%+）改为逐 token 流式回吐。新增可选 `LLM.streamGenerate()` 兼容 Anthropic SDK 的 `messages.stream`；SSE 加 heartbeat / padding 防 Cloudflare / 反向代理 buffer 小 chunk；新增 BGE-M3 remote host override（HF 环境下载）。共享 `/v1/ask` 的请求解析、runs 落盘与 answer cache 行为；原 `/v1/ask` 行为完全不变。配套新增 `Dockerfile`。`src/server/app.ts` / `src/llm/anthropic.ts` / `src/llm/mock.ts` / `src/llm/types.ts` / `src/query/answer.ts` / `src/embedding/bge-m3.ts` + 304 行新测试 `tests/stream-server.test.ts`。

- **控制台重设计 — design handoff alignment**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— 对齐 `design_handoff_console_redesign` 完整 token 体系：`layout.ts` 重写为设计 token CSS（light + dark via `prefers-color-scheme` AND `[data-theme]`），内联 28 符号 icon sprite，新增 `.modal` / `.menu` / `.banner` / `.empty` / `.kpi` / `.proj-card` / `.drawer` / `.del-*` 等组件。具体页面对齐：
  - **Home**：项目卡网格 + KPI strip + add-project 虚线卡；移除页头 workspace 绝对路径
  - **Project page**：面包屑行整行删除，状态 pill / start / stop / `indexed N pages · M chunks` 全部折叠进 Status 卡
  - **Config drawer**：4 源精确化（`.env` / `.console.json` / `anydocs.ask.json` / `ask.local.json`），`base` / `override` tag 替代 `precedence N`，密文格式改为 `abcd…wxyz`（first4 + … + last4）
  - **Eval tab**：edit-candidate modal 改用共享 `.modal` + `.form-grid`；pending-review 客户端分页 + 流式生成日志（main #14 / #16 的 UI 端整合）
  - **Traffic tab**：run-detail 改为右侧 `.drawer` 滑出 panel（QUESTION / METRICS / ANSWER / RETRIEVAL / CONFIG / ACTIONS），行内 `.sel` 选中态

- **项目删除流**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— 每张项目卡 hover 露出 kebab → popover（`Open project` / `Copy path` / `Remove from console…`）。Remove 打开 `.modal.danger`：目标摘要 + 影响清单 + 输入项目名确认 + `purge_state` 复选框（可选保留 `state/<projectId>/`）。运行中项目切到 `Stop & remove` 路径（先 SIGTERM 子运行时）。后端 `DELETE /api/projects/:name` 扩展 `purge_state` + `force_stop` 查询参数；无 `force_stop` 而对运行中项目 DELETE 返回 409 + `{running:true, port}` 作为防御。源文件路径下的 markdown 永不动。5 个新服务端测试。

- **Eval 流式进度**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— `runEval` 加 `onProgress?(event)` 回调，逐 case 发 `boot · warm · case-start · case-done · done` 事件。新增 `POST /api/projects/:name/eval/stream`（NDJSON），UI `bindEvalRun` 重写驱动真实进度条 + 「case N of M · slug · ~Ns remaining」（per-case 平均时长 × 剩余数 的滑动 ETA），替代旧的「running…」死等。CLI 行为不变（事件是叠加式）。2 个新服务端测试。

- **Clarify 建议可点击**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— `/v1/ask` 早已返回 `options[]`（每个 subtree 一项 `{ scope_id, label, breadcrumb, sample_pages }`），原 UI 只渲染成 bullet。现在每个 option 变成 `.btn` 按钮，点击带 `context.scope_id` 重新发同一问题，子运行时检索约束到该子树（ARCH §11）。`submitAsk()` 加可选 `{ scopeId, scopeLabel }`，状态文案变 `thinking… (scoped to {label})`。零后端修改。

### 修复

- **配置抽屉小标题被截断**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— `WORKSPACE · .env` / `PROJECT · anydocs.ask.json` 超出 `.drawer-sec-hd h3` ellipsis 宽度，渲染成 `PROJECT · …` 无法识别。改为裸文件名 + 设计稿 `base` / `override` tag。补上设计文档列在 precedence 链里但 view model 漏掉的第 4 源 `ask.local.json`。
- **`<html lang="zh">`**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— 控制台 UI 是英文的，HTML lang 错标 zh 会影响可访问性树与搜索索引。改为 `en`。同步把 6 处残留中文空态字符串改为英文（`无 citations` / `index 状态不可用` / `尚无 runs` 等）。
- **`[hidden]` 属性失效**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— `.banner { display: flex }` 与 UA 默认 `[hidden] { display: none }` 同特异性，作者侧后写胜出，导致 `<div class="banner" hidden>` 不隐藏（remove-project 弹窗里 idle 项目误显运行中警告条暴露的）。新增 `[hidden] { display: none !important; }` 全局兜底。

### 删除

- **`open reader / view log` 占位按钮**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— 设计稿假设的 reader UI 在 `anydocs-ask serve` 根路径 `/` 不存在（只挂 `/v1/*`），log tail endpoint 也没做。先移除按钮防误导，相关 CSS（`.status-acts`）/ 图标（`i-ext` / `i-term`）保留待 backend 落地时一行 HTML 重新挂回。
- **页头工作区 / 项目绝对路径**（PR [#28](https://github.com/cregis-dev/anydocs-ask/pull/28)）—— Home 与 Project 页头右槽渲染的 workspace path / project path 属于内部信息，不上 UI。项目路径在 Status 卡内仍可见，符合设计稿。
- **62 行 dead CSS** —— `.page-meta` / `.next-action` / `.btn-primary` 别名 / `.card-bd.tight` / `.kpi.warn/err/muted` / `.retrieval-hd` + `.chunks*` 全工程零引用。

### 测试

- 共 ~715 用例（PR #27 新增 304 行 stream 测试 / PR #28 新增 7 个 DELETE / eval-stream / runs-empty 测试），typecheck + test + build + CI（Node 22 + 24）全过。

### 未变更

- HTTP API 协议向后兼容：原 `/v1/ask` 非流式行为不变，`/v1/ask/stream` 是新增 SSE 端点。CLI 子命令签名（包括 `eval` 的 stdout 报告行）保持不变。

### 已知遗留

- **Eval / Ask cancel 按钮**：UI 未提供取消。后端需要 `AbortSignal` 串到 LLM 调用，跨两个流接口；留至 0.1.1。
- **Reader UI / log tail endpoint**：控制台 Status 卡内对应按钮的 CSS / 图标已就位，等 backend 接入。
- **F6 / O1（alpha.3 dogfood 遗留）**：小流量召回敏感度与 LLM single-call timeout 议题继续观察。

---

## 0.1.0-alpha.3 — 2026-05-14

补丁版本：修复一次完整 dogfood（`anydocs-user-manual`，76 页 zh-default 项目）暴露的 5 个问题。详见 [`docs/dogfood-2026-05-14.md`](./docs/dogfood-2026-05-14.md)。

### 修复

- **`/v1/ask` LLM 抛错时整条 run 丢失（F1）** — LLM 调用中途抛错（网关返回非对象 / 超时 / 上游故障）时，异常直接冒出 `askWithTrace` → Hono 返回 500 → `appendRun()` 永不执行，`runs.jsonl` 丢掉该行。这破坏了 runs.jsonl 作为完整审计日志的契约（ARCH §16.4），且 `analyze runs` D1/D2 看不到 LLM 间歇性失败。现在 LLM 调用包在 try/catch 中，抛错合成 `code='llm_failed'` 错误结果 + 已构建的部分检索 trace（fused / confidence），照常落 runs，HTTP 返回 503（与 `llm_unavailable` 同族）。（PR [#18](https://github.com/cregis-dev/anydocs-ask/pull/18)，`src/query/answer.ts` / `src/server/app.ts`）
- **`golden generate --limit N` 的语言偏置（F2）** — generator 按 `navigationsByLang` 的 Map 枚举顺序逐语言展开后再 `slice`，en 恰好先入 Map → 在 zh-default 项目上 `--limit 30` 产出 30/30 全英文候选。现在 `loadProject()` 读取 `anydocs.config.json#defaultLanguage` 并暴露到 `LoadedProject`；generator 改为 per-lang 收集 + round-robin 交错，`defaultLanguage`（已知时）在每轮先行。`--limit 30` 在 zh-default 双语项目上从 0/30 zh 变为 15/30 zh。（PR [#19](https://github.com/cregis-dev/anydocs-ask/pull/19)，`src/anydocs/loader.ts` / `src/golden/generator.ts`）
- **AnthropicLLM 错误信息不可定位（F3）** — `gateway returned non-object response (...): undefined` 无法区分 401 / 502 / 截断流 / 空 body。新增 `describeNonObject()`（显式 `undefined` / `null` / `string="..."` / `<type>=<json>`，超 ~200B 截断 + `(+NB)` 提示）与 `describeRequestError()`（鸭子类型读取 SDK APIError 的 `status` / `type` / `requestID` / `error` body / `message`，普通 Error 原样透传）。（PR [#21](https://github.com/cregis-dev/anydocs-ask/pull/21)，`src/llm/anthropic.ts`）
- **同页多 chunk 的 citation 视觉重复（F4）** — 检索召回同一页的两个 chunk 时，Ask citations 面板渲染出标题 + 面包屑完全一致的两行，唯一区别 `in_page_path` 藏在标题上方的小号 mono 行里。`renderCitations()` 现在从 `in_page_path`（`<headingId>/p[N]`）提取 section 标签，以次级字重附在标题后：`安装 · 验证-cli-可用` / `安装 · 创建一个文档项目`。（PR [#23](https://github.com/cregis-dev/anydocs-ask/pull/23)，`src/console/pages/project.ts`）
- **Ask 卡停止态标题中英混排（F5）** — PR #13 的 IA 清理把 next-action banner 与 Ask 卡的 body/按钮改为英文，却漏了停止态标题 `项目未启动`。改为 `Project not running`，与同卡内英文文案及 banner 一致。（PR [#24](https://github.com/cregis-dev/anydocs-ask/pull/24)，`src/console/pages/project.ts`）

### 文档

- **`docs/dogfood-2026-05-14.md`** — 完整 dogfood 走查报告：workspace add → start → 首问 → golden → eval → 真实查询 → analyze → 子进程生命周期；6 个 finding + 1 个观察项，含计时表与「已验证无问题」清单。（PR [#20](https://github.com/cregis-dev/anydocs-ask/pull/20) / [#25](https://github.com/cregis-dev/anydocs-ask/pull/25)）
- **`docs/ask-overview.md`** — 新增 ask 操作 / 原理 / 测评 / 优化方向速览 hub；同步修正 ARCHITECTURE.md 的结构重排公式（补 `title_match_boost`、`same_subtree_boost` 同子树语义）与 `answer.confidence` 归一化代理定义的文档漂移。（PR [#22](https://github.com/cregis-dev/anydocs-ask/pull/22)）

### 测试

- 净增 ~16 个用例：`tests/runs-server.test.ts`（LLM 抛错 → 503 + 落 error row + 部分 trace）、`tests/loader.test.ts`（新文件，`defaultLanguage` 读取的 5 种情况）、`tests/golden-generator.test.ts`（round-robin / defaultLanguage 先行 / fallback）、`tests/anthropic.test.ts`（新文件，6 个错误信息用例）、`tests/console-server.test.ts`（BOOTSTRAP_SCRIPT 解析守卫 + citeSectionLabel + 英文标题）。

### 未变更

- HTTP API 协议与 CLI 子命令签名向后兼容。`/v1/ask` 新增的 `llm_failed` 错误码是增量（既有 `invalid_question` / `invalid_scope` / `llm_unavailable` / `warming` 均不变）。

### 已知遗留（observe-only，未在本版处理）

- **F6** — `analyze runs` D1 在 76 页小项目上 9/9 命中召回失败，`confidenceFloor` 在小流量下可能过敏；待真实项目数据攒够后再校准。
- **O1** — LLM 单次调用 timeout ~30s，fallback 路径触发偏慢；考虑加可配置的 `singleCallTimeoutMs`。

---

## 0.1.0-alpha.2 — 2026-05-14

补丁 + 增量：Web 控制台从「能跑」推到「日常 dogfood 入口」，工作区注册表替代 symlink，新增 CI 工作流。

### 新增

- **`workspace add` / `workspace rm` + `projects.json` 注册表** — 替代 `ln -s` 注册项目源码；裸名解析（`anydocs-ask serve my-docs`）先查注册表，再回落路径解析。Web 控制台首页常驻 **Add Project** 表单，提交后写入 `<workspace>/projects.json` 并自动刷新。（PR [#9](https://github.com/cregis-dev/anydocs-ask/pull/9)，`src/workspace.ts` / `src/commands/workspace.ts` / `src/console/server.ts` / `src/console/pages/home.ts`）
- **`workspace init` 写入 `.env` 凭证模板** — `~/anydocs-ask-runtime/.env` 自动生成，提示 (A) `ANTHROPIC_API_KEY` 或 (B) `ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL` 两种写法；新用户不再需要去仓库根目录翻找 `.env.example`。（PR [#9](https://github.com/cregis-dev/anydocs-ask/pull/9)）
- **`.env` 加载链 + 自定义 dotenv 解析** — 新优先级 `<projectRoot>/.env > <workspace>/.env > shell exports`，并替换 `process.loadEnvFile()` 以处理两种实际场景：(a) 全局 shell-rc 中的 `export ANTHROPIC_API_KEY=` 空字符串被视作「已设」而忽略 `.env`，(b) 其他工具（如 Claude Code）的 `ANTHROPIC_BASE_URL` 覆盖 workspace 内的网关配置。`console` 命令分支此前 return 太早未触发加载，一并修复。（PR [#13](https://github.com/cregis-dev/anydocs-ask/pull/13)，`src/cli.ts`）
- **Console: Eval tab 结构化重排（IA cleanup）** — Run eval 按钮上移至 Workshop 之前；合并「Golden 题集」+「Golden Workshop」为单卡 + Approved / Pending review 子标签（默认 Pending）；候选行布局修复（template_id badge 不再溢出覆盖问题标题）；Ask 卡停止态用「▶ Start project」门替代失能 textarea + 按钮；Traffic tab 零运行时改为 dogfood 引导空态；next-action banner 全部改写为 plain English copy。（PR [#13](https://github.com/cregis-dev/anydocs-ask/pull/13)）
- **Console: Golden generate 流式进度 + 默认 LLM rewrite** — 新 `POST /api/projects/:name/golden/generate/stream` 端点输出 NDJSON（`{type:"log",line}` × N + 终止 `{type:"result",...}`）。Console 端默认 `llmRewrite=true` + `fallbackOnLlmError=true`：无凭据 / LLM 失败自动降级为模板候选而非 exit 1，保证一键按钮可用；CLI 保持严格语义（PRD §12.9 验收 #7）。Workshop 卡新增实时 `<pre>` 日志框 + 跑表计时。Actionable error（候选已存在、窗口内无 runs、零候选）通过 reporter 同时回 UI 与 stderr。（PR [#14](https://github.com/cregis-dev/anydocs-ask/pull/14)，`src/console/server.ts` / `src/console/ops.ts` / `src/commands/golden.ts` / `src/golden/llm-rewrite.ts`）
- **Console: Golden Workshop 候选生成上限 / 客户端分页 / 行内编辑模态框** — 「+ from structure」加默认 50（1–500）的 limit 输入；Pending 列表改为服务端全量渲染 + 客户端 20 条/页分页，当前页持久化到 `location.hash`（`#eval?gp=3`）；新增 Edit 模态框直接改 query / lang / context_pageId / filters / tags / expected.* / note，省去下钻 jsonl 编辑器。新增 `POST /api/projects/:name/golden/candidate/update` 端点 + `updateCandidate()` helper。（PR [#16](https://github.com/cregis-dev/anydocs-ask/pull/16)，`src/console/golden-workshop-state.ts` / `src/console/pages/project-eval-tab.ts`）
- **GitHub Actions CI 工作流** — push 到 main 与对 main 的 PR 触发 typecheck / test / build，矩阵覆盖 Node 20 + 22；PR 重提自动取消旧 run（concurrency group）。`packageManager` 字段作为 pnpm 版本单一来源。（PR [#15](https://github.com/cregis-dev/anydocs-ask/pull/15)，`.github/workflows/ci.yml`）
- **`docs/console-redesign-brief.md`** — 411 行控制台视觉/美学重做交付件，覆盖产品上下文、目标用户、25 个 mockup 状态清单、硬技术约束（无构建链、系统字体、内联 SVG）、可复用组件清单与文案准则。（PR [#13](https://github.com/cregis-dev/anydocs-ask/pull/13)）
- **`docs/web-console-usage-guide.md`** — Web 控制台使用指南首版；同步将 README / ARCH 中所有面向作者的描述中文化。

### 修复

- **`fix(console)`: BOOTSTRAP_SCRIPT 模板字面量 `\n` 转义** — `project.ts` 内嵌 `<script type="module">` 来自 TS 模板字面量，`'\n'` 被展开为真实换行导致渲染出的 JS 含未闭合单引号串（`Invalid or unexpected token`），整个模块解析失败 → Eval / Ask / 生命周期按钮全部失效（含 `?autostart=1`）。两处占位转义后恢复。（PR [#16](https://github.com/cregis-dev/anydocs-ask/pull/16)，`src/console/pages/project.ts`）
- **`fix(embedding)`: warmUp 增加 `allowRemoteModels` 保障与失败诊断日志** — 首次运行下载 BGE-M3 失败时给出可定位的错误来源，而非静默卡死。（PR [#12](https://github.com/cregis-dev/anydocs-ask/pull/12)）
- **`fix(console)`: 移除过时的 `projects/` 目录检查** — 配合 `projects.json` 注册表迁移，去除冗余存在性校验。（PR [#11](https://github.com/cregis-dev/anydocs-ask/pull/11)）

### 文档

- README：新用户引导重写（startup 简明且正确）；`<projectRoot>` 两种写法表（裸名 vs 路径）；控制台端口范围说明（4101–4199 保留给子进程，控制台自身落该范围之外）；首次 LLM 候选生成 30–90s 耗时提示。
- ARCHITECTURE §17.5：文档化 Console 端 LLM 自动降级语义。
- 全面中文化面向作者的文档表述。

### 测试

- 5 个新增 console 流式 / golden 命令回归用例（`tests/console-server.test.ts` / `tests/golden-cmd.test.ts`），与既有 384 个用例并行通过。
- `tests/workspace.test.ts` 新增 7 个 `projects.json` 注册表专项用例。
- `tests/next-action.test.ts` 校对新 banner copy。

### 未变更

- HTTP API 协议（`/v1/ask` / `/v1/health` / `/v1/index/status` / `/v1/ask/feedback`）与 CLI 子命令签名向后兼容；CLI `golden generate` 行为保持严格语义（仅 console 端开启自动降级）。

---

## 0.1.0-alpha.1 — 2026-05-11

补丁版本：修复启动评测中发现的若干 bug，并改善文档。

### 修复

- **`llm_unavailable` 错误信息** — 当 `apiKeyEnv` 等于默认值 `ANTHROPIC_API_KEY` 时，错误信息不再重复输出两次变量名（`'ANTHROPIC_API_KEY' / 'ANTHROPIC_API_KEY'`）。自定义 `apiKeyEnv` 现在渲染为 `'MY_KEY (or ANTHROPIC_API_KEY)'`。（`src/llm/factory.ts`）
- **`POST /v1/ask` 字段缺失错误** — 发送 `{"query":"…"}` 而非 `{"question":"…"}` 时，现在返回 `"field 'question' is required"` 而不是含糊的 `"question must not be empty"`，方便接入方自行排查。（`src/query/answer.ts`）
- **`analyze runs` 召回失败数虚高** — 校验 / 客户端错误类型的运行记录（`answer.kind = 'error'`）因 `confidence` 恒为 0 而被误计为召回失败。现在 D1 循环（含 30 秒重问扫描）完全跳过此类记录。（`src/analyze/dimensions.ts`）

### 新增

- **`fixtures/starter-docs/.env.example`** — 最简凭证模板，新用户按「快速上手」操作时无需再去项目根目录寻找 `.env.example`。
- **README 快速上手** — 分步引导（安装 → 配置 → 启动 → 验证 → 提问）、首次运行 BGE-M3 下载提示，以及完整的 `POST /v1/ask` 请求 / 响应契约。
- **测试覆盖** — 新增 `analyze-dimensions` 测试用例：*error kind 且低置信度不触发召回失败计数*。

---

## 0.1.0-alpha.0 — 2026-05-09

首个公开 alpha 版本。`PRD.md` 中定义的 v1 全部功能面已上线——索引 + 查询 + HTTP——以及 §16 评测闭环（golden / eval / runs / analyze）。v1.5 的反馈功能（β/γ 信号、`--from inbox`、analyze D4-D5）将在下一里程碑推进。

### 新增——索引与查询（PRD §1–§8、§13）

- SQLite + sqlite-vec + FTS5 schema，以多语言 `(page_id, lang)` 为复合主键；embedding 缓存以 `(content_hash, model:dtype)` 为键，fp32 / int8 空间不互相污染。
- 从 `pages/{lang}/*.json` + `navigation/{lang}.json` 到扁平 `pages` 表的结构层投影，保留导航顺序、子树根节点和发布状态。拖拽目录重排 ⇒ 不重算任何 embedding。
- 内容层：感知 token 数的分块、通过 `@xenova/transformers` 调用 bge-m3 本地 embedding 并落磁盘缓存。
- 由 `chokidar` 驱动的增量索引管线；三路（page / navigation / config）变更检测，带防抖；§4.6 端到端契约通过。
- 混合召回（向量 + BM25 RRF）+ 结构重排——语言 boost、同子树 boost、导航顺序衰减，以及带影子抑制的**标题匹配 boost**（编辑信号 `Termux 上安装` 优先于 `安装`，当两个标题同时出现时）。
- LLM 答案组装，含引用重编号（后处理后 `[cit_N]` 始终指向 `citations[N-1]`）、代码围栏块的幻觉过滤，以及归一化置信度代理 `top1.final_score / sum(top-5.final_score)`。
- 跨语言降级（PRD §4.8）：同语言 chunk 始终优先，仅当无原生命中时才翻译。

### 新增——HTTP 服务（PRD §10）

- Hono 服务器：`POST /v1/ask`、`GET /v1/index/status`、`GET /v1/health`。
- Anthropic 兼容的 LLM 网关：`authToken` + `baseURL` + `.env` 自动发现，含重试 / 退避策略和 `maxTokens` 预算，可通过 `anydocs.ask.json` 或 `ANTHROPIC_MODEL` 环境变量配置。
- CORS 白名单；默认绑定 `127.0.0.1:3100`（本地优先）。

### 新增——运行时工作区（ARCH §16.1）

- 默认工作区路径 `~/anydocs-ask-runtime/`，可通过 `--workspace` 或 `$ANYDOCS_ASK_WORKSPACE` 覆盖。
- 双根分离（第三次修订）：源项目存放在 `<workspace>/projects/`（路径或软链）；所有运行时数据——`index.db`、`runs/`、`golden/`、`reports/`——存放在 `<workspace>/state/<projectId>/`。源码仓库不受生成数据污染。
- `anydocs-ask workspace init|ls` CLI；裸名称项目参数解析为 `<workspace>/projects/<name>`（一进程一项目仍是 §5.5 硬约束）。

### 新增——评测闭环（ARCH §16.3 / §16.5 / §16.6）

- `golden generate --from structure` — 针对每个导航页面，使用五种模板（`what_is`、`how_to_use`、`compare_siblings`、`how_to_configure`、`caveats`）生成问答候选，可选用 `claude-sonnet-4-6` 将问题改写为自然语言。`must_cite_pages` 是 OR 集合（页面 + 同节兄弟节点，上限 5 个）；`must_contain` 仅在操作类模板中使用，来源于标题关键词。
- `golden generate --from runs`（ARCH §16.5.3）——从高置信度成功运行中挑选回归候选：`confidence ≥ 0.7`、`answer.md ≤ 600 字符`、30 秒内无同 session 重问。聚类近似重复项，与已批准的 case 去重。
- `golden review` — 将 `cases.candidate.jsonl` 中已批准的候选刷入 `cases.jsonl`。
- `eval`（ARCH §16.3.2）— 通过进程内 Runtime 执行已批准的 case，计算三项指标 R@5 / Citation-pass / Answer-rule-pass，在 `<state>/reports/<date>-eval.md` 写入 Markdown 报告，含与上份报告的基线差异对比。
- `runs tail|export` — 对按周切片的 jsonl 文件的只读视图。
- `analyze runs`（ARCH §16.6）— D1 召回失败（低置信度 / 无 citation / 30 秒内重问）、D2 延迟异常（按查询长度和融合 chunk 数分桶）、D3 歧义高发（触发 `subtree_ask` 但 5 分钟内无后续追问）。查询聚类使用编辑距离并查集而非 MinHash——在 v1 流量量级下已够用；MinHash 推迟到 v1.5 待流量规模需要时再引入。

### 冷启动门控

R@5 ≥ 0.70、Citation-pass ≥ 0.65、Answer-rule-pass ≥ 0.60。Hermes-docs 基线（30 个 case）：1.00 / 0.83 / 0.60——三项全部通过。不达标时，ARCH §16.6 引导运营者回到**导航 / 编排检视**，而不是调整召回权重。

### 本版未包含（v1.5+）

- Reader 端 β/γ 反馈采集（PRD §11）
- `golden generate --from inbox`（依赖 §15 收件箱）
- `analyze` 第 4 维（β 负反馈引发的 citation 错配）和第 5 维（跨次重建的 embedding 漂移）
- Web 评测面板（文件优先，v1.5 §11 第 3 条）
- 单进程加载多项目（§5.5 v1 硬约束；推至 v2）
- 跨项目共享 sqlite / runs / golden（v2）
