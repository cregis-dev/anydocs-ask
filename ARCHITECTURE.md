# Anydocs Ask — 初步架构

> Status: v0.1 初步架构（未实现）
> Date: 2026-05-04
> Scope: v1（首版）
> 配套：[PRD.md](./PRD.md)

---

## 1. 概览

Anydocs Ask 是一个**本地常驻的 HTTP 问答服务**，消费 anydocs 项目目录下的 `pages/*.json` 和 `navigation/*.json`，对 Reader 站点提供"带结构感"的问答能力。

部署形态：**一进程一 anydocs 项目**。多项目通过多端口部署。v1 不做多租户路由。

工程语言：TypeScript（与 anydocs 同栈）。运行时：Node 20+。

---

## 2. 核心设计：双层索引

整个架构最关键的决策。直接对应 PRD §4.6（拖拽零重算）。

### 2.1 内容层（Content Layer）

记录"文本本身和它的向量"：

- chunk 由文本切分而来
- `content_hash = sha256(normalize(text))` 作为 embedding 缓存键
- 文本未变 → hash 未变 → embedding 缓存命中 → **不调 embedding API**
- chunk 知道自己属于哪个 page（`page_id`），但不存"在哪个面包屑下"——那是结构层的事

### 2.2 结构层（Structure Layer）

记录"页面在编排树里的位置"：

- `breadcrumb` 路径（含本页）
- `nav_index`（在导航树里的序号；编排顺序的近似）
- `subtree_root`（二级子树锚点；用于聚合反问）
- `published` 状态

结构层可以毫秒级重建，因为它只是 `navigation/*.json` 树的投影。

#### 2.2.1 投影规则（v1 锁定）

`pages` 表每个字段都是从 navigation 树投影出来的，规则如下：

- `breadcrumb`：从 navigation 根到该页的完整路径节点列表（含根、含本页），每项 `{id, title}`。
- `nav_index`：该 page 在 **DFS 前序遍历** 中的序号（从 0 起），整棵树全局唯一；空缺值（如孤立 page）回退为 `INT_MAX`，让排序权重退化为零。
- `subtree_root`：该 page 在 navigation 树中**最近的"深度 1"祖先节点的 page_id**（深度 0 是根）。
  - 树结构：root → [section_1, section_2, ...] → [page_or_section, ...]，深度 1 即"section"层。
  - 自身就是深度 1 节点 → `subtree_root = self.page_id`。
  - 自身是 root（深度 0）的直挂 page（罕见，仅 README 类）→ `subtree_root = self.page_id`。
  - 选 "深度 1" 而非"深度 2/3" 的理由：开发者文档典型 navigation 是"前端 SDK / 后端 API / CLI / 部署"这一层做反问选项最自然；深度更深会把 "前端 SDK > 鉴权" 拆成独立反问选项，颗粒过细。粒度调整不在 v1，记入 §14 #4。
- `parent_id`：navigation 树中的直接父节点 id（不是 `subtree_root`），缺省 `NULL`。
- 多 navigation 文件：见 §7.1.1 合并规则。

### 2.3 解耦保证

| 编辑动作 | 内容层 | 结构层 |
|---|---|---|
| 编辑页面文字 | 仅变更的 chunk 重算 embedding（其他命中缓存） | 不动 |
| 仅改 metadata（标题、tags） | 不动 | 该页面行刷新 |
| 拖拽目录顺序 | **完全不动** | navigation 树重投影 |
| 删除 / 恢复发布 | 不动 | `published` 字段刷新 |

引用的面包屑在**查询时**实时 join 结构层 → 文档移动后引用自动跟着变。

---

## 3. 系统拓扑

