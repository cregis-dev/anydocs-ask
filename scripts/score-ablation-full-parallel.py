#!/usr/bin/env python3
"""Resource-only executor change; reuse the frozen full-v1 semantic scorers."""
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


async def stream(root, contract):
    golden = {s.case_id: s for s in BASE.apply_fact_rules(BASE.golden_samples(root), root / "dataset/fact-rules.json")}
    settings = BASE.provider_settings(BASE.BASE_METRICS | {"reference_fact_recall"})
    if settings.judge_provider != "anthropic" or settings.judge_model != "deepseek-v4-pro":
        raise ValueError("Frozen model/provider differs")
    scorers = BASE.build_scorers(settings, BASE.BASE_METRICS, profile="audited-v1")
    facts = BASE.build_scorers(settings, {"reference_fact_recall"}, profile="audited-v3")
    scorers = replace(scorers, reference_fact_recall=facts.reference_fact_recall)
    done = {}
    contract_hash = BASE.file_sha256(root / "judge-contract.json")
    for v in BASE.VARIANTS:
        for rep in range(1, 4):
            dest = root / "groups" / v / f"r{rep:02d}" / "judge"
            dest.mkdir(parents=True, exist_ok=True)
            marker = dest / "stream-contract.json"
            if marker.exists() and json.loads(marker.read_text())["contract_sha256"] != contract_hash:
                raise ValueError("Scoring contract changed")
            BASE.save(marker, {"contract_sha256": contract_hash})
            journal = dest / "results.jsonl"
            for r in BASE.load_trace_records(journal) if journal.exists() else []:
                key = (v, rep, r["case_id"])
                if key in done:
                    raise ValueError("Duplicate completed score")
                done[key] = r["_source_record_sha256"]
    phase = {"executor": str(Path(__file__).resolve()), "executor_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
             "started_at": datetime.now(timezone.utc).isoformat(), "initial_judge_concurrency": 2,
             "current_judge_concurrency": 8, "generation_concurrency": 1,
             "semantic_contract_sha256": contract_hash, "base_executor_sha256": BASE.file_sha256(BASE_PATH),
             "already_completed_outputs_preserved": len(done), "completed_scores_recomputed": 0,
             "cancelled_inflight_samples_upper_bound": 2,
             "cancelled_inflight_calls": "unknown partial calls; no completed final score was discarded",
             "reason": "Execution resources only; same frozen models, prompts, rules, outputs and score functions"}
    phase_path = root / "judge-execution-phase-02.json"
    if phase_path.exists():
        old = json.loads(phase_path.read_text())
        if old["executor_sha256"] != phase["executor_sha256"] or old["semantic_contract_sha256"] != contract_hash:
            raise ValueError("Executor or scoring contract changed")
    else:
        BASE.save(phase_path, phase)
    semaphore = asyncio.Semaphore(8)

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
            result["_judge_execution_phase"] = 2
            journal = root / "groups" / key[0] / f"r{key[1]:02d}" / "judge/results.jsonl"
            with journal.open("a") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")
            done[key] = result["_source_record_sha256"]
            print(f"JUDGE {len(done)}/1104 {key[0]} r{key[1]} {key[2]}: "
                  f"{len(result['scores'])} scores, {len(result['errors'])} errors", flush=True)
            BASE.save(root / "judge-stream-status.json", {"scored_outputs": len(done), "planned_outputs": 1104,
                      "judge_concurrency": 8, "execution_phase": 2})

    while True:
        ledger = root / "attempts.jsonl"
        try:
            records = BASE.load_trace_records(ledger) if ledger.exists() else []
        except ValueError:
            await asyncio.sleep(1)
            continue
        for r in records:
            key = (r["variant"], r["repetition"], r["case_id"])
            if key in done and done[key] != BASE.record_hash(r):
                raise ValueError("Previously scored output changed")
        pending = [r for r in records if (r["variant"], r["repetition"], r["case_id"]) not in done]
        if pending:
            await asyncio.gather(*(one(r) for r in pending[:32]))
            continue
        status = json.loads((root / "manifest.json").read_text())["status"]
        if status == "complete" and len(done) == 1104:
            break
        if status == "failed":
            raise ValueError("Generation stopped; partial scores preserved")
        await asyncio.sleep(5)
    for rep in range(1, 4):
        for v in BASE.VARIANTS:
            await BASE.judge_part(root, v, rep, contract, True)
    BASE.save(root / "judge-status.json", {"status": "complete", "completed_parts": 12, "scored_outputs": len(done)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--fact-rules", required=True, type=Path)
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(args.env_file, override=True)
    os.environ.update(RAGAS_JUDGE_PROVIDER="anthropic", RAGAS_JUDGE_MODEL="deepseek-v4-pro",
                      RAGAS_JUDGE_EXTRA_BODY_JSON='{"thinking":{"type":"disabled"}}',
                      RAGAS_MAX_TOKENS="4096", RAGAS_TIMEOUT_SECONDS="120")
    root = args.run.resolve()
    contract = BASE.prepare_contract(root, args.fact_rules.resolve())
    archive = root / "source-archive/scripts/score-ablation-full-parallel.py"
    if archive.exists() and archive.read_bytes() != Path(__file__).read_bytes():
        raise ValueError("Executor source archive differs")
    archive.write_bytes(Path(__file__).read_bytes())
    asyncio.run(stream(root, contract))

if __name__ == "__main__":
    main()
