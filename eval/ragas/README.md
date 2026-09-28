# anydocs Ragas evaluator

This package evaluates the JSONL trace written by a full `anydocs-ask eval`
run. It is deliberately separate from the online Ask process: Python, judge
model latency, and judge failures cannot affect production Q&A.

## Golden fields

Add reviewed semantic ground truth to selected entries in
`<state>/golden/cases.jsonl`:

```json
{
  "id": "transaction-fee",
  "query": "How is fee calculated?",
  "filters": { "audience": null, "version": null },
  "context_pageId": null,
  "expected": {
    "must_cite_pages": ["transaction-records"],
    "must_contain": [],
    "forbid_contain": [],
    "expected_kind": "answer",
    "reference_answer": "A short, human-reviewed canonical answer.",
    "reference_facts": [
      "The fee definition is stated exactly.",
      "The documented calculation rule is included."
    ],
    "evaluation_rubric": {
      "precision": "Do not invent rates or undocumented defaults."
    }
  },
  "tags": ["transactions", "reviewed-for-ragas"],
  "created_by": "manual",
  "reviewed_at": "2026-09-17",
  "reviewer": "docs-team",
  "lang": "en"
}
```

Start with 20-30 manually reviewed cases. `reference_answer` is used by
Factual Correctness. When it is absent, the runner joins `reference_facts`
into a reference. `rubric_compliance` evaluates the answer against the
canonical answer, atomic facts, retrieved context, and the case-specific
`evaluation_rubric`; its native 1-5 result is normalized to 0-1. Cases without
ground truth still receive Faithfulness and Answer Relevancy scores. Context
Precision and Context Recall are skipped when no reference or retrieved context
is present, while Rubric Compliance is skipped when no rubric is present.

Run a full eval, not `eval --no-router`: retrieval-only traces intentionally
have no generated answer and cannot produce the semantic scores.

## Run locally

```bash
cd eval/ragas
uv sync --extra dev --python 3.11

# Check reference/context coverage without calling a judge model.
uv run anydocs-ragas \
  /path/to/state/cregis-docs/reports/2026-09-17-eval.cases.jsonl \
  --validate-only

export RAGAS_JUDGE_MODEL=gpt-4.1-mini
export RAGAS_JUDGE_API_KEY=...
export RAGAS_EMBEDDING_MODEL=text-embedding-3-small
export RAGAS_EMBEDDING_API_KEY=...

uv run anydocs-ragas \
  /path/to/state/cregis-docs/reports/2026-09-17-eval.cases.jsonl \
  --output-dir /path/to/ragas-reports
```

Production full-eval traces include `runtime_build.release` and
`runtime_build.engine_release`; the runner uses those automatically. The
`--release` and `--engine` flags remain available as overrides for legacy or
locally generated traces.

OpenAI-compatible internal endpoints can be configured independently:

```bash
RAGAS_JUDGE_BASE_URL=http://judge.internal/v1
RAGAS_EMBEDDING_BASE_URL=http://embeddings.internal/v1
```

The default metrics are:

- `faithfulness`: answer claims supported by the actual generation context.
- `context_precision`: useful generation contexts ranked ahead of irrelevant ones,
  judged against reviewed Golden ground truth.
- `context_recall`: reviewed reference claims covered by the retrieved context.
- `reference_fact_recall`: runs Context Recall independently for each curated
  `reference_facts` item, then macro-averages the results. Use this as the
  primary actionable recall signal; it preserves Golden fact boundaries and
  reports per-fact reasons instead of allowing one omitted clause to collapse
  a multi-fact reference answer to zero.
- `answer_relevancy`: answer relevance to the user question.
- `factual_correctness`: answer agreement with reviewed Golden ground truth.
- `rubric_compliance`: case-specific groundedness and precision requirements.

Use
`--metrics faithfulness,context_precision,context_recall,reference_fact_recall,factual_correctness,rubric_compliance`
when the judge endpoint does not expose an embedding model.

`context_precision` complements the deterministic `Context-P@5` reported by the
TypeScript evaluator. `Context-P@5` checks page-ID membership and is cheap and
reproducible; Ragas context precision judges the semantic usefulness and order
of the exact contexts that reached generation.

