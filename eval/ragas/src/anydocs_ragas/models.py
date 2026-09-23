from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
import json
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class EvalSample:
    case_id: str
    user_input: str
    response: str | None
    retrieved_contexts: list[str]
    reference: str | None
    reference_facts: list[str] = field(default_factory=list)
    rubric: dict[str, str] = field(default_factory=dict)
    context_source: str = "none"
    lang: str = "unknown"


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def golden_sha256(samples: list[EvalSample]) -> str:
    """Fingerprint stable Golden inputs, independent of a release's RAG output."""
    payload = [
        {
            "case_id": sample.case_id,
            "user_input": sample.user_input,
            "reference": sample.reference,
            "reference_facts": sample.reference_facts,
            "rubric": sample.rubric,
            "lang": sample.lang,
        }
        for sample in sorted(samples, key=lambda item: item.case_id)
    ]
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256(encoded).hexdigest()


def load_trace_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSON on line {line_number}: {error.msg}") from error
            if not isinstance(value, dict):
                raise ValueError(f"line {line_number} must contain a JSON object")
            records.append(value)
    return records


def trace_build_metadata(records: list[dict[str, Any]]) -> dict[str, str]:
    for record in records:
        build = record.get("runtime_build")
        if not isinstance(build, dict):
            continue
        metadata = {
            key: value.strip()
            for key in ("release", "engine_release", "built_at", "release_url")
            if isinstance((value := build.get(key)), str) and value.strip()
        }
        if metadata:
            return metadata
    return {}


def extract_sample(record: dict[str, Any]) -> EvalSample:
    raw = record.get("ragas_sample")
    if isinstance(raw, dict):
        contexts = _string_list(raw.get("retrieved_contexts"))
        facts = _string_list(raw.get("reference_facts"))
        context_source = _optional_string(raw.get("context_source")) or "none"
        trace = record.get("trace")
        if (
            context_source == "trace_preview"
            and isinstance(trace, dict)
            and isinstance(trace.get("agent"), dict)
            and contexts
        ):
            # Agent selected_context contains the complete readDoc evidence
            # sent to generation, not a truncated diagnostic preview.
            context_source = "agent_evidence"
        return EvalSample(
            case_id=_required_string(record.get("case_id"), "case_id"),
            user_input=_required_string(raw.get("user_input"), "ragas_sample.user_input"),
            response=_optional_string(raw.get("response")),
            retrieved_contexts=contexts,
            reference=_optional_string(raw.get("reference")),
            reference_facts=facts,
            rubric=_string_dict(raw.get("rubric")),
            context_source=context_source,
            lang=_optional_string(record.get("lang")) or "unknown",
        )

    return _extract_legacy_sample(record)


def _extract_legacy_sample(record: dict[str, Any]) -> EvalSample:
    expected = record.get("expected") if isinstance(record.get("expected"), dict) else {}
    result = record.get("result") if isinstance(record.get("result"), dict) else {}
    trace = record.get("trace") if isinstance(record.get("trace"), dict) else {}
    snapshot = trace.get("input_snapshot") if isinstance(trace.get("input_snapshot"), dict) else {}
    documents = snapshot.get("documents") if isinstance(snapshot.get("documents"), list) else []
    contexts = [
        text
        for document in documents
        if isinstance(document, dict)
        if (text := _optional_string(document.get("text"))) is not None
    ]
    source = "prompt_snapshot" if contexts else "none"
    if not contexts:
        diagnostics = record.get("diagnostics") if isinstance(record.get("diagnostics"), dict) else {}
        prompt_context = diagnostics.get("prompt_context")
        prompt_context = prompt_context if isinstance(prompt_context, list) else []
        contexts = [
            text
            for chunk in prompt_context
            if isinstance(chunk, dict)
            if (text := _optional_string(chunk.get("text_preview"))) is not None
        ]
        if contexts:
            source = "trace_preview"

    facts = _string_list(expected.get("reference_facts"))
    reference = _optional_string(expected.get("reference_answer"))
    if reference is None and facts:
        reference = "\n".join(f"- {fact}" for fact in facts)
    response = _optional_string(result.get("answer_md")) if result.get("type") == "answer" else None

    return EvalSample(
        case_id=_required_string(record.get("case_id"), "case_id"),
        user_input=_required_string(record.get("query"), "query"),
        response=response,
        retrieved_contexts=contexts,
        reference=reference,
        reference_facts=facts,
        rubric=_string_dict(expected.get("evaluation_rubric")),
        context_source=source,
        lang=_optional_string(record.get("lang")) or "unknown",
    )


def coverage(samples: list[EvalSample]) -> dict[str, int | float]:
    total = len(samples)
    full_context = sum(
        sample.context_source in {"prompt_snapshot", "agent_evidence"}
        for sample in samples
    )
    references = sum(sample.reference is not None for sample in samples)
    answers = sum(sample.response is not None for sample in samples)
    rubrics = sum(bool(sample.rubric) for sample in samples)
    return {
        "total": total,
        "answer_count": answers,
        "full_context_count": full_context,
        "reference_count": references,
        "rubric_count": rubrics,
        "reference_coverage": references / total if total else 0.0,
        "full_context_coverage": full_context / total if total else 0.0,
    }


def _required_string(value: Any, field_name: str) -> str:
    text = _optional_string(value)
    if text is None:
        raise ValueError(f"{field_name} must be a non-empty string")
    return text


def _optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := _optional_string(item)) is not None]


def _string_dict(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): text
        for key, item in value.items()
        if (text := _optional_string(item)) is not None
    }
