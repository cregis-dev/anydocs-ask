# Ask — 操作 / 原理 / 测评 / 优化方向

> 一站式入口，把分散在 [PRD.md](../PRD.md) / [ARCHITECTURE.md](../ARCHITECTURE.md) / [README.md](../README.md) / [CHANGELOG.md](../CHANGELOG.md) 里的 ask 视角内容压成一份导览。深读各章节请走原文。
>
> 适用于 0.1.0-alpha.2（2026-05-14）。Schema / API / 阈值有变动以 PRD + ARCH + CHANGELOG 为准。

---

## 1. 概览

Anydocs Ask 是一个**本地常驻 HTTP 问答服务**，消费 anydocs 项目目录下的 `pages/{lang}/*.json` + `navigation/{lang}.json`，对 Reader 站点返回**带完整面包屑引用的结构化答案**。

部署形态：**一进程一项目**（PRD §5.5 / ARCH §16.1 硬约束）；多项目通过多端口部署。

四条做与不做判定线（PRD §4，违反任一即否决）：

1. **编排意图优先** — `nav_index` 作权重先验，严禁让 LLM 自己算"哪个文档更重要"。
2. **结构坐标上下文绑定** — 同子树为主、全局为辅；`scope_id` 校验失败必须 HTTP 400，**绝不静默降级全局检索**。
3. **结构化输出** — 比较类出表格、操作类出有序列表、概念类出段落 + 关键术语。
4. **树状降级反问** — 歧义提问用编排子树作选项，不让 LLM 编造。

多语言策略（PRD §4.8）：同语言优先 + 跨语言翻译降级 + 溯源保留原文（snippet 不翻译）。

---

## 2. 操作

按"开箱即用 → 评测调优 → 集成发布"三段递进。详细命令请见 [README.md](../README.md)。

### 2.1 首次启用（控制台为主）

```bash
pnpm install
pnpm dev workspace init                 # 生成 ~/anydocs-ask-runtime/.env 模板
$EDITOR ~/anydocs-ask-runtime/.env      # 填 ANTHROPIC_API_KEY 或 AUTH_TOKEN + BASE_URL
pnpm dev console                        # 启控制台 http://127.0.0.1:4100
# 首页 Add Project → 填项目路径（裸名或绝对路径都行，写入 projects.json 注册表）
```

控制台启动后会**按需 spawn / SIGTERM** 各项目的 `serve` 子进程（端口 4101–4199 自动分配，空闲 15 分钟回收）。首次索引 BGE-M3 模型 ~600MB，下载耗时 5–15 分钟，后续走本地缓存（`~/.cache/huggingface/anydocs-ask/transformers/`）。

### 2.2 调试与日常 dogfood

| 操作 | 控制台入口 | 等价 CLI |
|---|---|---|
| 体验台提问（默认 dry-run，不写 runs） | 项目页 **Ask** tab | — |
| 体验台落 runs（`source=console`，下游 analyze 默认排除） | 勾右上 **Persist** | `POST /v1/ask?source=console` |
| 看索引状态 / 触发 reindex | **Index** tab | `pnpm dev reindex <project>` |
| 看 7 天流量 / Re-ask | **Traffic** tab | `pnpm dev runs tail <project>` |
| 跑 eval / 看历史报告 / pin 基线 | **Eval** tab | `pnpm dev eval <project>` |
| 生成 + 审 golden 候选 | **Eval** tab → Workshop | `pnpm dev golden generate / review` |

控制台**自身零持久化状态**——所有配置 / 数据都落 `<workspace>/state/<projectId>/`（详 ARCH §16.1 双根分离）。删 console 进程或 cwd 不影响任何项目数据。

### 2.3 对外集成（Reader 直调 HTTP）

```bash
pnpm dev serve <projectRoot> --port 3100
curl http://localhost:3100/v1/health     # 预热完成后返回 {"status":"ok"}
curl -X POST http://localhost:3100/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"鉴权怎么做？","context":{"current_page_id":"foo"}}'
```

API 协议见 [ARCHITECTURE §5](../ARCHITECTURE.md)；CORS / 段落 anchor 等接入细节见 ARCH §10。

---

## 3. 原理

### 3.1 双层索引（PRD §4.6 拖拽零重算的命门）

