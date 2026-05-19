# RFC 0003 — 多轮对话 + Session 重写

> Status: Draft (起草中)
> Author: @shawndslee
> Date: 2026-05-20
> 范围版本: `@anydocs/ask` 0.4.x
> 设计依据: [PRD §10.2](../../PRD.md#102-版本路线按时间顺序) / [PRD §10.7](../../PRD.md#107-新增明确不做与-112-红线一致) 第 6 条 / [RFC 0001 §4.1](./0001-feedback-loop-v0.2.md#41-session_id-下发位置)
> 依赖 RFC: 0001（session_id 通道）
> 阻塞 RFC: [0004](./0004-embedded-ask-widget.md)（嵌入式场景必备）

---

## 0. TL;DR

把 RFC 0001 已埋的 `session_id` 通道从"重问检测"扩展到**真正的多轮对话**。引入小模型做 query reformulation，把"它怎么用？"这种依赖上下文的问题重写为独立可检索 query。**优先服务于嵌入式产品 UI 场景**（RFC 0004），不强制 Reader 多轮 UI 改造。

---

## 1. 为什么现在做

### 1.1 嵌入式场景的功能前置

RFC 0004 的嵌入式 Ask Widget 一旦上线，用户在 SaaS 产品 UI 里几乎必然有多轮对话需求（"这个值是什么意思" → "为什么会变" → "怎么改"）。**multi-turn 必须先于嵌入式 Widget 实装**，否则 Widget 发布即破产。

### 1.2 现有 session_id 只埋了通道，未消费

RFC 0001 把 `session_id` 通过响应字段下发 + 客户端 localStorage 维护，但当前消费仅一处：服务端"5min 同 session 重问检测"作为 γ 隐式信号源（RFC 0001 §4.2）。**完整的"用对话历史重写当前 query"路径没接**。

### 1.3 为什么必须用小模型

PRD §10.7 明确"用小模型替代大 LLM 生成最终答案" ❌，但 query 重写是辅助角色，**适合用小模型**：

- 重写是结构化任务（输入：对话历史 + 当前问题；输出：独立 query），4B 量级足够；
- 大模型走 query 重写性价比极差（latency × 2，成本 × 2，对最终答案质量增益边际）；
- 本地小模型可控、可缓存、可离线。

---

## 2. 范围拆分

### 2.1 0.4 in-scope

| # | 项 | 备注 |
|---|---|---|
| M1 | **小模型推理服务集成**（默认 Gemma 3 4B / Qwen2.5 3B 二选一，本地 Ollama 或 SDK 跑） | 部署形态可选：嵌入主进程 / 单独 sidecar |
| M2 | **Query reformulation 模块**：输入 `(session_history, current_question)` → 输出 `independent_question`；调小模型 | 位于 [src/query/](../../src/query/) 新增 `reformulate.ts` |
| M3 | **多轮 fallback 策略**：reformulation 结果 + 原始问题双路检索，结果合并；rewrite 失败不阻塞 | 防止 rewrite 错误放大失败 |
| M4 | **Session 历史管理**：复用 RFC 0001 §4.2 的进程内 Map + TTL 30min；持久化暂不做 | 服务重启清空可接受 |
| M5 | **新接口字段**：`/v1/ask` 响应增加 `reformulated_question?: string` 用于调试与反馈展示 | 不破坏现有 contract |
| M6 | **配置开关**：`anydocs.ask.json` 加 `multiTurn.enabled` / `multiTurn.model`，默认 `enabled: false` | 与 `feedback.enabled` 风格一致 |
| M7 | **Console Studio 集成**（依赖 RFC 0002）：Feedback tab 展示"对话级"分组；同 session 的连续 ask 折叠为一组 | 0.4 在 0.2 Studio 基础上叠加 |

### 2.2 0.4 out-of-scope（→ 0.5+ 或独立 RFC）

| # | 项 | 理由 |
|---|---|---|
| D1 | **Session 持久化**（重启不丢） | 多轮主要发生在嵌入式场景的短时会话；持久化收益小、成本高 |
| D2 | **跨设备 session 同步** | 同上；按需启动独立 RFC |
| D3 | **多轮答案级反馈**（"这一轮答得不好，但上一轮答对了"）| Feedback schema 已留位（session_id），UI 在 0.5+ 评估 |
| D4 | **多轮场景下的 clarify 路径优化** | clarify 当前是单轮设计；多轮下"用户在 clarify 后追问"的行为需要单独建模 |

### 2.3 永不做

- ❌ **强制 anydocs Reader 加多轮 UI**——Reader 多轮场景需求待 anydocs 主仓评估，**ask 工程的 multi-turn 优先服务于嵌入式 Widget**（PRD §10.7 第 6 条）
- ❌ **把对话历史直接拼到 prompt 里给大模型**——会爆 context、灌入噪声、放大 hallucination；必须先 reformulate 成独立 query
- ❌ **小模型替代大模型生成答案**（PRD §10.7 末条）

---

## 3. 实现里程碑

```
0.4.0-alpha.0 (≈ 2026-07-04)  M1 小模型推理服务集成 (Ollama / 本地 SDK)         基础设施
0.4.0-alpha.1 (≈ 2026-07-11)  M2 + M3 reformulation 模块 + fallback             核心
0.4.0-alpha.2 (≈ 2026-07-18)  M4 + M5 + M6 session 管理 + 接口 + 配置开关        管道
0.4.0         (≈ 2026-07-25)  M7 Console 集成 + 整体回归 + 嵌入式联调            交付
```

阻塞条件：RFC 0001 的 `session_id` 通道（S5）必须在 0.2.0 已 release。

---

## 4. 设计要点

### 4.1 Reformulation prompt 设计

```
你是问题重写助手。把"当前问题"结合"对话历史"重写为一个独立、自包含、可被检索系统检索的问题。

约束：
- 保留原问题的实体、动词、限定语
- 用对话历史中的指代对象替换代词（"它/这个/那个"）
- 不要添加未在对话中出现的信息
- 不要回答问题
- 输出仅一行重写后的问题

对话历史（最近 3 轮）：
{history}

当前问题：{current_question}

重写后：
```

约束输出长度 ≤ 200 字符；超时 2s 即放弃 reformulation，走原始 query。

### 4.2 双路检索 fallback（M3）

```
flow:
  reformulated_q = small_model.reformulate(history, current_q)   # 可能 null / timeout

  if reformulated_q and reformulated_q != current_q:
    chunks_a = retrieve(reformulated_q)
    chunks_b = retrieve(current_q)
    fused = RRF([chunks_a, chunks_b], k=60)
  else:
    fused = retrieve(current_q)
```

理由：现有 RRF 框架天然适合融合多个 query 路径；reformulation 错了不会"覆盖"原 query 的命中。

### 4.3 Session 历史窗口

- TTL：30min（与 RFC 0001 §4.2 一致）
- 窗口长度：reformulation 时只看**最近 3 轮**（更长上下文对小模型造成噪声）
- 截断策略：每轮保留 question + 答案前 200 字符（不传完整 markdown）

### 4.4 性能预算

| 阶段 | 预算 | 备注 |
|---|---|---|
| reformulation 推理 | ≤ 500ms（CPU）/ ≤ 150ms（GPU） | 超时即降级到原 query |
| 双路检索 | 复用现有 retrieval，并行执行 | 不增加总耗时 |
| 总额外延迟（warm） | ≤ 500ms（P95） | 满足 PRD §6.1 ≤ 8s P95 不破 |

---

## 5. 决策记录（2026-05-20 锁定）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 小模型部署形态：嵌入主进程 vs sidecar | **可配置，默认 Ollama sidecar**。Ollama 已有成熟运行时；嵌入主进程会增加冷启动 + 内存压力 |
| Q2 | reformulation 必走 vs 触发条件 | **必走**（仅当 session 有 ≥ 1 轮历史）；不做"判断是否需要重写"，简化设计 |
| Q3 | 重写失败/超时如何回退 | **静默回退到原 query**，trace 记录 `reformulation_skipped=true` |
| Q4 | reformulated_question 是否回写 feedback 表 | **是**。作为反馈数据的额外字段，便于诊断"重写错误"导致的失败 query |
| Q5 | 是否在 Reader 默认启用 | **否**。默认 `multiTurn.enabled=false`；Reader 多轮在 anydocs 主仓单独评估，本仓不强推 |
| Q6 | 是否允许用大模型做 reformulation（绕过小模型依赖） | **允许但不推荐**：`multiTurn.model='primary'` 选项保留，仅供"小模型不可用 + 必须开多轮"的紧急场景 |

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 小模型推理服务部署增加运维复杂度 | 默认 Ollama，文档化一键启动；`enabled=false` 时零依赖 |
| reformulation 错误放大失败率 | M3 双路 fallback + trace 可观测；Studio 内可看到"重写前 vs 重写后"对比 |
| 小模型质量不达预期（4B 模型重写漂移） | RFC 阶段先 benchmark：Gemma 3 4B / Qwen2.5 3B / Phi-3 mini，选最稳的；预留模型替换接口 |
| 性能不达 P95 ≤ 8s | M3 双路并行 + 超时回退；性能预算明确写入 §4.4 |
| 嵌入式 Widget（RFC 0004）排期变化 | 本 RFC 不强依赖 0004 落地时间；多轮独立可用（CLI / API 直接测） |

---

## 7. 与其他 RFC 的关系

| RFC | 关系 |
|---|---|
| [0001](./0001-feedback-loop-v0.2.md) | 复用 `session_id` 通道；reformulated_question 写入 feedback 表（trace 字段） |
| [0002](./0002-console-studio-feedback-loop.md) | Studio Feedback tab 在 0.4 后展示"对话级"分组 |
| [0004](./0004-embedded-ask-widget.md) | **强阻塞**——Widget 上线前必须有多轮 |
| [0005](./0005-citation-semantic-validation.md) | 小模型推理服务复用（同一 Ollama / SDK 实例） |

---

## 8. 未涉及

- Reader 站点多轮 UI（输入框历史、对话气泡）——anydocs 主仓评估，与本 RFC 解耦
- 多轮场景下的隐私边界——嵌入式场景的数据上下文注入由 RFC 0004 处理
- 长 session（超过 30min）的 summarization——0.5+ 视真实使用模式决定

---

## 9. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-20 | 起草 | @shawndslee |
