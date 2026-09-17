import json

from anydocs_ragas.models import (
    EvalSample,
    coverage,
    extract_sample,
    golden_sha256,
    load_trace_records,
    trace_build_metadata,
)


def test_extracts_v2_ragas_sample(tmp_path):
    path = tmp_path / "trace.jsonl"
    record = {
        "schema_version": 2,
        "case_id": "case-1",
        "lang": "zh",
        "ragas_sample": {
            "user_input": "手续费怎么计算？",
            "response": "按文档公式计算。",
            "retrieved_contexts": ["手续费公式"],
            "reference": "手续费按公式计算。",
            "reference_facts": ["使用文档公式"],
            "rubric": {"precision": "Do not invent a rate."},
            "context_source": "prompt_snapshot",
        },
    }
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    sample = extract_sample(load_trace_records(path)[0])
    assert sample.case_id == "case-1"
    assert sample.reference == "手续费按公式计算。"
    assert sample.retrieved_contexts == ["手续费公式"]
    assert coverage([sample])["reference_coverage"] == 1.0


def test_legacy_trace_builds_reference_from_atomic_facts():
    sample = extract_sample(
        {
            "schema_version": 1,
            "case_id": "legacy",
            "query": "How?",
            "lang": "en",
            "expected": {"reference_facts": ["First fact", "Second fact"]},
            "result": {"type": "answer", "answer_md": "Answer"},
            "trace": {
                "input_snapshot": {
                    "documents": [{"text": "Full prompt context"}],
                }
            },
        }
    )
    assert sample.reference == "- First fact\n- Second fact"
    assert sample.context_source == "prompt_snapshot"
    assert sample.retrieved_contexts == ["Full prompt context"]


def test_golden_hash_ignores_release_output_and_case_order():
    first = EvalSample(
        case_id="a",
        user_input="Question A",
        response="Release one answer",
        retrieved_contexts=["Release one context"],
        reference="Reference A",
    )
    second = EvalSample(
        case_id="b",
        user_input="Question B",
        response="Answer B",
        retrieved_contexts=["Context B"],
        reference="Reference B",
    )
    changed_output = EvalSample(
        case_id="a",
        user_input="Question A",
        response="Release two answer",
        retrieved_contexts=["Release two context"],
        reference="Reference A",
    )

    assert golden_sha256([first, second]) == golden_sha256([second, changed_output])
    assert golden_sha256([first]) != golden_sha256([
        EvalSample(
            case_id="a",
            user_input="Question A",
            response=first.response,
            retrieved_contexts=first.retrieved_contexts,
            reference="Changed reference",
        )
    ])


def test_extracts_release_and_engine_from_trace_metadata():
    assert trace_build_metadata([
        {"runtime_build": None},
        {
            "runtime_build": {
                "release": " docs-sha ",
                "engine_release": "ask-sha",
                "built_at": None,
            }
        },
    ]) == {"release": "docs-sha", "engine_release": "ask-sha"}
