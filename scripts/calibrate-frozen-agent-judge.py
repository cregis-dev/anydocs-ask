#!/usr/bin/env python3
"""Calibrate an opt-in RFR profile on twelve frozen Agent outputs, never generate."""

import argparse
import asyncio
from datetime import datetime, timezone
import importlib.metadata
import json
from pathlib import Path
import shutil
from statistics import mean
import subprocess
import sys

from anydocs_ragas.calibrated_judge import contract_metadata as v3_contract
from anydocs_ragas.cli import provider_settings
from anydocs_ragas.evidence_judge import evidence_units
from anydocs_ragas.fact_rules import apply_fact_rules
from anydocs_ragas.models import extract_sample, file_sha256, golden_sha256, load_trace_records
from anydocs_ragas.scoring import build_scorers


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def contract_metadata(profile="audited-v3"):
    if profile == "audited-v3":
        return v3_contract()
    if profile == "audited-v4":
        from anydocs_ragas.source_scoped_judge import contract_metadata as scoped_contract
        return scoped_contract()
    raise ValueError("Only development RFR profiles v3/v4 are supported")


def validate_source(source, selection, boundaries, *, rules=None, profile="audited-v3"):
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest.get("status") != "complete" or manifest.get("judge_profile") != "audited-v2":
        raise ValueError("A completed frozen v2 rejudgment is required")
    trace = source / "frozen/agentic.jsonl"
    boundary = json.loads(boundaries.read_text())
    if (file_sha256(trace) != manifest["source_raw_sha256"]["agentic"]
            or file_sha256(trace) != boundary["source_agent_trace_sha256"]):
        raise ValueError("Frozen Agent outputs changed")
    rows = load_trace_records(trace)
    selected_ids = {row["id"] for row in json.loads(selection.read_text())["cases"]}
    if (len(rows) != 12 or len(selected_ids) != 12
            or {row["case_id"] for row in rows} != selected_ids):
        raise ValueError("Only the exact selected twelve cases are supported")
    samples = apply_fact_rules([extract_sample(row) for row in rows], rules or source / "fact-rules.json",
                               allow_direct_api=profile == "audited-v4")
    if (golden_sha256(samples) != boundary["base_golden_sha256"]
            or sum(len(s.reference_facts) for s in samples) != 50):
        raise ValueError("Frozen Golden text or fifty-fact denominator changed")
    for case_id, item in boundary["cases"].items():
        sample = next(s for s in samples if s.case_id == case_id)
        if (len(item["expected_fact_verdicts"]) != len(sample.reference_facts)
                or any(type(v) is not int or v not in (0, 1) for v in item["expected_fact_verdicts"])):
            raise ValueError("Invalid development boundary labels")
    return rows, samples, boundary


