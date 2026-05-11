# `@anydocs/ask`

[anydocs](https://github.com/cregis-dev/anydocs) 项目的本地优先问答服务。读取 `pages/{lang}/*.json` + `navigation/{lang}.json`，向 Reader 站点提供带结构感、引用含完整面包屑的问答接口。

> 状态：**v1 alpha（0.1.0-alpha.0）。** 索引 + 查询 + HTTP + 评测闭环（§16）已上线。产品需求与架构文档：[`PRD.md`](./PRD.md)、[`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 快速上手

```bash
# 1. 安装
npm install -g @anydocs/ask   # 或免安装：npx @anydocs/ask <command>

# 2. 配置凭证（从项目根目录或 fixture 复制模板）
cp .env.example .env          # 然后填写 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN

# 3. （可选）初始化运行时工作区——首次 serve 时也会自动创建
anydocs-ask workspace init

# 4. 启动
anydocs-ask serve <projectRoot> --port 3100

# 5. 验证
curl http://localhost:3100/v1/health
# → {"status":"ok","warm":true,...}

# 6. 提问
curl -X POST http://localhost:3100/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"鉴权怎么做？","lang":"zh"}'
```

`<projectRoot>` 是包含 `anydocs.config.json`、`pages/` 和 `navigation/` 的目录。所有运行时数据（SQLite 索引、runs、golden 集、reports）写入 `~/anydocs-ask-runtime/state/<projectId>/`，源码仓库永远不会被修改。

### HTTP API

**`POST /v1/ask`**

```jsonc
// 请求
{
  "question": "如何鉴权？",          // 必填——用户问题（≤ 500 字）
  "lang": "zh",                      // 必填——"zh" | "en"
  "context": {                       // 可选
    "current_page_id": "auth",       //   用户当前所在页面
    "scope_id": "nav:zh.json:3"      //   将检索范围限定到某个导航子树
  }
}

// 响应——答案
{
  "type": "answer",
  "answer_id": "ans_…",
  "answer_md": "…markdown…",
  "answer_lang": "zh",
  "citations": [
    {
      "citation_id": "cit_1",
      "title": "鉴权",
      "breadcrumb": […],
      "url": "/zh/auth",
      "snippet": "…"
    }
  ],
  "translation_notice": null         // 跨语言降级时非 null
}

// 响应——错误
{ "type": "error", "code": "invalid_question", "message": "…" }
```

**`POST /v1/ask/feedback`** — 在渲染答案后发送 👍 / 👎 信号（详见 ARCHITECTURE.md §5.2）。

**`GET /v1/health`** — 预热完成后（BGE-M3 加载 + 初始索引）返回 `{"status":"ok"}`，预热期间返回 `{"status":"warming"}`；Reader 在首次提问前应轮询此接口。

> **首次运行提示：** 在全新机器上，BGE-M3 embedding 模型（约 600 MB）会在索引开始前自动下载。视网络速度，首次可能需要 5–15 分钟；此后从本地缓存加载，预热约 5–10 秒。

### `anydocs.ask.json`（可选）

在 `<projectRoot>` 中放置 `anydocs.ask.json` 可覆盖默认配置（模型、检索权重、CORS origins 等）。所有字段均为可选——本地开发时省略该文件即可。完整配置参考见 ARCHITECTURE.md §9。

---

## 是什么（以及不是什么）

- **是**：一个尊重作者*编排意图*（导航顺序、子树边界、发布状态）的 HTTP 服务。拖拽重排目录——embedding **不会**重算。
- **不是**：通用 AI 搜索。拒绝全局扁平化。引用必须包含完整的面包屑路径。

## v1 范围

面向**公开发布**的开发者文档站点 / 产品手册的终端用户问答。一个进程对应一个 anydocs 项目，多项目通过多端口部署。多语言是一等公民（当前支持 zh / en；同语言优先，跨语言翻译降级——详见 PRD §4.8）。

## Web 控制台（推荐）

Web 控制台是管理项目、测试查询、运行评测闭环的首选界面。仅绑定 `127.0.0.1`（回环地址），自动管理各项目的子进程。

### 控制台快速开始

```bash
# 1. 初始化运行时工作区（仅首次需要）
anydocs-ask workspace init

# 2. 将 anydocs 项目软链或复制到工作区
ln -s /path/to/my-docs ~/anydocs-ask-runtime/projects/my-docs

# 3. 启动控制台
anydocs-ask console                    # 默认地址：http://127.0.0.1:4100
anydocs-ask console --port 4200        # 自定义端口
anydocs-ask console --idle-timeout 30  # 空闲项目保活 30 分钟
```

在浏览器中打开 **http://127.0.0.1:4100**。

### 页面一览

| URL | 内容 |
|---|---|
| `/` | 工作区首页——全部项目、运行状态、工作区统计 |
| `/p/<name>` | 项目页——启动/停止、Ask 体验台、Eval、Analyze、Golden Workshop |
| `/p/<name>/runs` | 最近 N 条运行记录（查询日志） |
| `/p/<name>/reports/<file>` | 完整评测报告 |

### 项目生命周期

- **启动 / 停止** — 在项目页点击按钮，或访问 `/p/<name>?autostart=1`。控制台会以懒加载方式 spawn `anydocs-ask serve` 子进程，最多等待 30 秒完成预热。
- **空闲回收** — 超过 `idleTimeoutMin`（默认 15 分钟）无活动后，子进程自动终止以释放内存。
- **重新索引** — 子进程运行后，在项目页可触发；调用 `/v1/index/rebuild` 在进程内完成。

### Ask 体验台

项目页内嵌查询表单。请求默认以 `dry_run=1` 转发给子进程——答案会展示，但**不会**写入 runs 日志。开启 **Persist** 可将此次交互以 `source=console` 写入 runs jsonl（默认排除在分析 / golden 之外；使用 `--include-console` 可显式纳入）。

### Eval、Analyze、Golden Workshop

项目页提供三个评测闭环操作的一键按钮：

- **Eval** — 对 golden 集执行完整评测，生成带日期的报告。可选择钉固某份历史报告作为对比基线。
- **Analyze** — 汇总最近 N 天的查询流量（D1–D5 五个维度）。
- **Golden Workshop** — 审核生成的候选条目，逐条批准或拒绝，再将已批准条目刷入 golden 集（等价于 `golden review` + `golden flush`）。

### 配置

控制台启动时读取 `<workspace>/.console.json`。该文件为可选，缺省时使用所有默认值。

```jsonc
// ~/anydocs-ask-runtime/.console.json
{
  "enabled": true,              // 设为 false 可禁用 'anydocs-ask console'
  "port": 4100,                 // 控制台端口（必须在 childPortRange 范围之外）
  "idleTimeoutMin": 15,         // 子进程空闲多少分钟后自动回收
  "childPortRangeStart": 4101,
  "childPortRangeEnd": 4199,
  "childHealthTimeoutMs": 30000 // 等待子进程通过健康检查的超时毫秒数
}
```

子进程端口从 `[childPortRangeStart, childPortRangeEnd]` 中顺序分配，控制台端口必须落在该范围之外。

## CLI（进阶用法）

```bash
# 服务
anydocs-ask serve            <projectRoot> [--port 3100] [--host 127.0.0.1]
anydocs-ask reindex          <projectRoot>
anydocs-ask status           <projectRoot>

# 工作区（默认 ~/anydocs-ask-runtime/，可通过 --workspace 或 $ANYDOCS_ASK_WORKSPACE 覆盖
# 详见 ARCHITECTURE.md §16.1）
anydocs-ask workspace init
anydocs-ask workspace ls

# Runs jsonl（每次 /v1/ask 追加一行；ARCH §16.4）
anydocs-ask runs tail        <projectRoot> [--n 50]
anydocs-ask runs export      <projectRoot> --since <when> [--format jsonl|csv]

# 评测闭环（ARCH §16.3 / §16.5 / §16.6）
anydocs-ask golden generate  <projectRoot> [--from structure|runs] [--limit N]
                                           [--since 14d] [--no-llm-rewrite] [--force]
anydocs-ask golden review    <projectRoot> [--reviewer <name>]
anydocs-ask eval             <projectRoot> [--baseline <path>]
anydocs-ask analyze runs     <projectRoot> [--since 7d]
```

`<projectRoot>` 可以是文件系统路径，也可以是相对于运行时工作区解析的裸名称（`<workspace>/projects/<name>`）。所有运行时数据——index.db、runs/、golden/、reports/——均存放在 `<workspace>/state/<projectId>/` 下，保持源码仓库干净（双根分离，ARCH §16.1）。

## 实现进度

| 阶段 | 范围 | 状态 |
|---|---|---|
| 1 | 项目骨架 + Hono CLI shell + 冒烟测试 | ✅ |
| 2 | SQLite schema + sqlite-vec / FTS5 + 迁移 | ✅ |
| 3 | 结构层投影（多语言） | ✅ |
| 4 | 内容层 + bge-m3 embeddings + 缓存 | ✅ |
| 5 | 索引管线 + chokidar 监听 + §4.6 端到端门控 | ✅ |
| 6 | 查询管线（含跨语言降级） | ✅ |
| 7 | HTTP API + 配置 + CORS | ✅ |
| §16 | 运行时工作区 + Golden + Eval + Runs jsonl + Analyze D1-D3 | ✅ |
| §15 | β/γ 反馈收件箱 + Analyze D4-D5 + `--from inbox` | v1.5 |

## 开发

```bash
pnpm install
pnpm dev serve ./fixtures/starter-docs   # 通过 --experimental-strip-types 直接运行 CLI
pnpm test                                # node --test
pnpm typecheck
pnpm build                               # 输出到 dist/
```

依赖：Node >= 20，pnpm >= 8。

## 许可证

MIT
