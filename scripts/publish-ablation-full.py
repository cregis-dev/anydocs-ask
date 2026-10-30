#!/usr/bin/env python3
"""Publish completed score journals only, pacing dataset API traffic."""
import argparse
import asyncio
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("frozen_full_scorer", Path(__file__).with_name("score-ablation-full.py"))
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)


async def main():
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
    if json.loads((root / "manifest.json").read_text())["status"] != "complete":
        raise ValueError("Generation is incomplete")
    parts, hashes = [], {}
    for rep in range(1, 4):
        for variant in BASE.VARIANTS:
            part = root / "groups" / variant / f"r{rep:02d}" / "judge"
            journal = part / "results.jsonl"
            results = BASE.load_trace_records(journal)
            if len(results) != 92 or len({r["case_id"] for r in results}) != 92:
                raise ValueError("Refusing publication while any scoring work remains")
            hashes[str(journal.relative_to(root))] = BASE.file_sha256(journal)
            if not (part / "publication.json").exists():
                parts.append((variant, rep))
    BASE.save(root / "publication-recovery.json", {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "reason": "Dataset API 429 after first complete experiment; resume publication only",
        "spacing_seconds": 70, "pending_parts": parts, "score_journal_sha256_before": hashes,
        "completed_scores_recomputed": 0,
        "rate_limit_documentation": "https://langfuse.com/faq/all/api-limits",
    })
    for variant, rep in parts:
        print(f"PUBLICATION WAIT 70s before {variant} r{rep}", flush=True)
        await asyncio.sleep(70)
        await BASE.judge_part(root, variant, rep, contract, True)
        for path, expected in hashes.items():
            if BASE.file_sha256(root / path) != expected:
                raise ValueError("Score journals changed during publication-only recovery")
    BASE.save(root / "judge-status.json", {"status": "complete", "completed_parts": 12,
              "scored_outputs": 1104, "judge_concurrency_last_phase": 16,
              "publication_recovery": "publication-recovery.json"})
    BASE.save(root / "publication-recovery-complete.json", {
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "score_journals_unchanged": True, "completed_scores_recomputed": 0,
    })


if __name__ == "__main__":
    asyncio.run(main())
