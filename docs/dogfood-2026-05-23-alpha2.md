# Dogfood 2026-05-23 — RFC 0005 alpha.2 真机回归

> 项目：hermes-docs（107 pages / 460 chunks）
> 范围：alpha.2 (PR [#72](https://github.com/cregis-dev/anydocs-ask/pull/72)) `citationSemanticCheck.enabled=true` 真机 shadow
> 模型：deepseek-v4-flash（Anthropic gateway，`/Users/shawn/anydocs-ask-runtime/.env`）
> 工具：CLI curl

---

## 范围

- alpha.2 V3/V4/V6 接通后的端到端 shadow 信号采集
- 10 query 真实 zh × en cross-lang 场景（hermes-docs 是 en-only docs）
- 看 `citation-check-update` tail 是否落、verdict 分布、latency

执行路径：`anydocs.ask.json` 加 `citationSemanticCheck: { enabled: true, mode: 'shadow' }` → 重启 serve → curl 10 query → grep runs.jsonl。

---

## 通过项

### F1 V3 fire-and-forget tail 真机落地 ✅

10 query × 1 tail each = 10 `citation-check-update` 行落入 `state/hermes-docs/runs/2026-W21.jsonl`，按 `request_id` 与原 RunRecord 一一对应。主响应（`POST /v1/ask`）2-3s 即返回，与 alpha.1 同 latency；tail 在响应之后异步完成，符合 RFC §4.2 设计。

### F2 V4 RunCitation 携带 `citation_id` ✅

历史 W20/W21 行的 `RunCitation` 没有 `citation_id`；alpha.2 写入的新行每个 `RunCitation` 都有 `citation_id: "cit_N"`，tail 用它与 RunRecord join。

### F3 配置真接通 ✅

flip 前（PR #72 描述里）serve 启动无 warning、`citation-check-update` 0 条；flip 后立即开始产 tail。`enabled=false` → 整段不触发任何 LLM 调用的 alpha.0 承诺由 [tests/runs-server.test.ts](tests/runs-server.test.ts) call-count assertion 守住。

### F4 Verdict 信号看上去靠谱 ✅

32 verdicts 分布：

| verdict | count | 占比 |
|---|---|---|
| `supports` | 24 | 75% |
| `partially` | 7 | 22% |
| `not_supports` | 1 | 3% |

随机抽 5 个抽样手检，reason 都跟 chunk 内容对得上：

- 「hermes 怎么登录？」cit_2 `not_supports`：「片段仅提到 web 仪表盘存在，未提及 hermes gateway 命令，关键事实缺失」—— 答案确实在讲 gateway 命令但引用指向了 dashboard chunk，**真阳性**
- 「memory provider 有哪些选项？」cit_1 `supports`：「文档片段列出了完全相同的三个文件类型，与 claim 一致」—— 正确判 supports
- 「fallback provider 怎么配置？」cit_2 `supports`：「片段明确区分了凭证池（同 provider 内轮换）和 fallback providers（切换到不同 provider）」—— 引用区分准确

抽样规模太小（n=5）不足以下结论误报率，但**没有明显荒唐 verdict**。

### F5 Latency 在异步可接受范围 ✅

- per-batch latency: min 2089ms / **p50 9431ms** / max 14251ms
- p50 ~9.4s 对 fire-and-forget tail 是 OK 的（响应已发，shadow 数据延迟落盘）
- 比 standalone 单 cit 测试（2.5s）慢，因为 batch 输入更大；deepseek-v4-flash 在 long-context JSON 输出上慢

---

## 发现的瑕疵 / 已修

### F6【validator, P0】alpha.1 `maxTokens` 公式对 CJK reason 不够 — **本 PR 同步修复**

**症状**：第一次 flip 后，单 query 写出 1 verdict（应该 5）；第二次单 query 0 verdict（应该 6）。debug stderr 显示 LLM raw 响应截断在 25 字符：`[\n  {\n    \"cit_id\": \"cit_`。

**根因**：[src/query/citation-validator.ts:109](src/query/citation-validator.ts#L109) alpha.1 用 `Math.max(256, batch.length * 80)` 算 maxTokens。中文 reason 每字 1.5-2 tokens，加 100-char 上限即 ≤ 200 tokens / reason，加 JSON 结构 ~50 tokens → 每 verdict 真实预算 ~250 tokens。6-cit batch 给 480 tokens，输出截在 cit_1 中间，整批 `parseLlmJsonArray` null → 静默 `[]`。

**为什么 alpha.1 单测没抓到**：tests/citation-validator.test.ts 全部用 MockLLM，`responder` 直接返回完整 JSON 字符串，不模拟 `maxTokens` 截断。

**修法**：

```ts
maxTokens: Math.max(1024, batch.length * 300),
```

- floor 1024：单 cit 也给足 slack
- 300/verdict：50 (JSON) + 200 (CJK reason) + 50 cushion

**回归测试**：tests/citation-validator.test.ts 增加 maxTokens 下限断言（≥ 1024 / ≥ 3000）守住。修后 10 query × 32 verdicts 全部落库，**0 truncation**。

### F7【validator, P2】batch 内重复 `cit_id` 只保留 first verdict — 不修

`extractClaimChunkPairs` 给同一 `cit_N` 标记的多次出现各产 pair（行内多 `[cit_1] ... [cit_1]` 是常见 prompt 风格）。validator `runBatch` 内 `seen` Set 按 `cit_id` 去重，只保留第一条 verdict。

**为什么 P2 不修**：

1. 同一 cit 引用同一 chunk，多次出现的 claim 是同一句子的不同 prefix；judge 多次浪费 tokens 但产同结果。
2. 跨 batch 仍可能重复——是 V1 的小漏洞，alpha.3 顺手清理。
3. 不影响 shadow 数据可用性。

### F8【UX, P3】Console Studio 还看不到 verdict — 等 V5

V5 = Console Feedback tab 把 `semantic_check` 展示在 drawer。本次 dogfood 仅 CLI 验证 tail 落地；Studio 接通是 0.3.0 release 内容。

---

## 还没真机验过

- **enforce mode**（0.4 H4 候选）— schema 留位但 alpha.2 仅消费 `enabled`，`mode` 字段在 alpha.2 路径上不影响行为
- **跨语言场景**（zh answer × en chunk）— 本次 dogfood 实际就是这个组合（hermes-docs 是 en 文档），但没专门拆开看 verdict 在 cross-lang 上是否系统性偏差

---

## 行动建议

- ✅ **F6 修在本 PR 内**（同 branch `fix/citation-validator-max-tokens-cjk`），含回归测试
- F7 / F8 进 alpha.3 排队
- 攒数据继续 shadow——RFC §5 Q5 升档硬门槛门槛要求 ≥ 1000 条带 citation 的答案 + 误报率人工抽样 ≤ 5%。当前 10 query / 32 verdict，远未达
- 下一次 dogfood 重点：扩 50-100 query × 至少 2 个项目（hermes-docs + anydocs-user-manual），开始累积 N=1000 的样本池
