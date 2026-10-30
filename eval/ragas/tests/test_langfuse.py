import pytest
from langfuse import Evaluation
from langfuse.api.core.api_error import ApiError

from anydocs_ragas.langfuse import (
    publish_experiment,
    _ensure_dataset,
    _evaluations_for_result,
    _experiment_output,
    _publish_source_trace_scores,
    _propagation_metadata,
)


@pytest.mark.parametrize("profile", ["audited-v1", "audited-v2", "audited-v3", "audited-v4"])
def test_audited_propagation_keeps_identity_under_sdk_limit(profile):
    import json
    metadata = {"variant": "parent_child", "context_mode": "no_page", "judge_profile": profile,
                "evaluation_input_sha256": "a" * 64, "engine": "b" * 40, "release": "c" * 40}
    compact = _propagation_metadata(metadata)
    assert len(json.dumps(compact)) <= 200
    assert compact["judge_profile"] == profile
    assert compact["evaluation_input_sha256"] == "a" * 64
    assert "engine" not in compact
    with pytest.raises(ValueError):
        _propagation_metadata({**metadata, "variant": "oversized" * 100})


def test_publish_experiment_keeps_controlled_run_metadata(monkeypatch):
    from types import SimpleNamespace

    captured = {}

    class Dataset:
        items = []

        def run_experiment(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(dataset_run_url="https://example.test/run")

    class Client:
        def get_dataset(self, *_args, **_kwargs):
            return Dataset()

        def create_dataset_item(self, **_kwargs):
            pass

        def flush(self):
            pass

    monkeypatch.setattr("langfuse.Langfuse", lambda **_kwargs: Client())
    metadata = {"golden_sha256": "abc", "judge_provider": "anthropic", "judge_model": "judge",
                "experiment_id": "smoke", "variant": "page_static", "context_mode": "no_page",
                "repetition": 1, "evaluation_input_sha256": "input-hash"}
    url = publish_experiment(samples_by_id={"case-1": {"user_input": "question", "reference": "ref",
                             "lang": "en", "context_source": "prompt_snapshot", "reference_facts": ["fact"],
                             "rubric": {}}}, results=[{"case_id": "case-1", "scores": {}}],
                             dataset_base_name="test", experiment_name="smoke-page-static", metadata=metadata)
    assert url == "https://example.test/run"
    for name in ("experiment_id", "variant", "context_mode", "repetition", "evaluation_input_sha256"):
        assert captured["metadata"][name] == metadata[name]


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


@pytest.mark.parametrize("profile", ["audited-v2", "audited-v3", "audited-v4"])
def test_versioned_publication_preserves_source_scores_and_exposes_rules(monkeypatch, profile):
    from types import SimpleNamespace
    captured = {}

    class Dataset:
        items = []

        def run_experiment(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(dataset_run_url="https://example.test/v2")

    class Client:
        def get_dataset(self, *_args, **_kwargs):
            return Dataset()

        def create_dataset_item(self, **_kwargs):
            pass

        def flush(self):
            pass

    def forbidden(*_args):
        raise AssertionError("Old source scores must not be written")

    monkeypatch.setattr("langfuse.Langfuse", lambda **_kwargs: Client())
    monkeypatch.setattr("anydocs_ragas.langfuse._publish_source_trace_scores", forbidden)
    sample = {"user_input": "q", "reference": "v1 or v2", "lang": "en", "response": "a",
              "retrieved_contexts": ["v1"], "context_source": "agent_evidence", "reference_facts": ["v1 or v2"],
              "rubric": {}, "reference_fact_rules": {"v1 or v2": ["v1", "v2"]},
              "reference_fact_direct_apis": {"other fact": "POST /api/v1/payout"}}
    metadata = {"golden_sha256": "abc", "judge_provider": "anthropic", "judge_model": "judge",
                "judge_profile": profile, "variant": "agentic", "context_mode": "no_page",
                "evaluation_input_sha256": "a" * 64, "source_scores_published": False,
                "judge_fact_rules_sha256": "rules-hash"}
    kwargs = dict(samples_by_id={"one": sample}, results=[{"case_id": "one", "scores": {}, "errors": {}}],
                  dataset_base_name="test", experiment_name="v2", metadata=metadata)
    with pytest.raises(ValueError, match="overwrite"):
        publish_experiment(**kwargs)
    assert publish_experiment(**kwargs, publish_source_scores=False) == "https://example.test/v2"
    output = captured["task"](item=SimpleNamespace(input={"case_id": "one"}))
    assert output["reference_fact_rules"] == sample["reference_fact_rules"]
    assert output["reference_fact_direct_apis"] == sample["reference_fact_direct_apis"]
    assert output["evaluation_config"]["source_scores_published"] is False
    assert output["evaluation_config"]["judge_fact_rules_sha256"] == "rules-hash"
    assert output["judge_errors"] == {}
    assert captured["metadata"]["judge_profile"] == profile
