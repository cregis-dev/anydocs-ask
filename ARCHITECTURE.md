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
- `subtree_root`（二级子树锚点；用于聚合反问；为 nav 节点稳定 id，不是 page_id）
- `lang`（page 所属语种，与 navigation 文件一一对应）
- `published` 状态

结构层可以毫秒级重建，因为它只是 `navigation/*.json` 树的投影。

#### 2.2.1 投影规则（v1 锁定）

> **anydocs 实际 schema**：`NavItem = section | folder | page | link`（见 `@anydocs/core` `types/docs.ts`）。`section` / `folder` 是分组节点，无 `pageId`，可选 `id`。`page` 节点引用具体 page。`link` 是外链，不进 pages 表。
>
> **多语言**：anydocs 项目天然多语言（`pages/{zh,en}/*.json` + `navigation/{zh,en}.json`）。v1 全部 lang 入库，按 lang 隔离索引（详见 §4.8 PRD）。每份 `navigation/{lang}.json` 视作独立子树，pages 表 `lang` 字段必填。

`pages` 表每个字段都是从 navigation 树投影出来的，规则如下：

- `breadcrumb`：从 navigation 根到该页的完整路径节点列表（含根、含本页），每项 `{id, title, type}`。
  - `type`: `'section' | 'folder' | 'page'`（`link` 不进 breadcrumb 因为它不是祖先链上的节点）
  - section / folder 节点的 `title` 直接取自 NavItem.title
  - page 节点的 `title` 优先取 `NavItem.titleOverride`，否则取目标 PageDoc.title
- `nav_index`：该 page 在 **DFS 前序遍历** 中的序号（从 0 起，**单 lang 内全局唯一**，跨 lang 编号空间独立）；空缺值（如未挂在 navigation 上的孤立 page）回退为 `INT_MAX`，让排序权重退化为零。
- `subtree_root`：该 page 在 navigation 树中**最近的"深度 1"祖先节点的稳定 nav id**（深度 0 是 navigation 文件根）。
  - **稳定 nav id 派生**（§2.2.2）：优先用 NavItem 自己写的 `id`；NavItem 未提供 `id` 时用 `nav:<file-basename>:<dfs-path>`，如 `nav:zh.json:0/1`。
  - 树结构：root → [section_1, folder_2, page_3, ...] → [page_or_section, ...]，深度 1 即"section / folder / page"层（无论类型）。
  - 自身就是深度 1 节点（罕见：navigation 直接挂 page 类型节点）→ `subtree_root = stable_nav_id_of_self`。
  - 选 "深度 1" 而非"深度 2/3" 的理由：开发者文档典型 navigation 是"前端 SDK / 后端 API / CLI / 部署"这一层做反问选项最自然；深度更深会把 "前端 SDK > 鉴权" 拆成独立反问选项，颗粒过细。粒度调整不在 v1，记入 §14 #4。
- `parent_id`：navigation 树中的直接父节点稳定 nav id（不是 page_id），缺省 `NULL`。
- `lang`：page 所属语种（`zh` / `en` / 未来更多），来自 `pages/{lang}/...` 路径的 lang 段，且必须与该 page 被引用的 `navigation/{lang}.json` 一致；不一致 → 启动期 warn，按 navigation 路径的 lang 入库（PRD §4.5 隔离硬条件不破，但需要日志可见）。
- 多 navigation 文件：见 §7.1.1 多 lang 合并规则。

#### 2.2.2 稳定 nav id 派生算法

```
stable_nav_id(node, file, dfs_path) =
  if node.type === 'page'                            → node.pageId
  elif (node.type ∈ {section, folder, link}) && node.id  → node.id
  else                                               → `nav:${basename(file)}:${dfs_path.join('/')}`
```

- `dfs_path`: 从 navigation 文件根到本节点的子节点序号路径（0-based），不是 page id。例：root.items[0].children[1].children[0] → `0/1/0`。
- **page 节点优先用 `pageId`**：是显式作者意图，且 PageDoc.id 自身就是稳定标识；citation breadcrumb 末位也是这个值（与 §5.1 例子一致：`{"id": "p_frontend_auth", ...}` 即 pageId）。
- **section / folder / link 节点**：优先用作者显式写的 `id`（anydocs `NavItem` 的可选字段）；没写就用 dfs 派生。
- 未写 `id` 的派生形态是"位置敏感"的——拖拽改顺序会让派生 id 漂移。这破了 PRD §4.6 的"拖拽零 embedding 重算"——但**只破了 nav 投影层，不破 chunks/embedding 层**。投影是毫秒级重算，可接受。
- v1 的取舍：让作者侧"重要 section 显式给 id"是最佳实践（写一份 ARCH 用法文档），但不强制。导出 `chunk_priors`（v1.5）按 page_id 关联而非 subtree_root，所以 nav id 漂移不会污染反馈数据。
- **唯一性保证**：在单 lang 内，section/folder/link 的派生 id 因为带 dfs_path 必然唯一；page 节点 id = pageId，要求 navigation 文件内同一 pageId 不重复出现（重复 → 启动期 warn，仅取首次出现的位置算 nav_index / breadcrumb）。

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
-- 复合主键 (page_id, lang)：anydocs 同 page id 在不同 lang 下是独立内容
CREATE TABLE pages (
  page_id      TEXT NOT NULL,
  lang         TEXT NOT NULL,            -- 'zh' / 'en' / ...，来自文件路径
  status       TEXT NOT NULL,            -- 仅 published 入库（draft / in_review 一律不进）
  title        TEXT NOT NULL,
  slug         TEXT,
  breadcrumb   JSON NOT NULL,            -- [{id, title, type}, ...] 含本页；id 是稳定 nav id
  nav_index    INTEGER,                  -- 在 lang 内 navigation 树的 DFS 序号
  parent_id    TEXT,                     -- 父 nav 节点稳定 id，不是 page_id
  subtree_root TEXT,                     -- 深度 1 nav 节点稳定 id（见 §2.2.1）
  url          TEXT,                     -- Reader 上的 URL
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (page_id, lang)
);