```
                     Reader 站点（开发者文档 / 产品手册）
                             │
                             │  POST /v1/ask
                             │  POST /v1/ask/feedback
                             │  GET  /v1/health
                             │  GET  /v1/index/status
                             ▼
                ┌────────────────────────────────────┐
                │ @anydocs/ask（本地常驻进程）       │
                │ Hono on 127.0.0.1:3100             │
                ├────────────────────────────────────┤
                │ 查询管线                           │
                │  ├ 边界过滤（硬：published）       │
                │  ├ 混合召回（向量 + BM25 → RRF）   │
                │  ├ 结构重排（同子树 / nav 顺序）   │
                │  ├ 子树聚合判定                    │
                │  │  ├ 集中 → 生成                  │
                │  │  └ 分散 → 树状反问              │
                │  └ 后处理（引用合法 / 格式校验）   │
                ├────────────────────────────────────┤
                │ 索引管线                           │
                │  └ chokidar 增量（防抖 200ms）     │
                ├────────────────────────────────────┤
                │ Embedding（local bge-small-zh /    │
                │            remote OpenAI 可配）    │
                │ LLM（Anthropic / OpenAI 可配）     │
                └──────────────┬─────────────────────┘
                               │ 读
                               ▼
                ┌──────────────────────────────────┐
                │ anydocs 项目目录                 │
                │ pages/*.json + navigation/*.json │
                └──────────────────────────────────┘

      本地 SQLite（持久化）：.anydocs-ask/index.db
      ┌──────────┬──────────┬──────────────────┬──────────┐
      │ chunks   │ pages    │ embedding_cache  │ feedback │
      │ + vec    │ + FTS5   │                  │ + answers│
      └──────────┴──────────┴──────────────────┴──────────┘
```

---

## 4. 数据模型

```sql
-- 结构层：随拖拽实时刷新，不动 chunks
CREATE TABLE pages (
  page_id      TEXT PRIMARY KEY,
  status       TEXT NOT NULL,            -- 仅 published 入库
  title        TEXT NOT NULL,
  slug         TEXT,
  breadcrumb   JSON NOT NULL,            -- [{id, title}, ...] 含本页
  nav_index    INTEGER,                  -- 在导航树里的序号
  parent_id    TEXT,
  subtree_root TEXT,                     -- 二级子树锚点
  url          TEXT,                     -- Reader 上的 URL
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_pages_subtree ON pages(subtree_root);
CREATE INDEX idx_pages_parent  ON pages(parent_id);

-- 内容层：chunk 与 page 解耦；embedding 按 content_hash 缓存
CREATE TABLE chunks (
  chunk_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       TEXT NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
  in_page_path  TEXT,                    -- 如 "h2#auth/p[2]"
  text          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,           -- sha256(normalize(text))
  token_count   INTEGER NOT NULL,
  is_code       INTEGER DEFAULT 0,       -- 代码块原子，不切分
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_chunks_page ON chunks(page_id);
CREATE INDEX idx_chunks_hash ON chunks(content_hash);

-- BM25 倒排（FTS5），关键：dev docs 里 API 名 / ENV 变量靠精确词匹配
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content=chunks,
  content_rowid=chunk_id,
  tokenize='unicode61 remove_diacritics 2'
);

-- 向量索引（sqlite-vec 虚拟表）
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[384]                   -- bge-small-zh 默认 384 维
);

-- embedding 缓存：拖拽零重算的关键
CREATE TABLE embedding_cache (
  content_hash TEXT NOT NULL,
  model        TEXT NOT NULL,            -- 同 hash 不同 model 各自一行
  embedding    BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (content_hash, model)
);

-- 反馈池：后续优化的"养料"
CREATE TABLE feedback (
  feedback_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id        TEXT NOT NULL,
  question         TEXT NOT NULL,
  current_page_id  TEXT,
  retrieved        JSON,                  -- [{chunk_id, page_id, score}, ...]
  generated        TEXT NOT NULL,
  rating           INTEGER,               -- +1 / -1
  correction       TEXT,
  bad_citation_ids JSON,                  -- ["cit_2", ...]；v1 schema 留位，UI 在 v1.5 启用
  tags             JSON,
  model_used       TEXT,
  created_at       INTEGER NOT NULL
);

-- answer 缓存（用于 feedback 关联，TTL 24h）
CREATE TABLE answers (
  answer_id   TEXT PRIMARY KEY,
  question    TEXT NOT NULL,
  payload     JSON NOT NULL,             -- 完整生成上下文 + retrieved
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_answers_created ON answers(created_at);
```

### 4.1 缓存生命周期

**`answers`（answer_id → 完整生成上下文）**

- TTL：24h（PRD 假设用户反馈在一天内打回）。
- 清理策略：每次写入新 answer 时附带一次"机会式 GC"——`DELETE FROM answers WHERE created_at < now - 24h`。不开独立定时任务（一进程一项目，写入流量已足够触发清理）。
- 反馈到达时若 answer_id 已被 GC：`/v1/ask/feedback` 返回 HTTP 410 `answer_expired`。Reader 端可选择展示"反馈窗口已过"提示。**不**自动延长 TTL（避免高频问答的 answer 永不释放）。
- v1 不做反馈关联以外的用途，因此 24h 是足够的；v1.5 若启用"反馈数据回看 UI" 再考虑长期归档（届时归档应进 `feedback` 表的 retrieved 字段，而不是延 answers TTL）。

