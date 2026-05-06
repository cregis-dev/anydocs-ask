# Anydocs Ask — 产品需求文档（PRD）

> Status: v0.1 锁定
> Date: 2026-05-04
> Scope: v1（首版）
> 配套：[ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 1. 背景与动机

Anydocs 的核心价值在于创作者的**编排意图**——他们花时间把文档归类成"入门→进阶→高阶"或"V1→V2"，每一层级、每个排序都承载着判断。

主流 AI 问答接入文档系统时会做三件破坏编排意图的事：

1. **降维打击**：把立体知识树压扁成纯文本片段，混淆"V1 废弃接口"和"V2 推荐接口"。
2. **断章取义**：抓取到"第三步：执行部署"的内容，丢失了它在《环境 A 配置》目录下的语境。
3. **空间感缺失**：用户在《前端 API 手册》页面问"如何鉴权"时，AI 进行全局检索，返回后端或运维的鉴权方式。

**Anydocs Ask 的存在前提是承认编排意图为一等公民。** 系统的认知框架严格服从作者定义的层级网络，而不是让 LLM 自己去算相关性。

---

## 2. 愿景

一个**"读懂目录结构"**的本地优先问答服务：

- 给对外发布的开发者文档和产品手册接入一个能用的 Ask 入口
- 服从作者的编排顺序、子树关系和发布边界
- 拖拽目录不重算 embedding，编辑文本才重算
- 引用必须含完整面包屑路径

---

## 3. v1 目标用户与场景

### 3.1 主要场景

**对外发布的开发者文档站点 / 产品手册站点的终端用户问答。**

读者打开站点（Reader），在某个页面上唤起 Ask，提一个问题，得到一个**带结构感的回答 + 可追溯的引用**。

### 3.2 典型问题类型

| 类型 | 示例 |
|---|---|
| 事实查询 | "如何鉴权？" / "怎么调用 X API？" |
| 跨版本比较 | "v2 和 v3 有什么区别？" |
| 排错 | "为什么 webhook 返回 401？" |
| 产品手册查询 | "Pro 版包含哪些功能？" |
| 操作流程 | "如何从 free plan 升级到 team plan？" |

### 3.3 典型用户行为

- 在某具体页面点 "Ask" 按钮，希望系统知道当前语境
- 提问时使用业务术语、缩写（API、SDK、JWT、CLI 等）
- 期望直接得到答案，不愿点开 5 个搜索结果逐一阅读
- 看到答案不对时希望反馈一下（"这条不对"），但不会写长评论

### 3.4 显式不在 v1

- 内部 Studio 编辑场景的特化体验
- agent / MCP 调用接口
- Slack / Discord / 站外平台对接
- 跨多个 anydocs 项目的联邦检索
- 多语言 UI 切换控件（系统支持多语言索引 + 跨语言降级，但 Reader 端不提供"切换答案语种"按钮，详见 §4.8）

---

## 4. 核心产品原则（不可妥协）

每条都是 Ask 的"做与不做"判定线。任何实现方案违背任意一条 → 否决。

### 4.1 编排意图优先

AI 必须看懂目录树。作者把文档放在更靠前位置或更高层级 → 该文档对相关问题的优先级更高。

**严禁**靠 LLM 自己计算"哪个文档更重要"——以编排顺序作为先验注入到检索得分中。

> v1 的近似：用 `nav_index`（在导航树中的序号）作"重要性"先验。  
> v1.5+：anydocs 主仓加 `nav.weight` / `page.priority` 字段后启用完整版。

### 4.2 结构坐标上下文绑定

提问必须与当前所在的子树/版本绑定。Reader 调用 Ask 时传入 `current_page_id`，系统对同一子树命中加权。

**严禁**默认全局检索——同子树为主，全局为辅。

显式传入 `scope_id` 时，系统硬过滤到该子树；未知 / 已删 / 已 unpublish 的 `scope_id` 必须返回 HTTP 400，**绝不静默降级为全局检索**。

### 4.3 结构化输出

输入是结构化的，输出不能退化为干瘪文本：

| 问题形态 | 输出形态 |
|---|---|
| 比较类（A vs B / 差异 / 区别） | Markdown 表格 |
| 操作类（如何 / 步骤 / 怎么） | 有序列表 |
| 概念类（什么是 / 介绍） | 段落 + 关键术语 bullet |
| 含代码引用 | 保留代码块、语言标签、API 名 inline code |

### 4.4 树状降级反问

歧义提问时，**严禁** LLM 编造。系统用编排树本身作为反问选项：

> "您询问的鉴权，是指 [前端 SDK] 下的，还是 [后端 API] 下的？"

选项必须是**子树标签**，而不是"列出 top 5 文档让你选"。这是与传统 RAG 的关键差异。

**反问优先级高于格式化**：触发反问时直接返回 clarify 响应，不进入 §4.3 的输出格式判断；用户选定 `scope_id` 重发后才走完整的生成 + 格式化流程。

### 4.5 边界与版本隔离

未发布的页面**绝不**进入回答的依据集，即使语义相关度 100%。

v1 实现：`published` 状态硬过滤 + 单 anydocs 项目隔离（一进程一项目）。

> 多版本 / 多 audience 的细粒度隔离待 anydocs 主仓加 `audience` / `version` 字段后实现。

### 4.6 拖拽零重算

下列动作**不得触发任何 embedding 重算**：

- 拖拽目录改顺序 / 改父子关系
- 改页面标题 / slug / tags / SEO 等 metadata
- 发布状态切换（published ↔ draft）

仅当**正文 DocContentV1 节点**变更时，才重算**受影响的 chunk**（其他 chunk 命中 content_hash 缓存）。

任意上述非正文动作发生时：

- Ask 必须感知到变化（用户可接受的延迟内）
- **embedding API 调用次数 = 0**
- 引用的面包屑随之自动更新

实现方式：双层索引 + content_hash 缓存（详见 ARCHITECTURE.md 第 2 节）。

### 4.7 立体溯源

每个回答包含至少 1 条引用。每条引用必须含：

- 完整面包屑路径（如 `[快速开始] > [核心概念] > [状态管理]`）
- 可点击跳转的 URL（含 anchor 定位到段落）
- 来源段落片段（snippet）

### 4.8 多语言策略

> 状态：2026-05-06 锁定。anydocs 项目在 `pages/{lang}/` + `navigation/{lang}.json` 形式下天然多语言（v1 起 zh / en 双语为典型形态）。

**核心原则：同语言优先 + 跨语言翻译降级 + 溯源保留原文。**

| 场景 | 行为 |
|---|---|
| query 是 zh，且 zh 文档有充分命中 | 用 zh chunks 生成 zh 答案；citations 全是 zh |
| query 是 zh，但 zh 文档无命中（仅 en 有） | 用 en chunks 生成 zh 答案；citations 仍含 `lang: en` 的原文片段（snippet **不翻译**）；正文开头加一句"原文为英文文档，已为您翻译要点："提示 |
| query 是 zh，跨多个 zh 子树命中分散 | 走 §4.4 树状反问；反问选项**只显示 zh 子树**，反问文案也用 zh |
| query 是 zh，zh 与 en 子树都有命中 | 同 lang 优先（lang_boost）；如果 lang_boost 之后仍是 zh 主导子树 → 直答 zh；如果 zh 完全没命中才走翻译降级 |

**实现要点：**

- query lang **服务端检测**（中文字符比例 ≥30% → zh；否则 en），不破 `/v1/ask` API（不引入 `query_lang` 字段，参见 ARCHITECTURE §6 步骤 1.5）
- citation 必带 `lang` 字段；与 query lang 不同时额外带 `source_lang`；**snippet 不翻译**（避免误导作者溯源）
- clarify 反问只在同 lang 子树间做（混 lang 反问破坏体验）
- embedding 必须是多语言模型（默认 `bge-m3`，详见 ARCHITECTURE §8）
- 跨语言降级仅当**同 lang 完全无命中或得分极低**时触发，不在主流路径

**严禁**：默认全局检索时把所有语言 chunks 一起喂给 LLM；这会让答案在多语种间来回横跳，破坏 §4.7 溯源体验。

---

## 5. v1 功能需求

### 5.1 提问与回答

- HTTP 接口：`POST /v1/ask`
- 入参：`question` + `context.current_page_id`（可选）
- 返回二选一：
  - **答案响应**：`answer_md` (markdown) + `citations[]`（含完整面包屑）+ `answer_id`（用于关联反馈）
  - **澄清响应**：`clarify` + 子树选项 `[]`
- Reader 端 UI：modal / 侧栏输入框，呈现 markdown 答案 + 可点击的面包屑引用 + 反馈控件

### 5.2 反馈采集

- HTTP 接口：`POST /v1/ask/feedback`
- 每个答案下展示：👍 / 👎 / "答错了，正确答案是…"
- 反馈带完整上下文落库：question / retrieved chunks / generated answer / user correction / bad_citation_ids / model used / timestamp
- `/v1/ask` 响应中每条 citation 带 `citation_id`；反馈可指明"哪几条引用错"（v1 schema 留位，UI 可在 v1.5 启用以收集 citation 级信号）
- **此数据为后续 prompt 调优 / DSPy / fine-tune 的基础设施，v1 必须埋**

### 5.3 索引管理

- 启动时全量索引 `pages/*.json` + `navigation/*.json`
- 文件监听增量更新（chokidar）
- HTTP：
  - `GET /v1/index/status` — 索引健康度（doc count、last_indexed_at、embedding model）
  - `POST /v1/index/rebuild` — 强制重建（运维接口）

### 5.4 配置

- 项目根放 `anydocs.ask.json` 覆盖默认（embedding / LLM / 检索参数）
- 缺省走全局默认
- LLM API key 仅从环境变量读取，不写配置文件

### 5.5 CLI 入口

独立 CLI（不入侵 anydocs 主仓 CLI）：

```
anydocs-ask serve   <projectRoot> [--port 3100] [--host 127.0.0.1]
anydocs-ask reindex <projectRoot>
anydocs-ask status  <projectRoot>
```

或免安装：`npx -y @anydocs/ask serve <projectRoot>`。

一进程一项目；多项目通过多端口部署。

---

## 6. 非功能需求与约束

### 6.1 性能

| 指标 | 目标 |
|---|---|
| 单次问答 P50（warm） | ≤ 3s |
| 单次问答 P95（warm） | ≤ 8s |
| 1000 页项目首次索引 | ≤ 5min（本地 embedding） |
| 拖拽目录到反映在新问答里 | ≤ 10s（"用户可接受"） |

**冷启动与 warm-up**：服务启动时必须执行预热（embedding 模型加载 + 一次空 embedding 调用），warm-up 期间 `GET /v1/health` 返回 503。所有 P50 / P95 指标仅覆盖 warm 状态；冷启动时长（典型 5-10s，本地模型）不计入。Reader 端应在调用 `/v1/ask` 前轮询 `/v1/health` 至 200。

### 6.2 可用性

- 进程崩溃自动重启（依赖外部进程管理：pm2 / systemd / Docker restart）
- LLM API 故障 → 返回结构化错误，**不降级成幻觉回答**
- embedding API 故障 → 索引暂停但服务可继续（仅查询已索引内容）

### 6.3 安全

- 默认绑定 `127.0.0.1`；公网部署需显式 `--host 0.0.0.0` + 反向代理
- 任何接口都不返回未发布内容（即使运维接口）
- 反馈数据库不含 PII；调用方可在 v1.5 配置脱敏 hook
- **CORS**：开发模式默认放行 `http://localhost:*` / `http://127.0.0.1:*`；生产模式从 `anydocs.ask.json` 读 `server.cors.allowedOrigins` 白名单，未配置 → 拒绝所有跨域请求（fail closed，不静默放行）

### 6.4 本地优先

- 不强依赖云端服务（除 LLM API 外）
- embedding 默认本地多语言模型 `bge-m3`（~600MB，1024 维；与 §4.8 多语言策略配套）；可切远端或单语小模型
- 索引数据持久化为本地 SQLite 文件
- 首次安装的磁盘下行：bge-m3 模型 ~600MB（onnx int8 量化版可降至 ~300MB；v1 默认 fp32）；项目方对体积敏感时可在 `anydocs.ask.json` 切回单语小模型（如 bge-small-zh / bge-small-en，~100MB），但跨语言降级体验同步降级
- 离线场景：本地 embedding + 本地 LLM（v1.5 通过 Ollama 选项实现）

### 6.5 不动 anydocs 主仓 schema

v1 仅读 `pages/*.json` + `navigation/*.json` 的现有结构，不要求 anydocs 增加任何字段。任何"如果有 X 字段会更好"的部分都按近似实现，标记为 v1.5+ 升级点。

---

## 7. v1 显式不做

| 项 | 推迟到 | 理由 |
|---|---|---|
| 内部 Studio 用户特化体验 | v1.5 评估 | 体量小、需求待真实使用后再判断 |
| MCP / agent 调用接口 | v2 | 与 v1 用户场景正交，单独成版本 |
| 建议问题侧栏（"你可能想问"） | v1.5 | 产品价值大但非核心闭环 |
| 流式响应（SSE） | v1.5 | 一次性返回够用 |
| 实体表 + query expansion（缩写词扩展） | v1.5 | 看 v1 真实查询日志再判断需求强度 |
| 宏 / 微观意图分流 + 摘要层 | v1.5 | 同上 |
| DSPy 编译优化 | v2 | 标注数据 ≥200 条后再上 |
| Shadow Wiki / LLM 衍生知识图谱 | 不做 | 解错了 PRD 4.6 的题 |
| 多 anydocs 项目联邦检索 | v2 | 单项目场景未充分验证前不扩 |
| 多 audience 细粒度边界 | 待 anydocs 加 `audience` 字段 | 上游依赖 |
| "核心必读" 显式权重 | 待 anydocs 加 `nav.weight` / `page.priority` | 上游依赖；近似用 `nav_index` |
| 离线 LLM（Ollama） | v1.5 | 体积大、效果未达稳定 |
| 多语言 UI 切换控件（让用户手动选答案语种） | 看真实需求 | 系统已按 query lang 自动决定，UI 切换是另一层产品决策 |

---

## 8. 验收标准（v1 上线门槛）

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 拖拽目录 / 改标题 / 改 tags / 切换发布状态后 embedding API 调用为 0 | 端到端测试 + 调用 mock 计数 |
| 2 | 每个回答 ≥1 引用，引用含完整面包屑 | 自动测试 + schema 校验 |
| 3 | 未发布页面绝不出现在 used chunks | 自动测试 + 红队样本 |
| 4 | 跨子树歧义问题触发 clarify 而非直答 | 黄金样例集 |
| 5 | "对比 A 和 B" 类问题输出 markdown 表格 | 黄金样例集 + 格式校验 |
| 6 | 答案中代码块 / API 名都在 chunks 出现过 | 后处理校验 |
| 7 | answer_id 能关联回 feedback 落库 | 集成测试 |
| 8 | P50 ≤ 3s，P95 ≤ 8s | 压测 |
| 9 | 1000 页项目首次索引 ≤ 5min | 压测 |
| 10 | LLM API 故障时返回结构化错误，无幻觉降级 | 故障注入测试 |
| 11 | query 为中文但项目仅含英文 published 页时，返回**中文答案 + 英文原文 citation snippet**（含 `source_lang: 'en'` 标记）| 黄金样例集 |
| 12 | 双语项目内 query 为 zh 时，若 zh 子树存在充分命中，`used_chunks` 中**不出现** en 页面的 chunks | 红队样本 + lang 字段断言 |
| 13 | clarify 触发时 `options[]` 全部同 query lang；不出现混 lang 选项 | 集成测试 |

---

## 9. 依赖与遗留

### 9.1 与 anydocs 主仓的关系

**v1 不要求 anydocs 主仓做任何 schema 改动。** 仅消费现有的 `pages/*.json` + `navigation/*.json` 结构，所有"如果有 X 字段会更好"的部分都按近似实现并锁为 v1 默认行为：

- 编排权重：用 `nav_index`（导航树序号）近似，**这是 v1 永久方案**，不假设主仓未来会加字段
- audience / 多版本隔离：通过"一进程一项目"的部署形态实现项目级隔离；细粒度 audience 不在 v1
- Reader 站点的 Ask UI 控件（输入框 / 反馈按钮 / 答案 modal）：需要 anydocs 团队**单独**评估和实施，与 Ask 服务版本解耦；Ask 服务本身只提供 HTTP API，不强制 Reader 同时改

### 9.2 已知 v1 妥协（接受）

1. "必读"信号靠 `nav_index` 近似，可能与作者直觉有偏差——可通过调整作者侧的导航顺序变通
2. 缩写词召回不全（无实体扩展层）——BM25 + FTS5 兜底处理已知词形
3. 跨页摘要类问题效果一般（无摘要层）——但 v1 目标场景以"事实查询 / 操作 / 排错"为主，此问题影响小

### 9.3 反馈数据的下游消费者

v1 落库的反馈数据是后续多个版本的基础设施：

| 消费者 | 何时启用 |
|---|---|
| 手工 prompt 调优 | 50+ 👎 样本起 |
| 检索质量评估（eval set） | 持续 |
| DSPy 编译 | 200+ 标注起 |
| Fine-tune（如真有需要） | 1000+ 起 |

---

## 10. 后续版本展望（非承诺）

| 版本 | 重点 |
|---|---|
| **v1.5** | **QA 反馈回路（见 §11，已立项）** / 实体表 + query expansion / 意图分流 + 摘要层 / 流式响应 / Ollama 选项 |
| **v2** | DSPy 编译（基于 v1 数据）/ MCP 接口 / 多项目托管 |

---

## 11. v1.5 增量：QA 反馈回路（计划）

> Status: v0.1 计划（未实现）
> Date: 2026-05-06
> 触发条件：v1 上线并积累 ≥ 4 周真实查询日志后启动
> 详细架构：[ARCHITECTURE.md §15](./ARCHITECTURE.md)

### 11.1 目标

把 v1 已埋的 `feedback` 表数据转化为两条优化路径，并维护一份**人工审核过的高质量 QA 记录**作为可信输入：

- **A：reranker 加权**——基于反馈调整召回排序
- **A+：失败查询诊断**——聚类"答不好"的 query，输出"应补什么文档"的建议给作者

### 11.2 决策边界（2026-05-06 锁定）

四条决策，决定本节的所有设计取舍。任何后续提议违背任意一条 → 视为破 v1.5 边界，需重新评审：

| # | 决策 | 否决的方案 |
|---|---|---|
| 1 | 审过的 QA **不进检索**，仅当 reranker 信号 + 作者补文档建议 | Shadow Wiki / 把 QA 当 chunk 进库 / "审过即可作为答案源" |
| 2 | 反馈信号优先 β（Reader 显式按钮），无 β 时降级 γ（隐式信号） | 仅 γ；强制 anydocs Reader 全量改造 |
| 3 | QA 记录走**文件路径**（导出 markdown 由作者审，再 import 回库），不只在 SQLite 黑盒 | 内置 Web review 面板 / SQLite-only 审核 |
| 4 | 本节为 v1.5 增量，**v1 PRD 主体（§1-§9）不动** | 把任何 v1.5 功能塞进 v1 验收 |

### 11.3 功能需求

#### F1 反馈信号收集（β + γ）

**β（首选）**：Reader 答案区接入「答得好 / 答得差 / 答错了」按钮，调 v1 已有的 `POST /v1/ask/feedback`。

- v1 已锁"不入侵 anydocs 主仓"。v1.5 破例**只破一个按钮 + 一个 fetch 调用**这一点点边界，需 anydocs 团队同步评审与实施。
- 反馈控件出现在哪些 Reader 站点由 anydocs 团队按需启用，**Ask 服务不强制**。

**γ（兜底）**：未启用 β 的项目走隐式信号。

- 服务端可推：用户连续追问改写（同 session 5 分钟内）→ 弱负信号
- Reader 极小改造可推（一个 fetch 上报）：用户提问后未点击任何 citation / 离场 / 关闭 modal → 中等负信号
- 隐式信号**只用于 reranker**，**不进入 A+ 的"应补文档"建议**（噪声太大）

#### F2 失败查询诊断（A+）

周期任务（默认每周）扫 `feedback` 表，挑出符合任一条件的 query：

- 显式负反馈 ≥ 2 次的同语义簇
- 触发 clarify 后用户未选择任何子树
- 检索 top-1 RRF 分数 < 阈值（默认 0.05）

每簇产出一份「补文档建议」，含：建议挂在哪个 navigation 节点下、应覆盖什么内容、关联的 query 样本（脱敏）。

#### F3 QA 记录文件化（人工审核）

QA 记录走文件路径（详细 layout 见 ARCHITECTURE §15.5）：

```
.anydocs-ask/feedback/
├── inbox/         # 待审：每个 query 簇一份 markdown
├── approved/      # 审过通过：JSONL，喂 reranker
├── rejected/      # 审过否决：JSONL，仅留痕
└── suggestions/   # A+ 输出的"应补文档"建议
```

CLI：

```
anydocs-ask feedback export    # 待审 QA → inbox/*.md
anydocs-ask feedback import    # inbox/ 审过的 → approved/ or rejected/
anydocs-ask feedback status    # 队列长度 + 最近统计
anydocs-ask feedback diagnose  # 触发 A+ 失败查询诊断
```

审核流：作者用编辑器 / git 改 inbox/ 里的 markdown（标 `decision: approved/rejected` + 可选修正答案），跑 `import` 落库。**可 git commit + PR review**，多人协作友好。

### 11.4 核心约束

1. **审过的 QA 不进检索**——明确否决"Shadow Wiki / LLM 衍生知识层"。审过的 QA 仅用作 reranker 信号 + 给作者的补文档建议；不会作为 chunk 出现在召回结果里。
2. **作者不点头不写 anydocs**——A+ 产出的只是建议草稿，永远不自动写回 `pages/*.json`。
3. **β 不强制**——Reader 端是否加反馈控件由 anydocs 团队评估；未启用时自动降级到 γ。
4. **隐式信号 ≠ 显式信号**——γ 通道在 reranker 中权重低于 β（具体权重见 ARCHITECTURE §15.3）。
5. **数据本地优先**——`feedback/` 目录不上传任何远端服务；审核全在本地。
6. **默认关闭**——`feedback.enabled = false` 是默认；项目方显式开启才生效。

### 11.5 v1.5 验收标准（占位）

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 审过的 approved QA 不出现在 `/v1/ask` 的 `used_chunks` 里 | 红队验证 |
| 2 | 引入 β 信号后，黄金样例集 NDCG@5 不下降 | 消融实验 |
| 3 | A+ diagnose 周报对真实失败 query 覆盖率 ≥ 80% | 抽样人工评 |
| 4 | inbox/ 文件审过 import 后自动归档（作者侧零额外操作） | 集成测试 |
| 5 | feedback 关闭时（默认）查询管线行为与 v1 等价（无副作用） | 回归测试 |

> 阈值在 v1 上线、积累 ≥ 200 条 feedback 后基于真实数据校准；当前仅占位。
