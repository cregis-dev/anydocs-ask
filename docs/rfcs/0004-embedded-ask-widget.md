# RFC 0004 — 嵌入式 Ask Widget

> Status: Draft (起草中)
> Author: @shawndslee
> Date: 2026-05-20
> 范围版本: `@anydocs/ask` 0.4（设计稿）/ 0.5+（落地）
> 设计依据: [PRD §10.2](../../PRD.md#102-版本路线按时间顺序) / [PRD §10.7](../../PRD.md#107-新增明确不做与-112-红线一致) 第 7 条
> 阻塞依赖: [RFC 0003](./0003-multi-turn-session-rewrite.md)（多轮 + session 重写必须先 GA）

---

## 0. TL;DR

把 ask 从"文档站点内的问答入口"扩展到**"嵌入到 SaaS 产品 UI 的上下文助手"**。提供 JS Widget + REST API 两种接入形态；上下文采集严格遵守"宿主显式注入、SDK 不抓 DOM"原则。**0.4 仅完成设计稿 + 联调原型；0.5+ 才正式 GA**。

---

## 1. 为什么现在做

### 1.1 商业价值

- **新客获取**：文档站点内的 ask 黏住已有 anydocs 用户；嵌入式 Widget 让 ask 进入"客户买了 anydocs 但用户 80% 时间在产品里，不在文档站"的场景。**这是 ask 工程独立增长的关键载体**。
- **闭环数据更密**：嵌入式产品 UI 收到的用户困惑是真实业务场景里的困惑，比文档站点的 ask 质量信号更高。喂回 RFC 0002 Studio 的反馈闭环后，是文档质量改进的更强 driver。

### 1.2 为什么 0.4 设计 / 0.5+ 落地

- 多轮（RFC 0003）必须先就绪——嵌入式场景几乎必然多轮；
- Studio 反馈闭环（RFC 0002）需要先在 0.2 完成基础，嵌入式数据才有消费端；
- 0.4 期间和 design partner 联调原型，验证 IA、上下文协议、鉴权方案，避免 GA 后大改。

---

## 2. 范围拆分

### 2.1 0.4 in-scope（设计稿 + 原型）

| # | 项 | 备注 |
|---|---|---|
| W1 | **嵌入协议规格**：JS SDK 接入方式、上下文 setContext API、鉴权（project public key + domain allowlist） | 设计文档 + TypeScript 类型定义 |
| W2 | **iframe / shadow DOM 形态对比 + 决策** | 隔离性 vs 主题继承 vs 性能 |
| W3 | **MVP Widget 原型**：右下角浮层、URL + 标题作为唯一上下文、对话基于现有 ask 后端 | 内部 dogfood，不对外 |
| W4 | **CORS / 跨域调用安全方案**：preflight、source 域校验、rate limit | 重点：rate limit by domain + IP |
| W5 | **与 1 家 design partner 联调** | 0.4 周期内确认协议可落 |

### 2.2 0.5+ in-scope（GA 实装）

| # | 项 | 备注 |
|---|---|---|
| WG1 | Phase 1 GA：浮层 + URL 上下文 + 公网部署 | 客户可生产接入 |
| WG2 | Phase 2：元素级触发（选中文本"explain this" / 字段旁的 "?" 按钮 / data-anydocs-topic tag） | 提升精度 |
| WG3 | Phase 3：受控数据上下文注入（`setContext({ invoice: {...} })`） | 业务数据驱动的问答 |
| WG4 | Phase 4：用户态绑定 + 多租户答案裁剪 | 企业需求驱动 |

### 2.3 永不做

- ❌ **SDK 自动抓宿主 DOM 数据**（PRD §10.7 第 7 条）——数据上下文必须由宿主显式 `setContext()` 调用，避免隐私边界争议
- ❌ **Widget 默认上传任何宿主页面截图 / 完整 DOM 树**——只采集 URL / page title（用户可选关闭）
- ❌ **强制接入 anydocs Reader 同款 UI**——嵌入式 Widget 是独立 UI 系统
- ❌ **Widget 内嵌大模型 API key**——客户调用走 ask 服务转发，key 在服务端

---

## 3. 实现里程碑

### 3.1 0.4 设计 / 原型阶段

```
0.4.0-alpha.0 (≈ 2026-07-04)  W1 协议规格 + W2 形态决策            设计敲定
0.4.0-alpha.1 (≈ 2026-07-18)  W3 MVP 原型可跑                     dogfood
0.4.0         (≈ 2026-07-25)  W4 CORS + W5 联调确认                与 partner 对齐
```

### 3.2 0.5+ 实装阶段（拆独立子 RFC，本 RFC 仅占位）

```
0.5.0 (≈ 2026-Q3)  Phase 1 GA：浮层 + URL 上下文
0.6.0 (≈ 2026-Q4)  Phase 2：元素级触发
0.7.0+             Phase 3-4：数据注入 / 用户态
```

---

## 4. 设计要点（仅 0.4 设计稿层面）

### 4.1 接入形态

```html
<script src="https://cdn.anydocs.ai/ask-widget/v1.js" async></script>
<script>
  anydocsAsk.init({
    projectKey: 'pk_live_xxx',           // project public key, domain-bound
    position: 'bottom-right',            // bottom-right | bottom-left | inline
    locale: 'zh' | 'en' | 'auto',
    onSessionId: (id) => { /* 持久化 */ }
  })

  // 可选：宿主显式注入数据上下文
  anydocsAsk.setContext({
    page: 'invoice-detail',
    data: { invoiceId: 'inv_123', amount: 100 }  // 受 schema 限制，宿主选要传什么
  })
</script>
```

### 4.2 iframe vs shadow DOM 决策

| 方案 | 优点 | 缺点 | 适用 |
|---|---|---|---|
| iframe | 完全样式隔离、CSP 友好、安全边界清晰 | 主题继承困难、resize 难 | **默认推荐** |
| shadow DOM | 主题可继承、性能好 | 部分宿主 CSP 限制 web component | 高级集成 |

**0.4 决策**：MVP 默认走 iframe（避免主题踩坑）；为 shadow DOM 留接口（`mode: 'shadow'`），0.5+ 视客户需求启用。

### 4.3 上下文协议

| 上下文层 | 采集方式 | 隐私风险 |
|---|---|---|
| URL + page title | SDK 自动 | 低（已是浏览器 referrer 范畴） |
| 选中文本 / 触发元素文本 | 用户手动选中触发 | 低（用户主动） |
| data-anydocs-topic tag | 宿主显式标注 | 无（无 PII） |
| `setContext({...})` 数据 | 宿主显式调用 | 高 — 宿主自负责数据脱敏 |

**关键约束**：四层全部"opt-in"——宿主可在 `init` 时配置 `contextSources: ['url', 'topic-tag']` 显式开启，不传则只采 URL。

### 4.4 鉴权方案

```
公开接入（默认）:
  Widget → POST /v1/ask
    Header: X-Project-Key: pk_live_xxx
    Header: Origin: https://app.example.com    # 强制域名白名单
  Ask 服务校验 (pk → allowed domains)，不通过返回 403
  无用户态、无 token

企业接入（0.5+ Phase 4）:
  Widget → 宿主后端 → Ask 服务（宿主签名 user token）
  Ask 服务按 user token 裁剪答案
```

### 4.5 多轮会话集成（依赖 RFC 0003）

Widget 在 `init` 时自动取 `localStorage.anydocs.ask.session_id`；每次 ask 带上、从响应回填；UI 显示对话历史。多轮重写在 ask 服务端完成（RFC 0003 M2），Widget 不感知。

---

## 5. 决策记录（2026-05-20 锁定）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 嵌入形态默认 iframe vs shadow DOM | **iframe**（§4.2）；shadow DOM 留接口 |
| Q2 | 是否做 React / Vue 组件包装 | **不做**。统一走 JS SDK，框架封装可由社区做 |
| Q3 | 是否允许 Widget 直接访问宿主 cookie / localStorage | **不允许**。session_id 用 Widget 自己的存储 namespace |
| Q4 | rate limit 维度 | **(project_key, domain, IP) 三维**；默认 60 req/min/IP，可配置 |
| Q5 | 0.4 是否同时设计企业接入 token 流程 | **不**，0.4 只做公开接入（pk + domain allowlist）；企业流 0.5+ Phase 4 单独 RFC |
| Q6 | 联调 design partner 选择 | 0.4 周期内确定 1 家——优先**SaaS 产品 UI 客户**而非纯文档站点客户，否则验证不到嵌入场景 |

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 多轮（RFC 0003）延期 | 本 RFC 0.4 阶段只做设计 + 原型，可承受 RFC 0003 ≤ 1 个版本的滑动 |
| 数据上下文注入引发客户隐私顾虑 | "宿主显式注入 + opt-in" 原则；提供 schema validator 让客户预审 |
| CDN 部署 + 域名白名单运维复杂 | 0.4 阶段先用客户自部署 ask 服务（同源调用）；CDN 形态在 0.5+ 评估 |
| 跨域请求被宿主 CSP 阻止 | 提供 CSP header 模板与示例；rate limit 用 Origin 而非 Cookie |
| Widget 与宿主样式冲突 | iframe 默认隔离；shadow DOM 走 design tokens |
| 嵌入式场景的检索效果差（vocabulary mismatch） | 通过 0.3 A+ 诊断 + 反馈回路驱动；如果数据显示明显，触发 PRD §10.6 "query 理解增强"线启动 |

---

## 7. 与其他 RFC 的关系

| RFC | 关系 |
|---|---|
| [0001](./0001-feedback-loop-v0.2.md) | 嵌入式 Widget 反馈走同一通道；Widget 提供"在产品 UI 里点 👍/👎"控件 |
| [0002](./0002-console-studio-feedback-loop.md) | Studio Feedback tab 是嵌入式反馈数据的消费端；嵌入式来源在数据上要可与文档站点来源区分 |
| [0003](./0003-multi-turn-session-rewrite.md) | **强阻塞**，必须先就绪 |
| [0005](./0005-citation-semantic-validation.md) | 嵌入式场景下数据上下文注入答案，citation 校验更关键 |

---

## 8. 未涉及

- 移动端 native SDK（iOS / Android）——0.4 不做，远期视需求
- 实时协作场景（多人同时问同一份数据）——0.5+ 评估
- 嵌入式 Widget 的可观测性（独立 traffic dashboard）——可在 0.5+ 复用 Console Studio 现有 Traffic tab + 来源筛选
- 与 Slack / Teams / WeChat Work bot 的集成——远期，独立 RFC

---

## 9. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-20 | 起草（0.4 设计稿范围） | @shawndslee |
