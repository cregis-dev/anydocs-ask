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
| 含代码引用 | 保留代码块、语言标签、API 名 inline code（代码块在索引里跟随所在 section，不独立成 chunk，详见 ARCH §6 / §7.1） |

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

## 10. 后续版本展望（修订版）

> 修订日期：2026-05-20
> 触发：0.1.0 发布（2026-05-16）+ 1–2 家外部 design partner 真实使用反馈 + 0.2 反馈回路 RFC 起草过程中的认识更新
> 旧版（2026-05-04）保留在 git 历史；以本节为准

### 10.1 叙事演进：从"文档问答"到"文档质量闭环"

v1 立项时的叙事是"读懂目录结构的文档问答服务"。0.1.0 上线、首批 design partner 接入后，**ask 工程的差异化定位收敛为"文档质量的闭环引擎"**：

- **本体能力**（检索 + 生成）在 0.1.0 已接近这个语料下结构化方案的上限（RRF + 实体注入 + 结构化 rerank），继续做边际优化性价比快速下降；
- **真正不可复制的位**：anydocs 全家桶同时拥有"文档内容"和"用户问答行为"两侧数据，能形成"提问 → 命中分析 → 文档盲点 → 作者补文档 → 答案改善"的完整闭环；竞品（chat widget 单点 / 文档平台单点）都做不到；
- **后续 roadmap 围绕"闭环"这条主线编排**。本体的检索/生成增强（reranker、query 重写等）只服务于闭环数据所揭示的真实瓶颈，**不做先验优化**。

### 10.2 版本路线（按时间顺序）

| 版本 | 期 | 主线 | 关联 RFC |
|---|---|---|---|
| **0.2**（2026-05-23 已发布）| 2026-05 | 反馈回路管道铺通 + Console → Studio 升级、反馈闭环主线 + early multi-turn (RFC 0003 M1-M6 默认开启) + citation 校验 schema 留位 (RFC 0005 alpha) | [RFC 0001](./docs/rfcs/0001-feedback-loop-v0.2.md) / [RFC 0002](./docs/rfcs/0002-console-studio-feedback-loop.md) |
| **0.3**（2026-05-24 已发布）| 2026-05 | Citation 语义校验全链路（alpha.2 pipeline + V5 Studio 展示）+ 嵌入式 Ask Widget MVP（alpha.0→alpha.3 完整栈）—— 原 0.4 widget 主线提前到 0.3；0.3.1 补丁追加 RFC 0006 A+ alpha 链路（以 `0.4.0-alpha.X` 名义随车搭载、默认 `aplus.enabled=false`，功能上仍归 0.4） | [RFC 0005](./docs/rfcs/0005-citation-semantic-validation.md) / [RFC 0004](./docs/rfcs/0004-embedded-ask-widget.md) |
| **0.4** | 2026-06+ | A+ 失败查询诊断剩余链路（alpha.3 Studio A+ 视图 + 0.4.0 flip enabled，≥ 50 反馈 + 4 周观察窗后由 operator 触发）+ Citation 校验 H1 升级硬门槛（视 shadow 数据，§2.2 触发条件）+ Widget cross-origin direct mode + shadow DOM 形态 | [RFC 0006](./docs/rfcs/0006-failure-query-diagnostic-aplus.md) / [RFC 0005](./docs/rfcs/0005-citation-semantic-validation.md) H 系列 / RFC 0004 0.4.1+ |
| **0.5+** | 2026-Q3+ | Widget 企业接入（user token + multi-tenant） + Reranker 数据驱动启用（≥ 200 条门槛后 shadow → 上线） | RFC 0004 Phase 4 / RFC 待立项 |
| **远期**（v1.x / v2） | 待定 | DSPy 编译、MCP 接口、Ollama 选项、意图分流 + 摘要层、实体表 + query expansion 整合为"query 理解增强"线 | 待立项 |

### 10.3 0.3 启动阈值（拆分）

原 RFC 0001 §2.2 用 "≥ 200 条反馈" 单一阈值卡所有 0.3 项启动；本次修订**拆分为按子项**的阈值，避免诊断功能被 reranker 的样本量要求拖累：

| 0.3 子项 | 启动阈值 | 理由 |
|---|---|---|
| **A+ 失败查询诊断** | ≥ 50 条反馈 + ≥ 4 周观察窗 | 诊断是聚类 + 建议生成，对样本质量敏感性高于样本量；50 条已能形成 ≥ 3 个有效语义簇；早 1–2 周给作者补文档信号 |
| **Reranker A 路径加权** | ≥ 200 条反馈 + 显式负反馈 ≥ 30 条 | 调权需统计显著的负样本；门槛沿用原值；额外补充"必须先 shadow 模式跑两周对比"的前置（详见 §10.5） |
| **Citation 语义校验** | 无反馈量门槛 | 独立功能，作为反馈回路精度增强项；与 A+ 并行推进 |

### 10.4 Console → Studio 的定位升级（0.2 内）

