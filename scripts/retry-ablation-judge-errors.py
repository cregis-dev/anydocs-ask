#!/usr/bin/env python3
"""Retry only technical Judge errors once, retaining original scores and failures."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys


def merge_retry(original: dict, retry: dict, metric: str, artifact: str) -> dict:
    if original["case_id"] != retry["case_id"]:
        raise ValueError("Retry case mismatch")
    if metric in original["scores"] or metric not in original["errors"]:
        raise ValueError("Only a missing score with an explicit technical error can be retried")
    for key in ("judge_profile", "judge_contract_sha256", "judge_model", "evaluation_input_sha256"):
        if original[key] != retry[key]:
            raise ValueError(f"Retry changed {key}")
    if retry["errors"] or set(retry["scores"]) != {metric}:
        raise ValueError("Retry must contain exactly the failed metric and no errors")
    result = deepcopy(original)
    result.setdefault("judge_retry_history", []).append({
        "metric": metric, "original_error": result["errors"].pop(metric),
        "retry_artifact": artifact, "attempt": 1,
    })
    result["scores"][metric] = deepcopy(retry["scores"][metric])
    return result


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def one_file(path: Path, suffix: str) -> Path:
    files = list(path.glob(f"*{suffix}"))
    if len(files) != 1:
        raise ValueError(f"Expected one {suffix} in {path}")
    return files[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("variant", choices=("child_only", "parent_child", "page_static", "agentic"))
    args = parser.parse_args()
    root = args.run.resolve()
    group = root / "groups" / args.variant
    original_path = one_file(group / "judge-r01", ".cases.jsonl")
    originals = read_rows(original_path)
    raw = {r["case_id"]: r for r in read_rows(group / "raw.cases.jsonl")}
    if len(originals) != 12 or len(raw) != 12:
        raise ValueError("Only the completed 12-case smoke is supported")
    jobs = [(r["case_id"], metric) for r in originals for metric in r["errors"]]
    if not jobs:
        raise ValueError("No technical errors to retry")
    retry_root = group / "judge-retry-01"
    retry_root.mkdir(exist_ok=False)
    resolved = deepcopy(originals)
    entries = []
    for index, (case_id, metric) in enumerate(jobs):
        source = retry_root / f"{index:02d}.input.jsonl"
        source.write_text(json.dumps(raw[case_id], ensure_ascii=False) + "\n")
        output = retry_root / f"{index:02d}"
        command = [sys.executable, "-c", "import sys; from anydocs_ragas.cli import main; raise SystemExit(main(sys.argv[1:]))",
                   str(source), "--output-dir", str(output), "--metrics", metric,
                   "--concurrency", "1", "--judge-profile", "audited-v1"]
        result = subprocess.run(command, check=False)
        if result.returncode:
            raise ValueError("One allowed technical retry failed; preserve artifacts and stop")
        retry_path = one_file(output, ".cases.jsonl")
        retry = read_rows(retry_path)
        if len(retry) != 1:
            raise ValueError("Unexpected retry count")
        pos = next(i for i, row in enumerate(resolved) if row["case_id"] == case_id)
        resolved[pos] = merge_retry(resolved[pos], retry[0], metric, str(retry_path))
        entries.append({"case_id": case_id, "metric": metric, "retry_artifact": str(retry_path)})
    from anydocs_ragas.reporting import write_reports
    metadata = json.loads(one_file(group / "judge-r01", ".summary.json").read_text())["metadata"]
    paths = write_reports(group / "judge-r01-resolved", resolved, {**metadata, "technical_retry_count": len(jobs)})
    manifest = {"variant": args.variant, "original": str(original_path),
                "resolved": str(paths["cases"]), "retries": entries,
                "answers_regenerated": False, "successful_scores_replaced": False,
                "published": False}
    (retry_root / "resolution.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
