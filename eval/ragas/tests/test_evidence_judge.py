import asyncio
from dataclasses import replace
import json

import pytest
from pydantic import ValidationError

from anydocs_ragas.evidence_judge import (
    EvidenceFactScorer, EvidenceVerdict, contract_metadata, evidence_units, resolve_evidence,
)
from anydocs_ragas.fact_rules import apply_fact_rules
from anydocs_ragas.models import EvalSample, golden_sha256
from anydocs_ragas.scoring import Scorers, score_sample


class QueueLLM:
    def __init__(self, outputs):
        self.outputs, self.prompts = iter(outputs), []

    async def agenerate(self, prompt, response_model):
        self.prompts.append(prompt)
        await asyncio.sleep(0)
        return response_model(**next(self.outputs))


def verdict(value, ids=None):
    return {"verdict": value, "support_kind": "explicit" if value else "unsupported",
            "reason": "supported" if value else "missing", "evidence_ids": ids or []}


@pytest.mark.parametrize("values,expected", [([1, 0], 1), ([0, 1], 1), ([0, 0], 0), ([1, 1], 1)])
def test_any_of_is_code_max_not_average_or_conjunction(values, expected):
    llm = QueueLLM([verdict(value, ["c1:u1"] if value else []) for value in values])
    scorer = EvidenceFactScorer(llm)
    result = asyncio.run(scorer.ascore(user_input="balance", reference="v1 OR v2",
                         alternatives=["v1 balance", "v2 balance"], retrieved_contexts=["balance endpoint"]))
    audit = json.loads(result.reason)
    assert result.value == expected
    assert [branch["verdict"] for branch in audit["branches"]] == values
    assert audit["operator"] == "any_of"
    assert len(llm.prompts) == 2
    assert "v1 OR v2" not in llm.prompts[0]
    assert '"reference_branch": "v1 balance"' in llm.prompts[0]
    assert '"reference_branch": "v2 balance"' in llm.prompts[1]


def test_source_units_preserve_unicode_case_punctuation_and_offsets():
    contexts = ["  Title\n\nSub-addresses Generate 地址。\n\n- API_KEY: CaseSensitive", "x\r\n\r\ny"]
    units = evidence_units(contexts)
    assert [unit.id for unit in units] == ["c1:u1", "c1:u2", "c1:u3", "c2:u1", "c2:u2"]
    assert units[1].text == "Sub-addresses Generate 地址。"
    assert all(contexts[unit.context_index][unit.start:unit.end] == unit.text for unit in units)
    assert "".join("".join(c.split()) for c in contexts) == "".join("".join(u.text.split()) for u in units)
    assert evidence_units(contexts) == units


def test_positive_evidence_is_resolved_by_id_not_judge_copied_quote():
    llm = QueueLLM([verdict(1, ["c1:u2"])])
    result = asyncio.run(EvidenceFactScorer(llm).ascore(user_input="batch", reference="multiple addresses",
                         retrieved_contexts=["Title\n\nBatch Create Sub-addresses Generate multiple addresses."]))
    evidence = json.loads(result.reason)["branches"][0]["evidence"][0]
    assert evidence["text"] == "Batch Create Sub-addresses Generate multiple addresses."
    assert evidence["id"] == "c1:u2"
    assert "supporting_quotes" not in llm.prompts[0]


@pytest.mark.parametrize("output", [verdict(1), verdict(1, ["c9:u99"]),
    verdict(1, ["c1:u1", "c1:u1"]),
    {**verdict(1, ["c1:u1"]), "support_kind": "unsupported"},
    {**verdict(0), "support_kind": "explicit"}])
def test_invalid_evidence_is_error_not_zero(output):
    sample = EvalSample(case_id="one", user_input="q", response="a", reference="f",
                        reference_facts=["f"], retrieved_contexts=["actual"])
    result = asyncio.run(score_sample(sample, Scorers(reference_fact_recall=EvidenceFactScorer(QueueLLM([output])))))
    assert "reference_fact_recall" in result["errors"]
    assert not result["scores"]


@pytest.mark.parametrize("value", [True, "1", 2, -1])
def test_verdict_schema_rejects_nonbinary_or_noninteger_values(value):
    with pytest.raises(ValidationError):
        EvidenceVerdict(**{**verdict(1, ["c1:u1"]), "verdict": value})


