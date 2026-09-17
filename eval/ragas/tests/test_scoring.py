from dataclasses import dataclass
import asyncio

from anydocs_ragas.cli import provider_settings
from anydocs_ragas.models import EvalSample
from anydocs_ragas.scoring import Scorers, build_scorers, score_sample


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
                answer_relevancy=FakeMetric(0.7),
                factual_correctness=FakeMetric(0.9),
            ),
        ),
    )
    assert result["scores"]["faithfulness"]["value"] == 0.8
    assert result["scores"]["answer_relevancy"]["value"] == 0.7
    assert result["skipped"]["factual_correctness"] == "golden case has no reference answer or facts"


def test_anthropic_provider_reuses_existing_gateway_environment(monkeypatch):
    monkeypatch.setenv("RAGAS_JUDGE_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "internal-model")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "secret")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gateway.example.test")
    settings = provider_settings({"faithfulness", "factual_correctness"})
    assert settings.judge_provider == "anthropic"
    assert settings.judge_model == "internal-model"
    assert settings.judge_api_key is None
    assert settings.judge_auth_token == "secret"
    assert settings.judge_base_url == "https://gateway.example.test"
    assert settings.embedding_api_key is None
    assert settings.max_tokens == 4096

    scorers = build_scorers(settings, {"faithfulness", "factual_correctness"})
    assert type(scorers.faithfulness).__name__ == "Faithfulness"
    assert type(scorers.factual_correctness).__name__ == "FactualCorrectness"
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
