from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol

from .models import EvalSample


SUPPORTED_METRICS = (
    "faithfulness",
    "context_recall",
    "answer_relevancy",
    "factual_correctness",
    "rubric_compliance",
)


class MetricScorer(Protocol):
    async def ascore(self, **kwargs: Any) -> Any: ...


@dataclass(frozen=True)
class Scorers:
    faithfulness: MetricScorer | None = None
    context_recall: MetricScorer | None = None
    answer_relevancy: MetricScorer | None = None
    factual_correctness: MetricScorer | None = None
    rubric_compliance: MetricScorer | None = None


@dataclass(frozen=True)
class NormalizedMetricResult:
    value: float
    reason: str | None


@dataclass(frozen=True)
class NormalizedFivePointScorer:
    scorer: MetricScorer

    async def ascore(self, **kwargs: Any) -> NormalizedMetricResult:
        result = await self.scorer.ascore(**kwargs)
        value = max(1.0, min(5.0, float(result.value)))
        return NormalizedMetricResult(
            value=(value - 1.0) / 4.0,
            reason=getattr(result, "reason", None),
        )


@dataclass(frozen=True)
class ProviderSettings:
    judge_provider: str
    judge_model: str
    judge_api_key: str | None
    judge_auth_token: str | None
    judge_base_url: str | None
    embedding_model: str
    embedding_api_key: str | None
    embedding_base_url: str | None
    judge_extra_body: dict[str, Any] | None = None
    timeout_seconds: float = 120.0
    max_tokens: int = 4096


def build_scorers(settings: ProviderSettings, metrics: set[str]) -> Scorers:
    from ragas.embeddings.base import embedding_factory
    from ragas.llms import llm_factory
    from ragas.metrics.collections import (
        AnswerRelevancy,
        ContextRecall,
        Faithfulness,
        FactualCorrectness,
        InstanceSpecificRubrics,
    )

    if settings.judge_provider == "anthropic":
        from anthropic import AsyncAnthropic

        judge_client = AsyncAnthropic(
            api_key=settings.judge_api_key,
            auth_token=settings.judge_auth_token,
            base_url=settings.judge_base_url,
            timeout=settings.timeout_seconds,
        )
    else:
        from openai import AsyncOpenAI

        judge_client = AsyncOpenAI(
            api_key=settings.judge_api_key,
            base_url=settings.judge_base_url,
            timeout=settings.timeout_seconds,
        )
    model_args: dict[str, Any] = {
        "temperature": 0,
        "max_tokens": settings.max_tokens,
    }
    if settings.judge_extra_body is not None:
        model_args["extra_body"] = settings.judge_extra_body

    llm = llm_factory(
        settings.judge_model,
        provider=settings.judge_provider,
        client=judge_client,
        **model_args,
    )

    relevancy = None
    if "answer_relevancy" in metrics:
        from openai import AsyncOpenAI

        if settings.embedding_api_key is None:
            raise ValueError("embedding API key is required for answer_relevancy")
        embedding_client = AsyncOpenAI(
            api_key=settings.embedding_api_key,
            base_url=settings.embedding_base_url,
            timeout=settings.timeout_seconds,
        )
        embeddings = embedding_factory(
            "openai",
            model=settings.embedding_model,
            client=embedding_client,
        )
        relevancy = AnswerRelevancy(llm=llm, embeddings=embeddings)

    return Scorers(
        faithfulness=Faithfulness(llm=llm) if "faithfulness" in metrics else None,
        context_recall=ContextRecall(llm=llm) if "context_recall" in metrics else None,
        answer_relevancy=relevancy,
        factual_correctness=FactualCorrectness(llm=llm)
        if "factual_correctness" in metrics
        else None,
        rubric_compliance=(
            NormalizedFivePointScorer(InstanceSpecificRubrics(llm=llm))
            if "rubric_compliance" in metrics
            else None
        ),
    )


async def score_samples(
    samples: list[EvalSample],
    scorers: Scorers,
    concurrency: int,
) -> list[dict[str, Any]]:
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def guarded(sample: EvalSample) -> dict[str, Any]:
        async with semaphore:
            return await score_sample(sample, scorers)

    return list(await asyncio.gather(*(guarded(sample) for sample in samples)))