def test_original_quote_failure_cannot_recur_as_quote_output_is_disallowed():
    with pytest.raises(ValidationError):
        EvidenceVerdict(**{**verdict(1, ["c1:u1"]), "supporting_quotes": ["Sub-Addresses"]})


def test_any_of_branch_error_is_not_hidden_by_another_positive_branch():
    llm = QueueLLM([verdict(1, ["c1:u1"]), verdict(1, ["unknown"])])
    with pytest.raises(ValueError, match="Unknown|ValueError"):
        asyncio.run(EvidenceFactScorer(llm).ascore(user_input="q", reference="one or two",
                    alternatives=["one", "two"], retrieved_contexts=["one"]))


def test_concurrent_fact_calls_keep_separate_audits():
    class Echo:
        async def agenerate(self, prompt, response_model):
            await asyncio.sleep(.001)
            word = "Alpha" if "Alpha" in prompt else "Beta"
            return response_model(**{**verdict(1, ["c1:u1"]), "reason": word})
    async def run():
        scorer = EvidenceFactScorer(Echo())
        return await asyncio.gather(*(scorer.ascore(user_input=w, reference=w, retrieved_contexts=[w])
                                      for w in ["Alpha", "Beta"]))
    assert [json.loads(r.reason)["calls"][0]["result"]["reason"] for r in asyncio.run(run())] == ["Alpha", "Beta"]


def test_rules_are_versioned_exact_and_do_not_rewrite_golden(tmp_path):
    original = EvalSample(case_id="one", user_input="q", response="a", retrieved_contexts=["text"],
                          reference="v1 or v2", reference_facts=["v1 or v2", "not unit or currency"])
    data = {"schema_version": 1, "base_golden_sha256": golden_sha256([original]),
            "cases": {"one": [{"fact": "v1 or v2", "any_of": ["v1", "v2"]}]}}
    path = tmp_path / "rules.json"
    path.write_text(json.dumps(data))
    updated = apply_fact_rules([original], path)[0]
    assert not original.reference_fact_rules
    assert updated.reference_fact_rules == {"v1 or v2": ["v1", "v2"]}
    assert "not unit or currency" not in updated.reference_fact_rules
    assert golden_sha256([original]) == golden_sha256([updated])
    with pytest.raises(ValueError, match="frozen Golden"):
        apply_fact_rules([replace(original, reference="changed")], path)
    data["cases"]["one"][0]["fact"] = "unknown fact"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="missing or duplicate"):
        apply_fact_rules([original], path)


def test_rule_dispatch_preserves_one_fact_in_denominator():
    sample = EvalSample(case_id="one", user_input="q", response="a", retrieved_contexts=["v1"],
                        reference="v1 or v2", reference_facts=["v1 or v2"],
                        reference_fact_rules={"v1 or v2": ["v1", "v2"]})
    llm = QueueLLM([verdict(1, ["c1:u1"]), verdict(0)])
    result = asyncio.run(score_sample(sample, Scorers(reference_fact_recall=EvidenceFactScorer(llm))))
    assert result["scores"]["reference_fact_recall"]["value"] == 1
    assert len(json.loads(result["scores"]["reference_fact_recall"]["reason"])) == 1


def test_v2_contract_separate_from_v1():
    from anydocs_ragas.audited import contract_metadata as old_contract
    assert contract_metadata() == contract_metadata()
    assert contract_metadata()["judge_profile"] == "audited-v2"
    assert contract_metadata()["judge_contract_sha256"] != old_contract()["judge_contract_sha256"]


def test_v2_rejects_unrelated_metric_changes_before_client_creation():
    from anydocs_ragas.scoring import build_scorers
    with pytest.raises(ValueError, match="RFR only"):
        build_scorers(None, {"faithfulness"}, profile="audited-v2")


def test_v2_cli_requires_explicit_rules_before_validation(tmp_path, capsys):
    from anydocs_ragas.cli import main
    trace = tmp_path / "empty.jsonl"
    trace.write_text("")
    assert main([str(trace), "--judge-profile", "audited-v2", "--validate-only"]) == 2
    assert "requires an explicit fact-rules" in capsys.readouterr().err
