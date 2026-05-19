# RFC 0002 — Console → Studio：反馈闭环主线

> Status: Draft (起草中)
> Author: @shawndslee
> Date: 2026-05-20
> 范围版本: `@anydocs/ask` 0.2.x
> 设计依据: [PRD §10.4](../../PRD.md#104-console--studio-的定位升级02-内) / [PRD §11 F2](../../PRD.md#11-v15-增量qa-反馈回路计划) / [console-redesign-brief](../console-redesign-brief.md)
> 依赖 RFC: [0001](./0001-feedback-loop-v0.2.md)（反馈通道铺通）

---

## 0. TL;DR

把 Console 从"项目管理 dashboard"升级为**"文档质量闭环 Studio"**，新增 **Journey 6 — Close the feedback loop**，并实现 journey 间的**穿透式跳转**。三件事：

1. **反馈信号可视化层**——把 RFC 0001 收上来的 β/γ 信号在 Console 内可见、可下钻；
2. **失败查询簇 → 文档章节映射**——把 PRD §11 F2 的 A+ 诊断在 UI 层呈现（数据后端可在 0.3 完整接入，0.2 先做空态 + mock 联调）；
3. **跨 journey 跳转**——traffic 看到失败 query → 一键起草 golden case；eval 看到回归 → 跳到 trace + 文档章节；文档章节页 → 反向显示"用户在附近问了什么"。

本 RFC 是 ask 工程从"工具"升级为"产品"的拐点，叙事核心是 PRD §10.1 的"文档质量的闭环引擎"。

---

## 1. 为什么现在做

### 1.1 现状的缺口

[console-redesign-brief](../console-redesign-brief.md) 已经把 Console 定位为主要接口，列了 5 个 journey（first-time setup / dogfood Q / run eval / manage golden / diagnose live traffic），但：

- **反馈数据在 Console 里几乎不可见**——只有 traffic tab 的健康指标条提了 confidence / 非答率，没有"哪些 query 失败了""失败的 query 落在哪个文档章节"等下钻；
- **5 个 journey 是平级的**——dogfood、eval、traffic 是孤立 tab；用户从一个 journey 跳到另一个全靠人脑做映射；
- **"补文档"动作完全在 Console 之外**——失败 query 看到了也无法直接定位到要改的文档章节，更别说起草建议。

### 1.2 为什么 RFC 0001 不够

RFC 0001 解决的是"反馈通道铺通"（数据进 SQLite + 文件化审核流），但**反馈数据进来后给谁看、怎么消费**没在它范围内。S8 项虽然提了"Console 加 feedback tab（只读）"，但只是"队列长度 + 最近反馈"的列表，**不是闭环的产品形态**。本 RFC 把 S8 扩展为一条完整 journey。

### 1.3 时间紧迫度

0.1.0 已发布、design partner 在用。Console 没有反馈闭环视图，design partner 体感是"我看不到 ask 对我的文档有什么帮助"。**Studio 化是 0.2 design partner 续费的关键叙事**，必须在 0.2 周期内至少把骨架立起来（即使部分数据要等 0.3 才齐）。

---

## 2. 范围拆分

### 2.1 0.2 in-scope

| # | 项 | 备注 |
|---|---|---|
| T1 | **Feedback tab 升级**（替代 RFC 0001 S8 的只读列表）：分三栏 — KPI（最近 7d 反馈量 / 显式 vs 隐式比例 / 触发 A+ 候选数）/ 失败 query 列表 / 信号细节抽屉 | RFC 0001 S8 → 本 RFC 接管 |
| T2 | **Cross-journey 跳转协议**：URL 锚点 + 全局事件 — 任一 journey 选中一个 `answer_id` / `cluster_id` / `query_text`，可一键打开关联视图（trace / golden / 文档章节） | 仅协议 + 实现 traffic→ask、traffic→golden 两条最关键路径 |
| T3 | **Traffic tab 增强**：每行可展开 trace + 答案 + 反馈状态；"加为 golden case"按钮直接生成 candidate（无需手动复制 query） | 在现有 Traffic tab 上叠加 |
| T4 | **Content explorer 反向标记**（Index tab）：每个 nav 节点显示"过去 7d 用户在此附近的 ask 数 + 命中率"小标签；命中率 < 阈值时显示 warn 圆点 | 数据源 = runs.jsonl 聚合，0.2 不依赖 A+ |
| T5 | **Journey 6 user-facing 文案**：在 [console-redesign-brief](../console-redesign-brief.md) §3 加入 Journey 6 描述、§7 加入对应页面状态 | 文档更新 |
| T6 | **空态设计**：A+ 诊断功能 0.3 才接入，0.2 Feedback tab 在样本不足时展示明确的空态（"再积累 X 条反馈即可启用聚类诊断"）+ 引导 CTA | 不做 mock 数据 |

### 2.2 0.2 out-of-scope（→ 0.3 启动）

| # | 项 | 理由 |
|---|---|---|
| D1 | **A+ 失败查询簇视图**（聚类 + 挂回 nav 子树）| 依赖 A+ 后端聚类逻辑，与 PRD §10.3 ≥ 50 条阈值绑定 |
| D2 | **"补文档草稿"起草**（小模型生成补充内容大纲）| 依赖 A+ + 小模型基础设施，先看 0.3 数据再决定是否做 |
| D3 | **Eval ↔ Traffic 联动**（eval 报告里点击 case → 跳到该 case 对应的真实流量回放）| 数据 schema 已具备，但 UI 工程量大，先做 traffic ↔ ask / golden 两条 |
| D4 | **Content explorer 内嵌编辑**| Studio 化叙事的下一站；本 RFC 不做，保持"内容编辑在 anydocs 主仓 + git" |

### 2.3 永不做

延续 PRD §11.2 红线，本 RFC 明确不做：

- ❌ Console 内嵌 QA 审核 UI（审核走文件 + git，PRD §11.2 决策 ③）
- ❌ Console 直接修改 `pages/*.json`（PRD §11.2 决策 ②）
- ❌ Console 自动生成 + 自动 import 补文档（必须经作者 git review）
- ❌ Feedback 数据上传到任何远端服务（PRD §11.4 #5）
- ❌ A+ 聚类输出作为"答案"反向喂给 `/v1/ask`（PRD §11.2 决策 ①）

---

## 3. Journey 6 — Close the feedback loop（详描）

User story（"Doc Author Daria"视角）：

> 我是文档作者。这周早上我打开 Console，想知道：(1) ask 在我的文档上跑得好不好？(2) 哪些问题没答好？(3) 哪些文档章节"附近"用户问得多但答得差？(4) 我应该补哪些内容？

对应的 Console 行为序列：

1. **打开项目页 → Feedback tab**（0.2 新名，原是 RFC 0001 S8 的占位）；
2. **KPI 顶栏一眼看清状态**：本周反馈量、显式比例、A+ 候选数（0.2 显示空态）；
3. **下钻一条失败 query**：右抽屉显示 question + 答案 + retrieval trace + 反馈状态（👍/👎/无）+ 关联的 nav 子树；
4. **抽屉里"加为 golden case"**：一键把 query 灌进 Golden Workshop pending list（跨 journey 跳转 T2）；
5. **抽屉里"跳到关联文档章节"**：跳到 Index tab 该节点高亮（跨 journey 跳转 T2）；
6. **Index tab 看到反向标记**（T4）：哪些节点附近 ask 多 / 命中率低；
7. **0.3 起接入 A+ 后**：Feedback tab 多出"失败查询簇"视图，每个簇有"建议补哪个 nav 节点"卡片，可一键复制到剪贴板 / 导出为 markdown 提案。

整条 journey 不离开 Console，但**补文档动作仍然要回到 anydocs 主仓 + git review**——这是红线，不变。

---

## 4. 实现里程碑

```
0.2.0-alpha.0 (≈ 2026-05-30)  T2 cross-journey 跳转协议 + T6 空态     基础设施
0.2.0-alpha.1 (≈ 2026-06-06)  T1 Feedback tab 升级 (KPI + 列表 + 抽屉)  主页面
0.2.0-alpha.2 (≈ 2026-06-13)  T3 Traffic 增强 + T4 Index 反向标记       穿透完成
0.2.0         (≈ 2026-06-20)  T5 brief 文档更新 + 整体回归              交付
```

里程碑与 RFC 0001 对齐：本 RFC 的 T1 依赖 RFC 0001 S3（feedback 表字段就绪）+ S6（`feedback.enabled` 开关），起步时间晚一周。

---

## 5. 设计要点

### 5.1 Cross-journey 跳转协议（T2）

URL 锚点 + query string：

```
/p/<name>#traffic?focus=run_<id>            # traffic 默认聚焦某条 run
/p/<name>#ask?prefill=<question>            # ask 预填某个问题（用于复现）
/p/<name>#eval?case=<case_id>               # eval 高亮某个 case
/p/<name>#index?focus=<nav_id>              # index 高亮某个 nav 节点
/p/<name>#golden?candidate=<question>       # golden workshop 预填候选
/p/<name>#feedback?cluster=<cluster_id>     # feedback tab 聚焦某簇（0.3 启用）
```

实现：所有跳转通过统一 helper `goTo({ tab, focus })` 发起；接收端 tab 在 mount 时解析 query string，调用对应"focus 该项目"方法（滚动 + 高亮 + 展开抽屉）。

**关键约束**：跳转**不丢上下文**——`history.replaceState` 写 URL，浏览器后退能回到原 journey。

### 5.2 Feedback tab 布局（T1）

三栏左 / 中 / 右：

- **左 KPI**（固定）：本周反馈量 / 显式 vs 隐式比例 / 平均 confidence / non-answer rate / A+ 候选数（0.2 空态）/ 上周对比 sparkline
- **中列表**（可滚动）：按时间倒序展示反馈条目；每条显示 question 截断 + 反馈类型徽章 + confidence 数 + 命中 nav 子树
- **右抽屉**（点击列表项打开）：question 全文 / answer markdown / retrieval trace 折叠面板 / 反馈状态 / 操作区（加为 golden case / 跳到文档章节 / 复现 ask）

### 5.3 Content explorer 反向标记（T4）

数据计算：

- 每个 nav 节点统计"过去 7d 命中该节点为 used_chunks 来源页面"的 ask 数 + 平均 confidence
- 命中数 < 3 → 不显示标记（噪声）
- 命中数 ≥ 3 且 confidence 中位数 < 0.5 → warn 圆点
- 命中数 ≥ 3 且 confidence 中位数 ≥ 0.5 → 中性数字标签

实现：复用 `runs.jsonl` + 现有 analyze 维度，**不引入新数据表**。

### 5.4 0.2 / 0.3 数据分阶段策略

| 视图 | 0.2 数据源 | 0.3 增强 |
|---|---|---|
| KPI 顶栏 | runs.jsonl 聚合 + feedback 表 count | 增加 A+ 候选数 |
| 失败 query 列表 | runs.jsonl `error_code=no_citations` + feedback `rating<0` | 增加聚类后的簇视图 |
| 关联 nav 子树 | retrieval trace 的 nav_index | 不变 |
| 补文档草稿 | **不实现** | A+ 输出 + 小模型起草 |

0.2 不做 mock 数据；A+ 相关视图直接显示空态 + "等待 0.3 启用"。

---

## 6. 决策记录（2026-05-20 锁定）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | Feedback tab 是覆盖 RFC 0001 S8 还是并列？ | **覆盖**。RFC 0001 S8 范围在本 RFC T1 中重定义为完整的 KPI + 列表 + 抽屉，原 S8 只读列表降级为 T1 的子组件 |
| Q2 | Cross-journey 跳转用 URL 锚点还是全局事件总线？ | **URL 锚点 + query string**。浏览器后退保留、可分享、与现有 Console SSR 架构一致；不引入前端框架 |
| Q3 | A+ 视图 0.2 是否做 mock 数据演示？ | **不做**。空态 + "等待 0.3 启用"，避免给 design partner "功能已就绪"的错误预期 |
| Q4 | Content explorer 反向标记的命中数门槛？ | **≥ 3 次**。低于此噪声大；阈值可后续调，先用默认 |
| Q5 | "加为 golden case"是直接生成 candidate 还是打开预填表单？ | **打开预填表单**。强制作者过一道审，与"作者主权"原则一致 |
| Q6 | 0.2 是否把 Eval ↔ Traffic 联动也做了？ | **0.2 不做**。工程量过大，先做 traffic ↔ ask / golden 两条核心；Eval ↔ Traffic 放 0.3 |

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 0.2 反馈量积累慢，T1 抽屉显得"空" | T1 KPI 内引导文案说明"反馈采集中"；T6 空态在样本 < 10 条时显示更详细引导 |
| Cross-journey 跳转破坏现有 tab state（如 Eval 跑到一半被切走） | 跳转前判断 tab 是否有进行中操作，有则提示"切换会中断..."；用户确认才跳 |
| Content explorer 反向标记给作者错误信号（命中少不等于章节差） | 标记文案明确"命中数低 + 命中页面信心低"才提醒；详情抽屉里展示原始数据让作者判断 |
| 0.3 A+ 接入晚于预期 | 0.2 Feedback tab 不依赖 A+ 数据即可发布；A+ 视图先以空态存在，0.3 后端就绪时直接接入数据 |
| Studio 化叙事被 design partner 解读为"自动改文档" | 在 Feedback tab 顶部和所有"加为 golden case" / "跳到章节"操作旁明确标注"建议仅供作者参考，不会自动修改文档" |

---

## 8. 与其他 RFC 的关系

| RFC | 关系 |
|---|---|
| [0001](./0001-feedback-loop-v0.2.md) | 本 RFC 消费 0001 提供的 feedback 表数据；0001 的 S8 范围被本 RFC T1 接管 |
| [0003](./0003-multi-turn-session-rewrite.md) | 多轮上线后，Feedback tab 需要展示"对话级"反馈（一组 ask 共享 session），目前 0.2 schema 已留位 |
| [0004](./0004-embedded-ask-widget.md) | 嵌入式 Widget 反馈走同一通道；Console 的 Feedback tab 是嵌入式场景的数据消费端 |
| [0005](./0005-citation-semantic-validation.md) | Citation 校验产生的"引用错误"信号在 Feedback tab 抽屉中作为额外类别展示 |

---

## 9. 未涉及

- 多用户 / 多作者协作权限模型——design partner 当前规模无需求，先扁平
- 反馈数据导出 BI 工具（Looker / Metabase）——0.5+ 评估
- 移动端 Console——console-redesign-brief 已明确 < 720px out-of-scope

---

## 10. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-20 | 起草 | @shawndslee |
