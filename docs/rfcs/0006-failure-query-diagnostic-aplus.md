# RFC 0006 — 失败查询诊断（A+）

> Status: Accepted（2026-05-24 升档 + alpha.0 alignment 落 schema 留位 + CLI stub）
> Author: @shawndslee
> Date: 2026-05-24（Accepted 同日）
> 范围版本: `@anydocs/ask` 0.4
> 设计依据: [PRD §10.3](../../PRD.md#103-03-启动阈值拆分) A+ 行 / [PRD §11.3 F2](../../PRD.md#f2-失败查询诊断a) / [PRD §11.4](../../PRD.md#114-核心约束) 红线
> 阻塞依赖: [RFC 0001](./0001-feedback-loop-v0.2.md)（β/γ 通道）已 GA / [RFC 0002](./0002-console-studio-feedback-loop.md) Studio 已 GA

---

## 0. TL;DR

把 PRD §11.3 F2 概念化的「失败查询诊断 A+」扩成可落地工程设计：用现有 bge-m3 embedding 把显式负 β + 高质量 γ 信号聚类成 ≥ 3 个语义簇，每簇产 1 份「应补文档建议」markdown 落到 `state/<projectId>/feedback/suggestions/`，挂回最相关的 nav 子树。**0.4 主线**：alpha.0 schema 留位 + CLI stub → alpha.1 pure 聚类算法 + simulator → alpha.2 LLM 生成建议草稿 → alpha.3 Studio A+ 视图接通 → 0.4.0 shadow 模式（≥ 50 反馈门槛达成后 flip enabled）。

不引入小模型、不上 reranker、不自动写 `pages/*.json`、不消费 γ 进建议（PRD §11.4 红线沿用）。

---

## 1. 为什么现在做

### 1.1 现状盲区

PRD §11.3 F2 描述了 A+ 的目标输出（"补文档建议" markdown）但没钉算法。Console Studio Feedback tab 当前 KPI tile `A+ candidates` 显示 "—"（PRD §10.3 表 + tests/console-server.test.ts）。0.2/0.3 期间反馈量级见底（hermes-docs 15 条 / 其他项目 0 条），距 50 条门槛还有 ~3-4 周——但是：

- 工程实现复杂度被未知聚类算法选型 + 建议生成形态拖着
- design partner 在 1-2 个项目里跑，看不到 A+ 输出会**怀疑反馈回路的产品价值**
- ≥ 50 条阈值是「**信号质量**」门槛而非「**功能可用**」门槛——50 条以下也能跑算法，只是输出 cluster 噪声大；先把骨架接通，到点 flip enabled 即可

### 1.2 为什么 0.4 起步、阈值达成后再 flip

PRD §10.3 锁的 50 条 + 4 周观察窗是**产品启动门槛**：

- 50 条已能形成 ≥ 3 个有效语义簇（< 50 簇要么单元素要么混杂）
- 4 周观察窗确保不是单次活动峰、覆盖工作日 + 周末问答模式

工程上提前做：

- **算法 + 管道** 不依赖样本量大小（数学上单元素簇也能跑）
- **simulator** 用合成 60 条 fixture 跑端到端，验证管道正确 vs 真实数据等待解耦
- **shadow 模式** 跑算法但不点醒作者，只落到 `suggestions/.shadow/` 目录，给操作者 dogfood 看输出形状

`citationSemanticCheck.enabled=false` (RFC 0005 alpha.0) 是相似处理 — 接通管道但默认 off。

### 1.3 为什么独立成 RFC 0006 而非塞 RFC 0001

RFC 0001 §F2 把 A+ 写成 50 字概念，落地需要决策点 ≥ 10 个（聚类算法、嵌入复用、阈值、建议生成形态、CLI / Studio 接口、shadow 策略...）。独立 RFC 是 0003/0004/0005 的相同节奏。

### 1.4 为什么 2026-05-24 升档 Accepted

走 0003/0004/0005 一致的「先升档 + alpha.0 留位」节奏：

- §4 / §5 决策点全部钉死，前置 RFC（0001 β/γ 通道、0002 Studio、0003 multi-turn、0005 V5）均已落 main
- 工程基础与样本量门槛**解耦**——alpha.0/alpha.1/alpha.2 alpha 链可以提前推进，门槛达到时 operator flip `aplus.enabled` 即用
- design partner 看得到「即将启用」信号（CLI 子命令存在 + Studio KPI tile 接通），比一个"待启动"占位条更能立信

本 alignment PR 严格限于：

- RFC Status Draft → Accepted
- `anydocs.ask.json` 增 `aplus.{enabled, threshold, observationWindow, embedSimilarityThreshold}` 段
- CLI 注册 `feedback diagnose` 子命令 stub（仅打印门槛检查 + 当前反馈量；不读 embedding / 不跑聚类 / 不写 suggestions/）
- 不动 src/feedback/ pure 模块（alpha.1）
- 不动 Studio Feedback tab（alpha.3）

---

## 2. 范围拆分

### 2.1 0.4 in-scope（alpha 链路）

| # | 项 | 备注 |
|---|---|---|
| A1 | **CLI feedback diagnose stub**：命令注册、`--since` / `--shadow` / `--out` 标志；no-op 实现打印 "feedback < threshold; nothing to diagnose" | alpha.0 alignment |
| A2 | **配置 schema 留位**：`anydocs.ask.json` 新增 `aplus.{enabled, threshold, observationWindow, embedSimilarityThreshold}` 段，默认全 off | alpha.0 alignment |
| A3 | **聚类 pure 模块**：[src/feedback/diagnose-cluster.ts](../../src/feedback/diagnose-cluster.ts)（新建）。输入 feedback 行 + 既有 embedding cache；输出 cluster 列表（含 cluster_id / 成员 query / 中心 query / 密度评分） | alpha.1 |
| A4 | **Simulator + fixture**：[tests/feedback-diagnose-cluster.test.ts](../../tests/feedback-diagnose-cluster.test.ts) + `fixtures/feedback-diagnose/synthetic-60.json`（4 个语义主题 × 15 条扰动） | alpha.1 |
| A5 | **建议生成 pure 模块**：[src/feedback/diagnose-suggest.ts](../../src/feedback/diagnose-suggest.ts)。输入 cluster + 项目 nav；输出 markdown 草稿（"挂在哪 nav 节点下" + "覆盖什么内容" + "样本 query 列表"）。LLM 调用复用现有 Anthropic 通道（B.2） | alpha.2 |
| A6 | **CLI diagnose 接通 pipeline**：A3 + A5 串起来，写 `state/<projectId>/feedback/suggestions/<cluster_id>.md`；`--shadow` 写到 `suggestions/.shadow/` | alpha.2 |
| A7 | **Studio Feedback tab A+ 视图**：KPI tile `A+ candidates` 从 "—" 变实数；Feedback tab 增 `aplus` chip + drawer 展示 cluster 详情 | alpha.3 |
| A8 | **shadow → on 触发条件**：满足 PRD §10.3 双门槛后由 operator 显式 flip `aplus.enabled=true`；自动检测 + 警告但**不自动 flip**（避免 surprise） | 0.4.0 |

### 2.2 0.5+ 候选

| # | 项 | 触发条件 |
|---|---|---|
| H1 | A+ 输出反馈接入 reranker（"作者接受了哪些建议"信号） | Reranker A 路径就绪后（≥ 200 反馈门槛，PRD §10.3） |
| H2 | A+ 簇接 RFC 0005 citation verdict 信号（cluster 内多答案被 partially/not_supports → 加权） | RFC 0005 H1 升档硬门槛后 |
| H3 | 跨项目 A+ 聚合（多项目共享文档主题） | 多 design partner 场景 |
| H4 | 自动生成 `pages/*.json` patch 草稿（**PRD §11.4 红线 #2 不允许自动写**，但可 PR 形态供作者 review） | 用户明确请求 |

### 2.3 永不做

- ❌ **隐式 γ 信号进 A+ 建议**（PRD §11.4 / RFC 0001 §F1：噪声太大）
- ❌ **自动写回 `pages/*.json`**（PRD §11.4 红线 #2）
- ❌ **用小模型替代主 LLM 做建议生成**（PRD §10.7 / 0003/0005 B.2 一致路径）
- ❌ **没达 50 条强行 flip enabled**（产品门槛硬约束；shadow 模式可跑）
- ❌ **诊断结果进检索通道**（PRD §11.4 红线 #1 「审过的 QA 不进检索」延伸）

---

## 3. 实现里程碑

```
alignment PR   (2026-05-24, 本 PR)  Status 升档 + aplus schema + CLI stub     零行为变化
0.4.0-alpha.1                       A3 聚类 pure 模块 + A4 simulator           核心算法
0.4.0-alpha.2                       A5 建议生成 + A6 CLI 接通 pipeline + shadow 可 dogfood
0.4.0-alpha.3                       A7 Studio Feedback tab A+ 视图             可见
0.4.0                               A8 shadow → on (operator flip + threshold) 交付
```

绝对日期不预设；里程碑顺序锁定。`citationSemanticCheck` (RFC 0005) 已经验过该节奏。

alignment PR 严格限于：

- RFC Status Draft → Accepted
- `anydocs.ask.json` 增 `aplus` 段（4 字段，默认全 off / 沿用 §10.3 门槛值）
- CLI 注册 `feedback diagnose` 子命令 stub（打印门槛检查 + 当前反馈量）
- 配套 config tests + CLI smoke test
- 不动 src/feedback/ pure 模块（alpha.1）
- 不动 Studio Feedback tab（alpha.3）

---

## 4. 设计要点

### 4.1 失败 query 定义

继承 PRD §11.3 F2 三条 OR 准则，工程化为「候选池」过滤器：

| 准则 | 实现 | 权重 |
|---|---|---|
| 显式负 β ≥ 2 次同语义簇 | `feedback WHERE rating < 0 AND signal_source='explicit'` | 主信号 |
| Clarify 后用户未选子树 | `runs.jsonl WHERE answer.kind='clarify'` + 后续 session 内无满意答案的 follow-up | 次信号 |
| 检索 top-1 RRF 分数 < 阈值 | `runs.jsonl WHERE answer.confidence < 0.05`（默认；config 化）| 兜底信号 |
| **RFC 0005 V5 verdict ≠ supports** | `citation-check-update` tail join | 增强信号（H2） |

**γ 隐式信号不参与**（PRD §11.4 红线 + RFC 0001 §F1）。

### 4.2 聚类算法选型

**选择**：threshold-based union-find on bge-m3 cosine similarity，**阈值 0.65**（cit dedup 用 0.85，diagnose 要更宽 capture vocabulary mismatch）。

| 选项 | 优点 | 缺点 | 决策 |
|---|---|---|---|
| HDBSCAN | density-aware、自动出 noise 簇 | 50 样本太少；hyperparameter 多 | ❌ |
| K-means | 简单、O(n) | 需先知 k；center 受初始化影响 | ❌ |
| **Threshold-based union-find** | O(n²) 50 条不痛、阈值物理意义明确 | 阈值选不准会过粘 / 过稀 | ✅ |
| LLM as judge | 质量最高 | 50 条 = 1225 pair = 烧 ~$5/diagnose | 仅用于 cluster center query 选取 |

**阈值 0.65 推导**：bge-m3 同语义 query 经验 cosine 0.7+，同主题不同表述 0.55-0.7，跨主题 < 0.4。0.65 是 "同主题但表述差异大" 中点。**alpha.1 用 simulator 校准** —— 合成 fixture 设计 4 主题×15 query，正确簇数应该 = 4。如果 ≠ 4，调阈值。

### 4.3 嵌入复用

bge-m3 embedding cache 已经在 `embedding_cache` 表里（runs.jsonl 每行的 query 都缓存过）。`diagnose-cluster` 读 cache，**不重算**。

候选池外的 query 嵌入按需算（首次诊断时一次性补齐）。

### 4.4 建议生成 prompt

每个 cluster 给主 LLM：

```
你是文档诊断助手。下面是用户在产品 / 文档站对 anydocs 项目 <projectId>
提的一组失败 query（同主题）。基于现有文档 navigation（已注入），生成
一份补文档建议草稿。

输入：
  cluster_id: <id>
  member_queries: [<query>, <query>, ...]        # ≥ 2，去重后
  center_query: <最具代表性的 query>
  failed_answers: [<answer_md_summary>, ...]    # 已截到 200 字
  nav_subtrees: [<subtree>, ...]                # 候选挂载点

输出严格 markdown：
  # 建议：<在 <nav> 下新增/补充 "<topic>" 章节>
  ## 当前用户的痛点（脱敏抽样）
  - <query 1>
  - <query 2>
  ...
  ## 建议覆盖的事实点
  - <事实点 1>
  - <事实点 2>
  ## 建议挂载位置
  <nav 路径 + 锚点>
  ## 元数据
  cluster_id / 信号源（β/RFC0005）/ size

只输出 markdown，不要任何额外文本。
```

输出长度上限 1500 字符；超出截断。

### 4.5 输出形态

```
state/<projectId>/feedback/suggestions/
  cluster_<id>.md         # shadow + production 都写这里（区别在前 frontmatter）
  cluster_<id>.json       # 算法 trace：成员 ids、相似度矩阵、center query
  .shadow/                # shadow 模式时所有产出落这里子目录
    cluster_<id>.md
    cluster_<id>.json
```

markdown frontmatter（PRD §11.3 §11.4 git-friendly 风格延续）：

```
---
cluster_id: c_2026-05-24_3a7b
center_query: hermes 怎么配置 model provider？
member_count: 7
signal_sources: [beta_negative, citation_partially]
generated_at: 2026-05-24T12:30:00Z
shadow: false
---
```

### 4.6 CLI 形态

```
anydocs-ask feedback diagnose <projectRoot>
  [--since 7d]                 # 反馈窗口 (默认 7d)
  [--shadow]                   # 写 suggestions/.shadow/ 而非主目录
  [--threshold 50]             # 反馈量阈值，未达不写真产出 (默认 PRD 值)
  [--observation-window 28d]   # 4 周观察窗 (默认 PRD 值)
  [--limit 5]                  # 最多产出 cluster 数 (默认 5)
  [--dry-run]                  # 不写文件，只打印 cluster 详情
```

**门槛检查**：未达 50 条 || 观察窗 < 4 周 → 默认拒跑（除非 `--shadow` 或 `--threshold` override），打印 "<n> rows / <d> days; need 50 + 28d; use --shadow to bypass"。

### 4.7 Studio 接口（依赖 RFC 0002）

Feedback tab：

- KPI tile `A+ candidates` 从 "—" 变成 `<cluster_count> shadow` 或 `<cluster_count>`（已 enabled）
- 新增 `aplus_candidates` chip：过滤到出现在 cluster 里的 feedback 行
- Drawer 新增 SUGGESTION 段：cluster_id / 同簇 peer queries / suggestion preview / "在文件里查看" 链接（开本地 markdown）

### 4.8 失败模式

| 场景 | 行为 |
|---|---|
| feedback 不到 50 条 | CLI 拒跑（除非 `--shadow`）；Studio 显示 "再积累 N 条" 引导 |
| LLM 建议生成超时 / 抛错 | 整 cluster 跳过；其他 cluster 继续；stderr warn |
| nav 数据缺失 | 建议挂载位置写 "(unknown)"，不影响其他字段 |
| 嵌入 cache 缺失 | 现场补算（首次 diagnose 慢，后续走 cache） |
| `aplus.enabled=false`（默认） | CLI 仍可显式 `--shadow` 跑；Studio KPI tile 显 "—" |

---

## 5. 决策记录（2026-05-24 锁定）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 聚类算法 | **threshold-based union-find on bge-m3 cosine**（§4.2） |
| Q2 | 嵌入是否重算 | **复用 `embedding_cache`**，首次 diagnose 才补齐（§4.3） |
| Q3 | 建议生成用什么模型 | **复用现有 Anthropic 通道**（B.2 / RFC 0003/0005 一致路径） |
| Q4 | γ 隐式信号是否进 A+ | **不进**（PRD §11.4 红线 + RFC 0001 §F1） |
| Q5 | 输出在 `suggestions/` 子目录命名 | `cluster_<id>.md` + 同名 `.json` trace；`.shadow/` 子目录 |
| Q6 | shadow → on 是否自动 flip | **不自动**。operator 显式 `aplus.enabled=true`；满足门槛时 CLI / Studio 提示但不动 |
| Q7 | 跨语言聚类 | **同 embedding 空间**（bge-m3 是多语模型）；不区分 |
| Q8 | 同 cluster 多次跑 diagnose 是否覆盖 | **覆盖** `cluster_<id>.md`；`<id>` 是基于 cluster 中心查询的 hash，稳定 |

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 阈值 0.65 在不同项目效果不稳 | simulator + 多项目 dogfood；config 化 `aplus.embedSimilarityThreshold` |
| 50 条以下的 cluster 给作者噪声推荐 | shadow 模式 + 门槛检查 + operator 显式 flip |
| LLM 生成建议跑偏（推测事实点） | prompt 强约束：只能基于输入 query + answer + nav；不引入外部知识 |
| `feedback/suggestions/` 与 git 冲突 | suggestions 目录在 `.gitignore` 默认（与 inbox/ 同处理）；shadow 输出更要 ignored |
| Reranker 路径上线后双信号冲突 | A+ 与 reranker 用不同 feedback 通道（A+ 看 cluster，reranker 看 sample-level rating） |
| design partner 反馈量永远不到 50 | shadow 模式继续运转，提供 dogfood-level demo；产品价值不卡阈值 |

---

## 7. 与其他 RFC 关系

| RFC | 关系 |
|---|---|
| [0001](./0001-feedback-loop-v0.2.md) | 数据源：β 显式 + 高质量 γ 信号；推荐 `feedback.signal_source IN ('explicit')` |
| [0002](./0002-console-studio-feedback-loop.md) | Studio Feedback tab A+ 视图（A7）是 RFC 0002 T1 的延伸——既有 KPI tile `aplusCandidates` 当前 null，本 RFC 接通 |
| [0003](./0003-multi-turn-session-rewrite.md) | session 内 follow-up 模式是失败信号补充（A1.2 "clarify 后没选子树"）|
| [0004](./0004-embedded-ask-widget.md) | widget 流量进同 feedback 表，A+ 自动包含 widget 来源信号 |
| [0005](./0005-citation-semantic-validation.md) | verdict ≠ `supports` 作为 A1.4 增强信号（H2 候选） |

---

## 8. 未涉及

- A+ 建议的「作者反馈」回路（作者 accept / reject 后自动调权）→ H1，需 reranker 就绪后单独立项
- 多项目 A+ 跨切片（design partner 用 2+ 项目时的全局视图）→ H3
- 自动 PR 形态（A+ 建议 → `pages/*.json` patch PR）→ H4，需用户明确请求
- A+ 历史归档 / 时间序列（多次 diagnose 输出的演化）→ 0.5+ Console 时序视图

---

## 9. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-24 | 起草（0.4 alpha 链路 + 5 决策点 + 4 永不做）| @shawndslee |
| 2026-05-24 | **升档 Accepted + alpha.0 alignment**：`anydocs.ask.json.aplus` schema 留位 + CLI `feedback diagnose` stub。零行为变化。详见 §1.4 升档论证 + §3 里程碑首行 alignment PR | @shawndslee |