def development_controls(source, samples, boundary, profile="audited-v3"):
    by_id = {sample.case_id: sample for sample in samples}
    balance = by_id["cregis-waas-zh-sub-address-balance-query"]
    batch = by_id["cregis-waas-en-batch-address-create"]
    collection = by_id["cregis-waas-en-collection-single-source"]
    v2_sample = next(extract_sample(row) for row in load_trace_records(source / "frozen/page_static.jsonl")
                     if row["case_id"] == balance.case_id)
    v2_context = [c for c in v2_sample.retrieved_contexts if c.startswith("Page: POST /api/v2/sub_address_balance")]
    if len(v2_context) != 1:
        raise ValueError("Missing frozen v2 balance control")
    fact = balance.reference_facts[0]
    options = balance.reference_fact_rules[fact]
    controls = [
        ("v1_only_any_of", "Check balance evidence", fact, balance.retrieved_contexts, options, 1),
        ("v2_only_any_of", "Check balance evidence", fact, v2_context, options, 1),
        ("other_product_any_of", "Check balance evidence", fact,
         ["POST /openapi/v1/wallet_balance queries a Team API wallet balance."], options, 0),
        ("batch_endpoint_unicode_provenance", batch.user_input, batch.reference_facts[0], batch.retrieved_contexts, None, 1),
        ("version_specific_fact", balance.user_input, options[0], v2_context, None, 0),
        ("partial_conjunction", "Check both required fields", "Both currency and amount are required request fields.",
         ["Request fields:\n- currency: string, required."], None, 0),
        ("undefined_collection_field", collection.user_input, "Every /api/v1/collection request requires third_party_id.",
         collection.retrieved_contexts, None, 0),
    ]
    for case_id, item in boundary["cases"].items():
        sample = by_id[case_id]
        for index in item["changed_fact_index"]:
            fact = sample.reference_facts[index]
            control = (f"frozen_{case_id}_f{index + 1}", sample.user_input, fact,
                       sample.retrieved_contexts, None, item["expected_fact_verdicts"][index])
            if fact in sample.reference_fact_direct_apis:
                control += (sample.reference_fact_direct_apis[fact],)
            controls.append(control)
    webhook = by_id["cregis-webhook-en-public-callback-url"]
    public = ["Preparation: CALLBACK_URL: publicly reachable webhook URL."]
    controls += [
        ("explicit_public_requirement", webhook.user_input, webhook.reference_facts[0], public, None, 1),
        ("public_requirement_implies_not_direct_localhost", webhook.user_input, webhook.reference_facts[1], public, None, 1),
        ("unlisted_specific_error_mapping", "支付引擎 A0403 具体哪个参数错误？",
         "A0403 明确表示 order_amount 参数错误。", ["错误码表：Axxxx | Param Error | 参数错误 | 请联系客服。"], None, 0),
        ("dedicated_operation_does_not_exclude_another", "How to choose an operation?",
         "POST /payments/v1/send cannot select a source account.",
         ["POST /accounts/v1/withdraw has a required source_account field."], None, 0),
        ("explicit_operation_restriction", "How to choose an operation?",
         "POST /payments/v1/send cannot select a source account.",
         ["POST /payments/v1/send uses only the configured default wallet and does not accept a source account selector."], None, 1),
        ("format_does_not_prove_discovery_source", balance.user_input,
         "具体币种标识可从支持币种文档获取。", balance.retrieved_contexts, None, 0),
        ("target_network_semantic_equivalence", batch.user_input, batch.reference_facts[1], batch.retrieved_contexts, None, 1),
    ]
    if profile == "audited-v4":
        withdrawal = by_id["cregis-waas-en-sub-address-withdrawal-fields"]
        fact = withdrawal.reference_facts[4]
        operation = withdrawal.reference_fact_direct_apis[fact]
        static_withdrawal = next(extract_sample(row) for row in load_trace_records(source / "frozen/page_static.jsonl")
                                 if row["case_id"] == withdrawal.case_id)
        direct = [c for c in static_withdrawal.retrieved_contexts if c.startswith("Page: POST /api/v1/payout ")]
        if len(direct) != 1:
            raise ValueError("Missing frozen direct-v1 positive control")
        header = f"Page: {operation} — Payout\n\nSection: Endpoint\n\nCode (http):\n{operation}"
        prefix = header.replace("/api/v1/payout", "/api/v1/payout/query") + "\n\nSection: Description\n\nQuery the payout status."
        controls += [
            ("strict_direct_v1_positive", withdrawal.user_input, fact, direct, None, 1, operation),
            ("strict_other_version_only", withdrawal.user_input, fact, withdrawal.retrieved_contexts[1:], None, 0, operation),
            ("strict_body_mention_only", withdrawal.user_input, fact,
             ["This other document mentions POST /api/v1/payout and its default wallet."], None, 0, operation),
            ("strict_endpoint_header_only", withdrawal.user_input, fact, [header], None, 0, operation),
            ("strict_path_prefix_is_not_target", withdrawal.user_input, fact, [prefix], None, 0, operation),
            ("strict_source_presence_not_semantic_proof", withdrawal.user_input, fact,
             [header + "\n\nSection: Description\n\nThe response returns a status code and message; no source wallet rule is specified here."],
             None, 0, operation),
        ]
    return controls


