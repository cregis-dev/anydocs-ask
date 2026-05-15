# RFC 0001 — 0.2 反馈回路落地

> Status: Draft (起草中)
> Author: @shawndslee
> Date: 2026-05-16
> 范围版本: `@anydocs/ask` 0.2.0
> 设计依据: [PRD §11](../../PRD.md#11-v15-增量qa-反馈回路计划) / [ARCH §15](../../ARCHITECTURE.md#15-v15-增量qa-反馈回路)
> 跨仓协同: `anydocs` 主仓（Reader β 按钮）

---

## 0. TL;DR

0.2 把 PRD §11 v1.5 的反馈回路从"计划"变成"可用"。三件事并行推：

1. **Feedback 文件化审核流（F3）**——CLI + 目录布局，本仓内闭环。
2. **β 按钮跨仓协议**——给 `anydocs` 主仓出一份正式接入提案，本仓不动 Reader 代码。
3. **γ 服务端可推信号**——5min 重问检测落地，不依赖 Reader。

Reranker 加权（A 路径）与 A+ 失败查询诊断在数据足够后（≥ 200 条反馈）进 0.3 启动；0.2 只把通道铺通。

---

## 1. 为什么现在做

PRD §11 触发条件："v1 上线并积累 ≥ 4 周真实查询日志后启动"。0.1.0 发布日 = 2026-05-16，自然窗口 ≈ 2026-06-13。

0.2 在此窗口前完成"管道工程"，等数据到位即可启动调权与诊断；并行节奏避免 4 周空窗。

---

## 2. 范围拆分

### 2.1 0.2 in-scope

| # | 项 | 对应 PRD/ARCH |
|---|---|---|
| S1 | `state/<projectId>/feedback/{inbox,approved,rejected,suggestions}/` 目录初始化 | ARCH §15.5.1 |
| S2 | CLI: `feedback export / import / status` | PRD §11 F3 / ARCH §15.5.3 |
| S3 | `feedback` 表 `ALTER ADD COLUMN signal_source / reviewed_at / review_decision / session_id` | ARCH §15.2.1 |
| S4 | γ 服务端可推："5min 同 session 重问检测" 一条 | ARCH §15.2.2 表第 1 行 |
| S5 | `session_id` 下发到 `/v1/ask` 响应（cookie / response field 二选一） | ARCH §15.2.2 |
| S6 | `feedback.enabled` 配置开关；默认 `false`，行为与 v1 等价 | PRD §11.4 #6 |
| S7 | RFC 0001 跨仓提案（本文件）+ 与 anydocs 主仓评审 | §5 |
| S8 | Console 加 feedback tab（只读：队列长度 / 最近反馈 / 触发 export 按钮） | 复用 console 框架 |

### 2.2 0.2 out-of-scope（→ 0.3 启动）

| # | 项 | 理由 |
|---|---|---|
| D1 | `chunk_priors` 表与 reranker 加权 | 数据不足（< 200 条），调权无意义 |
| D2 | `feedback diagnose`（A+ 失败查询聚类） | 同上；先攒数据 |
| D3 | γ "未点 citation / 离场 / 停留" 三档 | 依赖 Reader 上报；与 β 同包评审 |
| D4 | `rebuild-priors` CLI | 依赖 D1 |
| D5 | 实体表 / query expansion / 意图分流 | PRD §10 v1.5 其他议题，独立 RFC |

### 2.3 永不做（PRD §11.2 决策红线）

- 审过的 QA 进检索（Shadow Wiki）
- 自动写回 anydocs `pages/*.json`
- 内置 Web review 面板（审核走文件 + git）
- 强制 anydocs Reader 全量改造

---

## 3. 实现里程碑

```
0.2.0-alpha.0 (≈ 2026-05-30)   S1 + S3 + S6                  本地通道铺通
0.2.0-alpha.1 (≈ 2026-06-06)   S2 (export/import/status)     CLI 可用
0.2.0-alpha.2 (≈ 2026-06-13)   S4 + S5 + S8                  γ 兜底 + console
0.2.0         (≈ 2026-06-20)   S7 评审完成；anydocs 排期确定  跨仓对齐
```

每个 alpha 都需通过：typecheck + test + build + `feedback.enabled=false` 时全量回归（v1 行为等价性）。

---

## 4. 设计要点（仅扩 ARCH §15 未决处）

### 4.1 `session_id` 下发位置

ARCH §15.2.2 只写了"`/v1/ask` 响应里下发 session_id"，没明确字段位置。**建议**：

- **响应字段**：`response.session_id`，与 `answer_id` 同级。
- **不下 cookie**：本地优先 + 跨域少；cookie 引入额外的 CORS preflight 与 SameSite 决策面。

Reader 客户端在 localStorage 维护，每次 ask 带上：

```ts
fetch('/v1/ask', {
  method: 'POST',
  body: JSON.stringify({
    question,
    current_page_id,
    session_id: localStorage.getItem('anydocs.ask.session_id') ?? undefined,
  }),
})
```

服务端：传了就续用、未传或过期就新生成。TTL 30min（ARCH §15.2.2）。

### 4.2 "5min 重问检测"的实现位置

服务端进程内存维护 `Map<session_id, RecentAsk[]>`。新 ask 进来时：

1. 取 `session_id` 对应的近 5min ask 列表
2. 对每条历史 ask 计算与当前 question 的语义相似度（复用 BGE-M3 embedding，已加载）
3. 任一 ≥ 0.85 → 写一条 `feedback` 行（`signal_source='implicit'`, `rating=-0.3`, `bad_citation_ids` 引用前一次的 used_chunks）

边界：

- session 表 TTL 30min，但相似度只看 5min 窗口
- 进程重启清空 session 表是可接受的（隐式信号本就是 best-effort）
- `feedback.enabled=false` 时跳过整个块

### 4.3 inbox 文件命名冲突

ARCH §15.5.1 例子是 `2026-W18-001-jwt-auth.md`。命名规则建议固定为：

```
<YYYY>-W<II>-<NNN>-<slug>.md
```

- `<YYYY>-W<II>`：ISO 周（与 runs 目录一致，避免月切问题）
- `<NNN>`：本周内的簇序号，001 起，3 位补零
- `<slug>`：簇质心 query 的前 32 字符 slug（kebab-case，移除非字母数字）

冲突解决：`export` 跑两次时，已存在的文件 **不覆盖**（PRD §11.4 #2 作者主权），日志提示。

### 4.4 `feedback.review_decision` 与 `signal_source` 的协同

ARCH §15.2.1 写了 `signal_source='curated'` 是审过的，但没说原 `'explicit'` / `'implicit'` 行的 `signal_source` 是否要在 import 时改写。**建议**：

- **不改写**原行 `signal_source`，新增一行 `signal_source='curated'` 关联同一 `cluster_id`。
- 这样保留原始信号轨迹，也方便 A+ 诊断时还原"原信号 → 审核结论"链。

需要给 `feedback` 表加一列 `cluster_id TEXT`，用于关联簇。

---

## 5. 跨仓提案（给 anydocs 主仓）

### 5.1 提案文本（拟提交到 anydocs 仓）

> **标题**: Reader 接入 ask feedback 按钮（最小破坏面）
>
> **背景**: anydocs-ask 在 0.2 上线反馈回路；Reader 端 β 显式按钮（PRD §11.2 决策 ②）需要主仓加 3 个按钮 + 1 个 fetch。
>
> **改动面**:
>
> 1. **UI**: 答案区下方加三按钮：👍 答得好 / 👎 答得差 / ✗ 答错了。按钮组件、位置、设计走主仓设计系统。
> 2. **网络**: `fetch(ASK_BASE_URL + '/v1/ask/feedback', { method: 'POST', body: { answer_id, rating, ... } })`。完整协议见 ARCH §5.2，0.2 不变。
> 3. **开关**: 项目方在 anydocs 项目配置加 `ask.feedback.enabled: true` 即启用；默认关。
> 4. **session_id**: Reader 在 localStorage 持久化 `anydocs.ask.session_id`，每次 ask 带上、从响应回填。
>
> **不引入**:
>
> - 新依赖
> - anydocs schema 变更
> - 任何 React 全局状态结构变更（按钮组件可独立挂载）
>
> **验收**:
>
> - `ask.feedback.enabled: false` 时按钮不渲染、零网络请求
> - `enabled: true` 时点击成功调到 `/v1/ask/feedback` 返回 200
> - localStorage 跨刷新 session 保持

### 5.2 评审 checkpoint

| 时间 | 事项 |
|---|---|
| 2026-05-20 | RFC 0001 内部 review（本仓）|
| 2026-05-23 | 把 §5.1 文本提交到 anydocs 主仓 issue/RFC |
| 2026-05-30 | anydocs 团队回应：接受 / 改动建议 / 排期 |
| 2026-06-13 | 主仓 PR review（如已排期）|
| 2026-06-20 | 跨仓联调 |

如主仓拒绝或大幅延后：降级方案见 §6。

---

## 6. 降级方案（β 不可用时）

如果 anydocs 主仓暂时不愿意接入 β 按钮：

- **0.2 仍按计划交付**：S1–S8 全部本仓闭环；β 通道接 console 内置的 dogfood "Ask" 界面（已有），先用 console 收 β 信号。
- 这相当于 PRD §11.2 决策 ② 的"内部 dogfood"路径，等数据规模显出价值后再回头推主仓。
- 0.3 启动调权时若 β 量太少，权重表回退到只用 `'curated'`（审过的）+ `'implicit'`。

---

## 7. 决策记录（2026-05-16 锁定）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | `session_id` 用响应字段还是 cookie？ | **响应字段**（`response.session_id`，与 `answer_id` 同级；见 §4.1）|
| Q2 | 重问检测的相似度阈值用 0.85 写死还是 config？ | **写死 0.85**；调整需单独 RFC |
| Q3 | inbox 文件 import 后是删除还是归档到 `processed/`？ | **删除**（git 已有历史；ARCH §15.5.3 表一致）|
| Q4 | `feedback` 表加 `cluster_id` 列还是单开关联表？ | **加列**（轻量；查询同表）|
| Q5 | Console feedback tab 0.2 要支持 "审核"操作还是只读？ | **只读**；审核走文件 + git（PRD §11.2 决策 ③）|
| Q6 | `feedback.enabled=false` 时 γ 是否也完全不收？ | **不收**（开关含义统一；γ 也属反馈范畴）|

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| anydocs 主仓评审周期超 4 周 | §6 降级到 console 内 dogfood |
| 真实 β 数据量在 4 周内 < 100 | 0.3 启动延后；S1–S8 不受影响 |
| `feedback` 表 ALTER 在大量旧数据上耗时 | SQLite ALTER ADD COLUMN 是 O(1)；旧行 default 值确定 |
| 隐式信号噪声污染 reranker | 0.3 才用；0.2 只采不消费；权重模型在 ARCH §15.3 已约束 |
| Session 表内存泄漏 | 30min TTL + 进程定时清理；上限 10k session |

---

## 9. 未涉及

- 0.1.x 收尾遗留（cancel 按钮 / Reader UI 占位 / log tail / F6 / O1）走主线分支独立 PR，与本 RFC 解耦。
- 实体表 / query expansion / 意图分流 / Ollama 选项 → 单独 RFC（PRD §10 v1.5 其他议题）。
- Analyze 维度 4–5 → ARCH §16.6 范围；与本 RFC 共享 `feedback` 表，但消费侧独立排期。

---

## 10. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-16 | 起草 | @shawndslee |
| 2026-05-16 | §7 决策锁定（Q1–Q6 全部接受推荐答案）；0.2.0-alpha.0 实施开始 | @shawndslee |
