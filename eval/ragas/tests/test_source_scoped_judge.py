import asyncio
import json

import pytest

from anydocs_ragas.fact_rules import apply_fact_rules
from anydocs_ragas.models import EvalSample, golden_sha256
from anydocs_ragas.scoring import Scorers, build_scorers, score_sample
from anydocs_ragas.source_scoped_judge import SourceScopedFactScorer, contract_metadata, direct_api_unit_ids


API = "POST /api/v1/payout"
FACT = "The regular /api/v1/payout uses the payout wallet rather than selecting a deposit sub-address."


def page(operation=API, body="The default payout wallet is used; no source selector is accepted."):
    return f"Page: {operation} — Payout\n\nSection: Endpoint\n\nCode (http):\n{operation}\n\nSection: Description\n\n{body}"


class LLM:
    def __init__(self, verdict=1, ids=None):
        self.verdict, self.ids, self.calls = verdict, ids or ["c1:u5"], 0

    async def agenerate(self, prompt, response_model):
        self.calls += 1
        return response_model(verdict=self.verdict, support_kind="explicit" if self.verdict else "unsupported",
                              reason="supported" if self.verdict else "missing", evidence_ids=self.ids)


@pytest.mark.parametrize("context", [page("POST /api/v2/payout"), page("POST /api/v1/payout/query"),
    "Some body mentions POST /api/v1/payout but is not the target API record.",
    "Page: POST /api/v1/payout — Payout\n\nSection: Endpoint\n\nCode (http):\nPOST /api/v1/payout",
    page().replace("Page: POST /api/v1/payout", "Page: POST /api/v2/payout"),
    page().replace("Code (http):\nPOST /api/v1/payout", "Code (http):\nGET /api/v1/payout")])
def test_direct_source_gate_rejects_mentions_wrong_version_prefix_method_and_header_only(context):
    llm = LLM()
    result = asyncio.run(SourceScopedFactScorer(llm).ascore(user_input="q", reference=FACT,
                         retrieved_contexts=[context], required_api_operation=API))
    audit = json.loads(result.reason)
    assert result.value == 0
    assert not audit["semantic_judge_called"]
    assert audit["branches"][0]["decision_source"] == "direct_api_source_gate"
    assert audit["calls"] == []
    assert llm.calls == 0


def test_direct_scope_requires_title_and_endpoint_within_same_page():
    context = "Page: Other API\n\nSection: Description\n\nSee POST /api/v1/payout.\n\n" + page()
    assert not direct_api_unit_ids([context], API)


def test_source_presence_still_requires_semantic_judging_and_substantive_citation():
    assert direct_api_unit_ids([page()], API) == ["c1:u5"]
    llm = LLM()
    result = asyncio.run(SourceScopedFactScorer(llm).ascore(user_input="q", reference=FACT,
                         retrieved_contexts=[page()], required_api_operation=API))
    assert result.value == 1
    assert llm.calls == 1
    audit = json.loads(result.reason)
    assert audit["profile"] == "audited-v4"
    assert audit["semantic_profile"] == "audited-v3"
    assert audit["branches"][0]["decision_source"] == "semantic_judge"


def test_target_page_presence_does_not_override_negative_semantic_verdict():
    result = asyncio.run(SourceScopedFactScorer(LLM(0)).ascore(user_input="q", reference=FACT,
                         retrieved_contexts=[page(body="This page only states the return type.")], required_api_operation=API))
    assert result.value == 0
    assert json.loads(result.reason)["semantic_judge_called"]


@pytest.mark.parametrize("ids", [["c1:u1"], ["c2:u5"]])
def test_positive_without_target_body_citation_is_rejected_and_original_verdict_is_preserved(ids):
    result = asyncio.run(SourceScopedFactScorer(LLM(ids=ids)).ascore(user_input="q", reference=FACT,
                         retrieved_contexts=[page(), page("POST /api/v2/payout")], required_api_operation=API))
    audit = json.loads(result.reason)
    assert result.value == 0
    assert audit["raw_semantic_value"] == 1
    assert audit["branches"][0]["semantic_verdict"] == 1
    assert audit["calls"][0]["result"]["verdict"] == 1
    assert audit["branches"][0]["decision_source"] == "direct_api_source_gate"


def test_rules_v2_require_explicit_v4_and_leave_golden_unchanged(tmp_path):
    sample = EvalSample(case_id="one", user_input="q", response="a", reference=FACT,
                        reference_facts=[FACT, "a or b"], retrieved_contexts=[page()])
    path = tmp_path / "rules.json"
    data = {"schema_version": 2, "base_golden_sha256": golden_sha256([sample]), "cases": {"one": [
            {"fact": FACT, "require_direct_api": API}, {"fact": "a or b", "any_of": ["a", "b"]}]}}
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="require audited-v4"):
        apply_fact_rules([sample], path)
    updated = apply_fact_rules([sample], path, allow_direct_api=True)[0]
    assert updated.reference_fact_direct_apis == {FACT: API}
    assert updated.reference_fact_rules == {"a or b": ["a", "b"]}
    assert not sample.reference_fact_direct_apis
    assert golden_sha256([sample]) == golden_sha256([updated])
    data["cases"]["one"][0]["require_direct_api"] = "POST /unrelated/api"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="must be named"):
        apply_fact_rules([sample], path, allow_direct_api=True)


def test_scoped_fact_stays_one_unit_in_case_denominator():
    sample = EvalSample(case_id="one", user_input="q", response="a", reference=FACT,
                        reference_facts=[FACT, "Other fact."], retrieved_contexts=[page("POST /api/v2/payout")],
                        reference_fact_direct_apis={FACT: API})
    llm = LLM(ids=["c1:u5"])
    result = asyncio.run(score_sample(sample, Scorers(reference_fact_recall=SourceScopedFactScorer(llm))))
    assert result["scores"]["reference_fact_recall"]["value"] == .5
    assert len(json.loads(result["scores"]["reference_fact_recall"]["reason"])) == 2
    assert llm.calls == 1


def test_scope_cannot_silently_gate_or_branches():
    with pytest.raises(ValueError, match="alternative branches"):
        asyncio.run(SourceScopedFactScorer(LLM()).ascore(user_input="q", reference=FACT,
                    retrieved_contexts=[page()], required_api_operation=API, alternatives=["a", "b"]))


def test_v4_retains_v3_semantic_contract_and_only_changes_rfr():
    from anydocs_ragas.calibrated_judge import contract_metadata as v3
    assert contract_metadata()["semantic_judge_contract_sha256"] == v3()["judge_contract_sha256"]
    assert v3()["judge_implementation_sha256"] == "71001a98d146d4f83f7f2e5beaa8d89c58e355f1a1ba147ed6e2be8f8b5b72a9"
    with pytest.raises(ValueError, match="RFR only"):
        build_scorers(None, {"context_recall"}, profile="audited-v4")