CREATE INDEX idx_pages_subtree ON pages(subtree_root);
CREATE INDEX idx_pages_parent  ON pages(parent_id);
CREATE INDEX idx_pages_lang    ON pages(lang);

-- 内容层：chunk 与 page 解耦；embedding 按 content_hash 缓存
-- chunks 也带 lang，便于查询时 lang_boost / 过滤不 join pages
CREATE TABLE chunks (
  chunk_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       TEXT NOT NULL,
  lang          TEXT NOT NULL,
  in_page_path  TEXT,                    -- 如 "h2#auth/p[2]"
  text          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,           -- sha256(normalize(text))
  token_count   INTEGER NOT NULL,
  is_code       INTEGER DEFAULT 0,       -- 代码块原子，不切分
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (page_id, lang) REFERENCES pages(page_id, lang) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_page ON chunks(page_id, lang);
CREATE INDEX idx_chunks_hash ON chunks(content_hash);
CREATE INDEX idx_chunks_lang ON chunks(lang);

-- BM25 倒排（FTS5），关键：dev docs 里 API 名 / ENV 变量靠精确词匹配
-- v1 单表跨 lang，过滤靠 join chunks.lang；FTS5 自带 unicode61 对中英文都能切
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content=chunks,
  content_rowid=chunk_id,
  tokenize='unicode61 remove_diacritics 2'
);

