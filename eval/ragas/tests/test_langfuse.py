import pytest
from langfuse import Evaluation
from langfuse.api.core.api_error import ApiError

from anydocs_ragas.langfuse import _ensure_dataset, _evaluations_for_result


class FakeLangfuse:
    def __init__(self, get_error=None, create_error=None):
        self.get_error = get_error
        self.create_error = create_error
        self.created = []

    def get_dataset(self, name, fetch_items_page_size):
        assert fetch_items_page_size == 1
        if self.get_error:
            raise self.get_error
        return {"name": name}

    def create_dataset(self, **kwargs):
        self.created.append(kwargs)
        if self.create_error:
            raise self.create_error


def test_ensure_dataset_reuses_existing_dataset():
    client = FakeLangfuse()
    _ensure_dataset(client, "golden@abc", "abcdef")
    assert client.created == []


def test_ensure_dataset_creates_missing_dataset_and_tolerates_race():
    missing = ApiError(status_code=404, body={})
    client = FakeLangfuse(get_error=missing)
    _ensure_dataset(client, "golden@abc", "abcdef")
    assert client.created[0]["metadata"] == {"golden_sha256": "abcdef"}

    raced = FakeLangfuse(
        get_error=missing,
        create_error=ApiError(status_code=409, body={}),
    )
    _ensure_dataset(raced, "golden@abc", "abcdef")


def test_ensure_dataset_does_not_hide_provider_errors():
    client = FakeLangfuse(get_error=ApiError(status_code=500, body={}))
    with pytest.raises(ApiError):
        _ensure_dataset(client, "golden@abc", "abcdef")


def test_evaluations_use_langfuse_sdk_type():
    evaluations = _evaluations_for_result(
        {
            "scores": {
                "faithfulness": {"value": 0.75, "reason": "grounded"},
                "factual_correctness": {"value": 0.5, "reason": None},
            }
        }
    )

    assert all(isinstance(evaluation, Evaluation) for evaluation in evaluations)
    assert [(evaluation.name, evaluation.value) for evaluation in evaluations] == [
        ("ragas_faithfulness", 0.75),
        ("ragas_factual_correctness", 0.5),
    ]
