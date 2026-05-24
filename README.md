# `@anydocs/ask`

为 [anydocs](https://github.com/cregis-dev/anydocs) 项目提供的本地问答服务。读取 `pages/{lang}/*.json` 和 `navigation/{lang}.json`，向 Reader 站点返回带完整面包屑引用的结构化答案。

> **v1（0.1.0）** — 索引、查询、HTTP 接口（含 SSE 流式 `POST /v1/ask/stream`）、Web 控制台、评测闭环均已就绪。
> 速览 ask 操作 / 原理 / 测评 / 优化方向：[`docs/ask-overview.md`](./docs/ask-overview.md)。
> 产品背景见 [`PRD.md`](./PRD.md)，集成细节见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，版本历史见 [`CHANGELOG.md`](./CHANGELOG.md)。

---

## 快速上手

> 全局安装：`npm install -g @anydocs/ask`。如需开发本仓库或运行 fixtures，按下方源码模式走。

```bash
# 1. 克隆并安装依赖
git clone https://github.com/cregis-dev/anydocs-ask.git
cd anydocs-ask
pnpm install

# 2. 初始化工作区，生成凭证文件
pnpm dev workspace init
# 命令会在 ~/anydocs-ask-runtime/.env 写入凭证模板，编辑填入 API Key：
$EDITOR ~/anydocs-ask-runtime/.env
# 选 (A) 填 ANTHROPIC_API_KEY，或选 (B) 填 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL

# 3. 启动 Web 控制台
pnpm dev console                    # 默认监听 http://127.0.0.1:4100
# 端口冲突？改用 4101–4199 范围外的端口（该范围保留给子进程）：
pnpm dev console --port 4200

# 4. 验证服务就绪
curl http://127.0.0.1:4100/         # 应返回工作区首页 HTML
```

控制台启动后，在首页底部的 **Add Project** 表单中填入 `fixtures/starter-docs` 或你自己的 anydocs 项目路径，即可开始提问、运行评测、审阅 golden 集。

> **首次运行提示：** BGE-M3 embedding 模型（约 600 MB）会在首次索引时自动下载到 `~/.cache/huggingface/anydocs-ask/transformers/`，视网速需 5–15 分钟；此后从本地缓存加载，预热约 5–10 秒。

不想用控制台？见 [CLI 模式](#cli-模式纯-http)。

---

## Web 控制台

控制台是管理项目、调试查询、运行评测闭环的首选入口。仅绑定本地回环地址（`127.0.0.1`），自动按需启停各项目的子进程。

### 页面一览

| URL | 内容 |
|---|---|
| `/` | 工作区首页——所有项目的状态与统计 |
| `/p/<name>` | 项目页——启动/停止、Ask 体验台、Eval、Analyze、Golden Workshop |
| `/p/<name>/runs` | 最近查询记录 |
| `/p/<name>/reports/<file>` | 完整评测报告 |

### 项目生命周期

- **添加项目** — 在首页填入项目路径（支持 `~` 展开），或通过 CLI 注册：
  ```bash
  pnpm dev workspace add ./fixtures/starter-docs
  pnpm dev workspace add /abs/path/to/my-docs --name my-docs
  ```
  项目路径写入 `projects.json` 注册表，无需软链或移动源码目录。

- **启动 / 停止** — 在项目页点击按钮，或访问 `/p/<name>?autostart=1`。控制台会按需 spawn `anydocs-ask serve` 子进程，最多等待 30 秒完成预热。

- **空闲回收** — 超过 `idleTimeoutMin`（默认 15 分钟）无活动后，子进程自动退出释放内存。

- **重新索引** — 子进程运行期间，在项目页触发；内部调用 `/v1/index/rebuild` 完成。

### Ask 体验台

项目页内嵌查询表单。请求默认带 `dry_run=1` 转发给子进程——答案正常展示，但**不写入** runs 日志。勾选 **Persist** 后，本次交互以 `source=console` 写入 runs jsonl（默认不纳入分析和 golden 候选；需要时用 `--include-console` 显式开启）。

### Eval、Analyze、Golden Workshop

项目页提供三个评测闭环操作：

- **Eval** — 对 golden 集执行完整评测，生成带日期的报告；可钉固一份历史报告作为对比基线。
- **Analyze** — 汇总最近 N 天的查询流量，输出 D1–D5 五个维度的分析。
- **Golden Workshop** — 逐条审核候选条目，批准或拒绝后一键刷入 golden 集（等价于 `golden review` + `golden flush`）。生成候选默认走 LLM 改写以提升查询质量，无凭据/调用失败时自动降级为模板原句；UI 实时流式展示每个 batch 的进度。

> **生成候选耗时提示：** Console 默认开启 LLM 改写。小项目（≤ 50 页）通常 30–90 秒完成（含网关偶发的 1–2 次重试），大项目按 50 条/批处理，整体随项目规模线性增长。需更快产出可在 CLI 用 `--no-llm-rewrite` 跳过 LLM 步骤。

### 配置

控制台启动时读取 `<workspace>/.console.json`，缺省时全部使用默认值：

```jsonc
// ~/anydocs-ask-runtime/.console.json
{
  "enabled": true,              // 设为 false 可禁用控制台命令
  "port": 4100,                 // 控制台端口，须在 4101–4199 之外
  "idleTimeoutMin": 15,         // 子进程空闲回收阈值（分钟）
  "childPortRangeStart": 4101,
  "childPortRangeEnd": 4199,
  "childHealthTimeoutMs": 30000 // 等待子进程健康检查通过的超时（毫秒）
}
```

子进程端口从 `[childPortRangeStart, childPortRangeEnd]` 顺序分配，控制台自身的端口必须落在该范围之外。

---

## CLI 模式（纯 HTTP）

直接启动一个 HTTP 服务供 Reader 调用，不经过控制台：

```bash
# 启动服务（首次运行会自动初始化 ~/anydocs-ask-runtime/）
pnpm dev serve ./fixtures/starter-docs --port 3100

# 健康检查
curl http://localhost:3100/v1/health
# → {"status":"ok","warm":true,...}

# 提问
curl -X POST http://localhost:3100/v1/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"鉴权怎么做？","lang":"zh"}'
```

### `<projectRoot>` 的两种写法

所有 CLI 子命令的第一个位置参数均为 `<projectRoot>`，指向一个 anydocs 项目目录（须包含 `anydocs.config.json`、`pages/`、`navigation/`）。支持两种形式，按是否含路径分隔符自动区分：

| 写法 | 示例 | 解析方式 | 适用场景 |
|---|---|---|---|
| **裸名称**（不含 `/`） | `my-docs` | 从 `projects.json` 查找对应路径 | 已通过 `workspace add` 注册 |
| **文件系统路径** | `./fixtures/starter-docs`、`/abs/path` | 按字面路径解析（相对路径基于 cwd） | 临时运行，无需注册 |

```bash
# 一次性注册
pnpm dev workspace add ./fixtures/starter-docs --name starter-docs

# 用裸名（已注册）
pnpm dev serve starter-docs --port 3100
pnpm dev eval  starter-docs

# 用路径（无需注册）
pnpm dev serve ./fixtures/starter-docs --port 3100
pnpm dev serve /Users/me/work/product-docs
```

无论哪种写法，**所有运行时数据（索引、runs、golden 集、报告）均写入 `<workspace>/state/<projectId>/`**，源码仓库始终保持干净（双根分离，见 ARCH §16.1）。

### HTTP API

**`POST /v1/ask`**

```jsonc
// 请求
{
  "question": "如何鉴权？",          // 必填，≤ 500 字
  "lang": "zh",                      // 必填，"zh" | "en"
  "context": {                       // 可选
    "current_page_id": "auth",       // 用户当前所在页面
    "scope_id": "nav:zh.json:3"      // 将检索范围限定到某个导航子树
  }
}

// 正常响应
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
  "translation_notice": null   // 跨语言降级时非 null
}

// 错误响应
{ "type": "error", "code": "invalid_question", "message": "…" }
```

**`POST /v1/ask/feedback`** — 提交 👍 / 👎 反馈（详见 ARCHITECTURE.md §5.2）。

**`GET /v1/health`** — 预热完成后返回 `{"status":"ok"}`，预热期间返回 `{"status":"warming"}`；Reader 发起首次提问前应轮询此接口。

### 完整子命令参考

> 全局安装（`npm install -g @anydocs/ask`）后 `anydocs-ask <cmd>` 直接可用。从源码运行时，把下方所有 `anydocs-ask <cmd>` 换成 `pnpm dev <cmd>`（仓库根目录），或 `pnpm build` 后用 `node dist/cli.js <cmd>`。

```bash
# 服务
anydocs-ask serve            <projectRoot> [--port 3100] [--host 127.0.0.1]
anydocs-ask reindex          <projectRoot>
anydocs-ask status           <projectRoot>

# 工作区管理（默认路径 ~/anydocs-ask-runtime/，可用 --workspace 或 $ANYDOCS_ASK_WORKSPACE 覆盖）
anydocs-ask workspace init
anydocs-ask workspace ls
anydocs-ask workspace add    <path> [--name <name>]   # 注册到 projects.json
anydocs-ask workspace rm     <name>                   # 移除注册（保留 state 数据）

# 查询记录（每次 /v1/ask 追加一行；ARCH §16.4）
anydocs-ask runs tail        <projectRoot> [--n 50]
anydocs-ask runs export      <projectRoot> --since <when> [--format jsonl|csv]

# 评测闭环（ARCH §16.3 / §16.5 / §16.6）
anydocs-ask golden generate  <projectRoot> [--from structure|runs] [--limit N]
                                           [--since 14d] [--no-llm-rewrite] [--force]
anydocs-ask golden review    <projectRoot> [--reviewer <name>]
anydocs-ask golden import    <projectRoot> --file <jsonl> [--replace]
anydocs-ask eval             <projectRoot> [--baseline <path>]
anydocs-ask analyze runs     <projectRoot> [--since 7d]
```

`golden import` is intended for source-controlled, hand-curated eval sets.
Relative `--file` paths are resolved from `<projectRoot>`, then written into
the runtime workspace under `<workspace>/state/<projectId>/golden/cases.jsonl`.

`--since` 接受 ISO 日期（`2026-04-01`）、ISO 时间戳，或时长简写（`7d` / `48h` / `30m`）。

### `anydocs.ask.json`（可选）

在 `<projectRoot>` 放置 `anydocs.ask.json` 可覆盖默认配置（模型、检索权重、CORS 域名等），所有字段均为可选。完整字段列表见 ARCHITECTURE.md §9。

项目也可以追加自定义 Prompt 说明，用于按文档站的业务语境特调回答风格；核心的“只基于片段回答 / 必须引用 / 不编造”规则不会被覆盖。也可在 Web Console 的项目页 `Prompt settings` 里编辑。为避免 prompt 过大，保存时会把换行/多空格压成单空格，并限制 `assistantName` 最多 80 字符、`systemInstructions` 最多 20 条、每条最多 500 字符。

```json
{
  "prompt": {
    "assistantName": "Cregis AI 助手",
    "systemInstructions": [
      "Payment Engine 主要用于订单、收款、托管收银台、支付回调和订单状态查询。",
      "WaaS 主要用于钱包、地址、充值、归集、提币和链上资产管理。",
      "回答时先给直接结论，再给必要步骤或注意事项。"
    ]
  }
}
```

---

## 设计原则

- **尊重编排意图** — 导航顺序、子树边界、发布状态均参与检索决策。拖拽重排目录，embedding 不会重算。
- **引用必须完整** — 每条引用包含完整面包屑路径，不接受无来源的扁平化答案。
- **不是通用搜索** — 专为结构化文档站点设计，拒绝全局向量检索的暗箱逻辑。

## 适用场景

面向**公开发布**的开发者文档与产品手册，为终端用户提供精准问答。每个进程对应一个 anydocs 项目，多项目通过多端口独立部署。多语言是一等公民，当前支持 zh / en，同语言优先，跨语言时自动翻译降级（详见 PRD §4.8）。

## 开发

```bash
pnpm install
pnpm dev serve ./fixtures/starter-docs   # 直接运行源码（--experimental-strip-types）
pnpm dev console                         # 启动 Web 控制台
pnpm test                                # node --test
pnpm typecheck
pnpm build                               # 输出到 dist/
```

依赖：Node ≥ 20，pnpm ≥ 8。实现进度与变更历史见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 许可证

MIT
