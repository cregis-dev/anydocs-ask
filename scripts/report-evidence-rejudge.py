#!/usr/bin/env python3
"""Compare versioned RFR judges on identical, frozen system outputs."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from statistics import mean, pstdev

from anydocs_ragas.evidence_judge import evidence_units
from anydocs_ragas.models import file_sha256, load_trace_records

VARIANTS = ("child_only", "parent_child", "page_static", "agentic")


def one_file(directory, suffix):
    files = list(directory.glob(f"*{suffix}"))
    if len(files) != 1:
        raise ValueError(f"Expected one {suffix} in {directory}")
    return files[0]


def read_scores(directory):
    return {row["case_id"]: row for row in load_trace_records(one_file(directory, ".cases.jsonl"))}


def value(row):
    score = row["scores"].get("reference_fact_recall")
    return score["value"] if score else None


def audit_row(row, raw):
    if value(row) is None:
        return {"scorer_calls": 0, "resolved_units": 0}
    inventory = {u.id: vars(u) for u in evidence_units(raw["ragas_sample"]["retrieved_contexts"])}
    calls, resolved_count, values = 0, 0, []
    facts = json.loads(row["scores"]["reference_fact_recall"]["reason"])
    if [fact["fact"] for fact in facts] != raw["ragas_sample"]["reference_facts"]:
        raise ValueError("Frozen fact text or order changed")
    for fact in facts:
        audit = json.loads(fact["reason"])
        if audit["profile"] != "audited-v2" or audit["value"] != max(b["verdict"] for b in audit["branches"]):
            raise ValueError("Invalid profile or OR aggregation")
        if fact["value"] != audit["value"]:
            raise ValueError("Fact score does not match its branch aggregation")
        calls += len(audit["calls"])
        for branch in audit["branches"]:
            if branch["verdict"] and not branch["evidence"]:
                raise ValueError("Positive branch missing evidence")
            for unit in branch["evidence"]:
                if unit != inventory.get(unit["id"]):
                    raise ValueError("Resolved evidence differs from frozen source")
                resolved_count += 1
        values.append(fact["value"])
    if abs(mean(values) - value(row)) > 1e-12:
        raise ValueError("Case score denominator changed")
    return {"scorer_calls": calls, "resolved_units": resolved_count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    root = args.run.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    source = Path(manifest["source"])
    groups, all_audits = {}, []
    for variant in VARIANTS:
        raw = {r["case_id"]: r for r in load_trace_records(root / "frozen" / f"{variant}.jsonl")}
        if (file_sha256(root / "frozen" / f"{variant}.jsonl") != manifest["source_raw_sha256"][variant]
                or file_sha256(source / "groups" / variant / "raw.cases.jsonl") != manifest["source_raw_sha256"][variant]):
            raise ValueError("Frozen or original answers changed")
        old = read_scores(source / "groups" / variant / "judge-r01")
        new = read_scores(root / "groups" / variant / "judge-r01")
        if set(raw) != set(new) or len(raw) != 12:
            raise ValueError("Expected the exact twelve cases")
        cases = []
        for case_id, row in new.items():
            all_audits.append(audit_row(row, raw[case_id]))
            old_value, new_value = value(old[case_id]), value(row)
            cases.append({"case_id": case_id, "old": old_value, "new": new_value,
                          "old_errors": old[case_id]["errors"], "new_errors": row["errors"]})
        valid_old = [case["old"] for case in cases if case["old"] is not None]
        valid_new = [case["new"] for case in cases if case["new"] is not None]
        paired = [case for case in cases if case["old"] is not None and case["new"] is not None]
        groups[variant] = {"old_mean": mean(valid_old), "old_scored": len(valid_old),
                           "new_mean": mean(valid_new) if valid_new else None, "new_scored": len(valid_new),
                           "new_error_cases": sum(bool(c["new_errors"]) for c in cases),
                           "paired_n": len(paired), "paired_mean_delta": mean(c["new"] - c["old"] for c in paired),
                           "cases": cases}
    agent_rounds = []
    for repeat in (1, 2, 3):
        directory = root / "groups" / "agentic" / f"judge-r{repeat:02d}"
        if directory.exists():
            rows = read_scores(directory)
            if set(rows) != {c["case_id"] for c in groups["agentic"]["cases"]}:
                raise ValueError("Calibration case set changed")
            agent_rounds.append(rows)
            if repeat > 1:
                raw = {r["case_id"]: r for r in load_trace_records(root / "frozen/agentic.jsonl")}
                all_audits += [audit_row(row, raw[case_id]) for case_id, row in rows.items()]
    common = [case_id for case_id in agent_rounds[0]
              if all(value(run[case_id]) is not None for run in agent_rounds)]
    common_means = [mean(value(run[case_id]) for case_id in common) for run in agent_rounds] if common else []
    calibration_cases = [{"case_id": case_id, "values": [value(run[case_id]) for run in agent_rounds]}
                         for case_id in agent_rounds[0]]
    ranges = [max(values) - min(values) for row in calibration_cases
              if len(values := [v for v in row["values"] if v is not None]) == len(agent_rounds)]
    calibration = {"rounds": len(agent_rounds), "common_n": len(common), "common_means": common_means,
                   "stddev": pstdev(common_means) if len(common_means) > 1 else None,
                   "changed_cases": sum(r > 1e-9 for r in ranges), "max_case_range": max(ranges) if ranges else None,
                   "cases": calibration_cases}
    analysis = {"groups": groups, "fixed_output_agent_judge": calibration,
                "original_outputs_unchanged": True, "answer_generation_calls": 0,
                "audited_scorer_calls": sum(a["scorer_calls"] for a in all_audits),
                "resolved_evidence_units_checked": sum(a["resolved_units"] for a in all_audits),
                "other_five_metrics": "not rejudged; retain original audited-v1 scores",
                "interpretation": "Judge contract change, never system quality gain"}
    (root / "analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + "\n")
    lines = ["# OR 与证据 ID 修正后的冻结输出重评", "",
             "只重评同一批 12 题 x 4 组的 Reference Fact Recall；没有生成新答案、重建索引或运行全量。",
             "Golden 文本与 50 个事实单元不变，两个现有事实的替代语义以独立规则文件显式表达。其他五项保留旧配置分数，没有混成同一轮新评分。", "",
             "| 组 | 旧 RFR (n/12) | 新 RFR (n/12) | 配对数 | 配对分差 | 新错误题数 |",
             "|---|---:|---:|---:|---:|---:|"]
    for variant, group in groups.items():
        lines.append(f"| {variant} | {group['old_mean']:.3f} ({group['old_scored']}/12) | {group['new_mean']:.3f} ({group['new_scored']}/12) | {group['paired_n']} | {group['paired_mean_delta']:+.3f} | {group['new_error_cases']} |")
    lines += ["", "旧/新分差来自 Judge 合同变化，不是系统增益；旧 D 的缺失项不补零。", "",
              "## 固定 Agent 输出重复评分", "", "```json", json.dumps(calibration, ensure_ascii=False, indent=2), "```", "",
              "## 逐题", "", "| Case | 组 | 旧 RFR | 新 RFR |", "|---|---|---:|---:|"]
    for variant, group in groups.items():
        for row in group["cases"]:
            old = "Judge error" if row["old"] is None else f"{row['old']:.3f}"
            new = "Judge error" if row["new"] is None else f"{row['new']:.3f}"
            lines.append(f"| {row['case_id']} | {variant} | {old} | {new} |")
    lines += ["", "## 边界", "", "- OR 使用显式 any_of 分支，由代码取 max；未自动解析自然语言里的或字。",
              "- 每个证据 ID 都回取原始上下文的精确字节内容对应文本与字符偏移；存在性不等于语义支持。",
              "- 语义 Judge 仍可能误判或有推论边界波动；有限反例通过不证明独立业务专家一致性。",
              "- 新评分仅发布到新 Experiment，原始源 Trace 分数不覆盖；第二、三次校准不发布。",
              "- 原始输入、输出、规则、源码、逐分支审计与 hash 保存在本目录。"]
    (root / "report.zh.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"report": str(root / "report.zh.md"), "groups": {v: {k: x for k, x in g.items() if k != "cases"} for v, g in groups.items()},
                      "calibration": {k: v for k, v in calibration.items() if k != "cases"}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
