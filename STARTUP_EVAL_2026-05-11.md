# Startup 评估报告 — 2026-05-11

评估角度：全新用户（无已有 workspace、无预配置 env）走完完整 startup 流程。

评估步骤：
1. 新建 workspace（`workspace init`）
2. 启动 server（`serve ./fixtures/starter-docs --port 3100`）
3. 健康检查 + 查询（`POST /v1/ask`）
4. 无 API Key 路径测试
5. 运行 `golden generate` → `golden review` → `eval` → `analyze runs`
6. 阅读 README、`.env.example`、`ARCHITECTURE.md §5.1/§9`

---

## 结论

功能核心管线（索引、检索、查询、评估循环）**均可正常运行**，所有命令均无崩溃。
但存在以下问题**阻碍客户交付**：

- **代码 Bug**：2 个（一个错误信息文本有误，一个错误响应无法指引新用户自救）
- **文档缺口**：3 个（README 无 Quick Start、无 API 格式、无 fixture env 模板）
- **体验问题**：2 个（error run 污染 analyze 报告；golden 语言选择可能不符期望）

---

## BUG-1：`llm_unavailable` 错误信息中 env var 名称重复

**严重度**：Medium — 不阻断功能但让用户困惑

**定位**：`src/llm/factory.ts:27`

```typescript
`LLM provider 'anthropic' requires either '${config.llm.apiKeyEnv}' / 'ANTHROPIC_API_KEY' or 'ANTHROPIC_AUTH_TOKEN' env var.`
```

当 `apiKeyEnv` 取默认值 `ANTHROPIC_API_KEY` 时，输出为：

```
"LLM provider 'anthropic' requires either 'ANTHROPIC_API_KEY' / 'ANTHROPIC_API_KEY' or 'ANTHROPIC_AUTH_TOKEN' env var."
```

`'ANTHROPIC_API_KEY' / 'ANTHROPIC_API_KEY'` 中同名重复，语义混乱。

**复现**：
```bash
# 不设置任何 LLM env var
curl -X POST http://localhost:3100/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"test","lang":"zh"}'
# 返回: {"type":"error","code":"llm_unavailable","message":"LLM provider 'anthropic' requires either 'ANTHROPIC_API_KEY' / 'ANTHROPIC_API_KEY' or ..."}
```

**期望修复**：将 ` / 'ANTHROPIC_API_KEY'` 部分去掉，或改为 `(env: '${config.llm.apiKeyEnv}')` 的表述。

---

## BUG-2：`POST /v1/ask` 字段名错误时错误信息无指引

**严重度**：Medium — 开发者集成时必踩，且无法自救

**问题**：API 的请求体字段名为 `question`，而直觉或参考其他 AI API 的开发者会用 `query`。发送 `{"query":"..."}` 时收到：

```json
{"type":"error","code":"invalid_question","message":"question must not be empty"}
```

错误信息只说"question 不能为空"，**完全没有提示 `question` 是必填字段名**，用户不知道问题出在字段名上。

**复现**：
```bash
curl -X POST http://localhost:3100/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"query":"什么是入门文档?","lang":"zh"}'
# 返回: {"type":"error","code":"invalid_question","message":"question must not be empty"}
```

**期望修复**：错误信息改为 `"field 'question' is required"` 或在 sanitize 层检测到 body 有 `query` 字段但无 `question` 时给出提示，如 `"field 'question' is required (did you mean to use 'query'? the field name is 'question')"`。

---

## DOC-3：README 缺少 API 合同文档

**严重度**：High — 集成必读，但 README 中完全没有

**问题**：README 只有 CLI 命令速查，没有任何关于 HTTP API 的说明：
- `POST /v1/ask` 的 request body 格式（字段：`question`、`lang`、`context`）
- response 格式（`type`、`answer_md`、`citations`、`answer_lang` 等）
- 错误格式

新用户要找到 API 格式需要深读 82KB 的 `ARCHITECTURE.md §5.1`。

**期望修复**：在 README 中增加"Integration"或"HTTP API"小节，包含：
```json
// Request
POST /v1/ask
{"question": "如何鉴权？", "lang": "zh", "context": {"current_page_id": "auth"}}

// Response (answer)
{"type":"answer","answer_md":"...","citations":[...],"answer_lang":"zh"}

// Response (error)
{"type":"error","code":"invalid_question","message":"..."}
```

---

## DOC-4：starter-docs fixture 缺少 `.env.example`

**严重度**：Medium — 新用户第一次运行的必踩坑

