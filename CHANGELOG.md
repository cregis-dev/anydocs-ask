# Changelog

All notable changes to `@anydocs/ask` are documented here. The format roughly
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows semver pre-release semantics (`0.1.0-alpha.N`).

## 0.1.0-alpha.0 — 2026-05-09

First public alpha. The full v1 surface from `PRD.md` is shipped — index +
query + HTTP — together with the §16 evaluation loop (golden / eval / runs /
analyze). v1.5 feedback features (β/γ signals, `--from inbox`, analyze D4-D5)
remain on the next milestone.

### Added — index & query (PRD §1-§8, §13)

- SQLite + sqlite-vec + FTS5 schema with multilingual `(page_id, lang)`
  primary key; embedding cache keyed on `(content_hash, model:dtype)` so the
  fp32/int8 spaces never collide.
- Structure-layer projection from `pages/{lang}/*.json` + `navigation/{lang}.json`
  to a flat `pages` table that preserves nav order, subtree roots, and
  publish state. Drag-reorder a section ⇒ no embeddings recomputed.
- Content layer: token-aware chunking, bge-m3 local embeddings via
  `@xenova/transformers` with on-disk cache.
- Incremental index pipeline driven by `chokidar`; three-branch (page /
  navigation / config) change detection with debounce; §4.6 end-to-end
  contract green.
- Hybrid retrieval (vec + BM25 RRF) with structural rerank — language
  boost, same-subtree boost, nav-order decay, and **title-match boost**
  with shadow-suppression (the editorial signal `Installation on Termux`
  beats `Installation` when both titles appear).
- LLM answer assembly with citation renumbering (`[cit_N]` always
  refers to `citations[N-1]` after postprocess), hallucination filter on
  code-fenced blocks, and a normalized confidence proxy
  `top1.final_score / sum(top-5.final_score)`.
- Cross-lang fallback (PRD §4.8): same-lang chunks always preferred,
  translation only when no native match.

### Added — HTTP service (PRD §10)

- Hono server: `POST /v1/ask`, `GET /v1/index/status`, `GET /v1/health`.
- Anthropic-compatible LLM gateway: `authToken` + `baseURL` + `.env` discovery,
  with retry / backoff and `maxTokens` budget. Configurable via
  `anydocs.ask.json` or `ANTHROPIC_MODEL` env override.
- CORS allowlist; bind defaults to `127.0.0.1:3100` (local-first).

### Added — runtime workspace (ARCH §16.1)

- Default workspace at `~/anydocs-ask-runtime/`, overridable via
  `--workspace` flag or `$ANYDOCS_ASK_WORKSPACE`.
- 双根分离 (third revision): source projects live under `<workspace>/projects/`
  (path or symlink); all runtime data — `index.db`, `runs/`, `golden/`,
  `reports/` — lives under `<workspace>/state/<projectId>/`. Source repos
  stay clean of generated state.
- `anydocs-ask workspace init|ls` CLI; bare-name project args resolve to
  `<workspace>/projects/<name>` (one project per process is still the §5.5
  invariant).

### Added — evaluation loop (ARCH §16.3 / §16.5 / §16.6)

- `golden generate --from structure` — emits Q&A candidates for every
  navigation page using five templates (`what_is`, `how_to_use`,
  `compare_siblings`, `how_to_configure`, `caveats`). Optional
  `claude-sonnet-4-6` rewrite for natural-language phrasing. `must_cite_pages`
  is an OR-set (page + same-section siblings, capped at 5); `must_contain`
  is heading-derived keywords on procedural templates only.
- `golden generate --from runs` (ARCH §16.5.3) — picks high-confidence
  successful runs as regression candidates: `confidence ≥ 0.7`,
  `answer.md ≤ 600 chars`, no in-session re-ask within 30s. Clusters
  near-duplicates, dedups against existing approved cases.
- `golden review` — flushes approved candidates from `cases.candidate.jsonl`
  into `cases.jsonl`.
- `eval` (ARCH §16.3.2) — runs approved cases through an in-process Runtime,
  computes the three metrics R@5 / Citation-pass / Answer-rule-pass, writes
  a Markdown report under `<state>/reports/<date>-eval.md` with baseline
  diff against the previous report.
- `runs tail|export` — read-only views over the per-week jsonl.
- `analyze runs` (ARCH §16.6) — D1 recall failures (low-confidence /
  empty-citation / 30s re-ask), D2 latency anomalies (bucketed by query
  length and fused-chunk count), D3 disambiguation cliffs
  (`subtree_ask_triggered` without 5min follow-up). Query clustering uses
  edit-distance union-find rather than MinHash — sufficient at v1 traffic
  volumes; MinHash deferred to v1.5 when traffic warrants.

### Cold-start gate

R@5 ≥ 0.70, Citation-pass ≥ 0.65, Answer-rule-pass ≥ 0.60. Hermes-docs
baseline (30 cases): 1.00 / 0.83 / 0.60 — passing all three. Below threshold,
ARCH §16.6 routes operators back to **navigation/编排 review**, not to
retrieval-weight tuning.

### Not in this release (v1.5+)

- Reader-side β/γ feedback ingestion (PRD §11)
- `golden generate --from inbox` (depends on §15 inbox)
- `analyze` dimensions 4 (citation mismatch via β-negative) and 5
  (embedding drift across reindexes)
- Web evaluation panel (file-first per v1.5 §11 #3)
- Multi-project loading in one process (§5.5 v1 invariant; v2)
- Cross-project shared sqlite/runs/golden (v2)