[console-redesign-brief](./docs/console-redesign-brief.md) 已经把 Console 定位为主要接口，列了 5 个 user journey。本次修订**新增 Journey 6 "Close the feedback loop"**（详见 RFC 0002），并把它升级为 Studio 化叙事的主轴：

- 反馈数据可视化（no_citations / 低 confidence / 显式 👎）
- 失败 query 聚类视图，挂回 nav 子树
- 文档章节页显示"过去 7 天用户在附近问的问题 + 命中率"
- Journey 之间的穿透式跳转（traffic → golden case / eval 回归 → trace + 文档章节）

这条主线落地后，design partner 续费理由从"AI 问答可用"升级为"它让我知道文档要改哪里"，是 ask 工程从工具到产品的拐点。

### 10.5 Reranker 的"先量再加"原则（0.5+）

原 PRD §11 / RFC 0001 默认 0.3 起就加 reranker。本次修订把 reranker 启用做了三档前置：

1. **前置 1**：运行 `anydocs-ask eval` 量出现有 top-K 精度基线（用 golden 集，不需要反馈数据）；
2. **前置 2**：满足 §10.3 表中 reranker 阈值（≥ 200 条反馈 + ≥ 30 条显式负）后，**shadow 模式**接入 `bge-reranker-v2-m3`，跑 ≥ 2 周对比当前结构化 rerank 与 cross-encoder rerank 的 top-8 差异；
3. **前置 3**：shadow 数据证明胜过现状（precision@8 提升 ≥ 0.05 或失败 query 命中率提升明显）才合并到生产路径。

不满足三档之一不强行上线 reranker。

### 10.6 不再保留 / 优先级下调

- ~~"v1.5 / v2" 标号~~ → 改用 0.x 语义化版本号，对齐 [CHANGELOG.md](./CHANGELOG.md)
- "Ollama 选项" → **保留但移到 0.5+**，触发条件改为"有 design partner 明确提出本地 LLM 诉求"（多见于企业内网客户）
- "意图分流 + 摘要层" → **保留但移到 0.5+**，触发条件改为"0.3 诊断数据显示 vocabulary mismatch 失败率 ≥ 阈值"，与"实体表 + query expansion"合并为单一"query 理解增强"线
- "流式响应" → 已在 0.1.0 实现（`/v1/ask/stream` SSE），从展望清单移除
- "DSPy 编译" → 远期目标不变，依赖 0.3 数据积累 ≥ 6 个月 + 200+ 审过 QA

### 10.7 新增明确不做（与 §11.2 红线一致）

延续 §11.2 已锁的四条红线，本次再追加四条：

- **审过的 QA 进检索** ❌（§11.2 决策 ① 沿用）
- **自动写回 anydocs `pages/*.json`** ❌（§11.2 决策 ② 沿用）
- **内置 Web 审核面板** ❌（§11.2 决策 ③ 沿用；Studio 化也保持"审核走文件 + git"）
- **强制 anydocs Reader 全量改造** ❌（§11.2 决策 ④ 沿用）
- **Reranker 凭直觉添加** ❌（必须满足 §10.5 三档前置）
- **多轮对话以"Reader 多轮 UI"为优先支撑场景** ❌（Reader 多轮在 anydocs 主仓评估；ask 工程的 multi-turn 设计**优先服务于嵌入式产品 UI**，避免被 Reader UI 排期拖累，详见 RFC 0003）
- **嵌入式 Widget 自动抓取宿主 DOM 数据** ❌（数据上下文必须由宿主显式 `setContext()` 注入，避免隐私边界争议，详见 RFC 0004）
- **用小模型替代大 LLM 生成最终答案** ❌（grounding 保真度风险）。**历史注**：RFC 0003 / 0005 起草版本曾把小模型保留为辅助角色（query 重写 / citation 校验 / 可答性判断）；两者落地阶段（2026-05 B.2 转向）均改为**复用现有主 LLM 通道**，anydocs-ask 不再引入任何小模型基础设施。本红线现在等价于"辅助角色由主 LLM 异步承担"。

### 10.8 RFC 索引

| RFC | 标题 | 状态 | 关联版本 |
|---|---|---|---|
| [0001](./docs/rfcs/0001-feedback-loop-v0.2.md) | 0.2 反馈回路落地 | **0.2.0 已落地** | 0.2 |
| [0002](./docs/rfcs/0002-console-studio-feedback-loop.md) | Console → Studio：反馈闭环主线 | **0.2.0 T1-T4 已落地** | 0.2 |
| [0003](./docs/rfcs/0003-multi-turn-session-rewrite.md) | 多轮对话 + Session 重写 | **M1-M6 已接通**（0.2.0 默认开启 / 0.4 主线收尾） | 0.4 |
| [0004](./docs/rfcs/0004-embedded-ask-widget.md) | 嵌入式 Ask Widget | **Accepted, alpha.0→alpha.3 已落地**（0.3.0 widget MVP + 跨域 gate + chat polish + bubble/theme/docsBaseUrl polish） | 0.3 / 0.4 cross-origin direct mode 续 |
| [0005](./docs/rfcs/0005-citation-semantic-validation.md) | Citation 语义校验（B.2 复用主 LLM） | **alpha.2 全链路接通**（0.3.0 V3+V4+V6 pipeline + V5 Studio 展示；H 升级硬门槛进 0.4） | 0.3 / 0.4 H 系列 |
| [0006](./docs/rfcs/0006-failure-query-diagnostic-aplus.md) | 失败查询诊断（A+，PRD §11.3 F2 展开） | **Accepted, alpha.0/.1/.2 已落地**（schema + CLI 接通聚类 + 建议生成 pipeline，默认 `aplus.enabled=false`；alpha.3 Studio 视图 + 0.4.0 flip enabled 待产品门槛 ≥ 50 反馈 + 4 周观察窗达成） | 0.4 |

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
<workspace>/state/<projectId>/feedback/
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

