# Backlog

短期未排期的小项。**不是 RFC 级**——成 RFC 的会进 `docs/rfcs/`；已立项的会进 `CHANGELOG.md` 或对应 RFC 的 milestone 段。

条目格式：

- `### <短标题>` — 一句话动机
- **现状**：为什么现在这样
- **建议**：要做什么
- **收益 / 成本**：粗判
- **不做的代价**：缓一缓的容忍度
- **触发条件**：什么时候捡起来

---

## ask 主路径重构（轻量化）

源起：2026-05-26 评审"显式 6 步管线（parseRequest → classifyIntent → retrieveContext → generateAnswer → postprocessCitations → persist/eval/feedback）"提议。整体提议判为**不做**——5/6 步已经隐式存在，纯线性会和现有的 citation retry / 异步 tail 打架。但从中拆出两条真有收益的小动作。

### 1. `askWithTraceInternal` 中段抽分私有函数

- **现状**：`src/query/answer.ts:158-520` 是 360 行的单函数。前 30 行是 input 校验 + lang detect + history 抽取，中段 200+ 行是 intent 探测 + retrieve/rerank/aggregate 编排 + pickContextChunks + 生成 + citation retry 缠在一起。已有 `// 1. ... // 6+7.` 步骤注释，但函数本身一屏看不完。
- **建议**：抽出 3-4 个**私有**函数（不导出、不改 API、不改 trace shape）：
  - `detectIntents(question, context)` —— 聚合 apiIntent / signatureAuthIntent / projectSetupIntent / apiReferenceHints / entityTerms 的结果
  - `runRetrievalAndAggregate(deps, ctx, intents)` —— retrieveWithTrace → rerank → aggregate → clarify 短路
  - `runGenerationWithCitationRetry(deps, prompt, queryLang, hooks)` —— LLM 调用 + postprocess + retry 循环
  - 主函数瘦到 ≤ 120 行，按时序读完整流程。
- **收益**：可读性 + 给 RFC 0006 后续接更细 per-step trace 留位（A+ 诊断要知道是 retrieve 失败还是 generate 失败）。
- **成本**：1 天工。`tests/ask.test.ts` 是端到端的，行为字节等价应自动 hold 住；citation retry 那段是最容易抽错的，需要保留"失败保持 llmOutput=旧、成功才 swap"的语义。
- **不做的代价**：低。注释已经在引路，新人不会迷路；只是 review 1100 行 PR 时痛。
- **触发条件**：0.4 收尾后（RFC 0006 GA flip + RFC 0005 H1 + RFC 0004 cross-origin 全部落地），或下次有人要在 `answer.ts` 主路径加新 step（比如 per-step trace 字段）时顺手做。

### 2. 6 个 regex intent 探测器归一成 `IntentResult`

- **现状**：`src/query/api-intent.ts` 提供 `detectApiIntent` / `detectSignatureAuthIntent` / `detectProjectSetupIntent` / `apiReferenceSearchHints` / `apiReferenceVersionPreferences`，外加 `answer.ts:1030 extractEntityTerms`，共 6 个独立 regex 探测器。`apiIntent` 一个旗标在 `answer.ts` 里被传给 retrieve options、rerank options、`pickAggregationCandidates`、`pickContextChunks`、`withMandatoryApiReferenceCitation` —— **5 处下游各读一次**。
- **建议**：定义 `IntentResult { api: boolean; signatureAuth: boolean; projectSetup: boolean; apiReferenceHints: string[]; apiReferenceVersionPrefs: string[]; entityTerms: string[] }`，单点调用 `classifyQueryIntent(question)`，下游函数签名收成 `(... , intent: IntentResult)`。
- **收益**：耦合归一——目前是"同一份 intent 被 5 处分别取用，每处都假设上游已经算好"，归一后多一个 intent 维度只动一处；也让 RFC 0006 诊断能直接 dump intent 到 trace。
- **成本**：1-1.5 天工。要小心 `apiReferenceHints` 这种"派生 intent"和 `apiIntent` 这种"主 intent"的层级——别一刀切扁平。
- **不做的代价**：中。每加一个新 intent 类型（比如以后要识别"代码生成请求"）都要在 5 处下游各加分支，是慢性出血。
- **触发条件**：和 #1 一起做最经济（都是主路径手术）；或者下次真要加一个新 intent 类型时顺手归一。

---

<!--
新增条目模板，复制以下三行：

### <短标题>
- **现状** / **建议** / **收益 / 成本** / **不做的代价** / **触发条件**
-->