-- 向量索引（sqlite-vec 虚拟表）
-- bge-m3 默认 1024 维 fp32；切单语小模型时维度按模型走（见 §8）
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]                  -- bge-m3 默认 1024 维
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
- 保留策略：v1 **永久保留**，不做 LRU。理由：bge-m3 维度 1024 fp32 ≈ 4KB / chunk，10 万 chunk ≈ 400MB，用户切换模型的频率极低（一年级别）；显式 GC 弊大于利。
- 模型切换流程（手动）：用户改 `anydocs.ask.json` 的 `embedding.model` 后，重启服务时检测到主流模型变化 → 启动期日志提示"new embedding model detected, X chunks need re-embed"，并自动触发一次 `/v1/index/rebuild` 等价的全量重算（旧 model 的 cache 行**保留**，便于回退）。
- 磁盘上限保护：`.anydocs-ask/index.db` 体积超过 2GB 时启动期 warn 日志，提示用户手动清理（v1 不自动删；自动删 = 下次启动重算 = 违反 §4.6 直觉）。
- 跨机器迁移：rsync `.anydocs-ask/index.db` 即可带走全部 cache，无额外步骤。
- 多语言一致：bge-m3 单模型覆盖 zh / en（PRD §4.8）；同一 `content_hash` 不会出现"zh 一份 en 一份"的重复缓存。

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
  "answer_lang": "zh",
  "answer_md": "鉴权使用 JWT bearer token...\n\n```ts\nconst client = new SDK({ token })\n```\n",
  "translation_notice": null,
  "citations": [
    {
      "citation_id": "cit_1",
      "page_id": "p_frontend_auth",
      "lang": "zh",
      "source_lang": null,
      "title": "前端鉴权",
      "breadcrumb": [
        {"id": "nav:zh.json:0", "title": "快速开始", "type": "section"},
        {"id": "nav:zh.json:1", "title": "前端 SDK", "type": "section"},
        {"id": "p_frontend_auth", "title": "前端鉴权", "type": "page"}
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

**字段语义**（v1）：

- `answer_lang`：服务端对 question 检测出的 lang（zh / en），与客户端无关。
- `translation_notice`：跨语言降级时的提示（如 `"原文为英文文档，已为您翻译要点："`）；同 lang 直答时为 `null`。
- `citations[].lang`：该 citation 来源 page 的实际 lang。
- `citations[].source_lang`：仅当 `citations[].lang !== answer_lang`（即触发跨 lang 降级）时填该 page 的实际 lang，否则 `null`。Reader 端可据此渲染"原文为 X 语言"标签。
- `citations[].breadcrumb[].id`：稳定 nav id（详见 §2.2.1 / §2.2.2）；`type` ∈ `'section' | 'folder' | 'page'`。
- `citations[].breadcrumb[].title`：从 navigation 节点取（section / folder 用自己 title；page 用 `titleOverride ?? PageDoc.title`），始终是源 lang 的原文，**不翻译**（PRD §4.8 溯源保留原文）。

响应（澄清）：

```json
{
  "type": "clarify",
  "answer_id": "ans_2026050412345def",
  "answer_lang": "zh",
  "message": "您询问的鉴权，是指：",
  "options": [
    {
      "scope_id": "nav:zh.json:1",
      "lang": "zh",
      "label": "前端 SDK",
      "breadcrumb": [
        {"id": "nav:zh.json:0", "title": "快速开始", "type": "section"},
        {"id": "nav:zh.json:1", "title": "前端 SDK", "type": "section"}
      ],
      "sample_pages": [
        {"id": "p_frontend_auth", "title": "前端鉴权"},
        {"id": "p_frontend_session", "title": "会话管理"}
      ]
    },
    {
      "scope_id": "nav:zh.json:2",
      "lang": "zh",
      "label": "后端 API",
      "breadcrumb": [
        {"id": "nav:zh.json:0", "title": "快速开始", "type": "section"},
        {"id": "nav:zh.json:2", "title": "后端 API", "type": "section"}
      ],
      "sample_pages": [
        {"id": "p_backend_auth", "title": "API Key"}
      ]
    }
  ]
}
```

客户端把选定的 `scope_id` 回传到下一次 `/v1/ask` 的 `context.scope_id`，再次提问时检索范围收敛到该子树。

**clarify 选项的 lang 约束**（PRD §4.8）：`options[]` 的 `lang` 必须全部等于 `answer_lang`（即 query 的检测 lang）；混 lang 反问 = 体验破坏 + bug，单测和集成测试都校验。

错误响应（未知 / 已 unpublish 的 scope_id）：

```json
{
  "type": "error",
  "code": "invalid_scope",
  "message": "scope_id 'nav:zh.json:99' 不在 published 范围内"
}
```

HTTP 400。`scope_id` 校验是硬条件——未命中 `pages` 表中任一 `subtree_root` 的请求一律 400，**绝不静默降级为全局检索**（对应 PRD §4.2）。

**`scope_id` 与 lang**：scope_id 含隐式 lang 信息（`nav:zh.json:...` 前缀决定 lang）。客户端传 scope_id 时不需要再传 lang——服务端解析 scope_id 并在校验时同步绑定 lang，覆盖 query lang 检测结果（用户显式选了 zh 子树，就用 zh 回答；用户显式选了 en 子树但用中文问，仍按 en 子树召回 + 翻译降级回 zh 答）。

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

1.5 query lang 检测（v1.0+；PRD §4.8）
   ├─ scope_id 给了 → 从 scope_id 解析 lang（覆盖检测）
   ├─ current_page_id 给了 → 从 pages 表查 lang（如果 page_id 在多 lang 都存在，按检测规则裁决）
   └─ 否则纯文本检测：
        cjk_ratio = (CJK Unified Ideographs 字符数 / 非空白字符总数)
        cjk_ratio ≥ 0.30 → 'zh'
        否则             → 'en'
      （未来加 lang 走 §14 #13 演进）

2. 边界过滤（硬条件，永远不可绕过）
   WHERE pages.status = 'published'
   AND (scope_id IS NULL OR pages.subtree_root = scope_id)
   注意：lang 不在硬过滤里——多 lang 检索是 v1 的核心能力（PRD §4.8）；
        lang 偏好通过步骤 4 的 lang_boost 体现，并通过步骤 5 的"同 lang
        优先 + 跨 lang 降级"决定最终走向。

3. 混合召回（K = 20）
   ├─ 向量路径：embed(question, model=bge-m3) → sqlite-vec 余弦 top-20
   ├─ BM25 路径：FTS5 MATCH question top-20
   └─ RRF 融合：score = Σ 1 / (60 + rank_i) → top-20

   说明：dev docs 场景下 BM25 不可省。API 名、ENV 变量、SDK 方法名
        靠精确词匹配；向量路径补"鉴权 / 登录 / auth"这类语义相似。
        bge-m3 同时覆盖 zh/en，所以单次 embed 可以同时打到 zh 和 en chunks。

4. 结构重排（在 RRF top-20 上加权）
   final_score = rrf_score × (1 + lang_boost + same_subtree_boost + nav_index_boost)

   ├─ lang_boost：chunks.lang == query_lang ? +0.30 : 0
   │  （PRD §4.8 同 lang 优先；权重最高，确保跨 lang 仅在同 lang 没结果时显现）
   ├─ same_subtree_boost：current_page_id 的祖先链命中本 chunk 所属页：+0.20
   └─ nav_index_boost：+0.10 × (1 / log(nav_index + 2))
      （nav_index 即"编排权重"近似；v1 不依赖 anydocs 加字段）

5. 子树聚合 + lang 路径判定（在重排后 top-10 上）
   先按 lang 切片：top10_same_lang = top10 ∩ {chunks.lang == query_lang}

   分支 A — 同 lang 充分（top10_same_lang 非空且 max(rrf) ≥ 0.01）
     按 chunks.page_id → pages.subtree_root 分组，计算各子树得分占比 p_i：
     ├─ max(p_i) ≥ 0.65 → 单一子树主导，进入生成（语种 = query_lang，正常路径）
     ├─ 否则 top-2 子树得分差 < 0.15 → 触发 clarify（选项全是同 lang 子树，
     │  反问文案也用 query_lang）
     └─ 中间情况 → 直接进入生成（按主导子树，语种 = query_lang）

   分支 B — 同 lang 不足（top10_same_lang 空 或 max(rrf) < 0.01）
     → 跨 lang 翻译降级
     使用 top10（不限 lang）作为生成上下文；
     生成时显式提示 LLM「用户用 query_lang 提问，参考片段含其他语种；
     用 query_lang 回答；citation snippets 不要翻译」；
     answer_lang = query_lang，translation_notice 填提示语，
     citations[i].source_lang = chunks[i].lang。

6. 生成
   构造 prompt：
   ├─ 系统约束：
   │   ├─ 必须基于检索片段，严禁编造
   │   ├─ 必须给出 ≥1 引用，引用须含 breadcrumb
   │   ├─ 答案中所有代码 / API 名必须能在片段里找到
   │   └─ 答案语种 = answer_lang（即 query_lang）；citation snippet **不翻译**
   ├─ 输出格式判断（基于 question 词法 + answer_lang 双语词表）：
   │   ├─ 含 "对比 / 差异 / vs / 区别" 或 "compare / difference / vs / diff" → Markdown 表格
   │   ├─ 含 "如何 / 步骤 / 怎么" 或 "how / step / guide"           → 有序列表
   │   ├─ 含 "什么是 / 介绍" 或 "what is / overview / intro"         → 段落 + 关键术语 bullet
   │   └─ 默认                                                       → 段落
   ├─ 上下文注入：top 8 chunks，每个带 [breadcrumb (lang)] 前缀
   │  跨 lang 降级时额外注入 "原文为 X 语言" 标记
   └─ 调远端 LLM（默认 claude-sonnet-4-6 / gpt-4o）

7. 后处理
   ├─ 引用合法性：每条 citation 必须能 join 回某个 used chunk
   ├─ lang 字段填充：citation.lang ← chunks.lang；
   │   if chunks.lang != answer_lang → citation.source_lang = chunks.lang
   │                                  否则 citation.source_lang = null
   ├─ clarify 选项 lang 自检：options[].lang 必须全部等于 answer_lang
   ├─ 格式校验：if 应该出表格但没出 → 二次调用 LLM 改写为表格
   ├─ 幻觉过滤：检测答案里的代码块 / 引号包裹的标识符是否在 chunks 中出现
   │           没出现的 → 标 ⚠ 或剔除
   └─ 截断：超 4000 字截断 + 省略提示

8. 落 answer 缓存（TTL 24h）+ 返回
```

> **测试钩子**：lang 检测 / lang_boost / 翻译降级三段是 v1 多语言的核心，单测必须覆盖 PRD §8 验收 #11 / #12 / #13 的样例。

---

## 7. 索引管线

### 7.1 全量索引（启动期 / `index/rebuild`）

```
1. 扫 pages/**/*.json + navigation/**/*.json（递归 glob，支持嵌套，如 pages/zh/intro.json）
2. 过滤 status = 'published'
3. 构建 pages 表（含 breadcrumb / nav_index / subtree_root，规则见 §2.2.1）
4. 切 chunks（v1 锁定，2026-05-06 修订）：
   ├─ 通过 @anydocs/core/render-page-content 把 DocContentV1 渲染成 markdown
   ├─ 按 markdown heading（h1 / h2 / h3）切 section，每 section 含 headingPath（祖先 heading
   │  链）+ headingId（来自 anydocs createHeadingIdGenerator，与 Reader 对齐）
   ├─ 短 section（≤ 2000 char ≈ 500 token）→ **整段一个 chunk，保持完整性**（用户原则：
   │  原文档已结构化，按原有块切完整性更强）
   ├─ 长 section（> 2000 char）→ 滚动切，overlap 200 char，与 anydocs build-artifacts.ts 一致
   ├─ 代码块（fenced code block）**跟随所在 section**，**不再单独原子化**
   │  （早期 v1 草案的"is_code=1 独立 chunk"策略改写为：is_code 字段保留为 BM25 / rerank
   │   辅助信号——仅当一个 section 几乎全是代码时标 1。理由：把代码块从语境里剥离会
   │   破坏问答生成时"这段代码用在何处"的上下文，与 §4.7 立体溯源精神冲突）
   └─ 计算 content_hash = sha256(normalize(text))，是 §4.6 拖拽零重算的核心
5. 算 / 取 embedding：
   ├─ 查 embedding_cache（hash, model）
   ├─ hit → 复用
   └─ miss → 调 embedding API → 写 cache + chunks_vec
6. FTS5 索引同步（INSERT INTO chunks_fts）
```

#### 7.1.1 多 navigation 文件 = 多 lang（v1 默认）

anydocs 的标准布局是 `navigation/{lang}.json` + `pages/{lang}/*.json`。v1 的处理规则：

- **每份 `navigation/{lang}.json` 视为该 lang 的独立子树**，DFS 编号、breadcrumb、subtree_root 都在单 lang 内闭环——**不**做"虚拟根合并"。
  - 反问选项不会出现"哪个文件"这种 meta 节点，直接是该 lang 内的真实 section / folder。
  - `nav_index` 是 (lang) 内全局唯一，跨 lang 各自一套。
- **page 必须由 navigation 同 lang 引用**：`pages/zh/foo.json` 必须出现在 `navigation/zh.json` 的某个 `page` 节点 `pageId === 'foo'` 下。否则 → 启动期 warn 并按"孤立 page"处理（`nav_index = INT_MAX`，`subtree_root = NULL`，仍可被向量召回但权重退化）。
- **lang 取自路径而非 PageDoc.lang 字段**：`pages/zh/foo.json` 的 lang 一定是 `zh`，PageDoc 内若 `lang` 字段不一致 → warn 但以路径为准（避免双源真理）。
- **未来字段（audience / version）**：anydocs 主仓加 `audience` / `version` 字段后启用细粒度隔离；当前 v1 仅按 lang 隔离，是 PRD §4.5 的最低限实现。
- **零 navigation 项目**（仅 `pages/*.json`，无 `navigation/`）：v1 报错并拒绝启动——anydocs 的典型项目都有 navigation，没 navigation 的项目用不上 Ask 的"编排意图优先"价值。错误信息：`navigation/ directory missing; Ask requires an anydocs project with navigation files`。

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
| Embedding（默认） | **bge-m3**（@xenova/transformers，本地） | 多语言，1024 维 fp32；与 PRD §4.8 多语言策略配套 |
| Embedding（可选） | OpenAI text-embedding-3-large / Voyage multilingual | 远端，配置切换 |
| LLM（默认） | Claude Sonnet 4.6（Anthropic API） | 结构化输出强 + 多语言能力强（跨 lang 翻译降级用） |
| LLM（可选） | GPT-4o（OpenAI） | 配置切换 |
| 文件监听 | chokidar | 标准；防抖合并 |
| 包管理 | pnpm（与 anydocs workspace 一致） | — |
| 仓库形态 | 独立仓 `anydocs-ask`（**不**进 anydocs monorepo） | 发布周期解耦；不入侵 anydocs 主仓 |
| 包名 | `@anydocs/ask` | npm 发布；保留 anydocs 生态归属 |
| CLI 入口 | `anydocs-ask serve <projectRoot>` | 包内 `bin` 字段；或 `npx -y @anydocs/ask serve` |

### 选型已定（2026-05-04 / 2026-05-06 多语言修订）

- **仓库形态**：独立仓。npm 包名仍为 `@anydocs/ask`，发布周期与 anydocs 主仓解耦；不要求改动 anydocs CLI。
- **Embedding 默认**：`bge-m3`（@xenova/transformers，本地，~600MB fp32，1024 维）。**2026-05-06 从 bge-small-zh 切换**——理由：anydocs 项目天然多语言（zh + en），单语模型无法支撑 PRD §4.8 的"同 lang 优先 + 跨 lang 降级"。bge-m3 是当前开源多语言 embedding 之王，dense 输出兼容 sqlite-vec。代价：~3x 磁盘 vs bge-small 系列，首次下载 ~600MB，CPU embed 速度比 bge-small 慢 ~30%。
- **可选**：项目方对体积敏感时可在 `anydocs.ask.json` 显式切回 `bge-small-zh` / `bge-small-en`，但跨语言降级体验同步退化（需在 `anydocs.ask.json` 显式开启 `embedding.allowSingleLangFallback: true` 才允许，避免静默降级）。
- **向量库**：sqlite-vec。理由：单文件零运维；典型 dev docs 站点（≤50k chunks）性能充裕。LanceDB 升级路径预留给 v1.5+ 大型项目。
- **LLM 默认**：Claude Sonnet 4.6（远端 API）。理由：结构化输出强、函数调用稳定 + 多语言能力（跨 lang 翻译降级路径直接靠 LLM 完成翻译，不引入独立翻译服务）；可经 `anydocs.ask.json` 切到 GPT-4o。

### 仍待 spike 的事项

- **bge-m3 在小内存机器上的首次加载耗时**：模型 ~600MB，加载到内存后 ~1.5GB RSS。VPS 1GB RAM 场景下需观察是否 OOM；超 §6.1 P95 8s 上限时需在 `anydocs.ask.json` 加 `embedding.preferQuantized: true` 走 int8 版本（@xenova/transformers 支持）。
- **bge-m3 在英文 API 名混合中文文档场景下的召回**：BM25 兜底英文标识符；spike 期跑黄金样例集观察。

### 已完成的 spike

- **embedding 量化（2026-05-07 实测，codex-mcp-docs 8 页 16 chunk on M-series Mac）**：
  - fp32：首次冷启 7m20s（含 1.2GB 模型下载）；纯 embed 时间 ≈ 27s/chunk
  - int8（`preferQuantized: true`）：冷启 1m18s（含 191MB 模型下载）；二次启动 2.1s 跑完 15 chunk，约 100ms/chunk（batch）
  - **可见加速 ≈ 5-6×**，磁盘 191MB vs 1.2GB
  - 实现细节：embedding_cache 的 `model` 列在量化时附 `:q8` 后缀（`Xenova/bge-m3:q8`），fp32/int8 互不污染缓存；切换 `preferQuantized` 不会静默用错维度向量
  - v1 默认仍 fp32（保留召回保真），但**生产 / VPS 场景推荐 `preferQuantized: true`**；仅在 PRD §8 召回回归测试发现明显损失才回 fp32

---

## 9. 配置

`anydocs.ask.json`（项目根，可选；缺省走全局默认）：

```json
{
  "embedding": {
    "provider": "local",
    "model": "bge-m3",
    "allowSingleLangFallback": false,
    "preferQuantized": false
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
| §4.7 立体溯源 | API §5.1 citations[].breadcrumb；查询时实时 join 结构层；citation snippet 保留原 lang 不翻译 |
| §4.8 多语言策略 | 检测 §6 步骤 1.5；lang_boost §6 步骤 4；同 lang 优先 + 跨 lang 降级 §6 步骤 5；citation lang/source_lang §5.1 + §6 步骤 7 |

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
| 9 | γ 隐式信号的噪声率与可用性 | A 路径在无 β 时是否仍 work | v1 上线后 4 周真实数据评估；过噪 → 弃用，仅留 β |
| 10 | query 簇化算法选型（HDBSCAN vs 阈值贪心 vs 简单 ANN） | A+ 诊断质量与实现复杂度 | v1.5 实现期 spike；优先单一依赖（不引新库） |
| 11 | `chunk_priors` 重算节奏（每周 batch vs 每条 feedback 增量）| 反馈时延 vs 写放大 | v1.5 实现期定；默认每周 |
| 12 | feedback 文件的多人协作冲突处理（同一 inbox/*.md 多人审）| 团队场景可用性 | v1.5 实现期定；优先 git merge 兜底，不上锁 |
| 13 | query lang 检测在中英混拼场景的可靠性（如 "怎么调用 getUserById API"）| §4.8 同 lang 优先准确性 | v1 上线后跑黄金样例集；CJK 比例 0.30 阈值若误判率 > 5% → 加入第二信号（current_page_id.lang 兜底）|
| 14 | bge-m3 在小内存机器（≤1GB RAM）的加载耗时 / OOM 概率 | v1.5 是否要默认开 int8 量化 | 实现期跑 macOS / Linux 双平台 1GB 容器观察；阈值：冷启 ≤ 30s 才放行默认 fp32 |
| 15 | NavItem.section / folder 的 `id` 字段在真实 anydocs 项目里写得有多 | `subtree_root` 的稳定性（PRD §4.6 的弱化版）| 实现期抽查现有 anydocs 项目；普及率 < 30% → 在 ARCH 加一份「最佳实践：给 section 写 id」给作者 |

---

## 15. v1.5 增量：QA 反馈回路

> Status: v0.1 计划（未实现）
> Date: 2026-05-06
> Scope: v1.5（v1 上线并积累 ≥4 周反馈数据后启动）
> 配套：[PRD.md §11](./PRD.md)

本节为 v1.5 设计草案。**v1 实现期不依赖此节**，但 v1 的 `feedback` / `answers` 表 schema 必须能容纳本节的扩展（已确认兼容：本节扩展走 `ALTER TABLE ADD COLUMN` 与新增表，不破坏 v1 schema）。

### 15.1 数据流总览

```
        v1 已有                              v1.5 新增
┌──────────────────────────┐    ┌──────────────────────────────────┐
│ /v1/ask          → answers│    │ feedback (β / γ 信号采集)        │
│ /v1/ask/feedback→ feedback│───>│  ├─→ chunk_priors (新表)          │
└──────────────────────────┘    │  │      └─→ 查询管线步骤 4 加权    │
                                │  └─→ inbox/*.md (人工审核)        │
                                │       ├─→ approved/*.jsonl         │
                                │       │     └─→ chunk_priors        │
                                │       └─→ rejected/*.jsonl         │
                                │                                    │
                                │ diagnose (周任务)                  │
                                │  └─→ suggestions/*.md (给作者)     │
                                └──────────────────────────────────┘
```

### 15.2 F1 反馈信号采集

#### 15.2.1 β：显式信号（Reader 集成）

- API：复用 v1 的 `POST /v1/ask/feedback`，rating 字段语义不变
- Reader 改造范围（v1.5 破例的"那一点点入侵"）：
  - 答案下方 3 个按钮（👍 / 👎 / "答错了"）
  - 一个 `fetch(ASK_BASE_URL + '/v1/ask/feedback', ...)` 调用
  - 不引入新依赖、不动 anydocs 主仓 schema
- 数据落 `feedback` 表，新增字段：

```sql
-- v1.5 ALTER（向后兼容；v1 旧数据 signal_source 默认 'explicit'）
ALTER TABLE feedback ADD COLUMN signal_source TEXT NOT NULL DEFAULT 'explicit';
-- 'explicit' (β) | 'implicit' (γ) | 'curated' (人工审核后)
ALTER TABLE feedback ADD COLUMN reviewed_at INTEGER;
ALTER TABLE feedback ADD COLUMN review_decision TEXT;
-- NULL (未审) | 'approved' | 'rejected'
ALTER TABLE feedback ADD COLUMN session_id TEXT;
-- γ 用：关联同一 session 的隐式信号
```

- v1 已埋的 `bad_citation_ids` 字段在 v1.5 启用：在 reranker 中下调对应 chunk 的权重

#### 15.2.2 γ：隐式信号

实现位置：`/v1/ask` 响应里下发一个 `session_id`（client cookie / localStorage 维持），Ask 进程内存维护短期 session table（TTL 30min）。

| 信号 | 检测位置 | rating 折算 | 是否需 Reader 改造 |
|---|---|---|---|
| 5min 内同 session 重问（语义相似度 ≥ 0.85）| 服务端 | -0.3 | 否 |
| 提问后 30s 内未点击任何 citation | Reader 上报 | -0.5 | 是（一个 fetch）|
| 关闭 modal / 路由变化 | Reader 上报 | -0.5 | 是 |
| 停留 ≥ 60s 且无追问 | 客户端定时器 | +0.3 | 是 |

退化路径：连 Reader 极小改造都做不到的项目，γ 只剩"重问检测"一条；其他三项静默无效。这是可接受的最低档。

### 15.3 Reranker 加权（A 路径）

修改 §6 步骤 4（结构重排），引入"反馈先验"：

```
final_score = rrf_score 
            × (1 + structural_boosts)          # v1 已有：同子树 + nav_index
            × (1 + feedback_prior(chunk_id))    # v1.5 新增；feedback.enabled=false 时为 0
```

`feedback_prior(chunk_id)` 计算（每周离线汇总到 `chunk_priors` 表，查询时 O(1) 查表）：

```
prior = clip(  Σ_{f referencing chunk} weight(f) × rating_normalized(f)
              ────────────────────────────────────────────────────────  ,
                              log(N + e)
              -0.3, +0.3 )

weight(f) = {
  1.0   if signal_source = 'curated'
  0.7   if signal_source = 'explicit'
  0.3   if signal_source = 'implicit'
}

rating_normalized(f):
  +1 / -1 → 直接用
  γ 隐式分（如 -0.5）→ 直接用
```

边界：

- prior ∈ [-0.3, +0.3]，避免少数极端反馈污染
- N < 5 → prior = 0（冷启动）
- chunk 删除时 chunk_priors 联级清理
- `feedback.enabled = false` 时 `feedback_prior` 强制返回 0（与 v1 行为等价）

新增表：

```sql
CREATE TABLE chunk_priors (
  chunk_id      INTEGER PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  prior         REAL NOT NULL,
  feedback_n    INTEGER NOT NULL,
  computed_at   INTEGER NOT NULL
);
```

### 15.4 F2 A+ 失败查询诊断

实现：CLI `anydocs-ask feedback diagnose <projectRoot>`。可手动跑或通过外部 cron 调度。

```
1. 拉取最近 N 天（默认 30）的 feedback：
   - rating < 0 OR
   - 触发 clarify 但 30min 内无后续 scope_id 重发 OR
   - 该 query 当时检索 max(rrf_score) < 0.01（与 §6 步骤 5 同口径）

2. 对 query 文本嵌入聚类
   - v1 已有 embedding 模型，复用，不引新依赖
   - 算法 spike 见 §14 #10；v1.5 默认 HDBSCAN（min_cluster_size=3）

3. 每簇产出一份建议：
   - suggested_parent_node：簇内 current_page_id 的 subtree_root 众数
   - title_hint：簇质心 query 的关键词聚合（jieba 中文 / 简单 ngram 英文）
   - sample_queries：脱敏后取 3-5 条
   - reasoning：覆盖了哪些失败信号（量化）

4. 写到 feedback/suggestions/<YYYY-Www>.md（见 §15.5）
```

### 15.5 F3 文件化审核流

#### 15.5.1 目录 layout

```
.anydocs-ask/
├── index.db                               # v1 已有
└── feedback/                              # v1.5 新增
    ├── inbox/
    │   └── 2026-W18-001-jwt-auth.md       # 待审；每个 query 簇一文件
    ├── approved/
    │   └── 2026-05.jsonl                  # 已审通过；按月分文件
    ├── rejected/
    │   └── 2026-05.jsonl
    └── suggestions/
        └── 2026-W18.md                    # A+ 周报
```

设计取舍：

- **目录 + 多文件**而非单大文件：方便 git diff、并行审、避免合并冲突
- **inbox 用 markdown**（带 frontmatter）：作者熟悉、可在编辑器里直接读检索 chunks 和反馈摘要
- **approved/rejected 用 JSONL**：机读为主、append-only 友好、月切片防止单文件膨胀
- **suggestions 用 markdown**：直接给作者读和决策，不需要机读

#### 15.5.2 inbox 文件 frontmatter 格式

```markdown
---
cluster_id: 2026-W18-001
queries:
  - "如何鉴权"
  - "鉴权怎么搞"
sample_answer_id: ans_2026050412345abc
current_pages:
  - p_frontend_sdk_intro
feedback_summary:
  explicit_negative: 3
  implicit_negative: 7
  bad_citation_ids: ["cit_2", "cit_5"]
decision: pending           # 改为 approved / rejected 后跑 import
notes: ""                   # 审核备注（可选）
corrected_answer: ""        # 作者改写的"标准答案"（可选）
---

## 系统给出的答案

（原始答案 markdown）

## 检索的 chunks

（top 5 chunks 的 breadcrumb + snippet）
```

#### 15.5.3 CLI 行为表

| 命令 | 行为 | 幂等性 |
|---|---|---|
| `feedback export <projectRoot>` | 从 db 挑 `reviewed_at IS NULL` 且符合"值得审"条件的 feedback，按簇生成 `inbox/*.md`；已存在的文件不覆盖 | 幂等 |
| `feedback import <projectRoot>` | 扫 `inbox/*.md`：`decision: approved` → 写 `approved/<YYYY-MM>.jsonl` + 更新 `feedback.review_decision='approved'` + `signal_source='curated'`；`rejected` 同理；`pending` 跳过；处理后**移除** inbox 文件 | 幂等 |
| `feedback status <projectRoot>` | 打印队列：待审 N、approved M、rejected K、最近 diagnose 时间 | 只读 |
| `feedback diagnose <projectRoot>` | 见 §15.4；写 `suggestions/<YYYY-Www>.md`（已存在则合并） | 幂等 |
| `feedback rebuild-priors <projectRoot>` | 重算 `chunk_priors` 表（默认每周自动） | 幂等 |

"值得审"条件（`feedback export` 的过滤器）：

- `signal_source = 'explicit'` 且 `rating <= 0`
- 或 `signal_source = 'implicit'` 且同 query 簇累计负 ≥ 3
- 已 `reviewed_at IS NOT NULL` 的不再导出

### 15.6 与 v1 ARCHITECTURE 的兼容性

| 维度 | 兼容性 |
|---|---|
| `chunks` / `chunks_vec` / `chunks_fts` / `pages` / `embedding_cache` 表 | **不动** |
| `feedback` 表 | 仅 `ALTER ADD COLUMN`（向后兼容）|
| `answers` 表 | **不动**（24h TTL 不变；v1.5 不依赖延长 TTL）|
| 新增表 | `chunk_priors` |
| `normalize()` 算法 | **不动**（content_hash 兼容）|
| 查询管线 | 仅在步骤 4 增加 `feedback_prior` 项；`feedback.enabled = false` 时该项为 0，行为与 v1 等价 |
| 索引管线 | **不动** |
| Reader 集成 | β 需 Reader 加 3 按钮 + 1 fetch；γ 仅服务端可推时无需 Reader 改造 |

### 15.7 配置（v1.5 新增段）

```json
{
  "feedback": {
    "enabled": false,
    "implicitSignals": "session-only",
    "rerankerWeight": 0.15,
    "diagnose": {
      "schedule": "weekly",
      "lookbackDays": 30,
      "minClusterSize": 3
    },
    "review": {
      "exportBatchSize": 50,
      "approvedFileRotation": "monthly"
    }
  }
}
```

`implicitSignals` 三档：

- `off`：完全不收 γ 信号
- `session-only`：只收服务端可推的"重问检测"
- `full`：收全部 γ 信号（要求 Reader 上报 click / 离场 / 停留时长）

### 15.8 显式不做（v1.5 边界）

| 项 | 理由 | 何时重评 |
|---|---|---|
| 审过的 QA 作为 chunk 进检索 | PRD §11 决策 #1 否决（Shadow Wiki） | v2 重新评估 |
| 自动写回 anydocs `pages/*.json` | PRD §11 决策 #1 否决（创作者主权） | v2 重新评估 |
| 内置 Web review 面板 | PRD §11 决策 #3 否决（文件优先） | 看作者侧反馈 |
| 跨项目反馈联邦 | 一进程一项目 | v2 |
| LLM 辅助审核（自动给 inbox 打 approve/reject 建议）| 引入幻觉源；与"人工审核"初衷冲突 | 看 v1.5 真实工作量 |