**问题**：`fixtures/starter-docs/` 是推荐的演示项目，但没有 `.env.example`。用户运行 `serve ./fixtures/starter-docs` 后发现第一次 `/v1/ask` 返回 `llm_unavailable` 错误，而不知道应该在哪里放 API key。

根目录的 `.env.example` 说明"Copy to `.env` in the project root you pass to `serve`"，但新用户不一定读到根目录的文档，且 starter-docs 本身是个独立目录。

**期望修复**：在 `fixtures/starter-docs/` 中放一个 `.env.example`（可以是最精简版本，只包含 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN`）。

---

## DOC-5：README 缺少 Quick Start / Getting Started 章节

**严重度**：High — 客户交付的第一印象

**问题**：README 是"参考文档"而非"上手指引"。新用户面对以下问题没有路径：
1. 我有一个 anydocs 项目，怎么给它接上 anydocs-ask？
2. 配置好之后怎么验证它工作了？
3. `anydocs.ask.json` 是什么？要不要创建？
4. `workspace init` 必须先跑吗？

**期望修复**：在 README 顶部增加"Quick Start（5 分钟上手）"章节，覆盖：
1. 安装（`npm i -g @anydocs/ask` 或 `npx @anydocs/ask`）
2. 配置 env（`cp .env.example .env` 并填 API key）
3. 可选：`workspace init`
4. 启动：`anydocs-ask serve <projectRoot>`
5. 验证：`curl http://localhost:3100/v1/health` 返回 `{"status":"ok"}`
6. 第一次查询：`curl -X POST .../v1/ask -d '{"question":"...","lang":"zh"}'`

---

## ISSUE-6：analyze runs 将 validation error 记为 recall failure

**严重度**：Low — 污染分析报告，但不阻断功能

**问题**：当有请求因 validation 失败（如 `invalid_question`、`invalid_scope`）被记录到 runs JSONL 时，`analyze runs` 会把这些 error runs 纳入"Recall failures"统计（因为 confidence=0），实际上这些是客户端错误，与检索质量无关。

**复现**：发送一个 `{"query":"..."}` 请求（validation error），然后运行 `analyze runs`。

**期望修复**：analyze 时过滤掉 `answer.kind === 'error'` 的 runs，或将其归入独立的"Client errors"分类。

---

## ISSUE-7：golden generate 对中文主导项目生成英文候选

**严重度**：Low — 影响 eval 准确性

**问题**：`anydocs.config.json` 中 `defaultLanguage: "zh"`，但 `golden generate --from structure` 生成的候选 `lang: "en"`，`must_contain` 关键词也是英文（如 `["includes", "read", "next"]`）。

导致结果：`eval` 显示 `Ans=0.33`，但失败原因是关键词语言不匹配，而不是检索/生成质量问题。

**期望修复**：`golden generate` 应优先使用项目的 `defaultLanguage` 作为候选 lang，或允许 `--lang zh` 参数指定。

---

## 其他观察（无需代码修改）

| 项 | 观察 | 结论 |
|---|---|---|
| `workspace ls` 不显示 path-referenced 项目 | `state/starter-docs` 存在但不在 `projects/` 目录 | 设计行为，但值得在 README 说明"ls 只列 workspace/projects/ 下的项目" |
| `anydocs.ask.json` 缺失警告 | 服务日志 `no anydocs.ask.json found; using defaults` | 默认值合理，但可加 `(see ARCHITECTURE.md §9 for reference config)` 提示 |
| 启动耗时 | 首次 warm-up ~5-8s（bge-m3 加载） | 属于预期范围；`/v1/health` 正确返回 503→200 |
| eval 独立进程 | `eval` 自启动一个 indexer 实例（不复用 serve 进程） | 功能正确，`chunks=0` 表示 embedding 全命中缓存 |

---

## 优先级排序（修复建议）

| 优先 | Item | 类型 | 改动量 |
|------|------|------|-------|
| P0 | DOC-5 Quick Start | 文档 | ~50 行 README |
| P0 | DOC-3 API 合同 | 文档 | ~30 行 README |
| P1 | BUG-2 字段名错误提示 | 代码 | 1-5 行 sanitize.ts |
| P1 | BUG-1 llm_unavailable 重复 | 代码 | 1 行 factory.ts |
| P1 | DOC-4 starter-docs `.env.example` | 文档/文件 | 新增 1 个文件 |
| P2 | ISSUE-6 golden lang 选择 | 代码 | ~10 行 generator.ts |
| P2 | ISSUE-7 analyze error run 过滤 | 代码 | ~5 行 analyze |