async def run_controls(controls, output, profile="audited-v3"):
    scorer = build_scorers(provider_settings({"reference_fact_recall"}), {"reference_fact_recall"},
                          profile=profile).reference_fact_recall
    results, semaphore = [], asyncio.Semaphore(2)

    async def one(control, repeat):
        name, question, fact, contexts, alternatives, expected = control[:6]
        requirement = {"required_api_operation": control[6]} if len(control) == 7 else {}
        row = {"name": name, "repeat": repeat, "expected": expected}
        async with semaphore:
            try:
                # Expected labels are deliberately not passed into the Judge call.
                result = await scorer.ascore(user_input=question, reference=fact,
                                             retrieved_contexts=contexts, alternatives=alternatives, **requirement)
                row.update(actual=result.value, passed=result.value == expected, audit=json.loads(result.reason))
            except Exception as error:
                row.update(passed=False, error_type=type(error).__name__, error=str(error))
            results.append(row)
            save(output / "controls-progress.json", {"completed": len(results), "planned": len(controls) * 3})
            print(f"control {len(results)}/{len(controls) * 3}: {name} r{repeat} {'pass' if row['passed'] else 'FAIL'}", flush=True)
        return row

    rows = await asyncio.gather(*(one(control, repeat) for repeat in (1, 2, 3) for control in controls))
    result = {**contract_metadata(profile), "review_status": "development controls, not held-out human accuracy",
              "repetitions": 3, "controls_per_repeat": len(controls), "total": len(rows),
              "passed": sum(row["passed"] for row in rows), "technical_errors": sum("error" in row for row in rows),
              "answer_generation_calls": 0, "controls": rows}
    result["deterministic_only_verdicts"] = sum(not r.get("audit", {}).get("calls", [None]) for r in rows if "error" not in r)
    result["scorer_branch_calls"] = sum(len(r.get("audit", {}).get("calls", [])) for r in rows)
    save(output / "judge-controls.json", result)
    return result


def audit_result(row, sample, profile="audited-v3"):
    score = row["scores"].get("reference_fact_recall")
    if score is None:
        return None
    facts = json.loads(score["reason"])
    if [f["fact"] for f in facts] != sample.reference_facts:
        raise ValueError("Frozen facts changed in score output")
    inventory = {unit.id: vars(unit) for unit in evidence_units(sample.retrieved_contexts)}
    values = []
    for fact in facts:
        audit = json.loads(fact["reason"])
        if audit["profile"] != profile:
            raise ValueError("Unexpected Judge profile")
        expected_branches = sample.reference_fact_rules.get(fact["fact"], [fact["fact"]])
        if [branch["reference_branch"] for branch in audit["branches"]] != expected_branches:
            raise ValueError("Fact branches changed")
        if audit["value"] != max(b["verdict"] for b in audit["branches"]) or fact["value"] != audit["value"]:
            raise ValueError("Invalid branch aggregation")
        if profile == "audited-v4":
            from anydocs_ragas.source_scoped_judge import direct_api_unit_ids
            operation = sample.reference_fact_direct_apis.get(fact["fact"])
            required = {"require_direct_api": operation} if operation else None
            if audit["source_requirement"] != required:
                raise ValueError("Direct API requirement changed")
            eligible = direct_api_unit_ids(sample.retrieved_contexts, operation) if operation else []
            if audit["eligible_direct_evidence_ids"] != eligible:
                raise ValueError("Direct source inventory changed")
            if any(b["verdict"] and operation and not set(b["evidence_ids"]).intersection(eligible)
                   for b in audit["branches"]):
                raise ValueError("Positive branch lacks required direct evidence")
        for branch in audit["branches"]:
            if branch["verdict"] and not branch["evidence"]:
                raise ValueError("Positive verdict missing evidence")
            if any(unit != inventory.get(unit["id"]) for unit in branch["evidence"]):
                raise ValueError("Evidence differs from frozen source")
        values.append(fact["value"])
    if abs(mean(values) - score["value"]) > 1e-12:
        raise ValueError("Fact denominator changed")
    return values


