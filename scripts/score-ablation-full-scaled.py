#!/usr/bin/env python3
"""Continue frozen scoring with an explicitly recorded resource-only phase."""
from __future__ import annotations
import argparse
import asyncio
from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path

BASE_PATH = Path(__file__).with_name("score-ablation-full.py")
SPEC = importlib.util.spec_from_file_location("frozen_full_scorer", BASE_PATH)
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)


async def stream(root, contract, concurrency, previous_concurrency, phase_number):
    golden = {s.case_id: s for s in BASE.apply_fact_rules(BASE.golden_samples(root), root / "dataset/fact-rules.json")}
    settings = BASE.provider_settings(BASE.BASE_METRICS | {"reference_fact_recall"})
    if settings.judge_provider != "anthropic" or settings.judge_model != "deepseek-v4-pro":
        raise ValueError("Frozen model/provider differs")
    scorers = BASE.build_scorers(settings, BASE.BASE_METRICS, profile="audited-v1")
    facts = BASE.build_scorers(settings, {"reference_fact_recall"}, profile="audited-v3")
    scorers = replace(scorers, reference_fact_recall=facts.reference_fact_recall)
    done = {}
    contract_hash = BASE.file_sha256(root / "judge-contract.json")
    for variant in BASE.VARIANTS:
        for rep in range(1, 4):
            dest = root / "groups" / variant / f"r{rep:02d}" / "judge"
            dest.mkdir(parents=True, exist_ok=True)
            marker = dest / "stream-contract.json"
            if marker.exists() and json.loads(marker.read_text())["contract_sha256"] != contract_hash:
                raise ValueError("Scoring contract changed")
            BASE.save(marker, {"contract_sha256": contract_hash})
            journal = dest / "results.jsonl"
            for result in BASE.load_trace_records(journal) if journal.exists() else []:
                key = (variant, rep, result["case_id"])
                if key in done:
                    raise ValueError("Duplicate completed score")
                done[key] = result["_source_record_sha256"]
    phase = {
        "executor": str(Path(__file__).resolve()),
        "executor_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "execution_phase": phase_number,
        "previous_judge_concurrency": previous_concurrency,
        "current_judge_concurrency": concurrency,
        "generation_concurrency": 1,
        "semantic_contract_sha256": contract_hash,
        "base_executor_sha256": BASE.file_sha256(BASE_PATH),
        "already_completed_outputs_preserved": len(done),
        "completed_scores_recomputed": 0,
        "cancelled_inflight_samples_upper_bound": previous_concurrency,
        "cancelled_inflight_calls": "unknown partial calls; no completed final score was discarded",
        "reason": "User requested higher concurrency; resources only, frozen scoring semantics unchanged",
    }
    phase_path = root / f"judge-execution-phase-{phase_number:02d}.json"
    if phase_path.exists():
        previous = json.loads(phase_path.read_text())
        for key in ("executor_sha256", "semantic_contract_sha256", "current_judge_concurrency"):
            if previous[key] != phase[key]:
                raise ValueError("Recorded execution phase differs")
    else:
        BASE.save(phase_path, phase)
    semaphore = asyncio.Semaphore(concurrency)

    async def one(record):
        key = (record["variant"], record["repetition"], record["case_id"])
        sample = BASE.extract_sample(record)
        expected = golden[sample.case_id]
        if BASE.golden_sha256([sample]) != BASE.golden_sha256([expected]):
            raise ValueError("Golden fields differ")
        if not sample.source_trace_id or not sample.source_observation_id:
            raise ValueError("Original trace missing")
        if sample.response and sample.context_source not in {"prompt_snapshot", "agent_evidence"}:
            raise ValueError("Authoritative evidence missing")
        sample = replace(sample, reference_fact_rules=expected.reference_fact_rules)
        async with semaphore:
            result = await BASE.score_sample(sample, scorers)
            result["_source_record_sha256"] = BASE.record_hash(record)
            result["_judge_execution_phase"] = phase_number
            journal = root / "groups" / key[0] / f"r{key[1]:02d}" / "judge/results.jsonl"
            with journal.open("a") as file:
                file.write(json.dumps(result, ensure_ascii=False) + "\n")
            done[key] = result["_source_record_sha256"]
            print(f"JUDGE {len(done)}/1104 {key[0]} r{key[1]} {key[2]}: "
                  f"{len(result['scores'])} scores, {len(result['errors'])} errors", flush=True)
            BASE.save(root / "judge-stream-status.json", {"scored_outputs": len(done), "planned_outputs": 1104,
                      "judge_concurrency": concurrency, "execution_phase": phase_number})

    while True:
        ledger = root / "attempts.jsonl"
        try:
            records = BASE.load_trace_records(ledger) if ledger.exists() else []
        except ValueError:
            await asyncio.sleep(1)
            continue
        for record in records:
            key = (record["variant"], record["repetition"], record["case_id"])
            if key in done and done[key] != BASE.record_hash(record):
                raise ValueError("Previously scored output changed")
        pending = [record for record in records if (record["variant"], record["repetition"], record["case_id"]) not in done]
        if pending:
            await asyncio.gather(*(one(record) for record in pending[:concurrency * 4]))
            continue
        status = json.loads((root / "manifest.json").read_text())["status"]
        if status == "complete" and len(done) == 1104:
            break
        if status == "failed":
            raise ValueError("Generation stopped; partial scores preserved")
        await asyncio.sleep(5)
    for rep in range(1, 4):
        for variant in BASE.VARIANTS:
            await BASE.judge_part(root, variant, rep, contract, True)
    BASE.save(root / "judge-status.json", {"status": "complete", "completed_parts": 12,
              "scored_outputs": len(done), "judge_concurrency": concurrency, "execution_phase": phase_number})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--fact-rules", required=True, type=Path)
    parser.add_argument("--concurrency", required=True, type=int)
    parser.add_argument("--previous-concurrency", required=True, type=int)
    parser.add_argument("--execution-phase", required=True, type=int)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 32 or args.previous_concurrency < 1 or args.execution_phase < 3:
        parser.error("Invalid resource phase parameters")
    from dotenv import load_dotenv
    load_dotenv(args.env_file, override=True)
    os.environ.update(RAGAS_JUDGE_PROVIDER="anthropic", RAGAS_JUDGE_MODEL="deepseek-v4-pro",
                      RAGAS_JUDGE_EXTRA_BODY_JSON='{"thinking":{"type":"disabled"}}',
                      RAGAS_MAX_TOKENS="4096", RAGAS_TIMEOUT_SECONDS="120")
    root = args.run.resolve()
    contract = BASE.prepare_contract(root, args.fact_rules.resolve())
    archive = root / "source-archive/scripts/score-ablation-full-scaled.py"
    if archive.exists() and archive.read_bytes() != Path(__file__).read_bytes():
        raise ValueError("Executor source archive differs")
    archive.write_bytes(Path(__file__).read_bytes())
    asyncio.run(stream(root, contract, args.concurrency, args.previous_concurrency, args.execution_phase))


if __name__ == "__main__":
    main()
