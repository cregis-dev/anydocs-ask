from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
from typing import Any

from . import __version__
from .models import (
    coverage,
    extract_sample,
    file_sha256,
    golden_sha256,
    load_trace_records,
    trace_build_metadata,
)
from .reporting import write_reports
from .scoring import (
    SUPPORTED_METRICS,
    ProviderSettings,
    build_scorers,
    score_samples,
)


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        prog="anydocs-ragas",
        description="Score an anydocs-ask full eval trace with offline Ragas judges.",
    )
    command.add_argument("trace", type=Path, help="Path to *-eval.cases.jsonl")
    command.add_argument("--output-dir", type=Path, default=Path("./ragas-reports"))
    command.add_argument("--metrics", default=",".join(SUPPORTED_METRICS))
    command.add_argument("--limit", type=int)
    command.add_argument("--concurrency", type=int, default=2)
    command.add_argument("--release", default=os.getenv("LANGFUSE_RELEASE"))
    command.add_argument("--engine", default=os.getenv("ANYDOCS_ENGINE_VERSION"))
    command.add_argument("--validate-only", action="store_true")
    command.add_argument("--langfuse-dataset", help="Publish scores to a versioned Langfuse dataset")
    command.add_argument("--experiment-name", help="Langfuse run name; defaults to release + Golden hash")
    command.add_argument("--version", action="version", version=__version__)
    return command


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        records = load_trace_records(args.trace)
        samples = [extract_sample(record) for record in records]
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.limit is not None:
        samples = samples[: max(0, args.limit)]
    coverage_summary = coverage(samples)
    print(json.dumps({"coverage": coverage_summary}, ensure_ascii=False, indent=2))
    if args.validate_only:
        return 0
    if not samples:
        print("error: no evaluation samples found", file=sys.stderr)
        return 2

    try:
        metrics = parse_metrics(args.metrics)
        settings = provider_settings(metrics)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    scorers = build_scorers(settings, metrics)
    results = asyncio.run(score_samples(samples, scorers, args.concurrency))
    golden_hash = golden_sha256(samples)
    trace_build = trace_build_metadata(records)
    release = args.release or trace_build.get("release")
    engine = args.engine or trace_build.get("engine_release")
    metadata = {
        "source_trace": str(args.trace.resolve()),
        "source_trace_sha256": file_sha256(args.trace),
        "golden_sha256": golden_hash,
        "release": release,
        "engine": engine,
        "ragas_runner_version": __version__,
        "judge_provider": settings.judge_provider,
        "judge_model": settings.judge_model,
        "embedding_model": settings.embedding_model,
        "metrics": sorted(metrics),
        "coverage": coverage_summary,
    }
    paths = write_reports(args.output_dir, results, metadata)
    for kind, path in paths.items():
        print(f"{kind}: {path.resolve()}")

    if args.langfuse_dataset:
        from .langfuse import publish_experiment

        sample_payloads = {sample.case_id: asdict(sample) for sample in samples}
        experiment_name = args.experiment_name or (
            f"ragas-{(release or 'unreleased')[:12]}-{golden_hash[:8]}"
        )
        try:
            url = publish_experiment(
                samples_by_id=sample_payloads,
                results=results,
                dataset_base_name=args.langfuse_dataset,
                experiment_name=experiment_name,
                metadata=metadata,
            )
        except Exception as error:
            print(f"error: Langfuse publish failed: {type(error).__name__}: {error}", file=sys.stderr)
            return 1
        if url:
            print(f"langfuse: {url}")

    return 1 if any(result["errors"] for result in results) else 0


def parse_metrics(value: str) -> set[str]:
    metrics = {item.strip() for item in value.split(",") if item.strip()}
    unknown = metrics.difference(SUPPORTED_METRICS)
    if unknown:
        raise ValueError(f"unsupported metrics: {', '.join(sorted(unknown))}")
    if not metrics:
        raise ValueError("at least one metric is required")
    return metrics


def provider_settings(metrics: set[str]) -> ProviderSettings:
    judge_provider = os.getenv("RAGAS_JUDGE_PROVIDER", "openai").strip().lower()
    if judge_provider not in {"openai", "anthropic"}:
        raise ValueError("RAGAS_JUDGE_PROVIDER must be openai or anthropic")

    if judge_provider == "anthropic":
        judge_model = _required_first_env("RAGAS_JUDGE_MODEL", "ANTHROPIC_MODEL")
        judge_api_key = _first_env("RAGAS_JUDGE_API_KEY", "ANTHROPIC_API_KEY")
        judge_auth_token = _first_env("RAGAS_JUDGE_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN")
        judge_base_url = _first_env("RAGAS_JUDGE_BASE_URL", "ANTHROPIC_BASE_URL")
        if judge_api_key is None and judge_auth_token is None:
            raise ValueError(
                "RAGAS_JUDGE_API_KEY/ANTHROPIC_API_KEY or "
                "RAGAS_JUDGE_AUTH_TOKEN/ANTHROPIC_AUTH_TOKEN is required"
            )
    else:
        judge_model = _required_first_env("RAGAS_JUDGE_MODEL")
        judge_api_key = _first_env("RAGAS_JUDGE_API_KEY", "OPENAI_API_KEY")
        judge_auth_token = None
        judge_base_url = _first_env("RAGAS_JUDGE_BASE_URL", "OPENAI_BASE_URL")
        if judge_api_key is None:
            raise ValueError("RAGAS_JUDGE_API_KEY or OPENAI_API_KEY is required")

    embedding_model = os.getenv("RAGAS_EMBEDDING_MODEL", "text-embedding-3-small")
    embedding_api_key = _first_env("RAGAS_EMBEDDING_API_KEY", "OPENAI_API_KEY")
    if "answer_relevancy" in metrics and embedding_api_key is None:
        raise ValueError("RAGAS_EMBEDDING_API_KEY or OPENAI_API_KEY is required for answer_relevancy")
    return ProviderSettings(
        judge_provider=judge_provider,
        judge_model=judge_model,
        judge_api_key=judge_api_key,
        judge_auth_token=judge_auth_token,
        judge_base_url=judge_base_url,
        embedding_model=embedding_model,
        embedding_api_key=embedding_api_key or (judge_api_key if judge_provider == "openai" else None),
        embedding_base_url=_first_env("RAGAS_EMBEDDING_BASE_URL", "OPENAI_BASE_URL"),
        timeout_seconds=float(os.getenv("RAGAS_TIMEOUT_SECONDS", "120")),
        max_tokens=int(os.getenv("RAGAS_MAX_TOKENS", "4096")),
    )


def _required_first_env(*names: str) -> str:
    value = _first_env(*names)
    if value is None:
        raise ValueError(f"{' or '.join(names)} is required")
    return value


def _first_env(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return None


if __name__ == "__main__":
    raise SystemExit(main())
