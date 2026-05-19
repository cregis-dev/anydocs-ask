# RFC 0005 — Citation 语义校验（小模型层）

> Status: Draft (起草中)
> Author: @shawndslee
> Date: 2026-05-20
> 范围版本: `@anydocs/ask` 0.3.x
> 设计依据: [PRD §10.3](../../PRD.md#103-03-启动阈值拆分) Citation 语义校验项 / [PRD §10.7](../../PRD.md#107-新增明确不做与-112-红线一致) 末条
> 关联代码: [src/query/postprocess.ts](../../src/query/postprocess.ts)

---

## 0. TL;DR

当前 [postprocess](../../src/query/postprocess.ts) 用字符串/词项级匹配判断 `[cit_N]` 标记是否对应 chunk，**只看"用了几个"，不看"用得对不对"**。引入小模型对每个 citation 做语义级校验，区分"无引用"和"引用了但引错"。**0.3 起 shadow 模式上线**（采集信号、不阻塞）；**0.4 视数据决定是否升级为硬门槛**。无反馈样本量门槛。

---

## 1. 为什么现在做

### 1.1 现状盲区

[answer.ts](../../src/query/answer.ts) `MAX_CITATION_RETRIES=2` 的重试逻辑只看 `used_chunks > 0`，即"答案中至少出现一个有效 `[cit_N]` 标记"。问题：

- **场景 A**（已捕获）：答案纯文本无 cit 标记 → `no_citations` → 重试或拒答。✓
- **场景 B**（未捕获）：答案有 cit 标记，但**标记位置的句子和 chunk 内容不对应**。例如 chunk 在讲 X，答案在讲 Y 但末尾标了 `[cit_2]`（指向 X chunk）。

场景 B 在 [postprocess](../../src/query/postprocess.ts) 当前的"hallucination 过滤"（基于关键词重合）层面只能粗判，遗漏率高。后果：

- **用户体验**：表面看引用齐全，实际链接到错的文档段；
- **反馈数据质量**：design partner 点 👎 的 query 在分析时被误判为"答案有引用，confidence 高"，**0.3 A+ 诊断（PRD §11 F2）会误判失败原因**。

### 1.2 为什么独立于其他 RFC

- **不依赖反馈数据**：是事后校验，本身不需要先有 feedback 量；
- **不依赖多轮**：单轮 / 多轮场景都有此需求；
- **不依赖嵌入式**：是 ask 工程本体的精度增强。

因此**可与 RFC 0002 Studio、RFC 0003 多轮并行推进**，0.3 完成 shadow 模式即可。

---

## 2. 范围拆分

### 2.1 0.3 in-scope（shadow 模式）

| # | 项 | 备注 |
|---|---|---|
| V1 | **小模型推理服务接入**：若 RFC 0003 已部署 Ollama / 本地 SDK，直接复用；否则本 RFC 单独部署 | 优先复用 |
| V2 | **Citation 校验模块**：输入 `(cit_id, claim_sentence, chunk_text)` → 输出 `supports / partially / not_supports + reason`；批量评估一次答案的所有 citations | [src/query/](../../src/query/) 新增 `citation-validator.ts` |
| V3 | **Postprocess 集成（shadow 模式）**：现有 [postprocess](../../src/query/postprocess.ts) 流程保持不变；新增校验结果作为 trace 字段写入 [runs.jsonl](../../src/server/app.ts) | **不阻塞答案返回** |
| V4 | **Trace 扩展**：每个 citation 增加 `semantic_check: { verdict, reason, model }` 字段 | RunRecord schema 扩展 |
| V5 | **Console Studio 展示（依赖 RFC 0002）**：Feedback tab 抽屉中显示语义校验结果；列表中可筛选"语义校验失败"类别 | 0.3 Studio 已存在时叠加 |
| V6 | **配置开关**：`anydocs.ask.json` 加 `citation.semanticCheck.enabled`，默认 `false`；启用后异步执行（不阻 latency） | 与 `feedback.enabled` 一致 |

### 2.2 0.4 候选 in-scope（视 0.3 shadow 数据）

| # | 项 | 触发条件 |
|---|---|---|
| H1 | 升级为硬门槛：语义校验失败 → 触发 citation reinforcement 重试 | 0.3 shadow 数据显示**≥ 10% 的答案有语义校验失败但被现有 postprocess 通过**，且小模型校验**误报率 ≤ 5%** |
| H2 | 校验失败时返回错误码 `citation_mismatch`（与 `no_citations` 并列） | 同上 |
| H3 | A+ 诊断（PRD §11 F2）消费语义校验失败信号 | 自然延伸 |

### 2.3 永不做

- ❌ **用小模型校验代替大模型重新生成答案**——校验是"评判"角色，不参与生成
- ❌ **校验失败即抛弃整个答案**（即使升级为硬门槛后也保留至少一次重试 + 降级返回）
- ❌ **校验过程依赖外部 SaaS API**——本 RFC 默认本地推理（与 PRD §10.4 数据本地优先原则一致）

---

## 3. 实现里程碑

```
0.3.0-alpha.0 (≈ 2026-06-13)  V1 小模型服务接入 / 复用                            基础设施
0.3.0-alpha.1 (≈ 2026-06-20)  V2 校验模块 + V4 trace 扩展                          核心
0.3.0-alpha.2 (≈ 2026-06-27)  V3 shadow 集成 + V6 配置开关                         可发布
0.3.0         (≈ 2026-07-04)  V5 Studio 展示（如 RFC 0002 已就绪） + 整体回归       交付
```

如 RFC 0003（多轮）先发布并部署了 Ollama，本 RFC V1 直接复用，alpha.0 可压缩 ≥ 3 天。

---

## 4. 设计要点

### 4.1 校验 prompt 设计

```
你是引用校验助手。判断"答案句子"是否能由"文档片段"语义支撑。

输出格式（严格 JSON）：
{ "verdict": "supports" | "partially" | "not_supports", "reason": "...一句话..." }

判断准则：
- supports: 答案句子的每个事实点都能在文档片段里找到对应
- partially: 大部分能找到，但有 1 个事实点缺失或偏差
- not_supports: 关键事实点找不到，或片段在讲另一件事

答案句子：{claim_sentence}

文档片段：{chunk_text}

输出：
```

输出长度限制：reason ≤ 100 字符。

### 4.2 性能与异步策略

| 选项 | latency | 答案体验 |
|---|---|---|
| 同步校验（V3 之前的方案）| 答案后多 1-3s | 阻塞，影响 P95 |
| **异步校验（V3 默认）** | 答案立即返回；校验结果 fire-and-forget 写入 runs.jsonl | 不阻塞 |
| 同步硬门槛（H1）| 答案后多 1-3s | 仅校验失败重试时阻塞 |

**0.3 默认异步**——校验只用于事后分析与 Studio 展示，不影响用户感知延迟。

### 4.3 批量调用

一个答案通常 3-8 个 citations。批量构造 prompt（每个 citation 一行）→ 小模型批量输出 JSONL，一次推理覆盖整答案。Gemma 3 4B 量级 ≤ 1.5s 完成。

### 4.4 Schema 扩展

`RunRecord.answer.citations[i]` 新增：

```ts
{
  citation_id: 'cit_1',
  chunk_id: '...',
  // ... 原有字段
  semantic_check?: {
    verdict: 'supports' | 'partially' | 'not_supports',
    reason: string,
    model: string,            // e.g. 'gemma-3-4b'
    checked_at: ISO8601,
    latency_ms: number,
  }
}
```

`semantic_check` 可选——`enabled=false` 时不存在；异步任务失败时也不存在（不影响主答案）。

---

## 5. 决策记录（2026-05-20 锁定）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | shadow vs 硬门槛 | **0.3 shadow only**；H1 升级需 0.3 shadow 数据满足 §2.2 条件 |
| Q2 | 异步 vs 同步 | **异步**（§4.2）；硬门槛升级后才考虑同步重试 |
| Q3 | 校验粒度：每个 citation vs 每个句子 | **每个 citation**——和现有 postprocess 粒度对齐 |
| Q4 | 校验模型选择 | **复用 RFC 0003 选定的模型**（Gemma 3 4B / Qwen2.5 3B）；不引入新模型 |
| Q5 | shadow 数据"够用"判定 | **≥ 1000 条带 citation 的答案 + 误报率人工抽样 ≤ 5%**；不到则继续 shadow |
| Q6 | 是否对所有答案校验 | **是**（异步无成本压力）；如果 0.3 期间发现成本问题，再加采样 |

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 小模型自身幻觉判错（误报） | shadow 模式低代价试错；§2.2 显式要求 ≤ 5% 误报率才升级硬门槛 |
| 异步任务堆积（高 QPS） | 队列限长 + 丢弃策略：超过 1k 待处理任务丢最早未启动；不影响主流 |
| 答案被改写后失去与 chunk 的字面关联 | 校验基于语义而非字面，本来就是为解决这个问题；不是风险，是设计目标 |
| 0.3 shadow 数据量不足判断升级 | 延期 H1；shadow 自身已经为 0.3 A+ 诊断提供更准信号，有独立价值 |
| 与 RFC 0003 推理服务竞争资源 | 同一 Ollama 实例 + 请求队列；高并发时优先 reformulation（用户感知延迟）|

---

## 7. 与其他 RFC 的关系

| RFC | 关系 |
|---|---|
| [0001](./0001-feedback-loop-v0.2.md) | 校验结果写入 feedback 表的 trace 字段；提升 0.3 A+ 诊断准确性 |
| [0002](./0002-console-studio-feedback-loop.md) | Studio Feedback tab 新增"语义校验失败"类别；抽屉展示 verdict + reason |
| [0003](./0003-multi-turn-session-rewrite.md) | 复用小模型推理服务部署 |
| [0004](./0004-embedded-ask-widget.md) | 嵌入式数据上下文场景下，校验更关键（参考 RFC 0004 风险表） |

---

## 8. 未涉及

- 校验失败时的 LLM 重试 prompt 设计——0.4 H1 才涉及，本 RFC 不展开
- 引用粒度从 chunk 级降到段落 / 句级——独立优化方向，单 RFC
- 跨语言场景下校验（zh 答案引 en chunk）——0.3 shadow 不区分语言收数据，0.4 视情况单议
- citation 数量异常多（≥ 15）的成本控制——0.3 后视真实分布定策略

---

## 9. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-20 | 起草 | @shawndslee |