**`embedding_cache`（content_hash, model → embedding）**

- 主键 `(content_hash, model)`：同一段文本对不同 embedding 模型各存一份，模型切换时不冲突。
- 保留策略：v1 **永久保留**，不做 LRU。理由：embedding 体积可控（384 维 fp32 ≈ 1.5KB / chunk，10 万 chunk ≈ 150MB），用户切换模型的频率极低（一年级别）；显式 GC 弊大于利。
- 模型切换流程（手动）：用户改 `anydocs.ask.json` 的 `embedding.model` 后，重启服务时检测到主流模型变化 → 启动期日志提示"new embedding model detected, X chunks need re-embed"，并自动触发一次 `/v1/index/rebuild` 等价的全量重算（旧 model 的 cache 行**保留**，便于回退）。
- 磁盘上限保护：`.anydocs-ask/index.db` 体积超过 2GB 时启动期 warn 日志，提示用户手动清理（v1 不自动删；自动删 = 下次启动重算 = 违反 §4.6 直觉）。
- 跨机器迁移：rsync `.anydocs-ask/index.db` 即可带走全部 cache，无额外步骤。

---

## 5. HTTP API

### 5.1 POST /v1/ask

请求：

```json
{
  "question": "如何鉴权？",
  "context": {
    "current_page_id": "p_frontend_sdk_intro",
    "scope_id": null
  },
  "options": {
    "max_chunks": 8,
    "model": null
  }
}
```

响应（答案）：

```json
{
  "type": "answer",
  "answer_id": "ans_2026050412345abc",
  "answer_md": "鉴权使用 JWT bearer token...\n\n```ts\nconst client = new SDK({ token })\n```\n",
  "citations": [
    {
      "citation_id": "cit_1",
      "page_id": "p_frontend_auth",
      "title": "前端鉴权",
      "breadcrumb": [
        {"id": "p_quickstart", "title": "快速开始"},
        {"id": "p_frontend",   "title": "前端 SDK"},
        {"id": "p_frontend_auth", "title": "前端鉴权"}
      ],
      "url": "/frontend/auth#bearer-token",
      "snippet": "客户端在每次请求 header 中带上 Authorization: Bearer ...",
      "in_page_path": "h2#bearer-token/p[1]"
    }
  ],
  "used_chunks": 5,
  "model": "claude-sonnet-4-6",
  "latency_ms": 2340
}
```

响应（澄清）：

```json
{
  "type": "clarify",
  "answer_id": "ans_2026050412345def",
  "message": "您询问的鉴权，是指：",
  "options": [
    {
      "scope_id": "p_frontend",
      "label": "前端 SDK",
      "breadcrumb": [
        {"id": "p_quickstart", "title": "快速开始"},
        {"id": "p_frontend",   "title": "前端 SDK"}
      ],
      "sample_pages": [
        {"id": "p_frontend_auth", "title": "前端鉴权"},
        {"id": "p_frontend_session", "title": "会话管理"}
      ]
    },
    {
      "scope_id": "p_backend",
      "label": "后端 API",
      "breadcrumb": [
        {"id": "p_quickstart", "title": "快速开始"},
        {"id": "p_backend",    "title": "后端 API"}
      ],
      "sample_pages": [
        {"id": "p_backend_auth", "title": "API Key"}
      ]
    }
  ]
}
```

客户端把选定的 `scope_id` 回传到下一次 `/v1/ask` 的 `context.scope_id`，再次提问时检索范围收敛到该子树。

错误响应（未知 / 已 unpublish 的 scope_id）：

```json
{
  "type": "error",
  "code": "invalid_scope",
  "message": "scope_id 'p_unknown' 不在 published 范围内"
}
```

HTTP 400。`scope_id` 校验是硬条件——未命中 `pages` 表中任一 `subtree_root` 的请求一律 400，**绝不静默降级为全局检索**（对应 PRD §4.2）。

### 5.2 POST /v1/ask/feedback

```json
{
  "answer_id": "ans_2026050412345abc",
  "rating": -1,
  "correction": "实际上前端鉴权不用 JWT，是 session cookie",
  "bad_citation_ids": ["cit_2"],
  "tags": ["wrong-fact"]
}
```

