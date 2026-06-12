# RFC 0005 — Citation 语义校验（B.2：复用主 LLM）

> Status: Implemented（shadow 全链路 V1–V5 已于 0.3.0 发版；H1 硬门槛待启）
> 实装状态（2026-06-13）：V1–V5 shadow 校验全链路已于 **0.3.0** 发版（citation-validator + claim-extractor + finalizeAskCall 异步触发 + runs.jsonl `citation-check-update` tail + Studio verdict 展示），默认 `citationSemanticCheck.enabled=false`（见 CHANGELOG 0.3.0 / PR #72,#74）。剩 = **H1 硬门槛**（校验失败时拦答案）仍 pending。
> Author: @shawndslee
> Date: 2026-05-20（Accepted 于 2026-05-23）
> 范围版本: `@anydocs/ask` 0.3.x
> 设计依据: [PRD §10.3](../../PRD.md#103-03-启动阈值拆分) Citation 语义校验项 / [PRD §10.7](../../PRD.md#107-新增明确不做与-112-红线一致) 末条
> 关联代码: [src/query/postprocess.ts](../../src/query/postprocess.ts) / [src/query/answer.ts](../../src/query/answer.ts)
> 依赖 RFC: 无运行时依赖；trace 字段在 0.3+ 与 RFC 0002 Studio 协作

---

## 0. TL;DR

当前 [postprocess](../../src/query/postprocess.ts) 用字符串/词项级匹配判断 `[cit_N]` 标记是否对应 chunk，**只看"用了几个"，不看"用得对不对"**。**B.2 路径**：复用现有主 LLM（Claude / Anthropic 通道）做事后语义校验——异步、批量、fire-and-forget；每个 citation 输出 `supports / partially / not_supports + reason` 进 trace。

**不引入小模型、不增运行时依赖、不阻塞主答案延迟。** 配置只暴露两个字段（`enabled` + `mode`），默认 `enabled:false`。

**0.3 起 shadow 模式上线**（采集信号、不阻塞）；**0.4 视数据决定是否升级为硬门槛**。

---

## 1. 为什么现在做

### 1.1 现状盲区

[answer.ts](../../src/query/answer.ts) `MAX_CITATION_RETRIES=2` 的重试逻辑只看 `used_chunks > 0`，即"答案中至少出现一个有效 `[cit_N]` 标记"。问题：

- **场景 A**（已捕获）：答案纯文本无 cit 标记 → `no_citations` → 重试或拒答。✓
- **场景 B**（未捕获）：答案有 cit 标记，但**标记位置的句子和 chunk 内容不对应**。例如 chunk 在讲 X，答案在讲 Y 但末尾标了 `[cit_2]`（指向 X chunk）。

场景 B 在 [postprocess](../../src/query/postprocess.ts) 当前的 `filterHallucinations`（基于关键词重合）只能粗判，遗漏率高。后果：

- **用户体验**：表面看引用齐全，实际链接到错的文档段
- **反馈数据质量**：design partner 点 👎 的 query 在分析时被误判为"答案有引用，confidence 高"，**0.3 A+ 诊断（PRD §11 F2）会误判失败原因**

### 1.2 为什么走 B.2 复用主 LLM 而非小模型

本 RFC 2026-05-20 起草版本假设"复用 RFC 0003 部署的小模型推理服务"。RFC 0003 alpha.1 (2026-05-22) 已彻底转向 **B.2 大模型一次消化**——删光了所有 OpenAI-compatible 客户端 / Ollama 适配 / 小模型 reformulation pipeline，anydocs-ask 现在**零外部运行时依赖**。两个事实驱动本 RFC 同步转向：

1. **小模型可靠性已被 0003 smoke 实证否定** —— Appendix A 数据显示 3-4B non-thinking 在 reformulation 任务上仍有 25% 翻车率（信息泄漏 / 复读）。Citation 校验是相似的 NLI-类任务（长输入 + 严格 JSON 输出），同样的 alignment-依赖问题会重现，且校验本身就是用来"判官"的——判官比生成更需要可靠性。
2. **B.2 转向后引入小模型 = 复活已废弃的运行时基础设施** —— 与 0003 删除的 OpenAI-compatible 客户端 / endpoint 配置 / API key env / timeout 等一整套现在不存在的脚手架冲突。

**B.2 复用 Claude 同时避开三层负担**：

| 方案 A（小模型校验）| 方案 B.2（主 LLM 校验）|
|---|---|
| 作者需自部署 LM Studio / Ollama / vLLM | 复用现有 Anthropic 通道 |
| 校验阶段 ~25% 翻车（参考 0003 同类任务）| Claude 多事实校验经验值 < 5% |
| 工程上需 OpenAI-compatible 客户端 + 模型选型 + 队列 | 工程上仅 batch prompt + LLM 调用 |
| 0.3 期需独立 smoke 实证 | 复用 0.3 现有 LLM 通道，可直接产数据 |

代价：每条触发校验的 answer 额外 1 次 LLM 调用，**异步、fire-and-forget**，不影响用户感知延迟。

### 1.3 为什么独立于其他 RFC

- **不依赖反馈数据**：是事后校验，本身不需要先有 feedback 量
- **不依赖多轮**：单轮 / 多轮场景都有此需求
- **不依赖嵌入式**：是 ask 工程本体的精度增强

因此**可与 RFC 0002 Studio、RFC 0003 多轮并行推进**，0.3 完成 shadow 模式即可。

---

## 2. 范围拆分

### 2.1 0.3 in-scope（shadow 模式）

| # | 项 | 备注 |
|---|---|---|
| V1 | **批量校验模块**：输入 `Array<(cit_id, claim_sentence, chunk_text)>` → 输出 `Array<{ verdict, reason, model, checked_at, latency_ms }>`；一次 LLM 调用覆盖整答案的所有 citations | [src/query/](../../src/query/) 新增 `citation-validator.ts`；复用 [src/llm/anthropic.ts](../../src/llm/anthropic.ts) |
| V2 | **claim 句抽取**：从 `answer_md` 解析出每个 `[cit_N]` 标记前面的句子作为 claim，与 chunk pair 化 | 简单正则 + 句号切分；不准则降级取 N-字 prefix |
| V3 | **Postprocess 集成（shadow 模式）**：现有 [postprocess](../../src/query/postprocess.ts) 流程保持不变；校验**异步**触发，结果写入 [runs.jsonl](../../src/server/app.ts) trace | **不阻塞答案返回** |
| V4 | **Trace 扩展**：`RunRecord.answer.citations[i]` 新增 `semantic_check` 字段（schema 见 §4.4） | RunRecord schema 加 optional 字段 |
| V5 | **Console Studio 展示（依赖 RFC 0002）**：Feedback tab 抽屉中显示语义校验结果；列表中可筛选 `semantic_check_failed` 类别 | 0.3 Studio 已存在时叠加 |
| V6 | **配置开关**：`anydocs.ask.json` 加 `citationSemanticCheck.{enabled, mode}`，默认 `enabled:false / mode:'shadow'`；启用后异步执行 | 与 `feedback.enabled` 风格一致 |

### 2.2 0.4 候选 in-scope（视 0.3 shadow 数据）

| # | 项 | 触发条件 |
|---|---|---|
| H1 | 升级为硬门槛：语义校验失败 → 触发 citation reinforcement 重试 | 0.3 shadow 数据显示**≥ 10% 的答案有语义校验失败但被现有 postprocess 通过**，且校验**误报率 ≤ 5%**（人工抽样） |
| H2 | 校验失败时返回错误码 `citation_mismatch`（与 `no_citations` 并列）| 同上 |
| H3 | A+ 诊断（PRD §11 F2）消费语义校验失败信号 | 自然延伸 |
| H4 | 同步 mode（`mode:'enforce'`）：校验失败立刻触发重试，最多 1 次 | 同 H1 |

### 2.3 永不做

- ❌ **用小模型/校验层替代主 LLM 生成答案**（PRD §10.7 末条 — 校验是"判官"角色，不参与生成）
- ❌ **校验失败即抛弃整个答案**（即使升级硬门槛后也保留至少一次重试 + 降级返回）
- ❌ **同步阻塞主答案延迟**（哪怕 0.4 H1 升级，也是"重试时阻塞"而非"校验时阻塞"）
- ❌ **依赖外部 SaaS API 做校验**（与 PRD §10.4 数据本地优先一致；Claude 调用与现有 ask 主路径同一通道、同一隐私边界）
- ❌ **裸跑小模型校验**（与 B.2 转向相悖；如未来再评估，需独立 RFC + 完整 smoke）

---

## 3. 实现里程碑

> ✅ **已实装**：V1–V5 全部于 **0.3.0** 发版（shadow 模式，默认关）。

```
0.3.0-alpha.0  对齐 PR：RFC Accept + config schema 留位          零行为变化   ✅ → 0.3.0
0.3.0-alpha.1  V1 校验模块 + V2 claim 句抽取                     核心         ✅ → 0.3.0
0.3.0-alpha.2  V3 shadow 集成 + V4 trace 扩展 + V6 config 接通   可发布       ✅ → 0.3.0
0.3.0          V5 Studio 展示（依赖 RFC 0002 已就绪）+ 整体回归   交付         ✅ → 0.3.0
```

~~绝对日期不预设；里程碑顺序锁定，alpha.0 启动时锚定~~ —— **V1–V5 已全部发版（见 CHANGELOG 0.3.0 / PR #72,#74）**；后续 H1 硬门槛（校验失败拦答案）另起子 RFC。

---

## 4. 设计要点

### 4.1 校验 prompt 设计

```
你是引用校验助手。判断一组"答案句子"是否能由对应的"文档片段"语义支撑。

输入是一个 JSON 数组，每个元素含 { cit_id, claim, chunk }。
逐条判断，输出严格 JSON 数组，保持顺序，长度等于输入：

[
  {
    "cit_id": "cit_1",
    "verdict": "supports" | "partially" | "not_supports",
    "reason": "...一句话（≤ 100 字符）..."
  },
  ...
]

判断准则：
- supports: 答案句子的每个事实点都能在文档片段里找到对应
- partially: 大部分能找到，但有 1 个事实点缺失或偏差
- not_supports: 关键事实点找不到，或片段在讲另一件事

只输出 JSON 数组，不要任何额外文本。
```

输出长度限制：`reason ≤ 100 字符`；批次 ≤ 10 个 citation/次。

### 4.2 性能与异步策略

| 选项 | latency | 答案体验 |
|---|---|---|
| 同步校验 | 答案后多 1-3s | 阻塞 P95 |
| **异步校验（V3 默认）** | 答案立即返回；校验结果 fire-and-forget 写入 runs.jsonl | 不阻塞 |
| 同步硬门槛（H1）| 答案后多 1-3s | 仅校验失败重试时阻塞 |

**0.3 默认异步**——校验只用于事后分析与 Studio 展示，不影响用户感知延迟。

实现路径：`finalizeAskCall` 主响应返回后，启动 unawaited Promise（`void (async () => { ... })()`）调 `citation-validator.validate(answer_id, claim_chunk_pairs)`。校验完成后通过 runs.jsonl 的 `feedback-update`-类追加机制写回（参见 [src/runs/types.ts](../../src/runs/types.ts) `RunFeedbackUpdate`）。

### 4.3 批量调用

一个答案通常 3-8 个 citations。**批量构造单个 LLM prompt**（每个 cit 一行）→ Claude 一次返回 JSON 数组，一次调用覆盖整答案。

> 历史注：起草版本估算 "Gemma 3 4B 量级 ≤ 1.5s"；B.2 转向后改用 Claude Sonnet 4.6，端到端 ~3-5s（异步无所谓）。

### 4.4 Schema 扩展

`RunRecord.answer.citations[i]` 新增 optional 字段：

```ts
{
  citation_id: 'cit_1',
  chunk_id: '...',
  // ... 原有字段
  semantic_check?: {
    verdict: 'supports' | 'partially' | 'not_supports',
    reason: string,            // ≤ 100 chars
    model: string,             // e.g. 'claude-sonnet-4-6'
    checked_at: string,        // ISO 8601
    latency_ms: number,        // 单次批量调用总耗时（同批所有 cit 共用）
  }
}
```

`semantic_check` 可选——`enabled=false` 时不存在；异步任务失败时也不存在（不影响主答案）。

### 4.5 配置 schema

`anydocs.ask.json`：

```json
{
  "citationSemanticCheck": {
    "enabled": false,
    "mode": "shadow"
  }
}
```

字段：
- `enabled: boolean`，默认 `false`。flip 到 `true` 后异步触发校验；`false` 时整段不执行（零额外 LLM 调用）。
- `mode: 'shadow' | 'enforce'`，默认 `'shadow'`。0.3 in-scope 只实现 `shadow`；`enforce`（H4）schema 留位，0.4 视数据决定是否开放。

### 4.6 失败模式与自然降级

| 场景 | 行为 |
|---|---|
| `enabled=false` | 整段不执行；trace 无 `semantic_check` 字段 |
| LLM 校验调用超时 / 抛错 | 异步任务静默失败；trace 无字段；不污染主答案路径 |
| Claude 返回非合法 JSON | 解析失败计数 +1（stderr warn）；trace 无字段 |
| 答案 `[cit_N]` 解析为零对（V2 找不到 claim 句）| 跳过该 cit；批次为空则整段跳过 |
| Citation 数 > 10 | 分批；reason 记 `batch_index` 区分 |

**关键原则**：校验失败永远不影响 `/v1/ask` 主响应——失败信息只进 stderr + 不写 trace 字段，让 shadow 数据自然"不含 semantic_check"，与 `enabled=false` 同一形态。

---

## 5. 决策记录（2026-05-23 锁定）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | shadow vs 硬门槛 | **0.3 shadow only**；H1 升级需 §2.2 条件 |
| Q2 | 异步 vs 同步 | **异步**（§4.2）；硬门槛升级后才考虑同步重试 |
| Q3 | 校验粒度：每个 citation vs 每个句子 | **每个 citation** —— 和现有 postprocess 粒度对齐 |
| Q4 | 校验模型选择 | **复用主 LLM（Claude）**，2026-05-23 锁定。依据：0003 smoke 实证 + B.2 转向 + 零额外依赖 |
| Q5 | shadow 数据"够用"判定 | **≥ 1000 条带 citation 的答案 + 误报率人工抽样 ≤ 5%**；不到则继续 shadow |
| Q6 | 是否对所有答案校验 | **是**（异步无 latency 压力）；如 0.3 期发现 cost 问题，再加采样 |
| Q7 | 校验结果是否回写 feedback 表 | **否**。trace 字段足以服务 Studio + analyze；feedback 表只承载用户/隐式信号 |
| Q8 | Claude API 调用失败的兜底 | **静默丢弃**（§4.6）；不重试、不写降级 trace；shadow 数据缺失视为"该轮未校验" |

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| Claude 调用 cost（每答案 +1 次 LLM）| design partner 量级（< 100 q/天）× ~$0.01/调用 < $1/天；高量场景文档化 + `enabled` 留 opt-out；超规模时上"采样"（§5 Q6 留口）|
| Claude 校验本身也有误报 | 4.4 设计的 verdict 三档（含 `partially`）+ shadow 模式低代价试错；§2.2 显式要求 ≤ 5% 误报率才升级硬门槛 |
| 异步任务堆积（高 QPS 时） | unawaited Promise 内部队列限长（参考 100 待处理）+ 丢弃策略：超限丢最新；不影响主流 |
| 答案被改写后失去与 chunk 的字面关联 | 校验基于语义而非字面，本来就是为解决这个问题；不是风险，是设计目标 |
| 0.3 shadow 数据量不足判断升级 | 延期 H1；shadow 自身已经为 0.3 A+ 诊断提供更准信号，有独立价值 |
| LLM 通道短时故障（429/503）影响主 ask | 异步任务与主 ask 共用通道，但 fire-and-forget 不会阻塞；异步层失败完全 swallow（§4.6）|

---

## 7. 与其他 RFC 的关系

| RFC | 关系 |
|---|---|
| [0001](./0001-feedback-loop-v0.2.md) | 校验结果写 runs.jsonl trace（不进 feedback 表）；提升 0.3 A+ 诊断准确性 |
| [0002](./0002-console-studio-feedback-loop.md) | Studio Feedback tab 新增"语义校验失败"类别；抽屉展示 verdict + reason |
| [0003](./0003-multi-turn-session-rewrite.md) | **同样的 B.2 复用主 LLM 模式** —— 一致的技术方向；不复用任何小模型基础设施（B.2 转向后已无） |
| [0004](./0004-embedded-ask-widget.md) | 嵌入式数据上下文场景下，校验更关键（参考 RFC 0004 风险表） |

---

## 8. 未涉及

- 校验失败时的 LLM 重试 prompt 设计——0.4 H1 才涉及，本 RFC 不展开
- 引用粒度从 chunk 级降到段落 / 句级——独立优化方向，单 RFC
- 跨语言场景下校验（zh 答案引 en chunk）——0.3 shadow 不区分语言收数据，0.4 视情况单议
- citation 数量异常多（≥ 15）的成本控制——0.3 后视真实分布定策略
- 校验 prompt 的 prompt-injection 防护——chunk 内容来自项目作者发布的 docs，不视作 untrusted 输入

---

## 9. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-20 | 起草（小模型校验路径，假设复用 RFC 0003 Ollama / 本地 SDK）| @shawndslee |
| 2026-05-23 | **方向修订：小模型 → B.2 复用主 LLM**。依据：RFC 0003 alpha.1 (2026-05-22) 已彻底删除小模型基础设施 + 0003 smoke 实证显示 3-4B 小模型在 NLI-类任务 25% 翻车；citation 校验作为"判官"角色需更高可靠性。同步重写 §0/§1/§2.1/§2.3/§4/§5/§7；schema 简化为 `enabled` + `mode` 两字段；Status → Accepted | @shawndslee |
