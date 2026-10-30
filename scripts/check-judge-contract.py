#!/usr/bin/env python3
"""Small preflight controls; no answer generation and no source score publication."""
import argparse
import asyncio
import json
from pathlib import Path

from anydocs_ragas.cli import provider_settings
from anydocs_ragas.audited import contract_metadata
from anydocs_ragas.scoring import build_scorers


async def check(args):
    old = args.previous
    golden = {r["id"]: r for r in map(json.loads, args.golden.read_text().splitlines()) if r}
    load = lambda arm: [json.loads(line) for line in (old / "groups" / arm / "raw.cases.jsonl").read_text().splitlines()]
    payout = next(r for r in load("agentic") if r["case_id"] == "cregis-waas-zh-payout-flow")
    checkout = next(r for r in load("parent_child") if r["case_id"] == "cregis-pe-zh-checkout-core-fields")
    collection = next(r for r in load("agentic") if r["case_id"] == "cregis-waas-en-collection-single-source")
    metrics = {"context_precision", "reference_fact_recall", "factual_correctness"}
    scorers = build_scorers(provider_settings(metrics), metrics, profile="audited-v1")
    fixtures = [
        ("partial_payout_contexts", scorers.context_precision, {
            "user_input": payout["query"], "reference": golden[payout["case_id"]]["expected"]["reference_answer"],
            "retrieved_contexts": payout["ragas_sample"]["retrieved_contexts"],
        }, 1.0),
        ("unrelated_context", scorers.context_precision, {
            "user_input": "Which WaaS endpoint initiates a payout?", "reference": "POST /api/v1/payout initiates a payout.",
            "retrieved_contexts": ["Team API authentication uses a separate authentication mechanism."],
        }, 0.0),
        ("single_source_schema_inference", scorers.reference_fact_recall, {
            "user_input": collection["query"], "reference": "Multiple source addresses require separate requests.",
            "retrieved_contexts": collection["ragas_sample"]["retrieved_contexts"],
        }, 1.0),
        ("checkout_core_not_all_false", scorers.factual_correctness, {
            "response": checkout["ragas_sample"]["response"],
            "reference": golden[checkout["case_id"]]["expected"]["reference_answer"],
        }, "nonzero"),
        ("contradictory_batch_limit", scorers.factual_correctness, {
            "response": "The maximum batch size is 1000 addresses.",
            "reference": "The maximum batch size is 100 addresses.",
        }, 0.0),
    ]
    results = []
    for name, scorer, inputs, expected in fixtures:
        try:
            result = await scorer.ascore(**inputs)
            value = float(result.value)
            passed = value > 0 if expected == "nonzero" else abs(value - expected) < 1e-8
            results.append({"control": name, "expected": expected, "value": value,
                            "passed": passed, "reason": result.reason})
        except Exception as error:
            results.append({"control": name, "expected": expected, "passed": False, "error": str(error)})
        print(json.dumps({k: v for k, v in results[-1].items() if k not in {"reason", "error"}}), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({**contract_metadata(), "scope": "5 judge controls, no generated answers",
                                       "results": results}, ensure_ascii=False, indent=2) + "\n")
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--golden", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    raise SystemExit(asyncio.run(check(parser.parse_args())))
