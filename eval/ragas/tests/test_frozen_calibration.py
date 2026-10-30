import importlib.util
import json
from pathlib import Path

import pytest

from anydocs_ragas.models import extract_sample, file_sha256, golden_sha256


def calibration_module():
    path = Path(__file__).resolve().parents[3] / "scripts/calibrate-frozen-agent-judge.py"
    spec = importlib.util.spec_from_file_location("frozen_calibration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture_files(tmp_path, count=12):
    source = tmp_path / "source"
    (source / "frozen").mkdir(parents=True)
    rows = [{"case_id": str(i), "ragas_sample": {"user_input": "q", "response": "a", "reference": "ref",
             "reference_facts": [f"f{j}" for j in range(5 if i < 2 else 4)], "retrieved_contexts": ["evidence"]}}
            for i in range(count)]
    trace = source / "frozen/agentic.jsonl"
    trace.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    digest = file_sha256(trace)
    golden = golden_sha256([extract_sample(r) for r in rows])
    (source / "manifest.json").write_text(json.dumps({"status": "complete", "judge_profile": "audited-v2",
                                                     "source_raw_sha256": {"agentic": digest}}))
    (source / "fact-rules.json").write_text(json.dumps({"schema_version": 1, "base_golden_sha256": golden, "cases": {}}))
    selection, boundary = tmp_path / "selection.json", tmp_path / "boundary.json"
    selection.write_text(json.dumps({"cases": [{"id": r["case_id"]} for r in rows]}))
    boundary.write_text(json.dumps({"source_agent_trace_sha256": digest, "base_golden_sha256": golden,
                                   "cases": {"0": {"expected_fact_verdicts": [1] * 5}}}))
    return source, selection, boundary


def test_bounded_calibration_accepts_only_frozen_twelve_and_fifty_facts(tmp_path):
    module = calibration_module()
    rows, samples, _ = module.validate_source(*fixture_files(tmp_path))
    assert len(rows) == len(samples) == 12
    assert sum(len(sample.reference_facts) for sample in samples) == 50


@pytest.mark.parametrize("count", [11, 13, 92])
def test_bounded_calibration_rejects_different_case_counts(tmp_path, count):
    module = calibration_module()
    with pytest.raises(ValueError, match="exact selected twelve"):
        module.validate_source(*fixture_files(tmp_path, count))


def test_bounded_calibration_rejects_modified_frozen_answers(tmp_path):
    module = calibration_module()
    source, selection, boundary = fixture_files(tmp_path)
    trace = source / "frozen/agentic.jsonl"
    trace.write_text(trace.read_text().replace('"a"', '"different answer"'))
    with pytest.raises(ValueError, match="outputs changed"):
        module.validate_source(source, selection, boundary)


def test_development_boundary_rejects_boolean_labels(tmp_path):
    module = calibration_module()
    source, selection, boundary = fixture_files(tmp_path)
    data = json.loads(boundary.read_text())
    data["cases"]["0"]["expected_fact_verdicts"][0] = True
    boundary.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="boundary labels"):
        module.validate_source(source, selection, boundary)