def write_analysis(output, samples, boundary, rounds, manifest):
    profile = manifest["judge_profile"]
    cases, disagreements = [], []
    for sample in samples:
        vectors = [audit_result(run[sample.case_id], sample, profile) for run in rounds]
        values = [mean(vector) if vector is not None else None for vector in vectors]
        item = {"case_id": sample.case_id, "values": values, "fact_verdicts": vectors,
                "errors": [run[sample.case_id]["errors"] for run in rounds]}
        complete = all(vector is not None for vector in vectors)
        item["changed_fact_indexes"] = ([i for i in range(len(sample.reference_facts))
                                         if len({vector[i] for vector in vectors}) > 1] if complete else None)
        item["case_score_changed"] = len(set(values)) > 1 if complete else None
        if expected := boundary["cases"].get(sample.case_id):
            item["proposed_expected_fact_verdicts"] = expected["expected_fact_verdicts"]
            item["agrees_with_development_boundary"] = all(v == expected["expected_fact_verdicts"] for v in vectors)
            if not item["agrees_with_development_boundary"]:
                disagreements.append(sample.case_id)
        cases.append(item)
    complete = [case for case in cases if all(v is not None for v in case["values"])]
    means = [mean(c["values"][r] for c in complete) for r in range(len(rounds))] if complete else []
    analysis = {"judge_profile": profile, "rounds": len(rounds), "common_valid_cases": len(complete),
                "macro_means": means, "changed_case_scores": sum(c["case_score_changed"] for c in complete),
                "changed_fact_units": sum(len(c["changed_fact_indexes"]) for c in complete),
                "technical_errors": sum(bool(errors) for case in cases for errors in case["errors"]),
                "development_boundary_disagreements": disagreements, "cases": cases,
                "answer_generation_calls": 0, "golden_text_changed": False,
                "interpretation": "Judge development calibration on frozen outputs; not a system gain or held-out accuracy"}
    audits = [json.loads(fact["reason"]) for run in rounds for sample in samples
              if (score := run[sample.case_id]["scores"].get("reference_fact_recall"))
              for fact in json.loads(score["reason"])]
    analysis["scorer_branch_calls"] = sum(len(audit["calls"]) for audit in audits)
    analysis["deterministic_only_fact_verdicts"] = sum(not audit["calls"] for audit in audits)
    save(output / "analysis.json", analysis)
    lines = [f"# 固定 Agent 输出的 {profile} 校准", "",
             "只重评 12 条冻结 Agentic 输出的 RFR；50 个金标事实、问题、回答和上下文均未修改。没有调用回答模型，也没有运行全量。",
             "边界标签为仓库证据辅助推导的开发裁决，尚未经过独立人工确认；控制项与本轮样本都不是留出测试集。", "",
             f"- 三轮共同有效题数：{len(complete)}/12。",
             f"- 三轮宏平均：{' / '.join(f'{v:.6f}' for v in means)}。",
             f"- 分数变化题数：{analysis['changed_case_scores']}/12；发生变化的事实单元：{analysis['changed_fact_units']}/50。",
             f"- 技术错误：{analysis['technical_errors']}；三题开发裁决不一致：{', '.join(disagreements) or '无'}。", "",
             "| Case | 第一次 | 第二次 | 第三次 | 波动事实序号（从 1 起） |", "|---|---:|---:|---:|---|"]
    for case in cases:
        values = ["error" if value is None else f"{value:.3f}" for value in case["values"]]
        indexes = case["changed_fact_indexes"]
        changed = "technical error" if indexes is None else ", ".join(str(i + 1) for i in indexes) or "无"
        lines.append(f"| {case['case_id']} | {' | '.join(values)} | {changed} |")
    lines += ["", "## 解释边界", "",
              "- 这是 Judge 合同变化，不是检索或 Agent 质量提升；不得直接将跨版本分差写成系统增益。",
              "- 所有重复均保留；不选最高分，不缓存语义判断，不重试至通过。技术错误不计为 0。",
              "- 证据 ID、原文和偏移验证仍只证明出处，不能机械证明语义蕴含。",
              "- 旧评分/源 Trace 不覆盖；其他五项语义指标未重评；线上系统、索引和 Golden 均未修改。",
              "- 即便本轮完全一致，也只支持这批开发样本的重复性，不证明一般稳定性。"]
    if profile == "audited-v4":
        lines += ["", "- v4 对一条版本排除事实增加直接 API 出处要求；缺少来源时由规则判 0，不是 LLM 语义能力提升。",
                  f"- 本轮规则直接判定的事实次数：{analysis['deterministic_only_fact_verdicts']}；scorer 分支模型调用：{analysis['scorer_branch_calls']}。"]
    (output / "report.zh.md").write_text("\n".join(lines) + "\n")
    manifest["analysis"] = {k: v for k, v in analysis.items() if k != "cases"}
    return analysis


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("selection", type=Path)
    parser.add_argument("boundaries", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--judge-profile", choices=("audited-v3", "audited-v4"), default="audited-v3")
    parser.add_argument("--fact-rules", type=Path)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if args.judge_profile == "audited-v4" and args.fact_rules is None:
        raise ValueError("V4 calibration requires an explicit source-requirement rules file")
    rules = args.fact_rules or source / "fact-rules.json"
    rows, samples, boundary = validate_source(source, args.selection, args.boundaries,
                                              rules=rules, profile=args.judge_profile)
    controls = development_controls(source, samples, boundary, args.judge_profile)
    settings = provider_settings({"reference_fact_recall"})
    if settings.judge_model != "deepseek-v4-pro":
        raise ValueError("This bounded calibration requires the frozen deepseek-v4-pro Judge model")
    output.mkdir(exist_ok=False)
    for original, name in [(source / "frozen/agentic.jsonl", "agentic.jsonl"),
                           (rules, "fact-rules.json"),
                           (args.selection, "selection.json"), (args.boundaries, "boundaries.json")]:
        shutil.copyfile(original, output / name)
    engine = Path(__file__).resolve().parents[1]
    files = ["eval/ragas/src/anydocs_ragas/" + name + ".py" for name in
             ("audited", "calibrated_judge", "source_scoped_judge", "evidence_judge", "fact_rules", "models", "scoring", "cli", "langfuse")]
    files += ["scripts/calibrate-frozen-agent-judge.py"]
    for name in files:
        target = output / "source-archive" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(engine / name, target)
    manifest = {**contract_metadata(args.judge_profile), "status": "running_controls", "source": str(source),
                "run_id": "pc-agent-judge-" + args.judge_profile.removeprefix("audited-") + "-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                "source_trace_sha256": file_sha256(output / "agentic.jsonl"),
                "golden_sha256": golden_sha256(samples), "fact_count": 50, "cases": 12,
                "answer_generation_calls": 0, "golden_text_changed": False, "system_changed": False,
                "source_scores_published": False, "source_files": {f: file_sha256(engine / f) for f in files},
                "boundary_sha256": file_sha256(args.boundaries), "fact_rules_sha256": file_sha256(output / "fact-rules.json"),
                "model": settings.judge_model, "provider": settings.judge_provider,
                "temperature": 0, "concurrency": 2, "max_tokens": settings.max_tokens,
                "timeout_seconds": settings.timeout_seconds, "extra_body": settings.judge_extra_body,
                "packages": {name: importlib.metadata.version(name) for name in ("ragas", "anthropic", "langfuse")},
                "planned_controls": len(controls) * 3, "planned_case_scores": 36,
                "review_status": boundary["review_status"]}
    save(output / "manifest.json", manifest)
    controls_result = asyncio.run(run_controls(controls, output, args.judge_profile))
    if controls_result["passed"] != controls_result["total"]:
        manifest["status"] = "development_control_failed"
        save(output / "manifest.json", manifest)
        failures = [f"- {r['name']} r{r['repeat']}: expected={r['expected']}, actual={r.get('actual', 'error')}"
                    for r in controls_result["controls"] if not r["passed"]]
        (output / "report.zh.md").write_text("\n".join([
            "# 开发控制项未全部通过", "", f"一致：{controls_result['passed']}/{controls_result['total']}。",
            "未启动 12 题重评；未生成回答，未跑全量。以下是开发标签分歧，不自动等于模型错误。", "", *failures,
            "", "所有原始控制项审计保留于 judge-controls.json；不重试至通过。", ""]))
        print("Development controls did not all pass; frozen-case judging not started.", flush=True)
        return 1
    rounds = []
    for repeat in (1, 2, 3):
        manifest["status"] = f"judging_repeat_{repeat}"
        save(output / "manifest.json", manifest)
        destination = output / f"judge-r{repeat:02d}"
        command = [sys.executable, "-m", "anydocs_ragas.cli", str(output / "agentic.jsonl"),
                   "--output-dir", str(destination), "--judge-profile", args.judge_profile,
                   "--fact-rules", str(output / "fact-rules.json"), "--metrics", "reference_fact_recall",
                   "--concurrency", "2", "--no-source-scores"]
        print(f"Rejudging frozen Agent outputs {repeat}/3; no answer generation", flush=True)
        result = subprocess.run(command, check=False)
        files = list(destination.glob("*.cases.jsonl"))
        if len(files) != 1:
            manifest["status"] = "judge_output_error"
            save(output / "manifest.json", manifest)
            return 1
        scored = load_trace_records(files[0])
        if len(scored) != 12 or {r["case_id"] for r in scored} != {r["case_id"] for r in rows}:
            raise ValueError("Case set changed")
        rounds.append({r["case_id"]: r for r in scored})
        manifest.setdefault("round_exit_codes", []).append(result.returncode)
    if file_sha256(output / "agentic.jsonl") != file_sha256(source / "frozen/agentic.jsonl"):
        raise ValueError("Frozen source changed")
    if any(file_sha256(engine / name) != digest for name, digest in manifest["source_files"].items()):
        raise ValueError("Scorer implementation changed while judging")
    analysis = write_analysis(output, samples, boundary, rounds, manifest)
    manifest["status"] = "complete" if not analysis["technical_errors"] else "complete_with_judge_errors"
    save(output / "manifest.json", manifest)
    print(json.dumps({"output": str(output), "analysis": manifest["analysis"]}, ensure_ascii=False), flush=True)
    return 1 if analysis["technical_errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