> 阈值在 v1 上线后基于真实数据校准。
>
> **2026-05-20 修订**：原"≥ 200 条 feedback"单一启动阈值已按子项拆分——A+ 失败查询诊断 ≥ 50 条即可启动，Reranker 加权仍需 ≥ 200 条 + 显式负 ≥ 30 条，Citation 语义校验无反馈量门槛。详见 §10.3。

---

## 12. 运行环境与评测闭环（v1 + v1.5）

> Status: v0.1 计划（未实现）
> Date: 2026-05-08
> 范围：v1 立项部分（workspace / runs / 冷启动 golden / analyze 1-3 维度）+ v1.5 增量部分（β/γ 依赖的 analyze 4-5 维度）。详见 §12.8 范围分配。
> 详细架构：[ARCHITECTURE.md §16](./ARCHITECTURE.md)

### 12.1 目标

把 anydocs-ask 从"能跑"推到"可评测、可改进"，三件事一次性立项：

- **代码与运行时分离**：真实文档库、索引、ask 历史、golden、reports 全部脱离代码仓，进独立 runtime workspace，多项目并列、互不干扰。
- **评测闭环**：Golden 集 + 周期 eval + runs 历史 + analyze 诊断，让"调权重 / 改 chunk / 补文档"每一步都有数据依据。
- **冷启动门槛**：第一次加载文档后没有反馈数据时，用 Golden 三指标判断"v1 默认配置是否够用 / 文档编排是否合格"。

### 12.2 决策边界（2026-05-08 锁定）

四项决策，决定本节的所有设计取舍。任何后续提议违背任意一条 → 视为破边界，需重新评审：

| # | 决策 | 否决的方案 |
|---|---|---|
| 1 | Runtime workspace 默认路径 `~/anydocs-ask-runtime/`（可见目录、便于 git 化 golden/feedback/reports） | `~/.anydocs-ask/`（隐藏目录，习惯不会 git） |
| 2 | Golden 冷启动启用 LLM 自动生成候选 + 人工筛选 | 全人工生成（成本高、上线慢） |
| 3 | Runs 历史**默认开启**（127.0.0.1 本地、不写 PII），通过 `runs.enabled=false` opt-out | 默认关闭 / 强制 opt-in（评测和 analyze 失去数据源） |
| 4 | 多项目**并列**：每个项目独立目录、独立进程、独立端口；HTTP 服务也分开 | 一进程多项目（破 v1 §5.5 "一进程一项目"硬约束） |

### 12.3 Workspace 布局

代码仓和运行时分离：

| 角色 | 路径 | 内容 |
|---|---|---|
| 代码仓 | `/Users/ahs/code/anydocs-ask/` | TS 源码、tests、最小 `fixtures/starter-docs`（仅供单测） |
| Runtime workspace | `~/anydocs-ask-runtime/`（默认；可被 `--workspace <path>` 或 `$ANYDOCS_ASK_WORKSPACE` 覆盖） | 真实文档、索引、ask 历史、golden、reports、feedback |

```
~/anydocs-ask-runtime/
├── .env                                # workspace 全局凭证（ANTHROPIC_*、模型 override 等）
├── projects/                           # source 侧：文档项目本体（path 或 symlink）
│   ├── docs-zh/                        # 完整 anydocs 项目
│   │   ├── pages/  navigation/  anydocs.config.json
│   │   └── anydocs.ask.json            # 可选 per-project 覆盖（保留在源仓）
│   ├── hermes-docs -> /Users/ahs/code/hermes-docs/   # symlink 接入既有仓库
│   └── starter-demo/
└── state/                              # runtime 侧：所有可重建的派生数据
    ├── docs-zh/                        # state-key = anydocs.config.json projectId
    │   ├── index.db                    # sqlite + sqlite-vec + FTS5
    │   ├── runs/<YYYY-Www>.jsonl       # ask 运行记录（按 ISO 周切片）
    │   ├── golden/cases.jsonl          # 评测 Golden 集
    │   ├── reports/<date>-{baseline,eval,analyze}.md
    │   ├── feedback/{inbox,approved,rejected,suggestions}/   # v1.5 §11
    │   └── answer-cache/
    └── hermes-docs/
```

**双根分离**（2026-05-08 三次订正，撤回二次订正的"项目自包含"）：source 与 runtime 数据走两个并列顶层 (`projects/` vs `state/`)。

