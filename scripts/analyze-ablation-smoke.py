#!/usr/bin/env python3
"""Summarize a completed smoke run without inferring population-level improvements."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import mean, pstdev

VARIANTS = ("child_only", "parent_child", "page_static", "agentic")
LABELS = {"child_only": "A Child-only", "parent_child": "B Parent-Child",
          "page_static": "C 固定读页", "agentic": "D Agentic"}
METRICS = ("reference_fact_recall", "rubric_compliance", "faithfulness",
           "context_recall", "context_precision", "factual_correctness")


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def metric_value(result: dict, metric: str) -> float | None:
    score = result.get("scores", {}).get(metric)
    return float(score["value"]) if score is not None else None


def percentile(values: list[float], fraction: float) -> float:
    import math
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def fmt(value: float | None, digits: int = 3) -> str:
    return "缺失" if value is None else f"{value:.{digits}f}"


def full_rubric(records: list[dict], judges: dict[str, dict]) -> float | None:
    values = []
    for record in records:
        if record["result"]["type"] != "answer":
            values.append(0.0)
        else:
            score = metric_value(judges[record["case_id"]], "rubric_compliance")
            if score is None:
                return None
            values.append(score)
    return mean(values)


def judge_artifacts(group: Path, repeat: int) -> list[Path]:
    resolved = group / f"judge-r{repeat:02d}-resolved"
    return list((resolved if resolved.exists() else group / f"judge-r{repeat:02d}").glob("*.cases.jsonl"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    root = args.run.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("completed_attempts") != 48:
        raise ValueError("Only a completed 48-attempt smoke run is accepted")
    raw = {v: read_jsonl(root / "groups" / v / "raw.cases.jsonl") for v in VARIANTS}
    fact_count = sum(len(row["ragas_sample"]["reference_facts"]) for row in raw["child_only"])
    judged = {}
    groups = {}
    for variant in VARIANTS:
        paths = judge_artifacts(root / "groups" / variant, 1)
        if len(paths) != 1:
            raise ValueError(f"Expected one completed judge artifact for {variant}")
        values = read_jsonl(paths[0])
        judged[variant] = {row["case_id"]: row for row in values}
        if set(judged[variant]) != {row["case_id"] for row in raw[variant]}:
            raise ValueError("Judge/raw case mismatch")
        metrics = {}
        for metric in METRICS:
            scores = [value for row in values if (value := metric_value(row, metric)) is not None]
            metrics[metric] = {"mean": mean(scores) if scores else None, "scored": len(scores),
                               "skipped": sum(metric in row["skipped"] for row in values),
                               "errors": sum(metric in row["errors"] for row in values)}
        records = raw[variant]
        latencies = [row["raw_latency_ms"] for row in records]
        groups[variant] = {"planned": 12, "attempted": len(records),
                           "answers": sum(row["result"]["type"] == "answer" for row in records),
                           "metrics": metrics, "rubric_itt": full_rubric(records, judged[variant]),
                           "latency_ms": {"mean": mean(latencies), "p50": percentile(latencies, .5), "p95": percentile(latencies, .95)},
                           "mean_evidence_tokens": mean(row["evidence_tokens"] for row in records),
                           "mean_input_tokens": mean(row["all_call_usage"]["input_tokens"] for row in records),
                           "mean_output_tokens": mean(row["all_call_usage"]["output_tokens"] for row in records),
                           "mean_model_calls": mean(len(row["model_calls"]) for row in records)}
    pairs = []
    for before, after in (("child_only", "parent_child"), ("parent_child", "page_static"), ("page_static", "agentic")):
        differences = []
        for case_id in judged[before]:
            a = metric_value(judged[before][case_id], "reference_fact_recall")
            b = metric_value(judged[after][case_id], "reference_fact_recall")
            differences.append({"case_id": case_id, "rfr_delta": b - a if a is not None and b is not None else None})
        eligible = [row["rfr_delta"] for row in differences if row["rfr_delta"] is not None]
        pairs.append({"before": before, "after": after, "n": len(eligible),
                      "mean_rfr_delta": mean(eligible) if eligible else None, "cases": differences})
    calibration = {}
    judge_runs = []
    calibration_repetitions = []
    for repeat in (1, 2, 3):
        paths = judge_artifacts(root / "groups" / "agentic", repeat)
        if len(paths) == 1:
            rows = read_jsonl(paths[0])
            if {row["case_id"] for row in rows} != set(judged["agentic"]):
                raise ValueError("Judge calibration/raw case mismatch")
            judge_runs.append(rows)
            calibration_repetitions.append(repeat)
    for metric in METRICS:
        round_scored = [sum(metric_value(row, metric) is not None for row in run) for run in judge_runs]
        round_errors = [sum(metric in row["errors"] for row in run) for run in judge_runs]
        round_means = [mean(scores) for run in judge_runs
                       if (scores := [value for row in run if (value := metric_value(row, metric)) is not None])]
        per_case = []
        for case_id in judged["agentic"]:
            values = [value for run in judge_runs
                      if (value := metric_value(next(row for row in run if row["case_id"] == case_id), metric)) is not None]
            per_case.append({"case_id": case_id, "values": values,
                             "scored_repetitions": len(values),
                             "range": max(values) - min(values) if values else None})
        common = [row for row in per_case if len(row["values"]) == len(judge_runs)]
        common_means = [mean(row["values"][i] for row in common) for i in range(len(judge_runs))] if common else []
        ranges = [row["range"] for row in per_case if row["range"] is not None]
        calibration[metric] = {"round_means": round_means,
                               "round_scored": round_scored, "round_errors": round_errors,
                               "common_case_count": len(common), "common_case_round_means": common_means,
                               "stddev": pstdev(common_means) if len(common_means) > 1 else None,
                               "changed_cases": sum(value > 1e-9 for value in ranges),
                               "max_case_range": max(ranges) if ranges else None,
                               "cases": per_case}
    all_records = [row for records in raw.values() for row in records]
    ab_ok = all(next(row for row in raw["child_only"] if row["case_id"] == case_id)["candidate_fingerprint"] ==
                next(row for row in raw["parent_child"] if row["case_id"] == case_id)["candidate_fingerprint"]
                for case_id in judged["child_only"])
    checks = {"attempts": len(all_records), "unique_case_variant_pairs": len({(r["case_id"], r["variant"]) for r in all_records}),
              "ab_candidates_identical": ab_ok,
              "budget_violations": sum(r["evidence_tokens"] > 8000 for r in all_records),
              "source_trace_links": sum(bool(r.get("langfuse_trace_id") and r.get("langfuse_observation_id")) for r in all_records),
              "model_calls": sum(len(r["model_calls"]) for r in all_records),
              "missing_usage_calls": sum(r["all_call_usage"]["missing_usage_calls"] for r in all_records),
              "generation_length_finishes": sum(call.get("finish_reason", {}).get("unified") == "length"
                                                for r in all_records for call in r["model_calls"])}
    checks["technical_judge_retries"] = len(list((root / "groups").glob("*/judge-retry-*/*/*.cases.jsonl")))
    checks["resolved_judge_errors"] = sum(len(row.get("judge_retry_history", []))
                                         for rows in judged.values() for row in rows.values())
    source_verification_path = root / "langfuse-source-verification.json"
    source_verification = (json.loads(source_verification_path.read_text())
                           if source_verification_path.exists() else {})
    project_id = source_verification.get("project_id")
    trace_base = f"https://jp.cloud.langfuse.com/project/{project_id}/traces" if project_id else None
    analysis = {"scope": "12 selected cases, one independent system run per group; descriptive only",
                "contract_checks": checks, "groups": groups, "paired": pairs,
                "judge_calibration_repetitions": calibration_repetitions,
                "fixed_output_judge_calibration": calibration}
    (root / "analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + "\n")
    lines = ["# Parent-Child / Agentic RAG 12 题冒烟报告", "",
             "日期：2026-10-20。范围：12 条固定回归题、四组各一次，共 48 次计划问答；未跑 92 条全量。", "",
             "这是接线和指标校准验证。样本按已知问题挑选，独立业务复核待完成，不估计生产准确率，不作统计显著性或泛化结论。", "",
             f"技术性 Judge 错误仅重试缺失分数：{checks['technical_judge_retries']} 项；原始失败、成功分数和单独的 resolved 视图均保留，没有重生成答案。", "",
             "## 环境与数据", "",
             f"- Engine 基线：`{manifest['engine_sha']}`；实验代码有工作区改动，以 manifest 中的文件 hash 为准。",
             f"- 文档 SHA：`{manifest['docs_sha']}`；实际索引：`{manifest['index_counts']}`。",
             f"- 回答模型：`{manifest['answer_model']}`；Judge：`{manifest['judge_model']}`；reranker 关闭。",
             f"- 运行环境：{manifest['cpu']}，{manifest['memory_bytes'] / 2 ** 30:.0f} GiB，{manifest['platform']}/{manifest['arch']}，Node {manifest['node']}。",
             "- 检索 Embedding 为本地 Xenova/bge-m3:q8；评分 metadata 中 text-embedding-3-small 是未启用 Answer Relevancy 的默认项，并未参与这六项评分。",
             f"- 场景：{manifest['context_mode']}，历史为空，单请求串行；延迟来自已启动 Runtime 内的 12 次请求，不含建库、HTTP 接入和 Judge。",
             "- P95 使用 nearest-rank；每组只有 12 次请求，因此这里 P95 等于本组最大值。远端模型是否冷启动不可控。",
             "- A/B/C 复用公共 reader；D 保留 Agent 提示词、工具、停止及修复。D-C 是整套编排增量。", "",
             "## 接线核验", "", "```json", json.dumps(checks, ensure_ascii=False, indent=2), "```", "",
             "## 质量与失败", "",
             "RFR 只检查实际上下文对 reference facts 的支持，不衡量最终答案是否说出了这些事实。",
             f"本集共 {fact_count} 条 reference facts；先逐题平均，再对 12 题等权宏平均，不将总支持 fact 数直接除以 {fact_count}。",
             "表中语义分为成功评分样本的条件均值，括号为 scored/12；rubric_itt 对任务未完成记 0。", "",
             "| 组 | 回答数 | RFR | Rubric | rubric_itt | Faithfulness | Context Recall | Context Precision | Factual Correctness |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for variant in VARIANTS:
        group = groups[variant]
        metric_cells = {metric: f"{fmt(value['mean'])} ({value['scored']}/12)" for metric, value in group["metrics"].items()}
        lines.append(f"| {LABELS[variant]} | {group['answers']}/12 | {metric_cells['reference_fact_recall']} | {metric_cells['rubric_compliance']} | {fmt(group['rubric_itt'])} | {metric_cells['faithfulness']} | {metric_cells['context_recall']} | {metric_cells['context_precision']} | {metric_cells['factual_correctness']} |")
    lines += ["", "## 延迟与用量", "", "费用未取得实际账单与已核验单价，不填写金额。Token 为所有底层模型调用的 provider usage 累计，包含内部修复。", "",
              "| 组 | 平均/P50/P95 ms | 平均 input/output tokens | 平均模型调用 | 平均证据估算 tokens |", "|---|---:|---:|---:|---:|"]
    for variant in VARIANTS:
        g = groups[variant]; t = g["latency_ms"]
        lines.append(f"| {LABELS[variant]} | {t['mean']:.0f}/{t['p50']:.0f}/{t['p95']:.0f} | {g['mean_input_tokens']:.0f}/{g['mean_output_tokens']:.0f} | {g['mean_model_calls']:.2f} | {g['mean_evidence_tokens']:.0f} |")
    lines += ["", "## 固定输出的 Judge 波动", "", "D 的同一批 12 份输出重复评分；没有重新生成答案。重复校准不回写首次源分数。", "",
              f"实际 Judge 轮次：{calibration_repetitions}。技术错误不填零；宏平均附当轮分母，标准差只用每轮都成功的共同题集，不代表系统重跑方差。", "",
              "| 指标 | 各次宏平均 (scored/12) | 共同题数 | 共同题均值标准差 | 有变化的题数/12 | 最大单题分差 |", "|---|---|---:|---:|---:|---:|"]
    for metric, value in calibration.items():
        means = ', '.join(f"{fmt(x)} ({n}/12)" for x, n in zip(value['round_means'], value['round_scored']))
        lines.append(f"| {metric} | {means} | {value['common_case_count']} | {fmt(value['stddev'], 6)} | {value['changed_cases']}/12 | {fmt(value['max_case_range'])} |")
    lines += ["", "Judge 原始错误保存在各轮 cases.jsonl 的 errors 中。缺失某轮的题不能据此宣称三轮稳定。", ""]
    lines += ["", "## 逐题证据与回答", ""]
    for c in raw["child_only"]:
        case_id = c["case_id"]
        missing_notes = []
        lines += [f"### {case_id}", "", c["query"], "", "| 组 | 结果 | RFR | Rubric | 已读页面 | 源 Trace |", "|---|---|---:|---:|---|---|"]
        for variant in VARIANTS:
            record = next(row for row in raw[variant] if row["case_id"] == case_id)
            score = judged[variant][case_id]
            pages = list(dict.fromkeys(row["page_id"] for row in record["trace"].get("selected_context", [])))
            trace_id = record.get("langfuse_trace_id")
            trace = (f"[{trace_id}]({trace_base}/{trace_id}?observation={record.get('langfuse_observation_id')})"
                     if trace_base and trace_id else f"`{trace_id}`")
            lines.append(f"| {LABELS[variant]} | {record['result']['type']} | {fmt(metric_value(score, 'reference_fact_recall'))} | {fmt(metric_value(score, 'rubric_compliance'))} | {', '.join(pages)} | {trace} |")
            fact_score = score.get("scores", {}).get("reference_fact_recall", {})
            try:
                facts = json.loads(fact_score.get("reason") or "[]")
            except (ValueError, TypeError):
                facts = []
            misses = [fact["fact"] for fact in facts if fact["value"] < 1]
            if misses:
                missing_notes.append(f"- {LABELS[variant]} 的未完全支持 facts：" + "；".join(misses))
        lines += ["", *missing_notes, ""]
    lines += ["## 局限与后续", "", "- 当前 88 页语料已不同于历史 84 页版本，不将本轮与旧总分直接相减。",
              "- 选择题、单轮系统生成、单一 Judge、无页面提示、未完成独立业务复核，均限制结论。",
              "- Context Precision 受页/片段粒度影响；合法引用 ID 不等于该引用支持对应句子。",
              "- 自动指标只作诊断，需结合原文和实际回答复核；全量和留出集尚未启动。", "",
              "标注及评分版本以本轮冻结文件为准。R1 的标注争议、R2 的逐题修订及评分配置见项目 eval 目录中的对应审核记录；不可跨数据/评分版本直接将分数相减。Quickstart 来源冲突与独立业务审核仍需跟进。", "",
              "原始输入、输出、逐事实 Judge 理由、模型 usage、源 Trace 与文件 hash 均在本目录及 manifest 中。"]
    (root / "report.zh.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"report": str(root / "report.zh.md"), "checks": checks}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
