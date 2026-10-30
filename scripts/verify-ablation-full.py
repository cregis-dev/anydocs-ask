#!/usr/bin/env python3
"""Read-only Langfuse CLI reconciliation against all local full-eval artifacts."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import time

METRICS = ("reference_fact_recall", "rubric_compliance", "faithfulness", "context_recall", "context_precision", "factual_correctness")


def lines(p):
    return [json.loads(s) for s in p.read_text().splitlines() if s.strip()]


def decode(value):
    return json.loads(value) if isinstance(value, str) else value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--reuse-existing-reads", action="store_true",
                        help="Recheck saved source roots and experiment payloads; scores are queried afresh by trace ID")
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(args.env_file, override=True)
    os.environ["LANGFUSE_HOST"] = os.environ["LANGFUSE_BASE_URL"]
    root = args.run.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    records = lines(root / "attempts.jsonl")
    if manifest["status"] != "complete" or len(records) != 1104:
        raise ValueError("All system attempts must be completed before final reconciliation")
    target = root / "langfuse-verification"
    target.mkdir(exist_ok=True)
    start = manifest["started_at"]
    end = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    cli_env = {key: val for key, val in os.environ.items() if key.startswith("LANGFUSE_") or key in {
        "PATH", "HOME", "TMPDIR", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
        "https_proxy", "http_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"}}

    def query(resource, options, name, reusable=False):
        if reusable and args.reuse_existing_reads and (target / name).exists():
            return json.loads((target / name).read_text())["data"]
        for attempt in range(4):
            result = subprocess.run(["npx", "--yes", "langfuse-cli", "api", resource, "list", *options, "--json"],
                                    env=cli_env, capture_output=True, text=True, timeout=300)
            try:
                envelope = json.loads(result.stdout)
            except json.JSONDecodeError:
                raise RuntimeError(f"Langfuse CLI response unavailable for {resource}; exit code {result.returncode}")
            if envelope.get("status") != 429:
                break
            if attempt == 3:
                raise RuntimeError(f"Langfuse read rate limit persisted for {resource}")
            details = envelope.get("body", {}).get("details", {})
            delay = max(60, int(details.get("retryAfterSeconds", 60)) + 1)
            print(f"READ RATE LIMIT: waiting {delay}s before retrying {resource}", flush=True)
            time.sleep(delay)
        if result.returncode:
            raise RuntimeError(f"Langfuse CLI failed for {resource}; exit code {result.returncode}, status {envelope.get('status')}")
        if envelope.get("status") != 200:
            raise RuntimeError(f"Langfuse HTTP status {envelope.get('status')} for {resource}")
        body = envelope["body"]
        (target / name).write_text(json.dumps(body, ensure_ascii=False) + "\n")
        return body["data"]

    roots = query("observations", ["--session-id", manifest["experiment_id"], "--is-root-observation",
        "--from-start-time", start, "--to-start-time", end, "--fields", "core,basic", "--limit", "1000",
        "--all", "--max-items", "2000"], "source-roots.json", reusable=True)
    observed = {r["id"]: r for r in roots}
    missing_roots = [r["langfuse_observation_id"] for r in records
                     if observed.get(r["langfuse_observation_id"], {}).get("traceId") != r["langfuse_trace_id"]]
    names, local_scores, expected_names = [], {}, {}
    for v in manifest["variants"]:
        for rep in range(1, 4):
            part = root / "groups" / v / f"r{rep:02d}" / "judge"
            publication = json.loads((part / "publication.json").read_text())
            names.append(publication["experiment_name"])
            expected_names[(v, rep)] = publication["experiment_name"]
            for result in lines(part / "results.jsonl"):
                local_scores[(v, rep, result["case_id"])] = result
    items = query("experiment-items", ["--experiment-name", ",".join(names), "--from-start-time", start,
        "--to-start-time", end, "--fields", "core,io,scores", "--score-limit", "50", "--limit", "100",
        "--all", "--max-items", "2000"], "experiment-items.json", reusable=True)
    raw_by_source = {r["langfuse_trace_id"]: r for r in records}
    mismatches, seen, score_count = [], set(), 0
    for item in items:
        output = decode(item["output"])
        record = raw_by_source.get(output.get("source_trace_id"))
        if record is None:
            mismatches.append({"kind": "unexpected_source", "item": item["id"]})
            continue
        key = (record["variant"], record["repetition"], record["case_id"])
        if key in seen:
            mismatches.append({"kind": "duplicate_experiment_item", "key": key})
        seen.add(key)
        sample = record["ragas_sample"]
        if item["experimentName"] != expected_names[key[:2]]:
            mismatches.append({"kind": "experiment_name", "key": key})
        if decode(item["input"]) != {"case_id": record["case_id"], "user_input": sample["user_input"]}:
            mismatches.append({"kind": "input", "key": key})
        expected = {"response": sample.get("response"), "retrieved_contexts": sample["retrieved_contexts"],
            "reference_answer": sample["reference"], "reference_facts": sample["reference_facts"],
            "evaluation_rubric": sample["rubric"], "source_observation_id": record["langfuse_observation_id"]}
        for field, val in expected.items():
            if output.get(field) != val:
                mismatches.append({"kind": "payload", "key": key, "field": field})
        scores = {s["name"]: float(s["value"]) for s in item.get("scores", []) if s["name"].startswith("ragas_")}
        local = local_scores[key]
        for metric, score in local["scores"].items():
            name = "ragas_" + metric
            if name not in scores or abs(scores[name] - score["value"]) > 1e-9:
                mismatches.append({"kind": "experiment_score", "key": key, "metric": metric})
            else:
                score_count += 1
        if output.get("judge_errors", {}) != local["errors"]:
            mismatches.append({"kind": "judge_errors", "key": key})
    source_scores = []
    trace_ids = [record["langfuse_trace_id"] for record in records]
    for offset in range(0, len(trace_ids), 50):
        batch = trace_ids[offset:offset + 50]
        source_scores.extend(query("scores", ["--trace-id", ",".join(batch), "--name", ",".join("ragas_" + m for m in METRICS),
            "--from-timestamp", start, "--to-timestamp", end, "--fields", "subject", "--limit", "100", "--all",
            "--max-items", "350"], f"source-scores-traces-{offset // 50 + 1:02d}.json", reusable=True))
        print(f"SOURCE SCORE CHECK {min(offset + 50, len(trace_ids))}/1104 traces", flush=True)
    remote = {(s["subject"].get("traceId", s["subject"]["id"]), s["name"]): s for s in source_scores}
    source_missing, source_matches = [], 0
    for record in records:
        key = (record["variant"], record["repetition"], record["case_id"])
        for metric, score in local_scores[key]["scores"].items():
            got = remote.get((record["langfuse_trace_id"], "ragas_" + metric))
            if got is None or abs(float(got["value"]) - score["value"]) > 1e-9 or got["subject"]["id"] != record["langfuse_observation_id"]:
                source_missing.append({"key": key, "metric": metric})
            else:
                source_matches += 1
    expected_keys = {(r["variant"], r["repetition"], r["case_id"]) for r in records}
    summary = {"verified_at": datetime.now(timezone.utc).isoformat(), "project_id": "cmu2a8k6q00rkad0d5ryxpy3n",
        "source_score_query_scope": "explicit original trace IDs; session filter returned zero in an earlier check",
        "reused_experiment_reads": args.reuse_existing_reads,
        "experiment_snapshot_saved_at": datetime.fromtimestamp((target / "experiment-items.json").stat().st_mtime, timezone.utc).isoformat(),
        "planned_source_traces": 1104, "source_root_matches": 1104 - len(missing_roots), "missing_source_roots": missing_roots,
        "planned_experiments": 12, "remote_experiment_names": sorted({r["experimentName"] for r in items}),
        "remote_items": len(items), "missing_item_keys": sorted(expected_keys - seen),
        "experiment_scores_matched": score_count, "source_scores_matched": source_matches,
        "expected_valid_scores": sum(len(r["scores"]) for r in local_scores.values()),
        "payload_or_score_mismatches": mismatches, "missing_or_mismatched_source_scores": source_missing}
    summary["passed"] = (not missing_roots and not mismatches and not source_missing and seen == expected_keys
                         and len(items) == 1104 and {r["experimentName"] for r in items} == set(names) and len(set(names)) == 12)
    (root / "langfuse-verification.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if not isinstance(v, list)}, ensure_ascii=False, indent=2))
    if not summary["passed"]:
        raise SystemExit(1)

if __name__ == "__main__":
    main()