| 维度 | source 侧 (`projects/<name>/`) | runtime 侧 (`state/<projectId>/`) |
|---|---|---|
| 内容 | 文档本体 + 用户 authored 配置 (`anydocs.config.json`, 可选 `anydocs.ask.json`) | 索引、runs、golden、reports、feedback、answer-cache |
| 接入 | 真实目录 / symlink 进 `projects/<name>` 都可 | 一律 `<workspace>/state/<projectId>/`，绝不回写 source |
| git 关系 | 由用户决定（hermes-docs 自有仓） | 独立 git，可单独提 review、单独迁移 |
| 删除安全 | 删了就没文档了 | `rm -rf state/<id>` 完全可恢复（reindex + golden generate 重来） |

**state-key 解析**：state 子目录名 = `<projectRoot>/anydocs.config.json` 里的 `projectId`（anydocs 格式必填字段）。bare-name `serve docs-zh` 与 path-form `serve /abs/docs-zh` 都查同一个 projectId → 同一份 state。projectId 冲突视为人为错误（CLI 检测时报错并指引）。

**为什么撤回"项目自包含"**：二次订正的 4 条理由（搬迁跟随 / git 化包含 / 路径全功能 / 一进程一项目）在 symlink 接入既有仓库时全部反转——污染源仓 `git status`、6.8MB index.db 误打进生产 git、用户清源仓时误删评测数据、`.gitignore` 还得手动加。三次订正后这些缺陷都消失。

**多项目语义**：每个 `projects/<name>/` 仍是独立 anydocs 项目，独立跑一个 `anydocs-ask serve` 进程占独立端口（3100/3101/3102 ...），不改变 v1 §5.5 一进程一项目硬约束。

**.env 加载**：CLI 启动时按顺序加载 `<workspace>/.env` → `<projectRoot>/.env`（process.loadEnvFile 不覆盖已存在变量 → workspace 是默认、projectRoot override）。cwd/.env 不再参与（避免 shell 位置偶然改变行为）。

### 12.4 Golden 集（评测基线）

三个来源，分阶段：

| 阶段 | 来源 | 工具 | 量级 |
|---|---|---|---|
| Day 0（冷启动） | **结构反向 + LLM 改写**：遍历 navigation，每页生成 3-5 个候选 Q（"什么是 X / X 和 Y 区别 / X 怎么用"），LLM 改写为自然语言；人工 30 分钟筛掉 ~50% | `anydocs-ask golden generate <project> --from structure` | 50–200 |
| v1 ≥2 周 | **从 runs 历史挑**：confidence ≥0.7 + 用户未重问 + answer 简洁 → 候选；人工补 `must_cite_pages` / `must_contain` | `... --from runs --since 14d` | 30–100/周 |
| v1.5 后 | **失败修补**：analyze 报告里"无 citation / 离场快"的 query → 人工补 expected | `... --from inbox` | 长尾 |

Golden case schema（jsonl，每行）：

```json
{
  "id": "q-001",
  "query": "鉴权怎么做",
  "filters": { "audience": "public" },
  "context_pageId": null,
  "expected": {
    "must_cite_pages": ["security/jwt"],
    "must_contain": ["JWT", "Bearer"],
    "forbid_contain": ["session cookie"]
  },
  "created_by": "author | llm-curated",
  "reviewed_at": "2026-05-08"
}
```

评测输出三个指标（详见 ARCHITECTURE §16.3）：

- **R@5**：top-5 命中 `must_cite_pages` 的覆盖率
- **Citation-pass**：答案 citations 全部落在 `must_cite_pages` 内的样本占比
- **Answer-rule-pass**：答案文本满足 `must_contain` ∧ ¬`forbid_contain` 的样本占比

### 12.5 Runs 历史

**位置**：`<workspace>/state/<projectId>/runs/<YYYY-Www>.jsonl`（runtime 侧，与 sqlite 同位），按 ISO 周切片，避免单文件无限增长。

**默认开启**，`runs.enabled=false` opt-out。每行记录一次 `/v1/ask`：query、filters、context、检索 trace（fused chunks + RRF/BM25/vec rank + nav_index_boost）、answer、citations、confidence、latency、tokens、model。详细 schema 见 ARCHITECTURE §16.4。

**隐私**：v1 默认不写 IP / UA / 用户标识；脱敏 hook 留 v1.5（PRD §9 已留口子）。`feedback.beta` / `feedback.gamma` 字段在 runs 中预留为 null，由 v1.5 §11 反馈回路异步回填。

**导出 / 探查**：`anydocs-ask runs tail <project>` / `runs export <project> --since ... --format csv|jsonl`。

### 12.6 冷启动评测协议

无 β/γ 信号、无积累 runs 时**严禁乱调权重**——只用 v1 默认（vec+BM25 RRF + nav_index_boost + 子树聚合反问 + sonnet-4-6 默认 prompt，详见 §4.2 / ARCHITECTURE §6）。

**Day 0 必做**：