- **内容层**（`chunks` + `chunks_vec` + `chunks_fts`）：文本切块、`content_hash = sha256(normalize(text))` 作 embedding 缓存键。文本未变 → hash 未变 → 缓存命中 → **不调 embedding API**。
- **结构层**（`pages`）：`breadcrumb` / `nav_index` / `subtree_root` / `lang` / `published`，从 `navigation/{lang}.json` 投影；毫秒级可重建。

| 编辑动作 | 内容层 | 结构层 |
|---|---|---|
| 拖拽目录顺序 | **不动** | 重投影 |
| 改 title / tags / slug / seo | 不动 | 该页行刷新 |
| 切换 published / draft | 删 / 加 chunks（命中 cache→ 0 embed 调用） | 行刷新 |
| 改 DocContentV1 正文 | 仅变更 chunk 重 embed（其余 cache 命中） | 行刷新 |

详 [ARCHITECTURE §2 / §7](../ARCHITECTURE.md)；`normalize()` 规约见 §7.1.2（v1 周期内**不可改**，否则全表 cache 失效）。

### 3.2 查询管线（ARCH §6）

```
1.  入参验证（question ≤ 500 字；scope_id 必须命中 pages.subtree_root，否则 400）
1.5 query lang 检测：scope_id > current_page_id.lang > 文本 CJK 比例（≥0.30 → zh）
2.  边界过滤：status='published' [AND subtree_root=scope_id]（lang 不在硬过滤里）
3.  混合召回 K=20：vec0 余弦 top-20 ∪ FTS5 BM25 top-20 → RRF(k=60) 融合 top-20
4.  结构重排：final_score = rrf_score × (1 + lang_boost + same_subtree_boost
                                           + nav_index_boost + title_match_boost)
       lang_boost          +0.30  chunk.lang == query_lang
       same_subtree_boost  +0.20  chunk.subtree_root == current_page 的 subtree_root
       nav_index_boost     +0.10 × 1/log(nav_index + 2)
       title_match_boost   +0.30  query 含 chunk 所在页 title（≥5 字符；影子抑制）
5.  子树聚合 + lang 路径：
       同 lang 充分（top10_same_lang 非空且 max(rrf) ≥ 0.01）：
         max(subtree share) ≥ 0.65   → 直答（dominant subtree）
         top-2 subtree Δ < 0.15       → clarify（选项全是同 lang 子树）
         其他                          → 直答（按主导子树）
       同 lang 不足                 → 跨 lang 翻译降级，answer_lang=query_lang，
                                      citation snippet 保留原 lang **不翻译**
6.  生成：prompt 含格式 hint（比较→表格 / 操作→列表 / 概念→段落 + bullet），
         注入 top-8 chunk（带 [breadcrumb (lang)] 前缀），LLM = claude-sonnet-4-6
7.  后处理：citation 合法性 / lang 填充 / 幻觉过滤 / 4000 字截断
8.  落 answer 缓存（24h TTL）+ append 一行 runs.jsonl（dry_run 跳过）
```

**置信度代理** `answer.confidence = top1.final_score / sum(top-5.final_score)`，∈ [0, 1]，是 analyze D1 `confidenceFloor` 的判定依据。原始 `top_final_score` 仅在内部 trace 用、不出 API。

### 3.3 引用 / 立体溯源（PRD §4.7）

每条 citation 含 `citation_id` / `chunk_id` / `page_id` / `lang` / `source_lang`（跨 lang 时填）/ `breadcrumb`（完整面包屑，**始终是源 lang 原文**）/ `url`（含段落 anchor）/ `snippet` / `in_page_path`。breadcrumb 在**查询时**实时 join 结构层 → 文档移动后引用自动跟着变。

---

## 4. 测评（评测闭环）

PRD §12 + ARCH §16 的实现已上线。冷启动期严禁乱调权重，只用 v1 默认 + golden 三指标判断"编排是否合格"。

### 4.1 数据三件套（双根分离，`<workspace>/state/<projectId>/`）

