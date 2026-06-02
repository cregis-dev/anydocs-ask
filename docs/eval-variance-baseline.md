# Eval Variance Baseline — 2026-05-22

Measured noise floor for the current 8-case `cregis-developer-docs` golden
set, used to decide whether an eval-metric delta on a PR is a real
improvement or just LLM stochasticity.

> **Run shape:** same code, same `cases.jsonl`, same retrieval index, eval
> command invoked 5x sequentially. Reports archived in
> `<state>/reports/2026-05-22-eval.variance-run-{1..5}.md`. Embedding
> cache is warm across runs, so retrieval is bit-identical.

## Per-metric distribution

| metric                  | run 1 | run 2 | run 3 | run 4 | run 5 | mean  | stddev | **2σ** |
|-------------------------|-------|-------|-------|-------|-------|-------|--------|--------|
| MRR                     | 0.854 | 0.854 | 0.854 | 0.854 | 0.854 | 0.854 | 0.000  | 0.000  |
| Hit@1                   | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 0.750 | 0.000  | 0.000  |
| Hit@3                   | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0.000  | 0.000  |
| Hit@5 (= R@5)           | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0.000  | 0.000  |
| Context-P@5             | 0.875 | 0.875 | 0.875 | 0.875 | 0.875 | 0.875 | 0.000  | 0.000  |
| Context-R@5             | 0.365 | 0.365 | 0.365 | 0.365 | 0.365 | 0.365 | 0.000  | 0.000  |
| Citation-pass           | 0.750 | 1.000 | 0.750 | 1.000 | 1.000 | 0.900 | 0.137  | **0.274** |
| Kind-pass               | 0.875 | 1.000 | 0.750 | 1.000 | 1.000 | 0.925 | 0.112  | **0.224** |
| API-rule-pass           | 0.800 | 0.800 | 0.800 | 1.000 | 0.800 | 0.840 | 0.089  | **0.179** |
| `answer_keyword_overlap`| 0.875 | 0.625 | 0.625 | 0.625 | 0.500 | 0.650 | 0.137  | **0.274** |

## Implications

### Retrieval-side metrics are deterministic

MRR, Hit@K, Context-P@5, Context-R@5 are bit-identical across 5 runs.
Retrieval is `(embed → vector + BM25 + RRF → rerank)` with no
non-determinism inside the index or the rerank function. **Any change ≥
0.001 on these metrics is real signal**, no replication required.

This is the cheapest place to detect regression: a single eval run is
enough to lock down whether retrieval changed.

### Generation-side metrics carry serious noise

Same code, same retrieved chunks, same prompt — the LLM still produces
materially different citations, answer kinds, and operation URLs across
runs. Concrete:

- **Citation-pass**: swings between 0.75 and 1.00 (2 cases out of 8 flipping)
- **`answer_keyword_overlap`**: range 0.50–0.875 (3 cases flipping)
- **Kind-pass**: 0.75–1.00 (2 cases flipping, one case occasionally erroring vs. answering)
- **API-rule-pass**: stable at 0.80 for 4/5 runs, 1.00 for one (one operation URL omission)

### "Significant change" thresholds (use 2σ)

For a PR to claim improvement on a generation-side metric, the delta
should exceed:

| metric                  | min Δ to be > noise (2σ) |
|-------------------------|---------------------------|
| Citation-pass           | **+0.27**                 |
| Kind-pass               | **+0.22**                 |
| API-rule-pass           | **+0.18**                 |
| `answer_keyword_overlap`| **+0.27**                 |

Below this, the delta is indistinguishable from random LLM jitter and
should not be cited as "this PR improved X by Y."

### Retroactive sanity check on recent claims

The chunking-bug-fix PR ([d7098f3](https://github.com/cregis-dev/anydocs-ask/commit/d7098f3))
reported these single-run deltas:

| metric        | claimed Δ | 2σ noise | verdict                |
|---------------|-----------|----------|------------------------|
| Citation-pass | +0.12     | 0.27     | **within noise**       |
| API-rule-pass | +0.20     | 0.18     | borderline (≈ 1σ over) |
| Kind-pass     | +0.12     | 0.22     | within noise           |
| R@5           | unchanged | 0.000    | n/a (deterministic)    |

The chunking fix is **almost certainly real** for two reasons that don't
depend on the LLM-side metrics:
1. It rebuilt the embedding/chunk space (different `content_hash` for
   code-containing pages), so retrieval-side metrics *could* have moved
   — and they didn't drop, so we know the fix didn't break retrieval.
2. The fix has a separate semantic justification (multi-line code
   preservation) that the eval can't fully measure with our current
   string-match metrics.

But for **future** PRs: stop reading single-run LLM-side deltas as
ground truth. Either run 3-5x, or rely on retrieval-side metrics +
inspect a few failing cases by hand.

## Caveats

1. **8 cases, 5 runs (40 LLM data points).** The variance estimate
   itself has wide CI. With more golden cases (Phase 3) the per-metric
   variance will shrink because each case contributes 1/N instead of
   1/8 to the mean. Re-measure after Phase 3 lands.

2. **One domain (payment-zh + a sprinkle of WaaS / setup / signature
   in en).** Variance in a signature-heavy or quickstart-heavy domain
   could be different. The retrieval-side zero-variance result will
   generalize; the LLM-side noise budget might not.

3. **One LLM (`deepseek-v4-pro` via `gw.cregis.ai`).** Different model /
   gateway combos have different temperature defaults and different
   instruction-following stability. The numbers here are specific to
   the current `anydocs.ask.json` config.

4. **temperature.** The eval pipeline calls Anthropic without an
   explicit temperature, so the gateway's default applies. Forcing
   `temperature: 0` would compress variance significantly but isn't
   yet wired — see the `LLMGenerateInput.temperature` plumbing in
   `src/llm/anthropic.ts`. Worth a follow-up.

## Operational rules

Going forward:

1. **PR description quoting an LLM-side metric delta must say "single
   run" OR "mean of N runs (stddev σ)".** A bare number is ambiguous.
2. **CI ablation guard** (Phase 4) compares against the variance-band,
   not against an exact baseline value.
3. **Retrieval-side metrics are the primary regression-detection
   surface.** They flag a real change immediately and cheaply.
4. **Re-run this baseline** after Phase 3 (expanded golden set) lands.
   Document the new variance table here, replacing the 2026-05-22 row,
   and keep historical tables in a `## History` section below.

## History

(2026-05-22 measurement is the foundational row. Future re-measurements
should append here when the golden set or LLM config changes.)
