from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid5


def publish_experiment(
    *,
    samples_by_id: dict[str, dict[str, Any]],
    results: list[dict[str, Any]],
    dataset_base_name: str,
    experiment_name: str,
    metadata: dict[str, Any],
) -> str | None:
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
        return {
            "case_id": case_id,
            "response": sample["response"],
            "retrieved_contexts": sample["retrieved_contexts"],
        }

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
        metadata={
            "release": str(metadata.get("release") or "unknown"),
            "engine": str(metadata.get("engine") or "unknown"),
            "golden_sha256": golden_hash,
            "judge_provider": str(metadata["judge_provider"]),
            "judge_model": str(metadata["judge_model"]),
        },
    )
    langfuse.flush()
    return experiment.dataset_run_url


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
