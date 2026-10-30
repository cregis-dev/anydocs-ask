import importlib.util
import json
from pathlib import Path

import pytest


def module():
    path = Path(__file__).resolve().parents[3] / "scripts/score-ablation-full.py"
    spec = importlib.util.spec_from_file_location("full_ablation", path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def test_full_contract_rebinds_existing_or_without_changing_labels(tmp_path):
    m = module()
    (tmp_path / "dataset").mkdir()
    golden = [{"id": "one", "query": "question", "lang": "en", "expected": {
        "reference_answer": "answer", "reference_facts": ["A or B"], "evaluation_rubric": {"r": "correct"}}}]
    (tmp_path / "dataset/cases.frozen.jsonl").write_text(json.dumps(golden[0]) + "\n")
    rules = tmp_path / "rules.json"
    rules.write_text(json.dumps({"schema_version": 1, "base_golden_sha256": "old-subset",
        "cases": {"one": [{"fact": "A or B", "any_of": ["A", "B"]}]}}))
    contract = m.prepare_contract(tmp_path, rules)
    assert contract["metric_profiles"]["reference_fact_recall"] == "audited-v3"
    assert contract["metric_profiles"]["context_recall"] == "audited-v1"
    assert not contract["strict_source_gate"]
    assert m.prepare_contract(tmp_path, rules) == contract
    assert json.loads((tmp_path / "dataset/fact-rules.json").read_text())["cases"] == json.loads(rules.read_text())["cases"]
    rules.write_text(json.dumps({"schema_version": 2, "cases": {}}))
    with pytest.raises(ValueError, match="strict source"):
        m.prepare_contract(tmp_path, rules)


def test_full_contract_uses_bounded_propagation_metadata():
    from anydocs_ragas.langfuse import _propagation_metadata
    compact = _propagation_metadata({"judge_profile": "ablation-full-v1", "variant": "parent_child",
                                    "context_mode": "no_page", "evaluation_input_sha256": "a" * 64,
                                    "metric_profiles": {"large": "x" * 500}})
    assert len(json.dumps(compact)) <= 200
    assert "metric_profiles" not in compact