async def score_sample(sample: EvalSample, scorers: Scorers) -> dict[str, Any]:
    scores: dict[str, dict[str, Any]] = {}
    skipped: dict[str, str] = {}
    errors: dict[str, str] = {}

    if scorers.faithfulness is not None:
        if sample.response is None:
            skipped["faithfulness"] = "case did not produce an answer"
        elif not sample.retrieved_contexts:
            skipped["faithfulness"] = "no retrieved contexts"
        else:
            await _score_metric(
                "faithfulness",
                scorers.faithfulness,
                scores,
                errors,
                user_input=sample.user_input,
                response=sample.response,
                retrieved_contexts=sample.retrieved_contexts,
            )

    if scorers.context_recall is not None:
        if sample.reference is None:
            skipped["context_recall"] = "golden case has no reference answer or facts"
        elif not sample.retrieved_contexts:
            skipped["context_recall"] = "no retrieved contexts"
        else:
            await _score_metric(
                "context_recall",
                scorers.context_recall,
                scores,
                errors,
                user_input=sample.user_input,
                retrieved_contexts=sample.retrieved_contexts,
                reference=sample.reference,
            )

    if scorers.answer_relevancy is not None:
        if sample.response is None:
            skipped["answer_relevancy"] = "case did not produce an answer"
        else:
            await _score_metric(
                "answer_relevancy",
                scorers.answer_relevancy,
                scores,
                errors,
                user_input=sample.user_input,
                response=sample.response,
            )

    if scorers.factual_correctness is not None:
        if sample.response is None:
            skipped["factual_correctness"] = "case did not produce an answer"
        elif sample.reference is None:
            skipped["factual_correctness"] = (
                "golden case has no reference answer or facts"
            )
        else:
            await _score_metric(
                "factual_correctness",
                scorers.factual_correctness,
                scores,
                errors,
                response=sample.response,
                reference=sample.reference,
            )

    if scorers.rubric_compliance is not None:
        if sample.response is None:
            skipped["rubric_compliance"] = "case did not produce an answer"
        elif not sample.rubric:
            skipped["rubric_compliance"] = "golden case has no evaluation rubric"
        else:
            await _score_metric(
                "rubric_compliance",
                scorers.rubric_compliance,
                scores,
                errors,
                user_input=sample.user_input,
                response=sample.response,
                retrieved_contexts=sample.retrieved_contexts,
                reference=_rubric_reference(sample),
                rubrics=_five_point_rubric(sample),
            )

    return {
        "case_id": sample.case_id,
        "lang": sample.lang,
        "context_source": sample.context_source,
        "scores": scores,
        "skipped": skipped,
        "errors": errors,
    }


async def _score_metric(
    name: str,
    scorer: MetricScorer,
    scores: dict[str, dict[str, Any]],
    errors: dict[str, str],
    **kwargs: Any,
) -> None:
    try:
        result = await scorer.ascore(**kwargs)
        scores[name] = {
            "value": float(result.value),
            "reason": getattr(result, "reason", None),
        }
    except Exception as error:  # The batch must survive one judge/provider failure.
        errors[name] = f"{type(error).__name__}: {error}"


def _rubric_reference(sample: EvalSample) -> str | None:
    parts: list[str] = []
    if sample.reference is not None:
        parts.append(sample.reference)
    if sample.reference_facts:
        facts = "\n".join(f"- {fact}" for fact in sample.reference_facts)
        parts.append(f"Atomic reference facts:\n{facts}")
    return "\n\n".join(parts) or None


def _five_point_rubric(sample: EvalSample) -> dict[str, str]:
    requirements = " ".join(
        f"{name}: {instruction}" for name, instruction in sample.rubric.items()
    )
    return {
        "score1_description": (
            "The response is materially incorrect, unsupported, irrelevant, or directly "
            f"violates a critical case-specific requirement. Requirements: {requirements}"
        ),
        "score2_description": (
            "The response contains some correct information but has major factual errors, "
            "unsupported claims, or omits most of the required answer."
        ),
        "score3_description": (
            "The response is broadly correct but misses important reference facts, is only "
            "partly grounded in the supplied context, or needs a substantial qualification."
        ),
        "score4_description": (
            "The response is accurate, grounded, and covers the important reference facts, "
            "with only a minor omission or imprecision."
        ),
        "score5_description": (
            "The response is fully correct, grounded in the supplied context, covers all "
            "material reference facts, and obeys every case-specific requirement. "
            f"Requirements: {requirements}"
        ),
    }
