from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid5
import json


def publish_experiment(
    *,
    samples_by_id: dict[str, dict[str, Any]],
    results: list[dict[str, Any]],
    dataset_base_name: str,
    experiment_name: str,
    metadata: dict[str, Any],
    publish_source_scores: bool = True,
) -> str | None:
    if metadata.get("judge_profile") in {"audited-v2", "audited-v3", "audited-v4"} and publish_source_scores:
        raise ValueError("Rejudging must not overwrite original source scores")
    from langfuse import Langfuse

    golden_hash = str(metadata["golden_sha256"])
    dataset_name = f"{dataset_base_name}@{golden_hash[:12]}"
    langfuse = Langfuse(
        environment="evaluation",
        release=str(metadata.get("release") or "unknown"),
    )
    existing_item_ids = _ensure_dataset(langfuse, dataset_name, golden_hash)
    for case_id, sample in samples_by_id.items():
        item_id = str(uuid5(NAMESPACE_URL, f"{dataset_name}:{case_id}"))
        if item_id in existing_item_ids:
            continue
        langfuse.create_dataset_item(
            dataset_name=dataset_name,
            id=item_id,
            input={
                "case_id": case_id,
                "user_input": sample["user_input"],
            },
            expected_output=sample["reference"],
            metadata={
                "case_id": case_id,
                "lang": sample["lang"],
                "context_source": sample["context_source"],
                "reference_facts": sample["reference_facts"],
                "evaluation_rubric": sample["rubric"],
            },
        )

    results_by_id = {result["case_id"]: result for result in results}

    def task(*, item: Any, **_: Any) -> dict[str, Any]:
        case_id = str(item.input["case_id"])
        sample = samples_by_id[case_id]
        output = _experiment_output(case_id, sample)
        output["evaluation_config"] = {key: metadata[key] for key in (
            "release", "engine", "golden_sha256", "judge_provider", "judge_model",
            "experiment_id", "variant", "context_mode", "repetition", "evaluation_input_sha256",
            "judge_profile", "judge_contract_sha256",
            "judge_fact_rules_sha256", "judge_implementation_sha256", "source_scores_published",
            "metric_profiles", "base_judge_contract_sha256", "fact_judge_contract_sha256",
        ) if key in metadata}
        if sample.get("reference_fact_rules"):
            output["reference_fact_rules"] = sample["reference_fact_rules"]
        if sample.get("reference_fact_direct_apis"):
            output["reference_fact_direct_apis"] = sample["reference_fact_direct_apis"]
        output["judge_errors"] = results_by_id[case_id].get("errors", {})
        return output

    def evaluator(*, input: Any, **_: Any) -> list[Any]:
        result = results_by_id[str(input["case_id"])]
        return _evaluations_for_result(result)

    dataset = langfuse.get_dataset(dataset_name, fetch_items_page_size=100)
    experiment = dataset.run_experiment(
        name=experiment_name,
        run_name=experiment_name,
        description="Offline Ragas scores generated from an anydocs-ask full eval trace.",
        task=task,
        evaluators=[evaluator],
        max_concurrency=4,
        metadata=_propagation_metadata({
            "release": str(metadata.get("release") or "unknown"),
            "engine": str(metadata.get("engine") or "unknown"),
            "golden_sha256": golden_hash,
            "judge_provider": str(metadata["judge_provider"]),
            "judge_model": str(metadata["judge_model"]),
            **{
                name: metadata[name]
                for name in ("experiment_id", "variant", "context_mode", "repetition", "evaluation_input_sha256", "judge_profile")
                if name in metadata
            },
        }),
    )
    if publish_source_scores:
        _publish_source_trace_scores(langfuse, samples_by_id, results)
    langfuse.flush()
    return experiment.dataset_run_url


def _propagation_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    if metadata.get("judge_profile") not in {"audited-v1", "audited-v2", "audited-v3", "audited-v4", "ablation-full-v1"}:
        return metadata
    compact = {key: metadata[key] for key in ("variant", "context_mode", "judge_profile", "evaluation_input_sha256")
               if key in metadata}
    if len(json.dumps(compact)) > 200:
        raise ValueError("Experiment propagation metadata exceeds the SDK limit")
    return compact


def _experiment_output(case_id: str, sample: dict[str, Any]) -> dict[str, Any]:
    return {
        "case_id": case_id,
        "response": sample["response"],
        "retrieved_contexts": sample["retrieved_contexts"],
        "reference_answer": sample.get("reference"),
        "reference_facts": sample.get("reference_facts", []),
        "evaluation_rubric": sample.get("rubric", {}),
        "source_trace_id": sample.get("source_trace_id"),
        "source_observation_id": sample.get("source_observation_id"),
        "agent_diagnostics": sample.get("agent_diagnostics", {}),
    }


def _evaluations_for_result(result: dict[str, Any]) -> list[Any]:
    from langfuse import Evaluation

    return [
        Evaluation(
            name=f"ragas_{name}",
            value=score["value"],
            comment=score.get("reason"),
        )
        for name, score in result["scores"].items()
    ]


def _publish_source_trace_scores(
    langfuse: Any,
    samples_by_id: dict[str, dict[str, Any]],
    results: list[dict[str, Any]],
) -> int:
    published = 0
    for result in results:
        case_id = str(result["case_id"])
        sample = samples_by_id.get(case_id, {})
        trace_id = sample.get("source_trace_id")
        observation_id = sample.get("source_observation_id")
        if not isinstance(trace_id, str) or not trace_id.strip():
            continue
        for name, score in result["scores"].items():
            score_id = str(uuid5(NAMESPACE_URL, f"anydocs-ragas:{trace_id}:{name}"))
            langfuse.create_score(
                score_id=score_id,
                trace_id=trace_id,
                observation_id=observation_id
                if isinstance(observation_id, str) and observation_id.strip()
                else None,
                name=f"ragas_{name}",
                value=float(score["value"]),
                data_type="NUMERIC",
                comment=score.get("reason"),
            )
            published += 1
    return published


def _ensure_dataset(
    langfuse: Any,
    dataset_name: str,
    golden_hash: str,
) -> set[str]:
    from langfuse.api.core.api_error import ApiError

    try:
        dataset = langfuse.get_dataset(dataset_name, fetch_items_page_size=100)
        return {
            str(item.id)
            for item in dataset.items
            if getattr(item, "id", None) is not None
        }
    except ApiError as error:
        if error.status_code != 404:
            raise

    try:
        langfuse.create_dataset(
            name=dataset_name,
            description="Versioned anydocs-ask Golden Set for offline Ragas evaluation.",
            metadata={"golden_sha256": golden_hash},
        )
    except ApiError as error:
        # Another evaluator may have created the same hash-versioned dataset.
        if error.status_code != 409:
            raise
    return set()
