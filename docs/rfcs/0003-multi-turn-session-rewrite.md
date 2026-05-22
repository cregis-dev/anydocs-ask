# RFC 0003 — 多轮对话 + Session（B.2：大模型一次消化）

> Status: Accepted（实施中，2026-05-21 方向切换到 B.2 大模型一次消化路径）
> Author: @shawndslee
> Date: 2026-05-20（Accepted 于 2026-05-21；方向修订 2026-05-21）
> 范围版本: `@anydocs/ask` 0.4.x
> 设计依据: [PRD §10.2](../../PRD.md#102-版本路线按时间顺序) / [PRD §10.7](../../PRD.md#107-新增明确不做与-112-红线一致) 第 6 条 / [RFC 0001 §4.1](./0001-feedback-loop-v0.2.md#41-session_id-下发位置)
> 依赖 RFC: 0001（session_id 通道，已在 0.1.x 落地）
> 阻塞 RFC: [0004](./0004-embedded-ask-widget.md)（嵌入式场景必备）

---

## 0. TL;DR

把 RFC 0001 已埋的 `session_id` 通道扩展到真正的多轮对话。**B.2 路径**：把最近 N 轮 history 拼进**现有大模型**的 prompt（system + history + 检索 chunks + current_q），由 Claude 在同一次 LLM 调用里完成代词消解 + 答案生成。同时把 history 拼进 embedding query，让检索召回也吃到上下文语义。

**不引入小模型、不增 LLM 调用次数、不增运行时依赖。** 配置只暴露两个字段（`enabled` + `historyTurns`）。

---

## 1. 为什么现在做

### 1.1 嵌入式场景的功能前置

RFC 0004 的嵌入式 Ask Widget 一旦上线，用户在 SaaS 产品 UI 里几乎必然有多轮对话需求（"这个值是什么意思" → "为什么会变" → "怎么改"）。**multi-turn 必须先于嵌入式 Widget 实装**，否则 Widget 发布即破产。

### 1.2 现有 session_id 只埋了通道，未消费

RFC 0001 把 `session_id` 通过响应字段下发 + 客户端 localStorage 维护，但当前消费仅一处：服务端"5min 同 session 重问检测"作为 γ 隐式信号源（RFC 0001 §4.2）。**完整的"用对话历史改善检索 + 让大模型理解代词"路径没接**。

### 1.3 为什么走"大模型一次消化"而不是小模型 reformulation

2026-05-21 alpha.0 预演 smoke 在用户本地（LM Studio + MLX + 多个小模型）跑了 4 模型 × 4 场景的真实验证。核心数据见 **Appendix A**。要点：

- thinking 系小模型（Gemma 3n / Qwen3 默认）reformulation 耗时 **30s**，直接破多轮 P95 ≤ 8s 预算
- non-thinking 4B 小模型最快路径仅 **315ms**（warm），但 1/4 场景出现严重信息泄漏（把整段 history 答案拼进新 query）
- 0.6B 量级要么不会重写、要么泄漏，capacity 不足
- 即便选对 3–4B non-thinking 模型，仍需 post-validation 校验 + 双路 RRF 兜底，工程复杂且不可信

**B.2 路径同时避开三层负担**：

| 方案 A（小模型 reformulation） | 方案 B.2（大模型一次消化） |
|---|---|
| 作者必须跑外部运行时（LM Studio / Ollama） | 复用现有 Anthropic / OpenAI 通道 |
| reformulation 阶段约 30% 翻车风险（实测 1/4 场景）| Claude 多轮指代消解经验值翻车率 < 5% |
| 必须做 post-validation + 双路 RRF 兜底 | 失败模式由 Claude 自身 + system prompt 约束自然解决 |
| 单次 ask 多 1 次小模型调用 | LLM 调用次数不变 |
| 工程上要新增 OpenAI-compatible 客户端 + reformulate.ts + 双路 fusion + 校验层 | 工程上仅 prompt.ts 增量 + 检索 query 拼接 + session 窗口管理 |

代价：每次开启多轮的 ask 输入端多约 1–2k token（3 轮 history + 截断摘要）。Claude Sonnet 4.6 input 价 $3/M token；design partner 量级（< 100 query/天）成本 < $1/天，可接受。

---

## 2. 范围拆分

### 2.1 0.4 in-scope

| # | 项 | 备注 |
|---|---|---|
| M1 | **History-aware retrieve query 构造** | 检索阶段：embedding query = `history.join() + current_q`（让向量空间吃到上下文语义）；BM25 query = `current_q`（避免老词稀释关键词信号）。同一路 RRF 融合，不引双路 |
| M2 | **Multi-turn system prompt** | system 段加多轮约束（§4.1）；user 段格式：history（截断后）+ 检索 chunks + current_q；改动集中在 [src/query/prompt.ts](../../src/query/prompt.ts) |
| M3 | **Session 历史窗口管理** | 复用 RFC 0001 §4.2 进程内 Map + TTL 30min；每轮持久化 `question + answer_md 前 200 字`；超窗丢弃，不做摘要压缩 |
| M4 | **新接口字段** | `/v1/ask` 响应增加 `history_window?: number`（本次用了几轮历史，便于 Studio 与 trace 展示）；不破坏现有 contract |
| M5 | **配置开关** | `anydocs.ask.json` 加 `multiTurn.enabled`（默认 false）/ `multiTurn.historyTurns`（默认 3）；与 `feedback.enabled` 风格一致 |
| M6 | **Console Studio 集成**（依赖 RFC 0002）| Feedback tab 展示"对话级"分组；同 session 连续 ask 折叠为一组 |

### 2.2 0.4 out-of-scope（→ 0.5+ 或独立 RFC）

| # | 项 | 理由 |
|---|---|---|
| D1 | **Session 持久化**（重启不丢） | 多轮主要发生在嵌入式场景的短时会话；持久化收益小、成本高 |
| D2 | **跨设备 session 同步** | 同上；按需启动独立 RFC |
| D3 | **多轮答案级反馈**（"这一轮答得不好，但上一轮答对了"）| Feedback schema 已留位（session_id），UI 在 0.5+ 评估 |
| D4 | **多轮场景下的 clarify 路径优化** | clarify 当前是单轮设计；B.2 把 history 进 embedding query 已经顺带改善多轮 clarify 决策，进一步优化等真实数据 |
| D5 | **长 session（> historyTurns 轮）摘要压缩** | 0.4 直接丢弃超窗轮；摘要压缩需独立设计，0.5+ 视真实使用模式决定 |

### 2.3 永不做

- ❌ **强制 anydocs Reader 加多轮 UI** —— Reader 多轮场景需求待 anydocs 主仓评估，ask 工程的 multi-turn 优先服务于嵌入式 Widget（PRD §10.7 第 6 条）
- ❌ **把对话历史"裸"拼到大模型 prompt**（不截断、不约束、不限轮数）—— 会爆 context、稀释 current_q 信号、放大 hallucination。B.2 拼接是**有约束 + 严格截断 + 默认 3 轮**的受控注入，与"裸拼"是两件事
- ❌ **小模型替代大模型生成答案**（PRD §10.7 末条）

> 历史注：本 RFC 2026-05-20 起草版本曾写"永不把历史拼到大模型"，2026-05-21 smoke 实证后修订为"永不**裸**拼"——带截断与约束的 history 注入是 B.2 主路径。

---

## 3. 实现里程碑

```
0.4.0-alpha.0  M1 history-aware retrieve query + 起步联调            基础设施
0.4.0-alpha.1  M2 multi-turn system prompt + 试运行                  核心
0.4.0-alpha.2  M3 + M4 + M5 session 窗口 + 接口字段 + 配置开关        管道
0.4.0          M6 Console Studio 集成 + 整体回归 + 嵌入式联调         交付
```

里程碑顺序锁定；**绝对日期在 alpha.0 启动时锚定**（方向已在 2026-05-21 拍板，并行 0.2 收尾推进，不预设硬截止）。

阻塞条件：~~RFC 0001 的 `session_id` 通道（S5）必须在 0.2.0 已 release~~ —— **已满足**。session_id 通道在 0.1.x 已埋（请求侧 [src/server/app.ts](../../src/server/app.ts) 接收、γ session table [src/feedback/gamma.ts](../../src/feedback/gamma.ts) 下发、Reader 客户端 [src/server/web-ask.ts](../../src/server/web-ask.ts) 持有 + localStorage 重连）。

---

## 4. 设计要点

### 4.1 Multi-turn system prompt 增量

在现有 system prompt 之上追加：

```
本次问题可能依赖前面的对话。下方"对话历史"段提供最近 N 轮的问题与答案摘要，
仅用于解析代词（它/这个/那个/那）和未明确说出的实体。

约束：
- 把当前问题里的指代解析为对话历史中最贴近的具体实体
- 答案必须基于检索到的 chunks（既有引用约束完全不变）
- 不要在答案里重述历史里已答过的内容
- 如果对话历史与当前问题语义无关，忽略历史，按单轮处理
- 答案语言与"当前问题"一致
```

user 消息格式：

```
对话历史（最近 N 轮，每轮答案截断到前 200 字）：
Q1: ...
A1: ...
Q2: ...
A2: ...

检索证据（chunks）：
[cit_1] ...
[cit_2] ...

当前问题：{current_q}
```

历史段为空（首次 ask 或 session 过期）时整段省略，等同单轮。

### 4.2 History-aware retrieve query 构造（M1）

```
embedding query = `${history_questions.join('\n')}\n${current_q}`   # 拼最近 N 轮 question
bm25 query       = `${current_q}`                                    # 不拼历史，避免老词稀释
chunks           = RRF([vec_retrieve(embedding_query), bm25_retrieve(bm25_query)])
```

理由：

- **embedding 路**吃语义，history 拼进去让向量空间投影包含"上下文 anchor"，多轮代词查询（"它怎么改？"）自然命中正确子树
- **BM25 路**是关键词 / TF-IDF 匹配，拼老问题的词会稀释当前问题关键词信号
- **RRF 融合层不变**，沿用单轮路径的 k=60；不引入"双路"概念

### 4.3 Session 历史窗口

- TTL：30min（与 RFC 0001 §4.2 一致）
- 窗口长度：默认 3，可配（`multiTurn.historyTurns`，范围 [1, 20]）
- 截断策略：每轮保留 `question` + `answer_md` 前 200 字符（不传完整 markdown）
- 超窗策略：> historyTurns 轮的旧记录直接丢弃，**不做摘要压缩**（0.4 不做，留 0.5+ D5）
- 持久化：进程内 Map，服务重启即清空（与 RFC 0001 §4.2 一致；接受）

### 4.4 性能预算

| 阶段 | 预算 | 备注 |
|---|---|---|
| Session 历史查询 | < 5ms | 进程内 Map lookup |
| Embedding query 输入扩展 | input tokens ≤ 1.5× 单轮 | history N=3 × ~50 字 + current_q |
| Retrieve / Rerank / Aggregate | 不变 | 完全复用单轮路径 |
| LLM input token | +1–2k token（3 轮历史 + 截断答案） | Claude Sonnet 4.6 input $3/M → +$0.003–0.006/query |
| LLM TTFT 增加 | +100–300ms | input 多 → prefill 略长；Claude 内置 prefix cache 在同 session 内有效缓解 |
| 总额外延迟（warm） | ≤ 500ms P95 | 满足 PRD §6.1 ≤ 8s P95 不破 |

实测 baseline 待 alpha.0 实装后回填。

### 4.5 失败模式与自然降级

不同于方案 A 需要 post-validation 拦截 reformulation 翻车，B.2 的失败模式都由 Claude 自身 + system prompt 约束自然解决：

| 场景 | 行为 |
|---|---|
| history 与当前问题无关（用户切话题） | system prompt 第 4 条要求 Claude 忽略历史；自然按单轮答 |
| chunks 不够 | 走现有 no_citations / clarify 路径，与单轮一致 |
| Session 过期 / 首次 ask | history 为空，整段省略 → 自动退化为单轮 |
| session_id 丢失（Reader localStorage 清空） | 同上 |
| Claude 答案语言切换错误（如把中文问题答成英文） | 现有 PRD §4.8 cross-lang fallback 机制 + system prompt 显式约束语言 |

**无需新增校验代码**——B.2 把"是否消费 history"的判断交给大模型，比方案 A 的"信号字符串校验"更稳健。

---

## 5. 决策记录

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 用小模型 reformulation 还是大模型一次消化？ | **大模型一次消化（B.2）**，2026-05-21 锁定。依据：smoke 数据（Appendix A）+ 工程简化 + 零依赖 |
| Q2 | history 是否在 retrieve 阶段消费？ | **是**。embedding query 拼 history（吃语义），BM25 不拼（保关键词焦点）。同一路 RRF |
| Q3 | history 截断到多少字 | 每轮保留 question + answer_md **前 200 字**。避免整 markdown 拼入造成 token 爆炸 |
| Q4 | history 是否回写 feedback 表 | **否**。feedback 仍以 session_id 为关联键；history 是 prompt-time 临时拼装，trace 里记 `history_window=N` 即可 |
| Q5 | Reader 默认启用？ | **否**。默认 `multiTurn.enabled=false`；Reader 多轮 UI 在 anydocs 主仓单独评估 |

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| Claude input token 增长 50–80%（每轮 ask） | design partner 量级（< 100 query/天）成本 < $1/天；高量场景在 README / config 文档化"history 进 prompt 的 token 影响" |
| Claude 对长 history 注意力分散 | system prompt 第 1/4 条显式约束 + history 严格截断 200 字/轮 + 默认窗口 3 轮 |
| Session table 重启清空 | 设计接受（§2.2 D1 永不持久化）；Reader 客户端 localStorage 持久化 session_id，server 端 history 丢就自然退化为单轮 |
| 多语言追问（zh ↔ en 跨语言）破坏检索 | 现有 PRD §4.8 cross-lang fallback 不变；BM25 路用 current_q 保关键词 |
| 用户切话题但 history 仍在窗口内 | Claude 按 system prompt 第 4 条忽略 history；session 自然过期清空 |
| 嵌入式 Widget（RFC 0004）排期变化 | 本 RFC 不强依赖 0004 落地时间；多轮独立可用（CLI / API 直接测） |

---

## 7. 与其他 RFC 的关系

| RFC | 关系 |
|---|---|
| [0001](./0001-feedback-loop-v0.2.md) | 复用 `session_id` 通道；trace 字段加 `history_window=N`（不入 feedback 表） |
| [0002](./0002-console-studio-feedback-loop.md) | Studio Feedback tab 在 0.4 后展示"对话级"分组；同 session 连续 ask 折叠 |
| [0004](./0004-embedded-ask-widget.md) | **强阻塞** —— Widget 上线前必须有多轮 |
| [0005](./0005-citation-semantic-validation.md) | citation 语义验证在多轮路径上同样工作；不复用任何"小模型"实例（B.2 没有）|

---

## 8. 未涉及

- Reader 站点多轮 UI（输入框历史、对话气泡）—— anydocs 主仓评估，与本 RFC 解耦
- 多轮场景下的隐私边界 —— 嵌入式场景的数据上下文注入由 RFC 0004 处理
- 长 session（超过 30min 或超过 historyTurns 轮）的 summarization —— 0.5+ 视真实使用模式决定（§2.2 D5）

---

## 9. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-20 | 起草（方案 A：小模型 reformulation pipeline）| @shawndslee |
| 2026-05-21 | Status → Accepted；提前于原 0.4 计划启动，与 0.2 收尾并行；阻塞条件标"已满足"；§3 移除绝对日期改为顺序锁定 + alpha.0 启动时锚定 | @shawndslee |
| 2026-05-21 | 方案 A 范围内 schema 修正：小模型运行时由作者自选（OpenAI-compatible 端点）；删除 §5 Q6 primary fallback | @shawndslee |
| 2026-05-21 | alpha.0 预演 smoke 写回 RFC：4 模型 × 4 场景实测 → 发现 4B non-thinking 翻车率 25%、thinking 模型完全不可用、§4.1 prompt 约束依靠 alignment 不可靠 | @shawndslee |
| 2026-05-21 | **方向修订：方案 A → 方案 B.2 大模型一次消化**。删除小模型 reformulation pipeline / OpenAI-compatible 客户端 / 双路 RRF / post-validation / 运行时准备示例；schema 简化为 `enabled` + `historyTurns` 两字段；§2.3 第 2 条改为禁止"裸拼"而非禁止"拼"；新增 Appendix A 保留 smoke 实证依据 | @shawndslee |
| 2026-05-22 | alpha.0 M1 落地（PR #57）：history-aware retrieve query 接通；`context.history` 仅承载 question 串，BM25 / entity injection 保持单轮 | @shawndslee |
| 2026-05-22 | **alpha.1 落地 M2+M3+M4 + 默认 flip**：M2 system prompt 加 5 条多轮约束 + user prompt 加"对话历史"段；M3 SessionEntry 增 `answer_md_summary`（200 字截断）；M4 `AskAnswer.history_window` 接口字段 + runs.jsonl 透出；`multiTurn.enabled` 默认 `false → true`。同步把 γ 相似度比较的 vector 与 retrieve vector 拆开（避免 multi-turn 注入污染 γ implicit-negative 信号）— 多算一次 raw question embedding，每轮多轮 ask cost +1 embed 调用 | @shawndslee |
| 2026-05-22 | **M6 落地（Console Studio 对话级分组）**：Feedback tab snapshot 引入 sessionId/historyWindow/turnIndex/sessionTurnCount 维度（runs.jsonl JOIN 兜底 β 行的空 session_id 列）；SSR + 内嵌 JS 双路径把连续同 session 行折叠成一个 dialogue 块，行内带 `T<N>/<M>` 徽章，header 带 history_window 标签；drawer 增 SESSION 段，列同 session 其它 turn 并支持 jump。RFC 0003 0.4 in-scope 全部接通；后续 M5 配置开关 + Reader 暴露归到 0.4 release 收尾 | @shawndslee |

---

## Appendix A — 2026-05-21 小模型 reformulation smoke 实证（B.2 决策依据）

为决定 RFC 0003 走"小模型 reformulation pipeline（方案 A）"还是"大模型一次消化（方案 B.2）"，在用户本地（LM Studio 0.3 / Apple Silicon + MLX）跑了 4 模型 × 4 场景 smoke。脚本临时写就（已废弃），数据如下：

| 模型 | thinking | scenario | elapsed_ms | 重写质量 |
|---|---|---|---|---|
| Gemma 3n E4B (`google/gemma-4-e4b`) | on（不可关）| zh | **29960** | ✅ 完美：`如何安装 LM Studio？` |
| Qwen3 0.6B | on | zh | 1778 | ⚠️ 信息泄漏：`如何在LM Studio中配置或安装其端点服务？`（拼了 history 里的"端点"）|
| Qwen3 0.6B | off (`/no_think`) | zh | **189** | ❌ 未重写（复读原句）|
| Qwen3-4B-Instruct-2507-MLX | off（model 自身 non-thinking）| zh cold | 1380 | ✅ `怎么安装 LM Studio？` |
| Qwen3-4B-Instruct-2507-MLX | off | zh **warm** | **315** | ✅ 同上（prefix cache 4.4× 加速）|
| Qwen3-4B-Instruct-2507-MLX | off | en | 986 | ❌ **严重信息泄漏**：`How do I install the multi-turn feature that requires a local model and points to an OpenAI-compatible runtime like LM Studio, Ollama, or vLLM?`（35 token vs 原句 6 token）|
| Qwen3-4B-Instruct-2507-MLX | off | product | 421 | ✅ `And what about the size of run logs?`（解 "that/size" → "run logs"）|

**五条核心发现**：

1. **thinking 系小模型完全不可用** —— reformulation 是 200→20 token 任务，thinking 把它跑成 30s
2. **0.6B 量级 capacity 不足** —— thinking off 复读、thinking on 信息泄漏
3. **3–4B non-thinking instruction-tuned 是底线** —— Qwen2.5-3B-Instruct / Qwen3-4B-Instruct-2507（注意 `-Instruct-2507` 后缀是 Qwen3 系列里**非 thinking** 变体）/ Gemma-3-4B-IT
4. **本地推理引擎 prefix cache 极有效** —— cold 1380ms → warm 315ms（4.4× 加速）
5. **prompt 约束"不要添加未在对话中出现的信息"依靠 model alignment 不可靠** —— 同一模型在 4 个场景里 1 个翻车（en 场景把 history 答案整段拼进 query）。这意味着即使选对模型，方案 A 仍需 post-validation + 双路 RRF 兜底，工程复杂度高

**结论**：投入"OpenAI-compatible 客户端 + reformulate.ts + 双路 fusion + post-validation 校验层"的工程没有性价比。Claude 在多轮指代消解上质量远高于 4B 小模型，且复用现有 LLM 通道**零额外依赖、零额外 LLM 调用次数**。
