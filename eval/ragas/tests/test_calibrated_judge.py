import asyncio
from hashlib import sha256
import json

import pytest

from anydocs_ragas.calibrated_judge import CalibratedFactScorer, FACT_POLICY, contract_metadata
from anydocs_ragas.evidence_judge import contract_metadata as v2_metadata
from anydocs_ragas.models import EvalSample
from anydocs_ragas.scoring import Scorers, build_scorers, score_sample


class QueueLLM:
    def __init__(self, outputs):
        self.outputs, self.prompts = iter(outputs), []

    async def agenerate(self, prompt, response_model):
        self.prompts.append(prompt)
        return response_model(**next(self.outputs))


def verdict(value, ids=None):
    return {"verdict": value, "support_kind": "explicit" if value else "unsupported",
            "reason": "supported" if value else "missing", "evidence_ids": ids or []}


@pytest.mark.parametrize("values,expected", [([1, 0], 1), ([0, 1], 1), ([0, 0], 0), ([1, 1], 1)])
def test_calibrated_any_of_keeps_code_aggregation_and_original_denominator(values, expected):
    llm = QueueLLM([verdict(v, ["c1:u1"] if v else []) for v in values])
    sample = EvalSample(case_id="one", user_input="q", response="a", reference="v1 or v2",
                        reference_facts=["v1 or v2"], retrieved_contexts=["v1"],
                        reference_fact_rules={"v1 or v2": ["v1", "v2"]})
    result = asyncio.run(score_sample(sample, Scorers(reference_fact_recall=CalibratedFactScorer(llm))))
    score = result["scores"]["reference_fact_recall"]
    assert score["value"] == expected
    facts = json.loads(score["reason"])
    assert len(facts) == 1
    audit = json.loads(facts[0]["reason"])
    assert audit["profile"] == "audited-v3"
    assert audit["operator"] == "any_of"
    assert [b["verdict"] for b in audit["branches"]] == values


def test_question_is_only_scope_and_frozen_branch_is_not_rewritten():
    question = "A0403 means which exact parameter?"
    reference = "表中 Axxxx 条目为 Param Error。"
    llm = QueueLLM([verdict(1, ["c1:u1"])])
    result = asyncio.run(CalibratedFactScorer(llm).ascore(user_input=question, reference=reference,
                         retrieved_contexts=["Axxxx | Param Error | 参数错误"]))
    prompt = llm.prompts[0]
    payload = json.loads(prompt.split("\nINPUT:\n", 1)[1])
    assert payload["question_scope_only"] == question
    assert payload["reference_branch"] == reference
    assert "question" not in payload
    assert json.loads(result.reason)["calls"][0]["prompt_sha256"] == sha256(prompt.encode()).hexdigest()
    assert "Never add a question's requested details" in FACT_POLICY
    assert "existence of a dedicated operation does not prove" in FACT_POLICY
    assert "Require the explicit public" in FACT_POLICY
    assert "format or example does not establish where to discover" in FACT_POLICY


@pytest.mark.parametrize("output", [verdict(1), verdict(1, ["unknown"]),
    verdict(1, ["c1:u1", "c1:u1"]), {**verdict(1, ["c1:u1"]), "support_kind": "unsupported"},
    {**verdict(0), "support_kind": "bounded_inference"}])
def test_calibrated_invalid_evidence_remains_technical_error(output):
    sample = EvalSample(case_id="one", user_input="q", response="a", reference="f",
                        reference_facts=["f"], retrieved_contexts=["actual"])
    result = asyncio.run(score_sample(sample, Scorers(reference_fact_recall=CalibratedFactScorer(QueueLLM([output])))))
    assert not result["scores"]
    assert "reference_fact_recall" in result["errors"]


def test_calibrated_any_of_error_is_not_hidden_by_positive():
    llm = QueueLLM([verdict(1, ["c1:u1"]), verdict(1, ["missing"])])
    with pytest.raises(ValueError):
        asyncio.run(CalibratedFactScorer(llm).ascore(user_input="q", reference="a or b",
                    alternatives=["a", "b"], retrieved_contexts=["a"]))


@pytest.mark.parametrize("alternatives", [[], ["a"], ["a", "a"], ["a", " "]])
def test_calibrated_invalid_alternatives_fail_before_model_call(alternatives):
    llm = QueueLLM([])
    with pytest.raises(ValueError):
        asyncio.run(CalibratedFactScorer(llm).ascore(user_input="q", reference="a",
                    alternatives=alternatives, retrieved_contexts=["a"]))
    assert not llm.prompts


def test_v3_has_distinct_version_without_rewriting_v2_contract():
    assert contract_metadata()["judge_profile"] == "audited-v3"
    assert contract_metadata()["judge_contract_sha256"] != v2_metadata()["judge_contract_sha256"]
    assert v2_metadata()["judge_contract_sha256"] == "a2b94203858d997b18d971b91fae0a0b2e0e60a9b0708b99c3cc0747ca93d57c"
    assert v2_metadata()["judge_implementation_sha256"] == "cb8eecccfe86a3b8cc5f765e0ce4100a864563ea12a5b57c5f8a9dccdadac5fd"


def test_v3_rejects_other_metrics_before_client_creation():
    with pytest.raises(ValueError, match="RFR only"):
        build_scorers(None, {"context_recall"}, profile="audited-v3")


def test_v3_cli_requires_rules_and_preserves_source_scores(tmp_path, capsys):
    from anydocs_ragas.cli import main
    trace = tmp_path / "empty.jsonl"
    trace.write_text("")
    assert main([str(trace), "--judge-profile", "audited-v3", "--validate-only"]) == 2
    assert "requires an explicit fact-rules" in capsys.readouterr().err


def test_v3_cli_publication_guard_runs_before_clients(tmp_path, capsys):
    from anydocs_ragas.cli import main
    from anydocs_ragas.models import extract_sample, golden_sha256
    raw = {"case_id": "one", "ragas_sample": {"user_input": "q", "response": "a",
           "reference": "f", "reference_facts": ["f"], "retrieved_contexts": ["f"]}}
    trace, rules = tmp_path / "one.jsonl", tmp_path / "rules.json"
    trace.write_text(json.dumps(raw) + "\n")
    rules.write_text(json.dumps({"schema_version": 1, "base_golden_sha256": golden_sha256([extract_sample(raw)]),
                                "cases": {}}))
    arguments = [str(trace), "--judge-profile", "audited-v3", "--fact-rules", str(rules),
                 "--langfuse-dataset", "test", "--validate-only"]
    assert main(arguments) == 2
    assert "preserve original source scores" in capsys.readouterr().err
    assert main(arguments + ["--no-source-scores"]) == 0