1. `anydocs-ask golden generate <project> --from structure` 出 50–200 条 baseline。
2. `anydocs-ask eval <project>` 跑指标（默认读 `<workspace>/state/<projectId>/golden/cases.jsonl`）。
3. 结果写入 `<workspace>/state/<projectId>/reports/<date>-baseline.md`，作为后续任何 retrieval 配置变更的回归基线。

**上线门槛建议**（推荐值，可调）：

| 指标 | 门槛 | 不达标的含义 |
|---|---|---|
| R@5 | ≥0.70 | 关键页缺失 / navigation 编排有歧义 |
| Citation-pass | ≥0.65 | chunk 边界 / breadcrumb 投影问题 |
| Answer-rule-pass | ≥0.60 | LLM prompt 或文档行文不够明确 |

**冷启动期不应该做**：reranker model、建议问题侧栏、query expansion、LLM few-shot——全在 v1.5+。践行 PRD §1 "服从编排"原则：先确认编排是否合格，再调算法。

### 12.7 Analyze 历史诊断

`anydocs-ask analyze runs <project> --since 7d` 周期产 markdown 报告（落 `<workspace>/state/<projectId>/reports/<date>-analyze.md`），高价值条目自动入 `<workspace>/state/<projectId>/feedback/suggestions/<YYYY-Www>.md` 等人工评审。五个诊断维度：

| # | 维度 | 触发条件 | 输出动作 | v1 / v1.5 |
|---|---|---|---|---|
| 1 | **召回失败** | confidence<0.4 ∨ 无 citation ∨ 30s 内重问 | 列 query + 高频缺失 page → 给作者"应补文档"建议 | v1 |
| 2 | **延迟异常** | latency_ms p95 超阈值的 query 模式 | 提示 chunk 过大 / token 爆 → 调 chunking 配置 | v1 |
| 3 | **歧义高发** | 反问触发率 / 未被 disambiguate 命中 | 提示 navigation 调整（合并/拆分子树） | v1 |
| 4 | **引用错配** | β=negative 的 citation | 反查 chunk → 是否拆分；进 feedback inbox | v1.5（依赖 β） |
| 5 | **embedding 漂移** | 同一 query 跨 reindex 命中页面变化 | embedding 模型选型信号 | v1.5（需累积多次 reindex） |

维度 1-3 是 v1.5 §11.3 F2（A+ 失败诊断）的具体化、且不依赖反馈信号——v1 即可上。维度 4-5 等 v1.5 反馈回路落地后启用。

### 12.8 v1 / v1.5 范围分配

明确每个能力的归属版本，避免 §11 v1.5 反馈回路与本节耦合不清：

| 能力 | v1 | v1.5 |
|---|---|---|
| Runtime workspace 目录约定 | ✅ | — |
| `--workspace` flag + `$ANYDOCS_ASK_WORKSPACE` | ✅ | — |
| 多项目并列（多进程多端口） | ✅ | — |
| Golden case schema + `golden generate --from structure` | ✅ | — |
| LLM 改写候选 Q | ✅ | — |
| `golden generate --from runs` | ✅ | — |
| `golden generate --from inbox` | — | ✅ |
| `eval` 命令 + 三指标 | ✅ | — |
| Runs jsonl 默认开启 | ✅ | — |
| `runs tail` / `runs export` | ✅ | — |
| Analyze 维度 1-3（召回 / 延迟 / 歧义） | ✅ | — |
| Analyze 维度 4-5（β 错配 / embedding 漂移） | — | ✅ |
| Cold-start baseline + 上线门槛 | ✅ | — |

### 12.9 v1 验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 默认 workspace `~/anydocs-ask-runtime/` 不存在时，CLI 自动创建并打印路径 | 集成测试 |
| 2 | 多项目并列：两个 `serve` 进程在 3100/3101 同时运行，互不读写对方 sqlite/runs/golden | 集成测试 |
| 3 | `runs.enabled=true` 时每次 `/v1/ask` 落一行 jsonl；`enabled=false` 时不落 | 单元测试 |
| 4 | `golden generate --from structure` 在 starter-demo 上至少生成 30 条候选并给出 LLM token 估算 | 集成测试 |
| 5 | `eval` 在 baseline golden 上输出三指标 + diff 上一次 baseline | 集成测试 |
| 6 | `analyze runs --since 7d` 在合成 runs 上识别全部 1-3 维度信号 | 红队验证 |
| 7 | 默认 LLM 关闭（无 ANTHROPIC_API_KEY）时，`golden generate --from structure` 报错并给出指引；不静默回退到纯结构候选 | 单元测试 |

## 13. v1 dev console（内部评测台）

> Status: v0.1 计划（未实现）
> Date: 2026-05-10
> 范围：v1 增量。仅供 anydocs **作者本机** dogfood 与评测用，**不对外暴露**。
> 详细架构：[ARCHITECTURE.md §17](./ARCHITECTURE.md)

### 13.1 目标

把 §12 已立项的 CLI 评测能力（`eval` / `analyze` / `golden generate` / `runs tail`）和 v1 ask 服务包成一个**作者本机的可视化壳**，解决三件事：

