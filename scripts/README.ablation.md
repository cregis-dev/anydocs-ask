# Controlled RAG evaluation adapters

These offline adapters preserve the Cregis development experiments rather than
providing a general-purpose production benchmark. The smoke contract accepts
12 selected cases across four variants; the full contract accepts 92 bilingual
cases, four variants, and three independent system runs (1,104 attempts).
Both record frozen inputs, source hashes, evidence budgets, and original traces.

The variants are `child_only`, `parent_child`, `page_static`, and `agentic`.
The full adapters intentionally pin `deepseek-flash` for answers,
`deepseek-v4-pro` for judging, and the documented evidence/token budgets.
Use a new versioned adapter and output directory for a different contract.
Development controls and repeatedly used cases are not held-out human labels
or a production acceptance gate.

## Offline checks

From the repository root:

```sh
pnpm typecheck
pnpm typecheck:eval
pnpm test
pnpm build
cd eval/ragas
uv run --locked --extra dev pytest -q
uv run --locked anydocs-ragas tests/fixtures/sample-eval.cases.jsonl --validate-only
```

These checks use test doubles and fixtures; they do not start a paid evaluation
or publish scores. See [the evaluator guide](../eval/ragas/README.md) for judge
profiles, credentials, frozen-output calibration, and score-publication rules.
The existing lockfile is retained for reproducible comparison with archived runs.

## Generate, score, and inspect

The TypeScript generation adapters accept explicit `--project`, `--golden`, and
`--output` paths. The smoke adapter additionally requires `--selection` and
`--context-mode`. Output directories must be new; use `--resume` only where the
adapter explicitly supports it. Generation calls the configured answer service
and requires its runtime credentials.

- `eval-ablation-smoke.ts` and `lib/ablation-full-plan.ts`: bounded smoke
  generation and the deterministic full-run schedule.
- `eval-ablation-full.ts`: full generation with frozen snapshots, input and
  implementation hashes, resumable attempt journals, and source tracing.
- `score-ablation-smoke.py`: frozen smoke scoring and judge-only repeats.
- `score-ablation-full.py`: the full-v1 contract and baseline scoring executor.
- `score-ablation-full-parallel.py` and `score-ablation-full-scaled.py`:
  resource-only continuation adapters. They record concurrency phases while
  retaining completed scores and the original scoring contract.
- `check-judge-contract.py`, `check-evidence-judge.py`,
  `calibrate-frozen-agent-judge.py`, and `rejudge-ablation-smoke.py`: explicit
  development controls or frozen-output rejudging without answer generation.
- `retry-ablation-judge-errors.py`: retries technical judge errors without
  regenerating answers or replacing already successful scores.
- `analyze-ablation-smoke.py`, `analyze-ablation-full.py`, and
  `report-evidence-rejudge.py`: local reports, paired comparisons, missing-score
  bounds, and per-fact diagnostics. Judge errors stay missing rather than zero.
- `publish-ablation-full.py`: explicit experiment publication; this writes to
  the configured Langfuse project.
- `verify-ablation-full.py`: read-only Langfuse CLI reconciliation, using an
  explicitly supplied environment file.

Run Python adapters in the evaluator environment, for example:

```sh
cd eval/ragas
uv run --locked python ../../scripts/analyze-ablation-full.py /path/to/frozen-run \
  --langfuse-trace-base-url https://langfuse.example.com/project/PROJECT_ID/traces
```

The trace-base option is optional; without it reports retain plain trace IDs.
Do not include credentials or tokens in report URLs. Generation, judging, and
publication are separate explicit operations: do not run them merely to verify
a code change. Keep runtime secrets and generated runs outside Git.
