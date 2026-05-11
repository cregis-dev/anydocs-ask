# `@anydocs/ask`

[anydocs](https://github.com/cregis-dev/anydocs) 项目的本地优先问答服务。读取 `pages/{lang}/*.json` + `navigation/{lang}.json`，向 Reader 站点提供带结构感、引用含完整面包屑的问答接口。

> 状态：**v1 alpha（0.1.0-alpha.1）。** 索引 + 查询 + HTTP + 评测闭环（§16）已上线。
> 产品文档：[`PRD.md`](./PRD.md)（先读这个，了解为什么）·[`ARCHITECTURE.md`](./ARCHITECTURE.md)（集成方读这个，了解怎么做）。

---

## 快速上手（5 分钟，使用内置 fixture）

> 包尚未发布到 npm，alpha 阶段请通过源码运行。

```bash
# 1. 克隆并安装
git clone https://github.com/cregis-dev/anydocs-ask.git
cd anydocs-ask
pnpm install

# 2. 配置凭证——把模板拷到 fixture 里
cp fixtures/starter-docs/.env.example fixtures/starter-docs/.env
$EDITOR fixtures/starter-docs/.env
# ⚠️ 模板里的 `ANTHROPIC_API_KEY=sk-ant-...` 是占位符，必须把 sk-ant-... 替换为真实 key
# 或改用注释里的 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL（接入兼容网关时）

# 3. 启动 Web 控制台（推荐入口）
pnpm dev console                    # 默认 http://127.0.0.1:4100
# 端口被占？换一个落在 4101–4199 *之外* 的端口（保留段是子进程用的）：
pnpm dev console --port 4200

# 4. 验证（把 4100 替换为你实际启动时打印的端口）
PORT=4100   # 改成 --port 指定的值
curl http://127.0.0.1:$PORT/        # 应返回工作区首页 HTML
```

打开浏览器访问启动时打印的地址（默认 **http://127.0.0.1:4100**），应当看到工作区首页（首次启动时项目列表为空）。把 `fixtures/starter-docs` 加为项目即可开始提问、跑评测、审阅 golden 集。控制台会按需 spawn / 回收子进程。

**首次运行注意：** BGE-M3 embedding 模型（约 600 MB）会在第一次索引前自动下载到 `~/.cache/huggingface/anydocs-ask/transformers/`，视网速 5–15 分钟；之后从本地缓存加载，预热约 5–10 秒。可提前 `ls ~/.cache/huggingface/anydocs-ask/` 确认是否已缓存。

要直接走 HTTP 而不开控制台？见下面 [CLI 模式](#cli-模式纯-http)。

---

## Web 控制台

控制台是管理项目、测试查询、运行评测闭环的首选界面。仅绑定 `127.0.0.1`（回环地址），自动管理各项目的子进程。

### 页面一览

| URL | 内容 |
|---|---|
| `/` | 工作区首页——全部项目、运行状态、工作区统计 |
| `/p/<name>` | 项目页——启动/停止、Ask 体验台、Eval、Analyze、Golden Workshop |
| `/p/<name>/runs` | 最近 N 条运行记录（查询日志） |
| `/p/<name>/reports/<file>` | 完整评测报告 |

### 项目生命周期

- **添加项目** — 在控制台首页底部的 **Add Project** 表单填入路径（支持 `~` 展开），或用 CLI：
  ```bash
  anydocs-ask workspace add ./fixtures/starter-docs
  anydocs-ask workspace add /abs/path/to/my-docs --name my-docs
  ```
  项目路径写入工作区的 `projects.json` 注册表，无需软链或移动源码。
- **启动 / 停止** — 在项目页点击按钮，或访问 `/p/<name>?autostart=1`。控制台会懒加载 spawn `anydocs-ask serve` 子进程，最多等待 30 秒完成预热。
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
  "port": 4100,                 // 控制台端口（必须落在 4101–4199 之外）
  "idleTimeoutMin": 15,         // 子进程空闲多少分钟后自动回收
  "childPortRangeStart": 4101,
  "childPortRangeEnd": 4199,
  "childHealthTimeoutMs": 30000 // 等待子进程通过健康检查的超时毫秒数
}
```

子进程端口从 `[childPortRangeStart, childPortRangeEnd]` 中顺序分配，控制台端口必须落在该范围之外。

---

## CLI 模式（纯 HTTP）

不想用控制台，直接起一个 HTTP 服务给 Reader：

```bash
# 启动服务（首次会自动创建 ~/anydocs-ask-runtime/）
pnpm dev serve ./fixtures/starter-docs --port 3100

# 验证
curl http://localhost:3100/v1/health
# → {"status":"ok","warm":true,...}

# 提问
curl -X POST http://localhost:3100/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"鉴权怎么做？","lang":"zh"}'
```

### `<projectRoot>` 是什么？——两种写法，二选一

所有 CLI 子命令第一个位置参数都是 `<projectRoot>`，指向**一个 anydocs 项目目录**（必须包含 `anydocs.config.json`、`pages/`、`navigation/`）。允许两种形式，**靠是否含 `/` 自动判定**（`src/workspace.ts`）：

| 写法 | 例子 | 实际解析为 | 何时用 |
|---|---|---|---|
| **裸名称**（不含 `/`） | `my-docs` | 在 `projects.json` 注册表中查找该名称对应的路径 | 已通过 `workspace add` 注册，想用简称 |
| **文件系统路径**（含 `/` 或绝对路径） | `./fixtures/starter-docs`、`/abs/path/to/docs` | 按字面路径解析（相对路径基于 `cwd`） | 临时跑一次，不想接入工作区 |

具体例子：

```bash
# 先注册（一次性）
anydocs-ask workspace add ./fixtures/starter-docs --name starter-docs

# A. 裸名——前提：已通过 workspace add 注册
anydocs-ask serve starter-docs --port 3100
anydocs-ask eval  starter-docs

# B. 路径——任意目录都行，无需注册
anydocs-ask serve ./fixtures/starter-docs --port 3100
anydocs-ask serve /Users/me/work/product-docs
```

无论用哪种写法，**所有运行时数据（SQLite 索引、runs、golden 集、reports）都写入 `<workspace>/state/<projectId>/`**，源码仓库永远不会被修改（双根分离，ARCH §16.1）。

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

### 完整 CLI 子命令

下表里所有 `<projectRoot>` 都遵循上一小节的两可规则——裸名 `my-docs` 或路径 `./fixtures/starter-docs`，二选一。

```bash
# 服务
anydocs-ask serve            <projectRoot> [--port 3100] [--host 127.0.0.1]
anydocs-ask reindex          <projectRoot>
anydocs-ask status           <projectRoot>

# 工作区（默认 ~/anydocs-ask-runtime/，可通过 --workspace 或 $ANYDOCS_ASK_WORKSPACE 覆盖；
# 详见 ARCHITECTURE.md §16.1）
anydocs-ask workspace init
anydocs-ask workspace ls
anydocs-ask workspace add    <path> [--name <name>]   # 注册项目路径到 projects.json
anydocs-ask workspace rm     <name>                   # 移除注册（保留 state 数据）

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

> 全局安装（`npm install -g @anydocs/ask`）需待包发布到 npm registry 之后。alpha 阶段请使用 `pnpm dev <command>` 或在本仓库 `pnpm build` 后从 `dist/cli.js` 直接调用。

### `anydocs.ask.json`（可选）

在 `<projectRoot>` 中放置 `anydocs.ask.json` 可覆盖默认配置（模型、检索权重、CORS origins 等）。所有字段均为可选——本地开发时省略该文件即可。完整配置参考见 ARCHITECTURE.md §9。

---

## 是什么（以及不是什么）

- **是**：一个尊重作者*编排意图*（导航顺序、子树边界、发布状态）的 HTTP 服务。拖拽重排目录——embedding **不会**重算。
- **不是**：通用 AI 搜索。拒绝全局扁平化。引用必须包含完整的面包屑路径。

## v1 范围

面向**公开发布**的开发者文档站点 / 产品手册的终端用户问答。一个进程对应一个 anydocs 项目，多项目通过多端口部署。多语言是一等公民（当前支持 zh / en；同语言优先，跨语言翻译降级——详见 PRD §4.8）。

## 开发

```bash
pnpm install
pnpm dev serve ./fixtures/starter-docs   # 通过 --experimental-strip-types 直接运行 CLI
pnpm dev console                         # 启动 Web 控制台
pnpm test                                # node --test
pnpm typecheck
pnpm build                               # 输出到 dist/
```

依赖：Node >= 20，pnpm >= 8。

实现进度与历史变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 许可证

MIT