- **作者亲身体感**：作者能像真实用户一样问问题，看到答案、citations、检索过程，判断"自己写的文档"是否被检索/答得对。
- **跨项目一站式**：在同一个本地 Web 入口里切换多个 anydocs 项目，不必手动起多个 `serve` 终端。
- **CLI 可视化**：把 `eval` / `analyze` / `golden generate` 的输入参数和输出报告以点击式 UI 暴露，降低评测使用门槛。

### 13.2 与已锁决策的关系

- **不破** §12.2 决策 4（一进程一项目）——console 自身是 meta 层，每选一个项目仍 spawn 独立 `anydocs-ask serve` 子进程占独立端口。
- **不替代** §11 v1.5 文件优先反馈流——console v1 **不引入新的 DB / 评审状态**；UI 上的所有"写动作"最终都是文件写或调用既有 CLI 函数。
- **修订** ARCH §16.9 "Web 评测面板"否决项的语义：保留"对外不做 / 不替代文件流"，新增允许"内部 dev console 作为既有 CLI 的可视化壳，零独立状态"。详见 ARCH §17.7。

### 13.3 用户场景

| # | 场景 | 主要操作 |
|---|---|---|
| 1 | 作者切到 docs-zh，问 "JWT 怎么续期"，看 top-5 chunk 与最终答案 | 选项目 → 输入问题 → 看返回（含检索 trace） |
| 2 | 作者发现"我刚补的 mobile/oauth 页召回不到"，想验证 reindex 后是否修复 | 选项目 → 触发 reindex → 重新问同一问题 |
| 3 | 上线前过一遍 baseline | 选项目 → 点 "Run eval" → 看三指标 vs baseline diff |
| 4 | 周报前看一周 ask 健康度 | 选项目 → 点 "Analyze runs (since 7d)" → 看报告 |
| 5 | 冷启动后审 LLM 生成的 Golden 候选 | 选项目 → 点 "Generate golden (from structure)" → 跳到候选文件 |

### 13.4 功能需求

#### 13.4.1 项目选择器（首页）

- **workspace 总览 strip**（2026-05-11 加入）：valid/total projects · indexed · running · golden cases · runs · 7d · most recent project
- 列 `<workspace>/projects/*`，每项卡片显示：projectId、源路径（含 symlink 标记）、warm 状态、indexed 状态、case 数、近 7 天 runs 数、上次 eval 日期
- 点击项目卡片：lazy spawn `anydocs-ask serve <name> --port <auto>`；console 全权分配端口（默认 4101+ 段，避免与作者手动启动的 3100/3101 区段冲突）。"open + start →" 一键 autostart
- 项目空闲超过 N 分钟自动 kill 子进程（默认 15 min；可配）。无显式 "pin"。
- 不替代 `workspace ls`——CLI 仍可独立用。

#### 13.4.2 Ask 体验台

- 文本框 + 提交按钮，调子进程的 `/v1/ask`，**默认 dry-run**：不落 runs jsonl，不进 answer-cache，仅在 console 内存里返回结果。
- 显示：检索 fused top-5（page / rrf_score / vec_rank / bm25_rank / nav_index_boost）、最终 answer markdown、citations、confidence、latency、model。
- 子树反问触发时显示反问选项树（与 Reader 一致）。
- 不提供"标记 bad"按钮（v1 不引入 feedback inbox 写入；详见 §13.6 与 v1.5 扩展点）。
- **persist 开关**（2026-05-11 加入）：右上 checkbox，默认 **OFF**，开启时该次提交反代到 `/v1/ask?source=console`，子进程**落 runs，进 answer-cache**，`source` 字段标记 `"console"`。
  - **不记忆**：刷新页面 / 切项目 / 切 tab 全部自动回到 dry-run，避免长期遗忘"还在灌库"。
  - **下游 guard**：`analyze runs` / `golden generate --from runs` 默认排除 `source=="console"`，需要 `--include-console` 显式纳入。
  - **UI 警告**：开启时按钮变红 + 顶端红条提示"将写 runs，源=console"；response 多 `_persisted: true` / `_source: "console"`。
  - 详 ARCH §17.3.3 / §17.8。

#### 13.4.3 项目页结构（4 tabs + next-action banner）

- 项目页右主区有 **4 个 tab**：**Ask**（默认 dogfood）/ **Index**（docs 入口 / 内容探索 / 验证 / reindex）/ **Eval**（独立 workflow）/ **Traffic**（7 天健康度 + runs 详情 + Re-ask）
- **next-action 横幅**：tab strip 上方根据 indexSnapshot / evalSnapshot / trafficWindow 推断作者下一步该做什么（info/warn/err 三色），CTA 跳到对应 tab；状态机命中规则见 ARCH §17.3.7
- **header gear (⚙) → Config drawer**：右侧抽屉只读显示 workspace `.env`（secrets `abcd***xy` 脱敏）/ `.console.json` / 项目 `anydocs.ask.json`；ESC / 点外侧关闭

#### 13.4.4 测评批跑（Eval tab）