### 5.3 其他

- `GET /v1/health` — 进程存活
- `GET /v1/index/status` — `{ doc_count, chunk_count, last_indexed_at, embedding_model, llm_model }`
- `POST /v1/index/rebuild` — 强制全量重建（运维）

---

## 6. 查询管线（细节）

```
1. 入参验证
   ├─ question 长度 ≤ 500 字
   ├─ scope_id（如有）必须命中 pages 表中某个 subtree_root；
   │  否则返回 HTTP 400 invalid_scope（绝不降级为全局）
   └─ options.max_chunks → min(client_value, retrieval.maxChunksHardCap)
      默认服务端硬上限 20，防止恶意客户端拖爆 LLM token

2. 边界过滤（硬条件，永远不可绕过）
   WHERE pages.status = 'published'
   AND (scope_id IS NULL OR pages.subtree_root = scope_id)

3. 混合召回（K = 20）
   ├─ 向量路径：embed(question) → sqlite-vec 余弦 top-20
   ├─ BM25 路径：FTS5 MATCH question top-20
   └─ RRF 融合：score = Σ 1 / (60 + rank_i) → top-20
   
   说明：dev docs 场景下 BM25 不可省。API 名、ENV 变量、SDK 方法名
        靠精确词匹配；向量路径补"鉴权 / 登录 / auth"这类语义相似。

4. 结构重排（在 RRF top-20 上加权）
   final_score = rrf_score × (1 + boosts)
   ├─ 同子树命中（current_page_id 的祖先链命中）：boost += 0.20
   └─ nav_index 靠前：boost += 0.10 × (1 / log(nav_index + 2))
      （nav_index 即"编排权重"近似；v1 不依赖 anydocs 加字段）

5. 子树聚合判定（在重排后 top-10 上）
   按 chunks.page_id → pages.subtree_root 分组，计算各子树得分占比 p_i：
   ├─ max(p_i) ≥ 0.65 → 单一子树主导，进入生成
   ├─ 否则 top-2 子树得分差 < 0.15 → 触发 clarify（树状反问）
   └─ 中间情况 → 直接进入生成（按主导子树）

6. 生成（仅"集中"分支）
   构造 prompt：
   ├─ 系统约束：
   │   ├─ 必须基于检索片段，严禁编造
   │   ├─ 必须给出 ≥1 引用，引用须含 breadcrumb
   │   └─ 答案中所有代码 / API 名必须能在片段里找到
   ├─ 输出格式判断（基于 question 词法）：
   │   ├─ 含 "对比 / 差异 / vs / 区别" → Markdown 表格
   │   ├─ 含 "如何 / 步骤 / 怎么"      → 有序列表
   │   ├─ 含 "什么是 / 介绍"           → 段落 + 关键术语 bullet
   │   └─ 默认                         → 段落
   ├─ 上下文注入：top 8 chunks，每个带 [breadcrumb] 前缀
   └─ 调远端 LLM（默认 claude-sonnet-4-6 / gpt-4o）

7. 后处理
   ├─ 引用合法性：每条 citation 必须能 join 回某个 used chunk
   ├─ 格式校验：if 应该出表格但没出 → 二次调用 LLM 改写为表格
   ├─ 幻觉过滤：检测答案里的代码块 / 引号包裹的标识符是否在 chunks 中出现
   │           没出现的 → 标 ⚠ 或剔除
   └─ 截断：超 4000 字截断 + 省略提示

8. 落 answer 缓存（TTL 24h）+ 返回
```

---

## 7. 索引管线

### 7.1 全量索引（启动期 / `index/rebuild`）

```
1. 扫 pages/**/*.json + navigation/**/*.json（递归 glob，支持嵌套，如 pages/zh/intro.json）
2. 过滤 status = 'published'
3. 构建 pages 表（含 breadcrumb / nav_index / subtree_root，规则见 §2.2.1）
4. 切 chunks：
   ├─ 按 DocContentV1 节点切（h2 / h3 边界优先）
   ├─ 代码块原子（is_code=1，不切分；超长代码块独立成 chunk）
   ├─ 段落 ≤ 500 token，硬上限 1000
   └─ 计算 content_hash = sha256(normalize(text))
5. 算 / 取 embedding：
   ├─ 查 embedding_cache（hash, model）
   ├─ hit → 复用
   └─ miss → 调 embedding API → 写 cache + chunks_vec
6. FTS5 索引同步（INSERT INTO chunks_fts）
```

