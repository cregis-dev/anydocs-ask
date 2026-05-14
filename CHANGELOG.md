# 更新日志

`@anydocs/ask` 的所有重要变更均记录于此。格式大体遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 semver 预发布语义（`0.1.0-alpha.N`）。

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