- 项目页右主区有 **4 个 tab**：**Ask**（默认 dogfood）/ **Index** / **Eval**（独立 workflow）/ **Traffic**
- **Eval tab**（2026-05-11 提升为一级 feature）：
  - golden 题集状态：n cases / 按 lang / tag / created_by 分布 / 最近编辑时间
  - 三指标卡：latest eval + baseline 对比，Δ 用颜色（绿涨红跌）标注
  - **baseline pin**：history 表每行 `pin` 按钮可钉一份历史报告作"金准"，后续 eval 默认对比它（不只对比上一份）；UI Unpin 一键清；落盘 `state/<id>/golden/eval-baseline.json`
  - Run eval：dropdown 选对比目标（previous / pinned / 任一历史报告），按钮触发；结果落 `state/<id>/reports/<date>-eval.md`，自动刷新视图
  - 最近报告 markdown inline 渲染（同 reports 页面）
  - history 表：所有 eval 报告 + R@5 / Cit / Ans 三列 + sparkline 趋势（≥3 报告时显示，unicode block 零依赖）
- **2026-05-12 重构**：sidebar "Golden / Analyze" 卡删，三按钮按数据流归位：
  - `analyze runs` → **Traffic tab** analyze 区（紧贴 7d 流量数据）；勾"include console traffic"等价 `--include-console`
  - `golden ← structure` / `golden ← runs` → **Eval tab** Golden Workshop 区（紧贴 cases 统计）
- **Golden Workshop**（PRD §13.6 第 4 行 v1 锁 2026-05-12 解除）：
  - cases.candidate.jsonl 候选列表 in-UI 显示，每行 approve / reject 按钮
  - "flush approved → cases.jsonl" 按钮，等价 `anydocs-ask golden review` 把 approved 移入正式 cases
  - 文件优先原则保留：console 只写 candidate jsonl 的 decision 字段，CLI `golden review` 仍可平行用
- 实现上**直接调用既有 CLI 内部函数**，不 fork shell；eval CLI 协议**未改**——pin baseline 只是 console 端读指针文件，转译成 `--baseline <path>` 传给 `runEval()`。
- 详 ARCH §17.3.4。

#### 13.4.5 Index tab（docs intake / 内容探索 / reindex）

- index 状态卡：on disk pages 数 / DB 中 pages / chunks / embed 缓存 / 最近 reindex 时间；disk vs DB 对照
- **⟳ reindex 按钮**：反代到 child `/v1/index/rebuild`，child idle 时禁用 + 提示
- 验证卡：anydocs loader warnings + console 自加（pages/ 不存在、空 lang 子目录）合并
- 首次设置引导：totalPages=0 时显大字 + 文件树骨架 + 路径
- 内容探索器：按 lang 切换 → 导航树（按 breadcrumb 自动分块）→ 每页 id/slug/status；missing file 红字；orphan（pages/ 有但 navigation/ 没引用）红色分组

#### 13.4.6 Traffic tab（7d 健康度 + runs 详情 + Re-ask）

- 4 KPI 卡 + 按日分桶 sparkline：queries · 7d / mean confidence / P95 latency (含 P50) / non-answer rate (error + clarify)
- 筛选条：query / source(reader|console) / kind / minConf
- runs 表（SSR）：行展开看完整 fused top-8 + answer markdown 渲染 + citations + meta(model/answer_id/request_id/tokens)
- **Re-ask 按钮**：行展开里点 ↩ 把 query 写回 Ask tab textarea + 切到 Ask tab；用当前 cfg 重跑该问题做对比
- console 与 reader 流量在 Traffic 视图里都纳入并以 src-pill 区分（与 analyze 默认排除 console 不同——这里需要可见对照）

#### 13.4.7 报告 / runs 查看（兼容入口）

- 旧 `/p/:name/runs` 独立页保留（外链 / 老 bookmark），Traffic tab 同时覆盖功能
- 项目页直接列 `state/<projectId>/reports/*.md`，按时间倒序，Markdown 在线渲染
- 不提供搜索 / 全文索引（runs 的检索能力在 §16.2 `runs export` CLI）

### 13.5 非功能与约束

- **绑定**：默认 `127.0.0.1:4100`；不支持 0.0.0.0 / 远程访问（v1 内部专用）。
- **状态**：console 进程**自身无持久化状态**——所有"配置"读 anydocs.ask.json，所有"数据"读 `<workspace>/state/<projectId>/`。重启 console 不丢任何东西。
- **认证**：v1 不做 token / 登录——基于 127.0.0.1 + 本机 dev tool 假设。后续如果对外开放，重新评审。
- **打包**：随 `@anydocs/ask` 同包发布；前端构建产物（如有）打进 dist。无独立 npm 包。
- **依赖**：后端复用既有依赖（Hono / SQLite / better-sqlite3），不再加新核心运行时依赖。前端走 Hono `html` 模板 SSR，零构建链；浏览器侧仅引入 `marked`（作为运行时依赖，由 console 自身的 `/console/static/marked.esm.js` 端点反代 `node_modules/marked` 的 ESM 入口提供——无 CDN、无外网依赖、与 `127.0.0.1` 内部 dev tool 假设一致）。

### 13.5.1 已知 v1 约束（操作时心里有数）

