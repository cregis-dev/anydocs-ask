#!/usr/bin/env python3
"""Rejudge RFR on the frozen 12x4 smoke outputs; never run the answer system."""

from datetime import datetime, timezone
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

from anydocs_ragas.evidence_judge import contract_metadata
from anydocs_ragas.fact_rules import apply_fact_rules
from anydocs_ragas.models import extract_sample, file_sha256, golden_sha256, load_trace_records

VARIANTS = ("child_only", "parent_child", "page_static", "agentic")


def one_file(directory: Path, suffix: str) -> Path:
    files = list(directory.glob(f"*{suffix}"))
    if len(files) != 1:
        raise ValueError(f"Expected one {suffix} in {directory}")
    return files[0]


def validate_source(source: Path, rules: Path):
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest.get("status") != "complete" or manifest.get("completed_attempts") != 48:
        raise ValueError("Only the completed 48-attempt smoke is supported")
    hashes, ids, golden = {}, None, None
    for variant in VARIANTS:
        trace = source / "groups" / variant / "raw.cases.jsonl"
        records = load_trace_records(trace)
        current_ids = {r["case_id"] for r in records}
        if len(records) != 12 or len(current_ids) != 12 or (ids is not None and ids != current_ids):
            raise ValueError("Expected the same 12 unique cases in every group")
        ids = current_ids
        metadata = json.loads(one_file(source / "groups" / variant / "judge-r01", ".summary.json").read_text())["metadata"]
        if file_sha256(trace) != metadata["source_trace_sha256"]:
            raise ValueError("Frozen outputs changed after the original scoring")
        samples = apply_fact_rules([extract_sample(r) for r in records], rules)
        current_golden = golden_sha256(samples)
        if golden is not None and golden != current_golden:
            raise ValueError("Groups do not share identical Golden inputs")
        golden = current_golden
        hashes[variant] = file_sha256(trace)
    return manifest, hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("rules", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--controls", type=Path, required=True)
    parser.add_argument("--no-publish", action="store_true")
    args = parser.parse_args()
    source, rules, output = args.source.resolve(), args.rules.resolve(), args.output.resolve()
    old_manifest, hashes = validate_source(source, rules)
    controls = json.loads(args.controls.read_text())
    contract = contract_metadata()
    if (controls.get("passed") != controls.get("total") or controls.get("total", 0) < 7
            or controls.get("judge_contract_sha256") != contract["judge_contract_sha256"]
            or controls.get("judge_implementation_sha256") != contract["judge_implementation_sha256"]):
        raise ValueError("Matching targeted controls must pass before rejudging")
    output.mkdir(exist_ok=False)
    (output / "frozen").mkdir()
    for variant in VARIANTS:
        shutil.copyfile(source / "groups" / variant / "raw.cases.jsonl", output / "frozen" / f"{variant}.jsonl")
    shutil.copyfile(rules, output / "fact-rules.json")
    shutil.copyfile(args.controls, output / "judge-controls.json")
    engine = Path(__file__).resolve().parents[1]
    files = ["eval/ragas/src/anydocs_ragas/" + name + ".py" for name in
             ("evidence_judge", "fact_rules", "models", "scoring", "cli", "langfuse")]
    files += ["scripts/rejudge-ablation-smoke.py", "scripts/report-evidence-rejudge.py", "scripts/check-evidence-judge.py"]
    for file in files:
        target = output / "source-archive" / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(engine / file, target)
    session = "pc-agent-rejudge-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    manifest = {"schema_version": 1, "rejudge_id": session, "source": str(source),
                "source_experiment_id": old_manifest["experiment_id"], "source_raw_sha256": hashes,
                "evaluation_input_sha256": old_manifest["evaluation_input_sha256"],
                "rule_sha256": file_sha256(rules), **contract,
                "metrics_recomputed": ["reference_fact_recall"], "answer_generation_calls": 0,
                "golden_text_changed": False, "source_scores_published": False,
                "judge_model": "deepseek-v4-pro", "concurrency": 2,
                "independent_business_review": "pending", "planned_first_scores": 48,
                "planned_agent_judge_repetitions": 3,
                "source_files": {f: file_sha256(engine / f) for f in files}, "status": "running"}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    statuses = []
    for variant, repeat in [(v, 1) for v in VARIANTS] + [("agentic", 2), ("agentic", 3)]:
        destination = output / "groups" / variant / f"judge-r{repeat:02d}"
        command = [sys.executable, "-c", "import sys; from anydocs_ragas.cli import main; raise SystemExit(main(sys.argv[1:]))",
                   str(output / "frozen" / f"{variant}.jsonl"), "--output-dir", str(destination),
                   "--judge-profile", "audited-v2", "--fact-rules", str(output / "fact-rules.json"),
                   "--metrics", "reference_fact_recall", "--concurrency", "2", "--no-source-scores"]
        publish = repeat == 1 and not args.no_publish
        if publish:
            command += ["--langfuse-dataset", "cregis-pc-agent-smoke",
                        "--experiment-name", f"{session}-{variant}-r01"]
        print(f"Rejudging {variant} repetition {repeat}; answer generation disabled", flush=True)
        result = subprocess.run(command, check=False)
        statuses.append({"variant": variant, "repeat": repeat, "exit_code": result.returncode,
                         "experiment_published": publish, "source_scores_published": False})
        (output / "judge-status.json").write_text(json.dumps(statuses, indent=2) + "\n")
        if result.returncode:
            manifest["status"] = "judge_or_publication_error"
            (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            return result.returncode
    if any(file_sha256(source / "groups" / v / "raw.cases.jsonl") != digest for v, digest in hashes.items()):
        raise ValueError("Original outputs changed during judging")
    manifest["status"] = "complete"
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
