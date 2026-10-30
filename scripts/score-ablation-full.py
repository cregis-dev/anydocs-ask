#!/usr/bin/env python3
"""Score fresh four-arm full outputs once; resumable at frozen-output boundaries."""
from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict, replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from hashlib import sha256

from anydocs_ragas.audited import contract_metadata as base_contract
from anydocs_ragas.calibrated_judge import contract_metadata as fact_contract
from anydocs_ragas.cli import provider_settings
from anydocs_ragas.fact_rules import apply_fact_rules
from anydocs_ragas.models import (EvalSample, coverage, extract_sample, file_sha256,
                                 golden_sha256, experiment_metadata, load_trace_records)
from anydocs_ragas.reporting import write_reports
from anydocs_ragas.scoring import build_scorers, score_sample

VARIANTS = ("child_only", "parent_child", "page_static", "agentic")
BASE_METRICS = {"faithfulness", "context_precision", "context_recall", "factual_correctness", "rubric_compliance"}
PROFILE = "ablation-full-v1"


def record_hash(record):
    return sha256(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def golden_samples(root):
    rows = load_trace_records(root / "dataset/cases.frozen.jsonl")
    return [EvalSample(case_id=r["id"], user_input=r["query"], response=None, retrieved_contexts=[],
                      reference=r["expected"]["reference_answer"], reference_facts=r["expected"]["reference_facts"],
                      rubric=r["expected"]["evaluation_rubric"], lang=r["lang"]) for r in rows]


def save(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def prepare_contract(root: Path, source_rules: Path):
    samples = golden_samples(root)
    rules = json.loads(source_rules.read_text())
    if rules.get("schema_version") != 1:
        raise ValueError("Full primary metric must not apply the experimental strict source gate")
    rules["base_golden_sha256"] = golden_sha256(samples)
    rules["scope"] = "Same two pre-reviewed OR facts; rebound to all 92 unchanged Golden cases, not new scoring rules"
    path = root / "dataset/fact-rules.json"
    if path.exists() and json.loads(path.read_text()) != rules:
        raise ValueError("Frozen full fact rules differ; refusing overwrite")
    if not path.exists():
        save(path, rules)
    apply_fact_rules(samples, path)
    contract = {"judge_profile": PROFILE, "metric_profiles": {
        **{m: "audited-v1" for m in sorted(BASE_METRICS)}, "reference_fact_recall": "audited-v3"},
        "base_contract": base_contract(), "fact_contract": fact_contract(),
        "judge_fact_rules_sha256": file_sha256(path), "golden_sha256": golden_sha256(samples),
        "judge_model": "deepseek-v4-pro", "judge_concurrency": 2,
        "judge_output_tokens": 4096, "judge_timeout_seconds": 120,
        "strict_source_gate": False, "independent_business_review": "pending",
        "known_disagreement": "v1 payout wallet inference from v2 remains semantically disputed; no forced direct-source score",
        "all_metrics_once_per_fresh_output": True, "automatic_successful_score_repeats": False}
    contract_path = root / "judge-contract.json"
    if contract_path.exists() and json.loads(contract_path.read_text()) != contract:
        raise ValueError("Scoring contract changed; refusing resume")
    save(contract_path, contract)
    return contract


async def judge_stream(root: Path, contract: dict):
    """Overlap offline judging with generation without increasing judge concurrency."""
    golden = {s.case_id: s for s in apply_fact_rules(golden_samples(root), root / "dataset/fact-rules.json")}
    settings = provider_settings(BASE_METRICS | {"reference_fact_recall"})
    if settings.judge_model != "deepseek-v4-pro" or settings.judge_provider != "anthropic":
        raise ValueError("Frozen model/provider differs")
    base = build_scorers(settings, BASE_METRICS, profile="audited-v1")
    facts = build_scorers(settings, {"reference_fact_recall"}, profile="audited-v3")
    scorers = replace(base, reference_fact_recall=facts.reference_fact_recall)
    done = {}
    contract_hash = file_sha256(root / "judge-contract.json")
    for v in VARIANTS:
        for rep in range(1, 4):
            dest = root / "groups" / v / f"r{rep:02d}" / "judge"
            dest.mkdir(parents=True, exist_ok=True)
            marker = dest / "stream-contract.json"
            if marker.exists() and json.loads(marker.read_text())["contract_sha256"] != contract_hash:
                raise ValueError("Streaming scorer contract changed")
            save(marker, {"contract_sha256": contract_hash})
            journal = dest / "results.jsonl"
            for r in load_trace_records(journal) if journal.exists() else []:
                key = (v, rep, r["case_id"])
                if key in done:
                    raise ValueError("Duplicate streaming score")
                done[key] = r["_source_record_sha256"]
    semaphore = asyncio.Semaphore(2)

    async def one(record):
        key = (record["variant"], record["repetition"], record["case_id"])
        sample = extract_sample(record)
        expected = golden[sample.case_id]
        if golden_sha256([sample]) != golden_sha256([expected]):
            raise ValueError("Generated trace has different Golden fields")
        if not sample.source_trace_id or not sample.source_observation_id:
            raise ValueError("Missing original trace")
        if sample.response and sample.context_source not in {"prompt_snapshot", "agent_evidence"}:
            raise ValueError("Answer lacks authoritative evidence")
        sample = replace(sample, reference_fact_rules=expected.reference_fact_rules)
        async with semaphore:
            result = await score_sample(sample, scorers)
            result["_source_record_sha256"] = record_hash(record)
            journal = root / "groups" / key[0] / f"r{key[1]:02d}" / "judge/results.jsonl"
            with journal.open("a") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")
            done[key] = result["_source_record_sha256"]
            print(f"JUDGE {len(done)}/1104 {key[0]} r{key[1]} {key[2]}: "
                  f"{len(result['scores'])} scores, {len(result['errors'])} errors", flush=True)
            save(root / "judge-stream-status.json", {"scored_outputs": len(done), "planned_outputs": 1104})

    while True:
        ledger = root / "attempts.jsonl"
        try:
            records = load_trace_records(ledger) if ledger.exists() else []
        except ValueError:
            await asyncio.sleep(1)
            continue
        for r in records:
            key = (r["variant"], r["repetition"], r["case_id"])
            if key in done and done[key] != record_hash(r):
                raise ValueError("Already scored output changed")
        pending = [r for r in records if (r["variant"], r["repetition"], r["case_id"]) not in done]
        if pending:
            await asyncio.gather(*(one(r) for r in pending[:20]))
            continue
        status = json.loads((root / "manifest.json").read_text())["status"]
        if status == "complete" and len(done) == 1104:
            return
        if status == "failed":
            raise ValueError("Generation stopped; preserving all scored outputs")
        await asyncio.sleep(5)


async def judge_part(root: Path, variant: str, repetition: int, contract: dict, publish: bool):
    part = root / "groups" / variant / f"r{repetition:02d}"
    raw = part / "raw.cases.jsonl"
    records = load_trace_records(raw)
    if len(records) != 92 or len({r["case_id"] for r in records}) != 92:
        raise ValueError("Each arm/repetition requires all 92 distinct attempts")
    samples = apply_fact_rules([extract_sample(r) for r in records], root / "dataset/fact-rules.json")
    if golden_sha256(samples) != contract["golden_sha256"]:
        raise ValueError("Golden changed between groups")
    if any(not s.source_trace_id or not s.source_observation_id for s in samples):
        raise ValueError("Missing original source trace")
    if any(s.response and s.context_source not in {"prompt_snapshot", "agent_evidence"} for s in samples):
        raise ValueError("Answer lacks actual evidence body")
    destination = part / "judge"
    destination.mkdir(exist_ok=True)
    source_hash = file_sha256(raw)
    identity = {"source_sha256": source_hash, "contract_sha256": file_sha256(root / "judge-contract.json")}
    identity_path = destination / "input-identity.json"
    if identity_path.exists() and json.loads(identity_path.read_text()) != identity:
        raise ValueError("Frozen source/scoring configuration changed")
    save(identity_path, identity)
    journal = destination / "results.jsonl"
    previous = load_trace_records(journal) if journal.exists() else []
    done = {r["case_id"]: r for r in previous}
    if len(done) != len(previous) or not set(done).issubset({s.case_id for s in samples}):
        raise ValueError("Duplicate or unexpected score journal rows")
    if any(r.get("_source_record_sha256") and r["_source_record_sha256"] != record_hash(next(x for x in records if x["case_id"] == r["case_id"])) for r in previous):
        raise ValueError("Scored source record changed")
    settings = provider_settings(BASE_METRICS | {"reference_fact_recall"})
    if settings.judge_model != "deepseek-v4-pro" or settings.judge_provider != "anthropic":
        raise ValueError("Frozen model/provider differs")
    scorers = build_scorers(settings, BASE_METRICS, profile="audited-v1")
    facts = build_scorers(settings, {"reference_fact_recall"}, profile="audited-v3")
    scorers = replace(scorers, reference_fact_recall=facts.reference_fact_recall)
    semaphore = asyncio.Semaphore(2)

    async def one(sample):
        if sample.case_id in done:
            return
        async with semaphore:
            result = await score_sample(sample, scorers)
            with journal.open("a") as handle:
                handle.write(json.dumps(result, ensure_ascii=False) + "\n")
            done[sample.case_id] = result
            print(f"JUDGE {variant} r{repetition} {len(done)}/92 {sample.case_id}: "
                  f"{len(result['scores'])} scores, {len(result['errors'])} errors, {len(result['skipped'])} skipped", flush=True)

    await asyncio.gather(*(one(s) for s in samples))
    results = [done[s.case_id] for s in samples]
    manifest = json.loads((root / "manifest.json").read_text())
    metadata = {**experiment_metadata(records), "judge_profile": PROFILE,
                "metric_profiles": contract["metric_profiles"], "judge_contract_sha256": file_sha256(root / "judge-contract.json"),
                "judge_fact_rules_sha256": contract["judge_fact_rules_sha256"],
                "judge_implementation_sha256": file_sha256(Path(__file__)),
                "base_judge_contract_sha256": contract["base_contract"]["judge_contract_sha256"],
                "fact_judge_contract_sha256": contract["fact_contract"]["judge_contract_sha256"],
                "source_trace": str(raw), "source_trace_sha256": source_hash,
                "golden_sha256": contract["golden_sha256"], "release": manifest["docs_sha"], "engine": manifest["engine_sha"],
                "judge_provider": settings.judge_provider, "judge_model": settings.judge_model,
                "embedding_model": "not used by these six semantic metrics",
                "metrics": sorted(BASE_METRICS | {"reference_fact_recall"}), "coverage": coverage(samples),
                "source_scores_published": publish, "new_generation_not_historical_rejudge": True}
    if not (destination / "reports.json").exists():
        paths = write_reports(destination, results, metadata)
        save(destination / "reports.json", {k: str(v) for k, v in paths.items()})
    if publish and not (destination / "publication.json").exists():
        from anydocs_ragas.langfuse import publish_experiment
        name = f"{manifest['experiment_id']}-{variant}-no_page-r{repetition:02d}"
        url = publish_experiment(samples_by_id={s.case_id: asdict(s) for s in samples}, results=results,
                                 dataset_base_name="cregis-pc-agent-ablation", experiment_name=name,
                                 metadata=metadata, publish_source_scores=True)
        save(destination / "publication.json", {"experiment_name": name, "url": url,
             "score_count": sum(len(r["scores"]) for r in results), "items": len(results),
             "published_at": datetime.now(timezone.utc).isoformat()})
        print(f"PUBLISHED {name}: {url}", flush=True)
    save(destination / "status.json", {"status": "complete", "scored_outputs": len(results),
         "valid_scores": sum(len(r["scores"]) for r in results),
         "errors": sum(len(r["errors"]) for r in results), "skipped": sum(len(r["skipped"]) for r in results)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--fact-rules", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--stream", action="store_true", help="Judge completed immutable attempts while generation continues")
    parser.add_argument("--no-publish", action="store_true")
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(args.env_file, override=True)
    os.environ.update(RAGAS_JUDGE_PROVIDER="anthropic", RAGAS_JUDGE_MODEL="deepseek-v4-pro",
                      RAGAS_JUDGE_EXTRA_BODY_JSON='{"thinking":{"type":"disabled"}}',
                      RAGAS_MAX_TOKENS="4096", RAGAS_TIMEOUT_SECONDS="120")
    root = args.run.resolve()
    contract = prepare_contract(root, args.fact_rules.resolve())
    if args.prepare_only:
        print(json.dumps(contract, indent=2))
        return 0
    if args.stream:
        asyncio.run(judge_stream(root, contract))
    finished = set()
    while len(finished) < 12:
        for repetition in range(1, 4):
            for variant in VARIANTS:
                key = (variant, repetition)
                if key in finished:
                    continue
                part = root / "groups" / variant / f"r{repetition:02d}"
                raw = part / "raw.cases.jsonl"
                if not raw.exists() or len(load_trace_records(raw)) != 92:
                    continue
                asyncio.run(judge_part(root, variant, repetition, contract, not args.no_publish))
                finished.add(key)
                save(root / "judge-status.json", {"completed_parts": [list(x) for x in sorted(finished)], "planned_parts": 12})
        if len(finished) == 12:
            break
        status = json.loads((root / "manifest.json").read_text())["status"]
        if status in {"failed", "complete"} or not args.watch:
            raise ValueError(f"Incomplete generation groups; generation status {status}")
        time.sleep(20)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
