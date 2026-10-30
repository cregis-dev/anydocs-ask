"""Load versioned alternative interpretations without changing frozen Golden text."""

from dataclasses import replace
import json
from pathlib import Path

from .models import EvalSample, golden_sha256


def apply_fact_rules(samples: list[EvalSample], path: Path, *, allow_direct_api: bool = False) -> list[EvalSample]:
    data = json.loads(path.read_text())
    if data.get("schema_version") not in (1, 2) or data.get("base_golden_sha256") != golden_sha256(samples):
        raise ValueError("Fact rules do not match the frozen Golden version")
    if data["schema_version"] == 2 and not allow_direct_api:
        raise ValueError("Schema-2 direct API requirements require audited-v4")
    by_id = {sample.case_id: sample for sample in samples}
    if len(by_id) != len(samples):
        raise ValueError("Duplicate Golden case IDs")
    cases = data.get("cases")
    if not isinstance(cases, dict):
        raise ValueError("Fact rules cases must be an object")
    rules, direct_apis = {}, {}
    for case_id, entries in cases.items():
        if case_id not in by_id or not isinstance(entries, list) or not entries:
            raise ValueError(f"Invalid fact-rule case: {case_id}")
        rules[case_id] = {}
        direct_apis[case_id] = {}
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Fact rule must be an object")
            fact, branches = entry.get("fact"), entry.get("any_of")
            if fact not in by_id[case_id].reference_facts or fact in seen:
                raise ValueError("Fact rule refers to a missing or duplicate frozen fact")
            seen.add(fact)
            if "require_direct_api" in entry:
                if data["schema_version"] != 2 or "any_of" in entry:
                    raise ValueError("Direct API rules must be schema 2 without any_of")
                from .source_scoped_judge import validate_operation
                operation = entry["require_direct_api"]
                validate_operation(operation)
                if operation.split(" ", 1)[1] not in fact:
                    raise ValueError("Direct API target must be named in the frozen fact")
                direct_apis[case_id][fact] = operation
                continue
            if (not isinstance(branches, list) or len(branches) < 2
                    or any(not isinstance(s, str) or not s.strip() for s in branches)
                    or len(set(branches)) != len(branches)):
                raise ValueError("any_of requires distinct nonempty branches")
            rules[case_id][fact] = branches
    return [replace(sample, reference_fact_rules=rules.get(sample.case_id, {}),
                    reference_fact_direct_apis=direct_apis.get(sample.case_id, {})) for sample in samples]
