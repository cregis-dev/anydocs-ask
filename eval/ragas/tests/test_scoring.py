from dataclasses import dataclass
import asyncio

from anydocs_ragas.cli import provider_settings
from anydocs_ragas.models import EvalSample
from anydocs_ragas.scoring import (
    NormalizedFivePointScorer,
    Scorers,
    build_scorers,
    score_sample,
)


@dataclass
class Result:
    value: float
    reason: str


class FakeMetric:
    def __init__(self, value):
        self.value = value

    async def ascore(self, **kwargs):
        assert kwargs
        return Result(self.value, "ok")


def test_normalizes_five_point_rubric_scores_to_zero_one():
    scorer = NormalizedFivePointScorer(FakeMetric(3))
    result = asyncio.run(scorer.ascore(response="answer"))
    assert result.value == 0.5
    assert result.reason == "ok"


def test_scores_available_metrics_and_skips_missing_reference():
    sample = EvalSample(
        case_id="case-1",
        user_input="question",
        response="answer",
        retrieved_contexts=["context"],
        reference=None,
    )
    result = asyncio.run(
        score_sample(
            sample,
            Scorers(
                faithfulness=FakeMetric(0.8),
                context_recall=FakeMetric(0.85),
                answer_relevancy=FakeMetric(0.7),
                factual_correctness=FakeMetric(0.9),
                rubric_compliance=FakeMetric(0.6),
            ),
        ),
    )
    assert result["scores"]["faithfulness"]["value"] == 0.8
    assert result["scores"]["answer_relevancy"]["value"] == 0.7
    assert (
        result["skipped"]["context_recall"]
        == "golden case has no reference answer or facts"
    )
    assert (
        result["skipped"]["factual_correctness"]
        == "golden case has no reference answer or facts"
    )
    assert (
        result["skipped"]["rubric_compliance"] == "golden case has no evaluation rubric"
    )


def test_context_recall_scores_reference_coverage_without_generated_answer():
    class ContextRecallMetric:
        async def ascore(self, **kwargs):
            assert kwargs == {
                "user_input": "Which endpoint creates a payout?",
                "retrieved_contexts": ["POST /api/v1/payout creates a payout."],
                "reference": "Use /api/v1/payout to create a payout.",
            }
            return Result(0.9, "most reference claims were retrieved")

    sample = EvalSample(
        case_id="case-context-recall",
        user_input="Which endpoint creates a payout?",
        response=None,
        retrieved_contexts=["POST /api/v1/payout creates a payout."],
        reference="Use /api/v1/payout to create a payout.",
    )
    result = asyncio.run(
        score_sample(sample, Scorers(context_recall=ContextRecallMetric()))
    )
    assert result["scores"]["context_recall"] == {
        "value": 0.9,
        "reason": "most reference claims were retrieved",
    }


def test_context_recall_skips_empty_retrieval_context():
    sample = EvalSample(
        case_id="case-no-context",
        user_input="Which endpoint creates a payout?",
        response="Use /api/v1/payout.",
        retrieved_contexts=[],
        reference="Use /api/v1/payout to create a payout.",
    )
    result = asyncio.run(score_sample(sample, Scorers(context_recall=FakeMetric(1.0))))
    assert result["skipped"]["context_recall"] == "no retrieved contexts"


def test_rubric_compliance_receives_case_guidance_and_atomic_facts():
    class RubricMetric:
        async def ascore(self, **kwargs):
            assert kwargs["rubrics"]["score5_description"].endswith(
                "Requirements: precision: Do not invent an endpoint."
            )
            assert (
                "Atomic reference facts:\n- Use /api/v1/payout." in kwargs["reference"]
            )
            assert kwargs["retrieved_contexts"] == ["POST /api/v1/payout"]
            return Result(0.95, "fully compliant")

    sample = EvalSample(
        case_id="case-rubric",
        user_input="Which endpoint creates a payout?",
        response="Use /api/v1/payout.",
        retrieved_contexts=["POST /api/v1/payout"],
        reference="Use the payout endpoint.",
        reference_facts=["Use /api/v1/payout."],
        rubric={"precision": "Do not invent an endpoint."},
    )
    result = asyncio.run(
        score_sample(sample, Scorers(rubric_compliance=RubricMetric()))
    )
    assert result["scores"]["rubric_compliance"] == {
        "value": 0.95,
        "reason": "fully compliant",
    }


def test_anthropic_provider_reuses_existing_gateway_environment(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "internal-model")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "secret")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gateway.example.test")
    settings = provider_settings(
        {"faithfulness", "context_recall", "factual_correctness", "rubric_compliance"}
    )
    assert settings.judge_provider == "anthropic"
    assert settings.judge_model == "internal-model"
    assert settings.judge_api_key is None
    assert settings.judge_auth_token == "secret"
    assert settings.judge_base_url == "https://gateway.example.test"
    assert settings.embedding_api_key is None
    assert settings.max_tokens == 4096

    scorers = build_scorers(
        settings,
        {"faithfulness", "context_recall", "factual_correctness", "rubric_compliance"},
    )
    assert type(scorers.faithfulness).__name__ == "Faithfulness"
    assert type(scorers.context_recall).__name__ == "ContextRecall"
    assert type(scorers.factual_correctness).__name__ == "FactualCorrectness"
    assert type(scorers.rubric_compliance).__name__ == "NormalizedFivePointScorer"
    assert type(scorers.rubric_compliance.scorer).__name__ == "InstanceSpecificRubrics"
    assert scorers.faithfulness.llm.model_args["max_tokens"] == 4096


def test_openai_provider_passes_extra_body_to_judge(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_PROVIDER", "openai")
    monkeypatch.setenv("RAGAS_JUDGE_MODEL", "deepseek-v4-pro")
    monkeypatch.setenv("RAGAS_JUDGE_API_KEY", "secret")
    monkeypatch.setenv("RAGAS_JUDGE_BASE_URL", "https://gateway.example.test/v1")
    monkeypatch.setenv(
        "RAGAS_JUDGE_EXTRA_BODY_JSON",
        '{"thinking":{"type":"disabled"}}',
    )
    settings = provider_settings({"faithfulness"})
    assert settings.judge_extra_body == {"thinking": {"type": "disabled"}}

    scorers = build_scorers(settings, {"faithfulness"})
    assert scorers.faithfulness.llm.model_args["extra_body"] == {
        "thinking": {"type": "disabled"},
    }


def test_judge_extra_body_must_be_json_object(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_PROVIDER", "openai")
    monkeypatch.setenv("RAGAS_JUDGE_MODEL", "deepseek-v4-pro")
    monkeypatch.setenv("RAGAS_JUDGE_API_KEY", "secret")
    monkeypatch.setenv("RAGAS_JUDGE_EXTRA_BODY_JSON", "[]")
    try:
        provider_settings({"faithfulness"})
    except ValueError as error:
        assert "must be a JSON object" in str(error)
    else:
        raise AssertionError("non-object extra body should fail")


def test_answer_relevancy_still_requires_openai_compatible_embeddings(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "internal-model")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "secret")
    monkeypatch.delenv("RAGAS_EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    try:
        provider_settings({"answer_relevancy"})
    except ValueError as error:
        assert "RAGAS_EMBEDDING_API_KEY" in str(error)
    else:
        raise AssertionError("missing embedding credentials should fail")