For an Anthropic-compatible judge, including an internal gateway already used
by Ask, set:

```bash
RAGAS_JUDGE_PROVIDER=anthropic
ANTHROPIC_MODEL=deepseek-v4-pro
ANTHROPIC_API_KEY=...
# Or use ANTHROPIC_AUTH_TOKEN for a Bearer-token gateway.
ANTHROPIC_BASE_URL=https://gateway.example.com
RAGAS_JUDGE_EXTRA_BODY_JSON='{"thinking":{"type":"disabled"}}'
RAGAS_MAX_TOKENS=4096
```

`RAGAS_JUDGE_MODEL`, `RAGAS_JUDGE_API_KEY`, `RAGAS_JUDGE_AUTH_TOKEN`, and
`RAGAS_JUDGE_BASE_URL` take precedence when the evaluator needs credentials
different from the online Ask service.
`RAGAS_MAX_TOKENS` controls the structured judge response budget; the default
is `4096` so faithfulness claim extraction is not truncated on longer answers.

Some reasoning models enable thinking by default, which can conflict with the
structured `tool_choice` requests used by Ragas. Pass a provider-specific
request body when needed; this works with both Anthropic- and OpenAI-compatible
judge clients:

```bash
RAGAS_JUDGE_PROVIDER=openai
RAGAS_JUDGE_MODEL=deepseek-v4-pro
RAGAS_JUDGE_API_KEY=...
RAGAS_JUDGE_BASE_URL=https://gateway.example.com/v1
RAGAS_JUDGE_EXTRA_BODY_JSON='{"thinking":{"type":"disabled"}}'
```

`RAGAS_JUDGE_EXTRA_BODY_JSON` must be a JSON object and is forwarded unchanged
to the judge request.

## Run in Docker on the internal server

```bash
docker build -t anydocs-ragas:0.3 eval/ragas

docker run --rm \
  --env-file /etc/cregis-docs/ragas.env \
  -v /var/lib/cregis-docs/ask:/runtime:ro \
  -v /var/lib/cregis-docs/ragas-reports:/reports \
  anydocs-ragas:0.3 \
  /runtime/state/cregis-docs/reports/2026-09-17-eval.cases.jsonl \
  --output-dir /reports
```

Keep judge, embedding, and Langfuse credentials in
`/etc/cregis-docs/ragas.env`; do not put them in the image or command history.

The runner writes per-case JSONL, aggregate JSON, and a Markdown report. It
returns non-zero when a configured judge metric errors, while missing
references are recorded as skipped rather than failed.

## Langfuse Dataset/Experiment

When the existing `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and
`LANGFUSE_BASE_URL` variables are available, add:

```bash
--langfuse-dataset anydocs-cregis-golden
```

The runner appends a SHA-256 of the stable Golden inputs and references to the
dataset name. Answers and retrieved contexts are intentionally excluded from
that hash, so multiple releases run as comparable experiments on the same
dataset; changing ground truth creates a new dataset. The experiment records
release, engine, judge model, and all successful Ragas scores. Full evals
produced by a tracing-enabled engine also include `source_trace_id`,
`source_observation_id`, and a compact Agent diagnostic summary in every
experiment output. For direct low-score review, the output also repeats
`reference_answer`, `reference_facts`, and `evaluation_rubric` from the
versioned Dataset item alongside the response and retrieved contexts. The
publisher writes the same `ragas_*` scores back to that original Agent
observation, so a low-score filter in **Scores** opens the actual planning /
search / read / generation trace instead of only the offline replay
observation. Older trace files without source IDs remain publishable; they
simply skip this back-link. Secrets stay in the server environment and are
never written to the reports.

Useful failure filters include:

```text
scores.ragas_context_recall:<0.75
scores.ragas_reference_fact_recall:<0.75
scores.ragas_context_precision:<0.75
scores.ragas_faithfulness:<0.8
scores.agent_required_fact_coverage:<1
scores.agent_tool_error_count:>0
```

External judge, embedding, or Langfuse endpoints receive the selected
documentation context and generated answers. Use endpoints and retention
policies approved for the documentation's data classification.
