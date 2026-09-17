from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
from statistics import mean
from typing import Any


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    values: dict[str, list[float]] = defaultdict(list)
    skipped: dict[str, int] = defaultdict(int)
    errors: dict[str, int] = defaultdict(int)
    for result in results:
        for name, score in result["scores"].items():
            values[name].append(float(score["value"]))
        for name in result["skipped"]:
            skipped[name] += 1
        for name in result["errors"]:
            errors[name] += 1
    metrics = {
        name: {
            "mean": mean(metric_values),
            "n": len(metric_values),
            "skipped": skipped[name],
            "errors": errors[name],
        }
        for name, metric_values in sorted(values.items())
    }
    for name in sorted(set(skipped) | set(errors)):
        metrics.setdefault(
            name,
            {"mean": None, "n": 0, "skipped": skipped[name], "errors": errors[name]},
        )
    return {"case_count": len(results), "metrics": metrics}


def write_reports(
    output_dir: Path,
    results: list[dict[str, Any]],
    metadata: dict[str, Any],
) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stem = f"{timestamp}-ragas"
    jsonl_path = output_dir / f"{stem}.cases.jsonl"
    summary_path = output_dir / f"{stem}.summary.json"
    markdown_path = output_dir / f"{stem}.md"
    summary = {"schema_version": 1, "metadata": metadata, **summarize(results)}

    with jsonl_path.open("w", encoding="utf-8") as handle:
        for result in results:
            handle.write(json.dumps({"schema_version": 1, **metadata, **result}, ensure_ascii=False) + "\n")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(summary, results), encoding="utf-8")
    return {"cases": jsonl_path, "summary": summary_path, "markdown": markdown_path}


def render_markdown(summary: dict[str, Any], results: list[dict[str, Any]]) -> str:
    metadata = summary["metadata"]
    lines = [
        "# Ragas evaluation",
        "",
        f"- Release: `{metadata.get('release') or 'unknown'}`",
        f"- Engine: `{metadata.get('engine') or 'unknown'}`",
        f"- Golden SHA-256: `{metadata['golden_sha256']}`",
        f"- Judge: `{metadata['judge_provider']}/{metadata['judge_model']}`",
        f"- Embeddings: `{metadata['embedding_model']}`",
        f"- Cases: {summary['case_count']}",
        "",
        "| Metric | Mean | Scored | Skipped | Errors |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, metric in summary["metrics"].items():
        value = "-" if metric["mean"] is None else f"{metric['mean']:.3f}"
        lines.append(
            f"| {name} | {value} | {metric['n']} | {metric['skipped']} | {metric['errors']} |"
        )
    failures = [result for result in results if result["errors"]]
    if failures:
        lines.extend(["", f"## Judge errors ({len(failures)})", ""])
        for result in failures:
            detail = "; ".join(f"{name}: {message}" for name, message in result["errors"].items())
            lines.append(f"- `{result['case_id']}`: {detail}")
    lines.append("")
    return "\n".join(lines)
