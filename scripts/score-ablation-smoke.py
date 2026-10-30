#!/usr/bin/env python3
"""Score the 48 frozen smoke outputs; calibration repeats never overwrite source scores."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

VARIANTS = ("child_only", "parent_child", "page_static", "agentic")
METRICS = "faithfulness,context_precision,context_recall,reference_fact_recall,factual_correctness,rubric_compliance"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--no-publish", action="store_true")
    parser.add_argument("--calibration-repeats", type=int, default=3, choices=(1, 3))
    parser.add_argument("--judge-profile", choices=("legacy", "audited-v1"), default="audited-v1")
    args = parser.parse_args()
    root = args.run.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("status") != "complete" or manifest.get("completed_attempts") != 48:
        raise ValueError("Judge requires the completed 12-case / four-group smoke run")
    plans = [(variant, 1) for variant in VARIANTS]
    plans += [("agentic", repeat) for repeat in range(2, args.calibration_repeats + 1)]
    results = []
    for variant, repeat in plans:
        trace = root / "groups" / variant / "raw.cases.jsonl"
        records = [json.loads(line) for line in trace.read_text().splitlines() if line.strip()]
        if len(records) != 12 or len({row["case_id"] for row in records}) != 12:
            raise ValueError(f"Expected exactly 12 unique frozen records for {variant}")
        for row in records:
            sample = row["ragas_sample"]
            if not sample.get("reference") or not sample.get("reference_facts") or not sample.get("rubric"):
                raise ValueError("Missing ground truth; stop before judge calls")
            if row["result"]["type"] == "answer" and sample.get("context_source") not in {"prompt_snapshot", "agent_evidence"}:
                raise ValueError("Answer lacks full actual evidence")
            if not row.get("langfuse_trace_id") and not args.no_publish:
                raise ValueError("Source trace missing; refusing unlinked publication")
        output = root / "groups" / variant / f"judge-r{repeat:02d}"
        if output.exists():
            raise ValueError(f"Refusing to overwrite judge run: {output}")
        command = [sys.executable, "-c", "import sys; from anydocs_ragas.cli import main; raise SystemExit(main(sys.argv[1:]))",
                   str(trace), "--output-dir", str(output), "--metrics", METRICS, "--concurrency", "2",
                   "--judge-profile", args.judge_profile]
        if repeat == 1 and not args.no_publish:
            command += ["--langfuse-dataset", "cregis-pc-agent-smoke",
                        "--experiment-name", f"{manifest['experiment_id']}-{variant}-{manifest['context_mode']}-r01"]
        print(f"Judging {variant}, fixed-output judge repetition {repeat}", flush=True)
        result = subprocess.run(command, check=False)
        results.append({"variant": variant, "judge_repetition": repeat, "exit_code": result.returncode,
                        "source_scores_published": repeat == 1 and not args.no_publish})
        (root / "judge-status.json").write_text(json.dumps(results, indent=2) + "\n")
        if result.returncode:
            print("Judge or publication failed; preserving outputs and stopping further automatic calls", file=sys.stderr)
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
