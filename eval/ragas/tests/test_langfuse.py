import pytest
from langfuse import Evaluation
from langfuse.api.core.api_error import ApiError

from anydocs_ragas.langfuse import (
    _ensure_dataset,
    _evaluations_for_result,
    _experiment_output,
    _publish_source_trace_scores,
)


class FakeLangfuse:
    def __init__(self, get_error=None, create_error=None, item_ids=()):
        self.get_error = get_error
        self.create_error = create_error
        self.created = []
        self.item_ids = item_ids

    def get_dataset(self, name, fetch_items_page_size):
        assert fetch_items_page_size == 100
        if self.get_error:
            raise self.get_error
        return type(
            "Dataset",
            (),
            {
                "name": name,
                "items": [type("Item", (), {"id": item_id})() for item_id in self.item_ids],
            },
        )()

    def create_dataset(self, **kwargs):
        self.created.append(kwargs)
        if self.create_error:
            raise self.create_error


def test_ensure_dataset_reuses_existing_dataset():
    client = FakeLangfuse(item_ids=("item-1", "item-2"))
    item_ids = _ensure_dataset(client, "golden@abc", "abcdef")
    assert client.created == []
    assert item_ids == {"item-1", "item-2"}


def test_ensure_dataset_creates_missing_dataset_and_tolerates_race():
    missing = ApiError(status_code=404, body={})
    client = FakeLangfuse(get_error=missing)
    assert _ensure_dataset(client, "golden@abc", "abcdef") == set()
    assert client.created[0]["metadata"] == {"golden_sha256": "abcdef"}

    raced = FakeLangfuse(
        get_error=missing,
        create_error=ApiError(status_code=409, body={}),
    )
    assert _ensure_dataset(raced, "golden@abc", "abcdef") == set()


def test_ensure_dataset_does_not_hide_provider_errors():
    client = FakeLangfuse(get_error=ApiError(status_code=500, body={}))
    with pytest.raises(ApiError):
        _ensure_dataset(client, "golden@abc", "abcdef")


def test_evaluations_use_langfuse_sdk_type():
    evaluations = _evaluations_for_result(
        {
            "scores": {
                "faithfulness": {"value": 0.75, "reason": "grounded"},
                "context_precision": {"value": 1.0, "reason": "useful first"},
                "factual_correctness": {"value": 0.5, "reason": None},
            }
        }
    )

    assert all(isinstance(evaluation, Evaluation) for evaluation in evaluations)
    assert [(evaluation.name, evaluation.value) for evaluation in evaluations] == [
        ("ragas_faithfulness", 0.75),
        ("ragas_context_precision", 1.0),
        ("ragas_factual_correctness", 0.5),
    ]


def test_experiment_output_includes_golden_context_for_trace_review():
    output = _experiment_output(
        "case-1",
        {
            "response": "Use /api/v1/payout.",
            "retrieved_contexts": ["POST /api/v1/payout creates a payout."],
            "reference": "Use /api/v1/payout to create a payout.",
            "reference_facts": ["The endpoint is /api/v1/payout."],
            "rubric": {"precision": "Do not name a different endpoint."},
            "source_trace_id": "trace-1",
            "source_observation_id": "observation-1",
            "agent_diagnostics": {"steps": 2},
        },
    )

    assert output == {
        "case_id": "case-1",
        "response": "Use /api/v1/payout.",
        "retrieved_contexts": ["POST /api/v1/payout creates a payout."],
        "reference_answer": "Use /api/v1/payout to create a payout.",
        "reference_facts": ["The endpoint is /api/v1/payout."],
        "evaluation_rubric": {"precision": "Do not name a different endpoint."},
        "source_trace_id": "trace-1",
        "source_observation_id": "observation-1",
        "agent_diagnostics": {"steps": 2},
    }


def test_publish_source_trace_scores_links_scores_to_original_observation():
    class ScoreClient:
        def __init__(self):
            self.scores = []

        def create_score(self, **kwargs):
            self.scores.append(kwargs)

    client = ScoreClient()
    count = _publish_source_trace_scores(
        client,
        {
            "case-1": {
                "source_trace_id": "trace-1",
                "source_observation_id": "observation-1",
            },
            "case-2": {"source_trace_id": None, "source_observation_id": None},
        },
        [
            {
                "case_id": "case-1",
                "scores": {
                    "context_recall": {"value": 0.5, "reason": "missing one fact"},
                    "faithfulness": {"value": 0.75, "reason": None},
                },
            },
            {
                "case_id": "case-2",
                "scores": {"context_recall": {"value": 0.25, "reason": None}},
            },
        ],
    )

    assert count == 2
    assert [score["name"] for score in client.scores] == [
        "ragas_context_recall",
        "ragas_faithfulness",
    ]
    assert all(score["trace_id"] == "trace-1" for score in client.scores)
    assert all(score["observation_id"] == "observation-1" for score in client.scores)
    assert all("score_id" in score for score in client.scores)
    assert client.scores[0]["comment"] == "missing one fact"
