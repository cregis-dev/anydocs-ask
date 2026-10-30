from copy import deepcopy
import importlib.util
from pathlib import Path

import pytest

path = Path(__file__).resolve().parents[3] / "scripts/retry-ablation-judge-errors.py"
spec = importlib.util.spec_from_file_location("judge_retry", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture():
    common = {"case_id": "one", "judge_profile": "audited-v1", "judge_contract_sha256": "hash",
              "judge_model": "judge", "evaluation_input_sha256": "input"}
    return ({**common, "scores": {"faithfulness": {"value": .5}}, "errors": {"reference_fact_recall": "invalid quote"}},
            {**common, "scores": {"reference_fact_recall": {"value": 1}}, "errors": {}})


def test_retry_preserves_successful_scores_original_and_error_history():
    original, retry = fixture()
    before = deepcopy(original)
    result = module.merge_retry(original, retry, "reference_fact_recall", "retry.jsonl")
    assert original == before
    assert result["scores"]["faithfulness"] == original["scores"]["faithfulness"]
    assert result["errors"] == {}
    assert result["judge_retry_history"][0]["original_error"] == "invalid quote"


def test_retry_cannot_replace_a_success():
    original, retry = fixture()
    original["scores"]["reference_fact_recall"] = {"value": 0}
    with pytest.raises(ValueError, match="Only a missing score"):
        module.merge_retry(original, retry, "reference_fact_recall", "x")


def test_retry_cannot_change_contract_or_case():
    original, retry = fixture()
    retry["judge_contract_sha256"] = "different"
    with pytest.raises(ValueError, match="changed judge_contract"):
        module.merge_retry(original, retry, "reference_fact_recall", "x")
    retry["case_id"] = "other"
    with pytest.raises(ValueError, match="case mismatch"):
        module.merge_retry(original, retry, "reference_fact_recall", "x")


def test_retry_cannot_hide_error_or_rerun_other_metrics():
    original, retry = fixture()
    retry["scores"]["faithfulness"] = {"value": 1}
    with pytest.raises(ValueError, match="exactly the failed metric"):
        module.merge_retry(original, retry, "reference_fact_recall", "x")