| 目录 / 文件 | 内容 | 写者 |
|---|---|---|
| `index.db` | SQLite + sqlite-vec + FTS5；chunks / pages / embedding_cache / feedback / answers | indexer / `/v1/ask` |
| `runs/<YYYY-Www>.jsonl` | 每次 `/v1/ask` append 一行（含 trace、citations、confidence、latency、source） | `server/app.ts:appendRun` |
| `golden/cases.jsonl` + `cases.candidate.jsonl` | 已批准的评测 case 与待审候选 | `golden generate / review` |
| `reports/<date>-{baseline,eval,analyze}.md` | 评测报告（含 `<!-- EVAL_SUMMARY {...} -->` 注释行供 history 表读取） | `eval` / `analyze runs` |

### 4.2 三指标（ARCH §16.3）

| 指标 | 定义 | 默认门槛 | 不达标含义 |
|---|---|---|---|
| **R@5** | `fused[:5].pages ∩ must_cite_pages ≠ ∅` 的样本占比 | ≥ 0.70 | 关键页缺失 / nav 编排有歧义 |
| **Citation-pass** | `answer.citations.pages ⊆ must_cite_pages` 的样本占比 | ≥ 0.65 | chunk 边界 / breadcrumb 投影问题 |
| **Answer-rule-pass** | `must_contain` 全命中 ∧ `forbid_contain` 全不命中 | ≥ 0.60 | LLM prompt 或文档行文不够明确 |

### 4.3 闭环工作流（Day 0 → 持续）

```
Day 0 (冷启动)
   golden generate --from structure --limit 50    # LLM 改写默认开；
                                                  #   按 defaultLanguage 优先 + 多 lang 轮询
                                                  #   交错（修复 dogfood-2026-05-14 F2 lang 偏置）
   人工 30 分钟筛 → cases.jsonl                    # 控制台 Eval tab Golden Workshop 一键审
   eval → baseline.md（pin 起来作回归基线）

v1 ≥ 2 周
   golden generate --from runs --since 14d        # 从高置信度成功记录补充
   eval（与 baseline diff，红涨绿跌一目了然）
   analyze runs --since 7d                        # D1 召回失败 / D2 延迟异常 / D3 歧义高发
                                                  # → reports + 高价值簇入 feedback/suggestions/

v1.5
   feedback diagnose                              # A+ 失败查询簇 → "应补文档"建议
   feedback export / import                       # inbox/*.md 人工审 → approved.jsonl → chunk_priors
   analyze D4 / D5（依赖 β 反馈 / 多次 reindex）
```

`/v1/ask` 始终 append runs.jsonl（含 error / clarify / answer 三种 kind；LLM 抛错也落 `kind=error, code=llm_failed`——PR #18 修复，参 dogfood-2026-05-14 F1）。

Console 体验台 persist 落的 runs 自带 `source=console`，`analyze` / `golden generate --from runs` 默认排除该来源；显式纳入用 `--include-console`（控制台 Traffic tab Analyze 区有勾选框）。

---

## 5. 优化方向

按"立即可调 / 下一个里程碑 / 远期"三档列。**调权重前先确认编排是否合格**——PRD §1 编排意图先于算法。

### 5.1 v1 立即可调（无需上游字段）

- **检索权重**：`anydocs.ask.json` 的 `retrieval.{rrfK,rerankSameSubtreeBoost,navOrderBoost,maxChunksHardCap}`。先看 eval / analyze 指标再动手；冷启动期一律默认值（PRD §12.6）。clarify 子树聚合阈值（dominance / spread）现固化为 `src/query/aggregate.ts` 的代码常量，跨项目标定经验充足后再考虑外露。
- **chunk 边界**：`indexing.{chunkMaxTokens,chunkHardCap}`；analyze D2 显示 "long queries + many candidates 慢" → 多半是 chunk 过大触发 token 爆。
- **embedding 量化**：`embedding.preferQuantized: true` 走 int8 版 bge-m3，冷启快 5-6× / 磁盘 ~191MB vs 1.2GB（ARCH §8 spike 实测）。VPS / 小内存场景推荐。
- **navigation 编排**：D3 歧义高发 → 合并 / 拆分子树。R@5 偏低 → 给重要 section 显式写 `id`（ARCH §2.2.2 推荐）+ 调整 nav 顺序（`nav_index` 作权重）。
- **文档行文**：Answer-rule-pass 偏低多半是文档没写明确 `must_contain` 关键词；A+ diagnose（v1.5）会自动给"应补文档"建议。

### 5.2 v1.5 计划（PRD §11 / ARCH §15）

