import asyncio
import json
from types import SimpleNamespace

import pytest
from ragas.llms.base import InstructorBaseRagasLLM
from ragas.metrics.collections import ContextPrecision, FactualCorrectness

from anydocs_ragas.audited import (
    AuditedScorer, FixedFactScorer, RecordingLLM, configure_audited, contract_metadata,
)
from anydocs_ragas.scoring import Scorers, score_sample
from anydocs_ragas.models import EvalSample


class QueueLLM(InstructorBaseRagasLLM):
    def __init__(self, results):
        self.results = list(results)
        self.prompts = []

    def generate(self, *_args, **_kwargs):
        raise AssertionError("No synchronous calls")

    async def agenerate(self, prompt, response_model):
        self.prompts.append(prompt)
        await asyncio.sleep(0)
        return response_model(**self.results.pop(0))


def test_audited_precision_keeps_native_ap_and_records_each_context_verdict():
    delegate = QueueLLM([{"verdict": x, "reason": "material part"} for x in [1, 0, 1]])
    llm = RecordingLLM(delegate)
    scorers = configure_audited(Scorers(context_precision=ContextPrecision(llm=llm)), llm)
    result = asyncio.run(scorers.context_precision.ascore(user_input="q", reference="a and b",
                                                        retrieved_contexts=["a", "unrelated", "b"]))
    assert result.value == pytest.approx((1 + 2 / 3) / 2)
    audit = json.loads(result.reason)
    assert [c["result"]["verdict"] for c in audit["calls"]] == [1, 0, 1]
    assert all("AT LEAST ONE" in p for p in delegate.prompts)


def test_fixed_fact_is_one_binary_unit_with_verbatim_evidence():
    delegate = QueueLLM([{"verdict": 1, "reason": "single field implies one source",
                          "supporting_quotes": ["from_address is a string"]}])
    scorer = AuditedScorer(FixedFactScorer(RecordingLLM(delegate)), "reference_fact_recall")
    result = asyncio.run(scorer.ascore(user_input="q", reference="Only one source per request",
                                      retrieved_contexts=["from_address is a string"]))
    assert result.value == 1
    assert len(json.loads(result.reason)["calls"]) == 1
    assert "do not split" in delegate.prompts[0]


def test_fabricated_support_quote_is_an_error_not_a_zero_or_positive_score():
    llm = RecordingLLM(QueueLLM([{"verdict": 1, "reason": "invented",
                                 "supporting_quotes": ["not in the context"]}]))
    scorer = AuditedScorer(FixedFactScorer(llm), "reference_fact_recall")
    sample = EvalSample(case_id="q", user_input="q", response=None, retrieved_contexts=["actual"],
                        reference="fact", reference_facts=["fact"])
    result = asyncio.run(score_sample(sample, Scorers(reference_fact_recall=scorer)))
    assert "reference_fact_recall" in result["errors"]
    assert "reference_fact_recall" not in result["scores"]
    assert "supporting_quotes" in result["errors"]["reference_fact_recall"]


def test_factual_correctness_uses_high_atomicity_and_retains_both_nli_directions():
    delegate = QueueLLM([
        {"claims": ["a", "extra"]},
        {"statements": [{"statement": "a", "reason": "yes", "verdict": 1},
                         {"statement": "extra", "reason": "not in reference", "verdict": 0}]},
        {"claims": ["a"]},
        {"statements": [{"statement": "a", "reason": "yes", "verdict": 1}]},
    ])
    llm = RecordingLLM(delegate)
    scorers = configure_audited(Scorers(factual_correctness=FactualCorrectness(llm=llm)), llm)
    result = asyncio.run(scorers.factual_correctness.ascore(response="a and extra", reference="a"))
    assert result.value == 0.67
    assert len(json.loads(result.reason)["calls"]) == 4
    assert '"atomicity": "high"' in delegate.prompts[0]
    assert '"coverage": "high"' in delegate.prompts[0]
    assert "Preserve explicit" in delegate.prompts[0]


@pytest.mark.parametrize("output", [{"claims": []}, {"classifications": []}, {"verdict": 2}])
def test_empty_or_nonbinary_judge_outputs_are_rejected(output):
    from pydantic import create_model
    model = create_model("InvalidOutput", **{k: (type(v), ...) for k, v in output.items()})
    llm = RecordingLLM(QueueLLM([output]))
    with pytest.raises(ValueError):
        asyncio.run(llm.agenerate("q", model))


def test_nonfinite_metric_is_not_a_valid_score():
    class InvalidMetric:
        async def ascore(self, **_kwargs):
            return SimpleNamespace(value=float("nan"))
    with pytest.raises(ValueError):
        asyncio.run(AuditedScorer(InvalidMetric(), "metric").ascore())


def test_concurrent_metric_calls_do_not_mix_judge_audits():
    class EchoLLM(QueueLLM):
        async def agenerate(self, prompt, response_model):
            await asyncio.sleep(0.001)
            word = "Alpha" if "Alpha" in prompt else "Beta"
            return response_model(verdict=1, reason=word, supporting_quotes=[word])
    scorer = AuditedScorer(FixedFactScorer(RecordingLLM(EchoLLM([]))), "fact")
    async def run():
        return await asyncio.gather(*(scorer.ascore(user_input=w, reference=w,
                                     retrieved_contexts=[w]) for w in ["Alpha", "Beta"]))
    results = asyncio.run(run())
    assert [json.loads(r.reason)["calls"][0]["result"]["reason"] for r in results] == ["Alpha", "Beta"]
    assert all(len(json.loads(r.reason)["calls"]) == 1 for r in results)


def test_contract_hash_is_stable_and_versioned():
    assert contract_metadata() == contract_metadata()
    assert contract_metadata()["judge_profile"] == "audited-v1"
    assert len(contract_metadata()["judge_contract_sha256"]) == 64