- **触发 eval / analyze 的 HTTP 请求会阻塞至完成**：v1 MVP 直返结果路径，`run eval` 在中型 docs 上可能 30s+ 才返回。浏览器 fetch 默认超时数分钟内 OK，但 UI 上的 "running…" 文字不会更新。后台任务 + 心跳进度留 v1.5（PRD §13.8）。
- **同项目 serve + eval 并发可能锁等**：作者手动 `serve docs-zh`（端口 3100）后 console 触发同项目 eval，两个进程都打开 `state/<projectId>/index.db`。SQLite WAL 模式下并发 reader 安全，但 eval 的 `runtime.start()` 会做 fullReindex（写）→ 可能短暂 lock wait，eval 本身变慢但不损坏数据。如撞到，先 stop child 再跑 eval。
- **子进程冷启动健康探测默认 30s**：dev 模式下 `serve` 子进程要 strip-types 加载 ~50 个 TS 文件 + 嵌入器 warm-up，5s 不够。`<workspace>/.console.json` 的 `childHealthTimeoutMs` 可调（≥1000）。

### 13.6 v1 显式不做

| 项 | 理由 | 何时重评 |
|---|---|---|
| ~~Ask 体验台直接落 runs（"灌真实流量"语义）~~ | ~~dry-run 与真实流量混淆会污染 §12.7 analyze；v1 默认走 dry-run，避免作者测试自动写库~~ | **2026-05-11 落地**：UI 加 persist 切换（默认 OFF + 不记忆），runs 多 `source: "reader" \| "console"` 字段，analyze / golden 默认排除 console 流量，`--include-console` 显式纳入。详 §13.4.2 |
| "标记 bad / good" 按钮 → feedback inbox | v1.5 §11 反馈回路尚未落地；过早引入会先于 β/γ 信号链 | v1.5 §11 落地时同步加 |
| 检索 / LLM 完整 trace（prompt 全文 / token 用量 / 中间排序） | v1 ask 未埋点；要改 `/v1/ask` 协议加 `?debug=1` | v1.5 |
| ~~写权限的 Golden 编辑器（候选审 / 通过 / 驳回 in-UI）~~ | ~~文件优先；候选文件直接编辑 jsonl 即可，UI 化收益不抵复杂度~~ | **2026-05-12 落地**：Eval tab Golden Workshop——console 只写 candidate jsonl 的 decision 字段，CLI `golden review` 仍可平行用，文件优先原则未破 |
| 多用户 / 远程访问 / 团队共享 | v1 内部专用；多用户场景与 PRD §6 本地优先冲突 | v2 |
| 自动定时任务（cron 调 eval / analyze） | 应用层职责，非 console 职责（用 macOS launchd / cron + CLI 即可） | — |

### 13.7 v1 验收标准（console 增量）

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | `anydocs-ask console` 启动后绑定 `127.0.0.1:4100`，列出 `<workspace>/projects/*` 全部项目 | 集成测试 |
| 2 | 点击项目卡片 5 秒内 spawn 出独立 `serve` 子进程，端口落在 4101+ 段，不撞作者手动起的 3100 | 集成测试 |
| 3 | Ask 体验台默认 dry-run：提交问题后 `<workspace>/state/<projectId>/runs/` 周文件**不增加行数** | 集成测试 |
| 4 | 项目卡片切换 / console 退出时，子进程正确 SIGTERM，不留僵尸进程 | 集成测试 |
| 5 | 点击 "Run eval" 触发与 CLI `anydocs-ask eval <project>` **完全等价**的代码路径，输出报告位置一致 | 单元测试 + 集成对照 |
| 6 | console 自身无 sqlite / 无落盘状态；删除 console 进程或 cwd 不影响任何项目数据 | 红队验证 |
| 7 | 不暴露 0.0.0.0 / 不开认证：尝试从其他主机访问 4100 端口失败 | 集成测试 |
| 8 | 同一 query 在 console Ask 体验台返回的 fused/answer/citations 与通过 Reader 直调 child `/v1/ask`（同 child 进程、同请求体）返回结果**逐字段一致**（仅 `_dry_run` / `_persisted` / `_source` 字段差异） | 集成对照 |
| 9 | persist=true 时 runs jsonl 新行 `source` 字段 = `"console"`；`analyze runs` 默认排除该行；`--include-console` 显式纳入 | 单元 + 集成 |

### 13.8 v1.5 扩展点（不在本版做，仅留口子）

- ~~**Ask 体验台 → 真实流量**：增加"saved"按钮把 dry-run 结果以 `source: "console"` tag 落 runs，方便作者把高质量 dogfood query 灌进数据集。~~ **2026-05-11 落地**，详 §13.4.2 persist 段。
- **β 标 bad → inbox**：与 v1.5 §11 一同接入；UI 仅写 `feedback/inbox/<date>-<id>.md`，不引入 DB。
- **检索 / LLM trace 深挖**：要 `/v1/ask` 协议增 `?debug=1` 字段；console 默认带上、外部调用方仍按需。
- **Golden 候选审**：等作者用一段时间反馈 jsonl 直编是否够用，再决定是否上 UI。