#### 7.1.1 多 navigation 文件合并

当 `navigation/**/*.json` 出现多个文件（如 `navigation/zh.json` + `navigation/en.json`）：

- v1 默认按 **文件名字典序** 合并为一棵虚拟根树：每个文件视为虚拟根的一个子节点，子节点 id 取 `nav:<basename>`、title 取 basename。
- `nav_index` 在合并后的虚拟树上做 DFS 编号；`subtree_root` 仍走 §2.2.1 的"深度 1"规则——这意味着多 navigation 文件场景下 `subtree_root` 退化为"哪个文件"，反问选项也按文件分组。
- 这是 v1 兜底实现；典型 anydocs 项目仅一份 navigation，所以不阻塞。多文件多语言 / 多 audience 的细粒度处理是 v1.5 工作（依赖 anydocs 主仓加 audience / locale 字段）。

#### 7.1.2 `normalize()` 规约（content_hash 的命门）

`content_hash = sha256(normalize(text))` 是 PRD §4.6 "拖拽零重算" 能否真正达成的核心。`normalize` 必须是 **确定性、跨平台、跨版本稳定** 的纯函数，且在整个 v1 周期内不可改动（一旦改动 → 全表 cache 失效）。

v1 锁定算法（按顺序执行，每步输出作下一步输入）：

1. **Unicode 规范化**：`text.normalize('NFKC')`——中文全角/半角统一、兼容字符折叠。
2. **行尾统一**：`\r\n` 与 `\r` 统一替换为 `\n`。
3. **零宽字符清理**：移除 `​`（零宽空格）、`‌` / `‍`（零宽连字符）、`﻿`（BOM）。
4. **行内连续空白折叠**：每行内的连续空白（空格 / Tab）压成单个空格；行间换行保留。
5. **首尾空白裁剪**：每行 `trimEnd()`；整段 `trim()`。
6. **强制 UTF-8 编码**后送入 sha256。

**显式不做**：

- 大小写折叠（API 名 `getUserById` vs `getuserbyid` 必须区分）。
- 标点归一化（中文全/半角顿号"、" / "," 已经被 NFKC 处理）。
- 代码块特殊处理：代码块文本走相同 normalize，**不**因 `is_code=1` 而跳过（确保拖拽代码块到不同位置时仍命中 cache）。

**变更约束**：normalize 算法的任意改动必须：(a) 走 ARCHITECTURE 修订 review；(b) bump `embedding_cache` 表的隐式版本（实践上：在 `.anydocs-ask/index.db` 旁建 `normalize_version` 文件，启动期版本不一致 → 自动清空 `embedding_cache` 并 rebuild）。v1 不实现该机制，但保留升级路径。

### 7.2 增量更新（chokidar 监听）

```
事件 → diff → 走对应分支（自上而下判定，命中即走）：

├─ pages/X.json 删除 / status published → draft
│  └─ 删 X 的 chunks（CASCADE）+ pages 行；embedding cache 保留
│     [embedding API 调用：0]
│
├─ pages/X.json 新增（首次出现且 status=published）
│  或 status draft → published
│  └─ 走步骤 3-6 给 X 建 pages 行 + 切 chunks + 走 cache 命中查询
│     正常情况下文本未曾变过 → embedding_cache 全 hit → 0 调用
│     仅当首次发布的页面 cache 未建立时才调 embedding API
│     ★ PRD §4.6 验收 #1（"切换发布状态" embedding=0）的关键路径
│
├─ pages/X.json DocContentV1 正文 diff 非空
│  └─ 仅 X 走步骤 4-6（embedding cache 命中部分仍复用）+ 同步刷 pages 行
│
├─ pages/X.json 仅 metadata 白名单字段 diff
│  └─ 仅刷 pages 表对应行（不动 chunks）★ PRD §4.6 关键
│     [embedding API 调用：0]
│
├─ navigation/**/*.json diff
│  └─ 仅刷 pages 表的 breadcrumb / nav_index / subtree_root
│     （chunks / chunks_vec / chunks_fts 全表零写）★ PRD §4.6 关键
│     [embedding API 调用：0]
│
└─ pages/X.json 含非白名单字段变更
   └─ warn 日志 + 按"正文 diff"路径全量重算受影响 chunk（保守 fail-safe）
```

