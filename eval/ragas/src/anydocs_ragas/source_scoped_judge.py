"""Opt-in direct-API provenance requirements layered over the frozen v3 judge."""

from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any

from .audited import AuditResult
from .calibrated_judge import CalibratedFactScorer, contract_metadata as semantic_metadata
from .evidence_judge import evidence_units

PROFILE = "audited-v4"
OPERATION = re.compile(r"(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /[A-Za-z0-9_./~-]+")
SOURCE_POLICY = """An explicit per-fact require_direct_api operation is a necessary
provenance condition, not a semantic verdict. Match both the normalized API page's
first Page header and its Endpoint HTTP code block, within the same page. Body
mentions, other versions, prefix matches, and endpoint/header-only records do not
meet this condition. If it is missing, return unsupported without a semantic call.
If present, judge the unchanged fact using the v3 semantic contract; a positive
verdict must also cite substantive evidence from the required direct API page.
Source presence and citation provenance never prove semantic entailment.
Unscoped facts retain v3 judging; explicit OR rules retain code-max aggregation.
"""


def validate_operation(operation: str) -> None:
    if not isinstance(operation, str) or not OPERATION.fullmatch(operation):
        raise ValueError("require_direct_api must be an exact HTTP method and API path")


def direct_api_unit_ids(contexts: list[str], operation: str) -> list[str]:
    validate_operation(operation)
    eligible = set()
    for index, text in enumerate(contexts):
        # These are normalized index records, not arbitrary endpoint mentions.
        page = re.split(r"\r?\nPage:", text, maxsplit=1)[0]
        header = re.match(r"Page:\s+([A-Z]+)\s+(\S+)(?:\s|$)", page)
        if not header or f"{header[1]} {header[2]}" != operation:
            continue
        sections = re.split(r"(?m)^Section:\s*", page)
        endpoint = next((s for s in sections[1:] if s.splitlines()[0].strip() == "Endpoint"), "")
        if re.search(r"Code \(http\):\s*\r?\n" + re.escape(operation) + r"[ \t]*(?:\r?\n|$)", endpoint):
            eligible.add(index)
    return [unit.id for unit in evidence_units(contexts)
            if unit.context_index in eligible
            and not unit.text.startswith(("Page:", "Section:", "API reference:", "Code (http):"))]


def contract_metadata() -> dict[str, Any]:
    semantic = semantic_metadata()
    payload = {"profile": PROFILE, "source_policy": SOURCE_POLICY,
               "semantic_contract_sha256": semantic["judge_contract_sha256"],
               "semantic_implementation_sha256": semantic["judge_implementation_sha256"]}
    return {**semantic, "judge_profile": PROFILE,
            "judge_contract_sha256": sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
            "judge_implementation_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
            "semantic_judge_profile": "audited-v3",
            "semantic_judge_contract_sha256": semantic["judge_contract_sha256"],
            "evidence_requirement": "explicit per-fact direct API provenance; not semantic proof"}


class SourceScopedFactScorer:
    def __init__(self, llm: Any):
        self.semantic = CalibratedFactScorer(llm)

    async def ascore(self, *, user_input: str, reference: str, retrieved_contexts: list[str],
                     alternatives: list[str] | None = None,
                     required_api_operation: str | None = None) -> AuditResult:
        if required_api_operation is not None:
            validate_operation(required_api_operation)
            if alternatives is not None:
                raise ValueError("Direct API requirements on alternative branches are not supported")
        eligible_ids = (direct_api_unit_ids(retrieved_contexts, required_api_operation)
                        if required_api_operation is not None else [])
        if not evidence_units(retrieved_contexts):
            raise ValueError("No nonempty evidence units")
        requirement = {"require_direct_api": required_api_operation} if required_api_operation else None
        if requirement is not None and not eligible_ids:
            reason = f"Required direct API body evidence is absent: {required_api_operation}."
            audit = {"profile": PROFILE, "metric": "reference_fact_recall", "reference_fact": reference,
                     "operator": "single", "branches": [{"reference_branch": reference, "verdict": 0,
                         "support_kind": "unsupported", "reason": reason, "evidence_ids": [], "evidence": [],
                         "decision_source": "direct_api_source_gate"}],
                     "value": 0, "calls": [], "source_requirement": requirement,
                     "eligible_direct_evidence_ids": [], "semantic_judge_called": False}
            return AuditResult(0.0, json.dumps(audit, ensure_ascii=False))
        result = await self.semantic.ascore(user_input=user_input, reference=reference,
                                           retrieved_contexts=retrieved_contexts, alternatives=alternatives)
        audit = json.loads(result.reason)
        audit.update(profile=PROFILE, semantic_profile="audited-v3", source_requirement=requirement,
                     eligible_direct_evidence_ids=eligible_ids, semantic_judge_called=True,
                     raw_semantic_value=result.value)
        for branch in audit["branches"]:
            branch["decision_source"] = "semantic_judge"
            if (requirement is not None and branch["verdict"] == 1
                    and not set(branch["evidence_ids"]).intersection(eligible_ids)):
                branch.update(semantic_verdict=1, semantic_reason=branch["reason"], verdict=0,
                              support_kind="unsupported", decision_source="direct_api_source_gate",
                              reason="Positive semantic verdict did not cite substantive required API evidence.")
        audit["value"] = max(branch["verdict"] for branch in audit["branches"])
        return AuditResult(float(audit["value"]), json.dumps(audit, ensure_ascii=False))