| 能力 | 触发条件 |
|---|---|
| **β 反馈采集** — Reader 加 👍/👎/答错按钮，调既有 `POST /v1/ask/feedback` | 上线 ≥ 4 周后真实积累 |
| **γ 隐式信号** — 重问 / 未点引用 / 离场，喂 reranker（权重低于 β） | 同上 |
| **chunk_priors reranker 加权** — 反馈先验进 §6 步骤 4，∈ [-0.30, +0.30] | feedback ≥ 50 条起 |
| **A+ 失败查询诊断** — 周任务聚类负反馈 query，输出"应补文档"建议 | feedback 表非空起 |
| **inbox/*.md 文件流审核** — `feedback export / import`，git 友好多人协作 | 同上 |
| **Analyze D4 / D5** — 引用错配（依赖 β）/ embedding 漂移（依赖多次 reindex） | β 落地后 / 累积多份 reindex |
| **`--from inbox` golden 补全** — 审过的失败修补回灌评测集 | inbox 流稳定后 |
| **流式响应 (SSE)** / **实体表 + query expansion** / **意图分流 + 摘要层** / **Ollama 离线 LLM** | 真实使用反馈触发 |

约束：**审过的 QA 不进检索**（PRD §11 决策 1 明确否决 Shadow Wiki）；只做 reranker 信号 + 给作者的补文档建议。

### 5.3 v2 / 远期

- **DSPy 编译** — 需 v1 反馈数据 ≥ 200 条。
- **MCP / agent 接口** — `@anydocs/ask-mcp` 包名已预留。
- **多项目联邦 / 单进程多项目** — v1 硬约束「一进程一项目」放开。
- **多 audience / 多 version 细粒度隔离** — 等 anydocs 主仓加 `audience` / `version` / `nav.weight` / `page.priority` 字段；近似实现一律记为 v1 永久方案。

### 5.4 已知瑕疵（dogfood-2026-05-14）

| ID | 状态 | 备注 |
|---|---|---|
| F1 `/v1/ask` LLM 抛错丢 run | ✅ PR #18 已合 | error path 现在 append `kind=error, code=llm_failed` |
| F2 `golden generate --limit` lang 偏置 | ✅ PR #19 已合 | 按 `defaultLanguage` 优先 + 多 lang 轮询交错 |
| F3 LLM gateway error message 留 `undefined` | ✅ PR #21 已合 | `AnthropicLLM` 错误现在带 status / type / requestID / body（截断 ~200B） |
| F4 同页两 chunk citation 视觉重复 | 🔧 待修 | 把 `in_page_path` 拼到 title 同级 |
| F5 Ask 卡停止态中英混排 | 🔧 待修 | IA cleanup 后统一回中文或英文 |
| F6 analyze D1 在小项目上 9/9 命中召回失败 | 📋 观察 | confidence floor 待真实数据校准；不在 alpha.3 动 |
| O1 LLM 单次调用 timeout 偏长（~30s × 重试） | 📋 观察 | 配置项 `singleCallTimeoutMs` 待评估 |

完整 dogfood 报告见 [docs/dogfood-2026-05-14.md](./dogfood-2026-05-14.md)。

---

## 附录：常用文件 / 命令速查

| 你想 | 路径 / 命令 |
|---|---|
| 看产品契约（什么不可妥协） | [PRD.md §4](../PRD.md) |
| 看实现细节（pipeline / schema / 阈值） | [ARCHITECTURE.md §2 / §6 / §16](../ARCHITECTURE.md) |
| 看 HTTP API 协议 | [ARCHITECTURE.md §5](../ARCHITECTURE.md) |
| 看版本变化 | [CHANGELOG.md](../CHANGELOG.md) |
| 看控制台视觉/IA 重做 | [docs/console-redesign-brief.md](./console-redesign-brief.md) |
| 看 dogfood findings | [docs/dogfood-2026-05-14.md](./dogfood-2026-05-14.md) |
| 看默认配置全集 | [ARCHITECTURE.md §9 + §16.7](../ARCHITECTURE.md) |
| 找 query 管线源码 | `src/query/{answer,retrieval,rerank,aggregate,prompt,postprocess}.ts` |
| 找 console 端入口 | `src/console/server.ts` + `src/console/pages/` |
| 找 eval / analyze / golden 源码 | `src/commands/{eval,analyze,golden}.ts` + `src/{analyze,golden}/` |