**metadata 字段白名单**（仅这些字段变更视为"非正文"，零 embedding 重算）：

`title` / `slug` / `tags` / `seo` / `coverImage` / `category` / `relatedPages` / `updatedAt`

**`status` 字段刻意不在白名单**——它的变更走上面专门的"删除"或"新增/draft→published"分支，因为它伴随 `chunks` 行的增删；白名单语义是"仅刷 pages 表行，不动 chunks"，与 status 不符。

未在白名单的字段（含 anydocs 主仓未来新增的字段）一律走"正文 diff"路径——宁可重算也不漏。白名单更新需走 ARCHITECTURE 修订 review，不在实现期凭手感扩。

**path → page_id 映射**：chokidar 给的是文件路径，不是 page_id。索引器需要在内存维护 `path → page_id` 映射；新增文件时从 JSON 内容里读 `id`，删除事件时反查（删除事件读不到文件内容）。映射 corrupt 时 fail-safe 走全量 `index/rebuild`。

**防抖**：连续变更 200ms 内合并成一次 reindex 任务。

**容错**：拖拽 / 写入期间 chokidar 可能读到半写入的 JSON 或临时被锁定的文件。处理：parse / read 失败 → 跳过本次事件，等下次防抖窗口重读；同一文件连续 3 次失败才升级为 error 日志，避免噪音。

---

## 8. 技术选型

| 维度 | 选择 | 备注 |
|---|---|---|
| 语言 / 运行时 | TypeScript / Node 20+ | 与 anydocs 同栈 |
| HTTP | Hono | 轻量；与 Cloudflare/Vercel 生态友好（v2 云部署伏笔） |
| 存储 | SQLite + sqlite-vec + FTS5 | 单文件，零运维；100k chunk 内性能足够 |
| Embedding（默认） | bge-small-zh-v1.5（@xenova/transformers，本地） | 中文友好；离线可用；384 维 |
| Embedding（可选） | OpenAI text-embedding-3-small / Voyage | 远端，配置切换 |
| LLM（默认） | Claude Sonnet 4.6（Anthropic API） | 结构化输出强 |
| LLM（可选） | GPT-4o（OpenAI） | 配置切换 |
| 文件监听 | chokidar | 标准；防抖合并 |
| 包管理 | pnpm（与 anydocs workspace 一致） | — |
| 仓库形态 | 独立仓 `anydocs-ask`（**不**进 anydocs monorepo） | 发布周期解耦；不入侵 anydocs 主仓 |
| 包名 | `@anydocs/ask` | npm 发布；保留 anydocs 生态归属 |
| CLI 入口 | `anydocs-ask serve <projectRoot>` | 包内 `bin` 字段；或 `npx -y @anydocs/ask serve` |

### 选型已定（2026-05-04）

- **仓库形态**：独立仓。npm 包名仍为 `@anydocs/ask`，发布周期与 anydocs 主仓解耦；不要求改动 anydocs CLI。
- **Embedding 默认**：`bge-small-zh-v1.5`（@xenova/transformers，本地，~100MB，384 维）。理由：anydocs 用户群以中文文档为主；BM25 兜底处理英文 API 名 / 标识符的精确召回，不依赖 embedding 跨语种能力；首次安装体积可接受。英文为主项目可在 `anydocs.ask.json` 切换到 `bge-small-en-v1.5`。
- **向量库**：sqlite-vec。理由：单文件零运维；典型 dev docs 站点（≤50k chunks）性能充裕。LanceDB 升级路径预留给 v1.5+ 大型项目。
- **LLM 默认**：Claude Sonnet 4.6（远端 API）。理由：结构化输出强、函数调用稳定；可经 `anydocs.ask.json` 切到 GPT-4o。

### 仍待 spike 的事项

- **embedding 量化**：bge-small 默认 fp32；100k+ chunks 时考虑 int8 量化降磁盘。

---

## 9. 配置

`anydocs.ask.json`（项目根，可选；缺省走全局默认）：

```json
{
  "embedding": {
    "provider": "local",
    "model": "bge-small-zh-v1.5"
  },
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "retrieval": {
    "topK": 20,
    "rrfK": 60,
    "rerankSameSubtreeBoost": 0.20,
    "navOrderBoost": 0.10,
    "maxChunksHardCap": 20
  },
  "clarify": {
    "dominantThreshold": 0.65,
    "ambiguousGap": 0.15
  },
  "server": {
    "host": "127.0.0.1",
    "port": 3100,
    "cors": {
      "allowedOrigins": []
    }
  },
  "indexing": {
    "chunkMaxTokens": 500,
    "chunkHardCap": 1000,
    "debounceMs": 200
  }
}
```

