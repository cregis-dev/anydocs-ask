#!/usr/bin/env python3
"""Targeted v2 Judge controls; these never generate or publish RAG answers."""

import argparse
import asyncio
import json
from pathlib import Path

from anydocs_ragas.cli import provider_settings
from anydocs_ragas.evidence_judge import contract_metadata
from anydocs_ragas.fact_rules import apply_fact_rules
from anydocs_ragas.models import extract_sample, load_trace_records
from anydocs_ragas.scoring import build_scorers


async def run(source: Path, rules: Path):
    samples = apply_fact_rules([extract_sample(r) for r in load_trace_records(source / "groups/agentic/raw.cases.jsonl")], rules)
    by_id = {s.case_id: s for s in samples}
    balance = by_id["cregis-waas-zh-sub-address-balance-query"]
    batch = by_id["cregis-waas-en-batch-address-create"]
    collection = by_id["cregis-waas-en-collection-single-source"]
    static = [extract_sample(r) for r in load_trace_records(source / "groups/page_static/raw.cases.jsonl")]
    v2 = next(s for s in static if s.case_id == balance.case_id)
    v2_context = [c for c in v2.retrieved_contexts if c.startswith("Page: POST /api/v2/sub_address_balance")]
    if len(v2_context) != 1:
        raise ValueError("Expected the frozen v2 API context")
    fact = balance.reference_facts[0]
    alternatives = balance.reference_fact_rules[fact]
    controls = [
        ("v1_only_satisfies_any_of", fact, balance.retrieved_contexts, alternatives, 1),
        ("v2_only_satisfies_any_of", fact, v2_context, alternatives, 1),
        ("other_product_satisfies_neither", fact,
         ["POST /openapi/v1/wallet_balance queries a Team API wallet balance."], alternatives, 0),
        ("original_batch_quote_failure", batch.reference_facts[0], batch.retrieved_contexts, None, 1),
        ("exact_api_version_matters", alternatives[0], v2_context, None, 0),
        ("partial_conjunction_not_any_of", "Both currency and amount are required request fields.",
         ["Request fields:\n- currency: string, required."], None, 0),
        ("collection_undefined_field", "Every /api/v1/collection request requires third_party_id.",
         collection.retrieved_contexts, None, 0),
    ]
    scorer = build_scorers(provider_settings({"reference_fact_recall"}), {"reference_fact_recall"}, profile="audited-v2").reference_fact_recall
    results = []
    for name, reference, contexts, options, expected in controls:
        result = await scorer.ascore(user_input="Check this fact against these contexts only.",
                                     reference=reference, retrieved_contexts=contexts, alternatives=options)
        results.append({"name": name, "expected": expected, "actual": result.value,
                        "passed": result.value == expected, "audit": json.loads(result.reason)})
    return {**contract_metadata(), "scope": "targeted development controls, not held-out Judge accuracy",
            "answer_generation_calls": 0, "passed": sum(r["passed"] for r in results),
            "total": len(results), "controls": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("rules", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Refusing to overwrite controls")
    result = asyncio.run(run(args.source, args.rules))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "total": result["total"], "output": str(args.output)}))
    return 0 if result["passed"] == result["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
