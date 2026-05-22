# Golden Set Curation Log — cregis-developer-docs

How the `cases.jsonl` under `<state>/golden/` was built, expanded, and
which attempts were set aside. Live document; append entries as the set
grows.

## 2026-05-21 · Seed (8 hand-crafted cases)

Manual authorship by `reviewer=codex`. Distribution:

- Payment Engine (zh×3, en×1) — checkout core fields, callback state
  mapping, crypto order_currency, en crypto order_currency
- WaaS (zh×1, en×1) — payout flow, webhook idempotency
- Signature / auth (zh×1) — signature rule
- Project setup (en×1) — payment-engine vs waas-api project

These set the quality bar for everything that follows: realistic
developer scenarios, multi-page citations, explicit
`must_cite_operations` / `must_cite_urls`, and `must_contain_regex`
that uses synonym alternations rather than rigid keyword lists.

## 2026-05-22 · Attempted: `golden generate --from structure`

Goal: bootstrap ~20-30 new cases for Phase 3 (domain expansion).

Two passes:

| Pass | Command | Result |
|---|---|---|
| #1 | `--limit 40` | 40 candidates, **all from Get Started nav group**, 4 pages |
| #2 | `--limit 400 --rewrite-batch-size 10` | 128 candidates across 4 nav groups, **13 pages** |

The LLM-rewrite step on `gw.cregis.ai` failed with the default batch
size of 50 (`gateway returned non-object response: undefined`).
Reduced batch to 10 via the new `--rewrite-batch-size` CLI flag
([9d12801](https://github.com/cregis-dev/anydocs-ask/commit/9d12801))
and the rewrite then succeeded with occasional retries.

### Why these 128 candidates were set aside

Even after the LLM rewrite, the templates didn't transform into
realistic queries. Representative output:

```
"平台概览是什么？"
"如何使用平台概览？"
"在快速入门中，平台概览与认证和签名有什么区别？"
"如何配置平台概览？"
"使用平台概览时有哪些注意事项？"
```

Compared to a hand-crafted reference:

```
"支付引擎回调里的 event_type 和查询订单返回的 data.status 为什么名字不一样？"
```

The gap is structural, not surface. The five built-in templates
(`what_is`, `how_to_use`, `compare_siblings`, `how_to_configure`,
`caveats`) describe metadata about a page rather than the
scenario-driven questions a developer actually asks. LLM rewrite is a
phrasing pass, not a re-conceptualization pass.

Additional gaps:
- **No OpenAPI operation pages covered** (`api-payment-engine-api-*`,
  `api-waas-api-*`) — the structure generator iterates real pages only,
  so the API-rule-pass surface is uncovered.
- **`must_contain` is empty** on every candidate — `answer_rule_pass`
  would be trivially-true, providing no signal.
- **Only 13 of 61 pages covered** — `--limit 400` is an upper bound, but
  the generator emits ~10-13 candidates per nav group and stops.

The candidates are NOT committed (they live under
`~/anydocs-ask-runtime/state/default/golden/cases.candidate.jsonl`,
outside the repo). They were left in place for diagnostic reference; a
later `golden generate --force` will overwrite them when the generator
is improved.

### Path forward (Phase 3 v2)

Hand-craft 20 new cases via a prompt-driven manual pass — see the
prompt in this session's transcript. Coverage targets:

- Signature / auth ×5 (zh+en mix; existing seed only has 1 zh)
- Project setup ×3 (extends 1 existing en)
- WaaS payout ×4 (extends 2 existing)
- Payment Engine scenarios ×4 (extends 4 existing)
- Cross-product / concepts ×4 (new domain)

Total goal: 8 seed + 20 new = **28 cases**, roughly 14 zh + 14 en.

### Open work item: improve the structure generator

`src/golden/generator.ts` could grow two new templates that the cregis
domain actually wants:

- **`api_operation`** — emits questions referencing a specific operation
  + its parameters / response shape, sourced from OpenAPI synthetic
  pages. Would cover the API-rule-pass surface.
- **`parameter_table`** — emits "what does field X mean / when do I
  use it" style questions from the parameter listings inside synthetic
  API pages or in supported-tokens / supported-currencies tables.

Not blocking — Phase 3 v2 goes through manual authorship. File this
under "if the project ever needs a 100+ case set for many domains."

## History

Append new entries above the "Open work item" section as the set
grows. Each entry should record: date, source (manual / generator /
runs), domain coverage delta, and any decisions worth carrying forward.