LLM API key **仅从环境变量读取**，不写配置文件。配置里只写 `apiKeyEnv` 字段名。

---

## 10. Reader 集成

Reader 是另一个 anydocs 内的应用（已有 Next.js 站点）。Ask 服务的接入只需要 Reader 端做以下改动（不属于 Ask 服务范围，但需 anydocs 团队配合）：

1. **入口控件**：站点头部加「Ask」按钮 + `Cmd+K` 快捷键
2. **Modal**：唤起一个 modal，含输入框 + 答案区 + 反馈按钮
3. **API 调用**：`POST {ASK_BASE_URL}/v1/ask`，`current_page_id` 取自当前 URL（如 `?page=` 或路由参数）
4. **答案渲染**：markdown，引用项是可点击的面包屑链
5. **反馈控件**：答案下方 👍 / 👎 / "答错了，正确答案是..."三按钮 → `POST /v1/ask/feedback`
6. **澄清渲染**：clarify 响应渲染为 2-3 个子树卡片，点击 → 自动以 `scope_id` 重发问题

`ASK_BASE_URL` 配置：
- 优先环境变量 `NEXT_PUBLIC_ANYDOCS_ASK_URL`
- 其次 `anydocs.ask.json` 中读取（构建期注入）
- 缺省 `http://127.0.0.1:3100`

### 10.1 CORS

Reader 与 Ask 一定跨 origin（开发：`localhost:3000` → `127.0.0.1:3100`；生产：`reader.example.com` → `ask.example.com`），CORS 中间件是 v1 必备：

| 项 | 开发模式（默认） | 生产模式 |
|---|---|---|
| `Access-Control-Allow-Origin` | 放行 `http://localhost:*` / `http://127.0.0.1:*` | 从 `server.cors.allowedOrigins` 读白名单，未配置 → 拒绝所有跨域 |
| Allowed methods | `GET, POST, OPTIONS` | 同左 |
| Allowed headers | `Content-Type` | 同左 |
| `Allow-Credentials` | `false` | `false`（v1 无 cookie / session） |

判定开发 / 生产模式：`process.env.NODE_ENV === 'production'` 走生产分支；其他一律开发。生产模式下白名单空 → 启动时 warn 日志，**不**自动放行 localhost。

### 10.2 段落 anchor 来源与失效降级

PRD §4.7 要求 citation URL 含段落 anchor（如 `/frontend/auth#bearer-token`）。anchor 来源依赖 anydocs Reader 的 markdown→HTML pipeline 是否对 heading 输出稳定 slug。

v1 处理：

- 索引时从 chunk 所在的最近 heading（h2 / h3）派生 anchor slug；slugify 算法**必须与 anydocs Reader 对齐**（同一份实现或镜像版本），否则跳转 404
- chunk 不在任何 heading 下（如页面开头段、序言）→ citation URL 退化为页面级（无 `#fragment`），不报错
- chunk 在代码块内 → anchor 取代码块所属的最近 heading
- heading 文字含 emoji / 特殊字符 → 按 anydocs Reader 的 slugify 规则统一处理

**待 spike**（见 §14 #8）：anydocs Reader 当前的 heading slugify 实现是否在仓库内可直接复用，还是 Ask 需要自带一份对齐版本。spike 失败 → 降级为页面级 URL 是 v1 兜底，不阻塞上线。

---

## 11. 部署形态（v1）

### 11.1 本地开发

```bash
anydocs studio  ./my-docs            # 编辑（anydocs 主仓 CLI）
anydocs preview ./my-docs            # 预览 Reader（anydocs 主仓 CLI）
anydocs-ask serve ./my-docs          # 启动 Ask（独立 CLI，端口 3100）
# 或：npx -y @anydocs/ask serve ./my-docs
```

三个进程独立。Reader 的 dev server 通过 `NEXT_PUBLIC_ANYDOCS_ASK_URL=http://127.0.0.1:3100` 指向 Ask。

**启动顺序与 warm-up**：`anydocs-ask serve` 启动后会先加载 embedding 模型 + 跑一次空 embedding 预热（典型 5-10s），期间 `GET /v1/health` 返回 503；warm 后转 200。Reader 应轮询 `/v1/health` 直到 200 再放行 Ask 入口控件。所有 PRD §6.1 的 P50 / P95 指标仅覆盖 warm 状态。

