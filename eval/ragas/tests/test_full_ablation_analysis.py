import importlib.util
from pathlib import Path
import pytest


def module():
    path = Path(__file__).resolve().parents[3] / "scripts/analyze-ablation-full.py"
    spec = importlib.util.spec_from_file_location("full_analysis", path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def test_trace_links_use_an_explicit_project_url():
    m = module()
    assert m.trace_base_url(None) is None
    assert m.trace_base_url("https://langfuse.example.test/project/project-id/traces/") == \
        "https://langfuse.example.test/project/project-id/traces"
    for value in ("not-a-url", "file:///tmp/report", "https://user:secret@example.test/traces",
                  "https://example.test/traces?token=secret", "https://example.test/traces#token"):
        with pytest.raises(ValueError):
            m.trace_base_url(value)


def test_missing_judge_errors_are_not_zero_but_task_failures_are_itt_zero():
    m = module()
    row = {"result": {"type": "answer"}, "ragas_sample": {"retrieved_contexts": ["evidence"]}}
    assert m.value(row, {"errors": {"reference_fact_recall": "bad judge"}}, "reference_fact_recall") is None
    assert m.value(row, {}, "rubric_itt") is None
    row["result"] = {"type": "error"}
    assert m.value(row, {}, "rubric_itt") == 0
    assert m.value(row, {"scores": {"reference_fact_recall": {"value": .5}}}, "reference_fact_recall") == .5
    row["ragas_sample"]["retrieved_contexts"] = []
    assert m.value(row, {}, "reference_fact_recall") == 0


def test_cluster_bootstrap_preserves_pairs_and_is_seeded():
    m = module()
    values = {"one-en": .2, "one-zh": .2, "two": -.1}
    families = {"one-en": "one", "one-zh": "one", "two": "two"}
    a = m.bootstrap(values, families, repeats=100)
    assert a == m.bootstrap(values, families, repeats=100)
    assert a["clusters"] == 2
    assert a["low"] == -.1
    assert abs(a["high"] - .2) < 1e-9


def test_missing_bounds_are_sensitivity_not_observed_score_imputation():
    m = module()
    values = [1, None, .5]
    result = m.missing_bounds(values)
    assert result == {"planned_requests": 3, "missing_requests": 1, "lower": .5, "upper": 2.5 / 3}
    assert values == [1, None, .5]
    assert m.missing_bounds([1, 0])["lower"] == m.missing_bounds([1, 0])["upper"] == .5


def test_recall_input_excludes_answer_but_factual_input_excludes_context():
    m = module()
    a = {"ragas_sample": {"user_input": "q", "reference_facts": ["fact"], "reference": "ref",
                          "response": "answer-a", "retrieved_contexts": ["ctx"]}}
    b = {"ragas_sample": {**a["ragas_sample"], "response": "answer-b"}}
    assert m.metric_input(a, "reference_fact_recall") == m.metric_input(b, "reference_fact_recall")
    assert m.metric_input(a, "factual_correctness") != m.metric_input(b, "factual_correctness")
    c = {"ragas_sample": {**a["ragas_sample"], "retrieved_contexts": ["other"]}}
    assert m.metric_input(a, "factual_correctness") == m.metric_input(c, "factual_correctness")


def test_same_input_fact_flips_are_not_hidden_by_macro_cancellation():
    import json
    m = module()
    rows, judges = [], {}
    for rep, values in enumerate(([1, 0], [0, 1], [1, 0]), 1):
        rows.append({"variant": "child_only", "case_id": "one", "repetition": rep,
            "ragas_sample": {"user_input": "q", "reference_facts": ["A", "B"],
                             "retrieved_contexts": ["same evidence"], "response": f"answer {rep}"}})
        judges[("child_only", rep, "one")] = {"scores": {"reference_fact_recall": {
            "value": .5, "reason": json.dumps([{"fact": f, "value": v} for f, v in zip(("A", "B"), values)])}}}
    d = m.same_input_variation(rows, judges)["child_only"]["reference_fact_recall"]
    assert d["same_input_three_valid_scores_cases"] == 1
    assert d["changed_cases"] == 0
    assert d["fact_level_changed_cases"] == 1
    assert d["fact_level_changes"][0]["macro_cancelled_changes"]