### 11.2 对外发布（v1 简化版）

v1 假设：本地开发 + 编辑发生在创作者机器上；对外发布是构建后的 Reader 静态站点 + 一个常驻 Ask 进程。

部署形态：
- Reader 站点：静态构建产物（`anydocs build` 产出 `dist/`），托管在 Vercel / Netlify / 自建静态服务
- Ask 服务：在一台 VPS 上以 `anydocs-ask serve <projectRoot> --host 0.0.0.0 --port 3100` 跑（通过 Docker / systemd 管理）
- Reader → Ask：通过 `NEXT_PUBLIC_ANYDOCS_ASK_URL` 指向 Ask 的公网域名（HTTPS 反向代理）
- 项目源 `pages/*.json` + `navigation/*.json`：和 Reader 构建产物一起部署到 VPS（rsync / git pull）

> 完整的对外发布流程（含索引同步、CDN、缓存）是 v1.5 工作；v1 给一份"最小可对外"路径即可。

---

## 12. PRD 原则到实现的对照

| PRD 条款 | 实现位置 |
|---|---|
| §4.1 编排意图优先 | 查询管线 §6 步骤 4：`navOrderBoost`（`nav_index` 近似，v1 永久方案） |
| §4.2 结构坐标上下文 | API context.current_page_id；查询管线 §6 步骤 4 同子树 boost |
| §4.3 结构化输出 | 查询管线 §6 步骤 6 格式判断 + 步骤 7 后处理校验 |
| §4.4 树状降级反问 | 查询管线 §6 步骤 5 子树聚合 + API §5.1 clarify 响应 |
| §4.5 边界与版本隔离 | 查询管线 §6 步骤 2 硬条件；索引管线 §7 仅 published 入库 |
| §4.6 拖拽零重算 | 双层索引 §2 + embedding_cache §4 + 增量更新 §7.2 navigation 分支 |
| §4.7 立体溯源 | API §5.1 citations[].breadcrumb；查询时实时 join 结构层 |

---

## 13. v1 不做（架构层面）

| 项 | 影响 | 何时加 |
|---|---|---|
| 实体表 + query expansion | 缩写词召回不全 | v1.5 |
| 摘要层 + 意图分流 | 跨页摘要类问题效果一般 | v1.5 |
| 流式响应（SSE） | 答案需等完整生成 | v1.5（API 兼容扩展） |
| Ollama / 本地 LLM | 必须联网 | v1.5 |
| 多项目托管 | 一进程一项目 | v2 |
| MCP 接口 | 仅 HTTP | v2，预留 `@anydocs/ask-mcp` 包名 |
| DSPy 编译 | prompt 走传统模板 | v2，需 v1 反馈数据 ≥200 条 |
| Shadow Wiki / LLM 衍生层 | — | 永不做 |

---

## 14. 开放技术问题（实现前需研究 / 决定）

| # | 问题 | 影响 | 何时决 |
|---|---|---|---|
| 1 | LLM 输出 markdown 表格的稳定性（即使 prompt 要求） | 后处理重写策略复杂度 | 实现中观察 |
| 2 | 远端 embedding（OpenAI）批量调用与速率限制 | 大项目首次索引耗时 | 实现前评估 |
| 3 | chokidar 在 macOS / Linux / Windows 上的稳定性 | 增量索引可靠性 | 实现中观察 |
| 4 | `subtree_root` 的合理粒度（二级 vs 三级） | 反问选项的可读性 | 实现后小规模真用户验证 |
| 5 | `clarify` 的触发阈值（0.65 / 0.15）调优 | 反问频率与体感 | v1 上线后基于反馈数据迭代 |
| 6 | bge-small-zh 在含大量英文 API 名的混合文档上召回质量 | 是否需要切到 multilingual 模型 | 实现中黄金样例集观察；BM25 已兜底，预期问题不严重 |
| 7 | sqlite-vec 在实际项目规模下的 P95 延迟 | 是否需要 LanceDB | v1 上线后监控；100k chunks 内预期无碍 |
| 8 | anydocs Reader 的 heading slugify 实现是否可复用 | citation 段落 anchor 能否稳定生成（PRD §4.7） | 实现前 spike；失败则降级到页面级 URL |
