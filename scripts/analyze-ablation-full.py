#!/usr/bin/env python3
"""Paired, case-first descriptive analysis of all frozen full-ablation attempts."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from hashlib import sha256
import json
import math
from pathlib import Path
import random
from statistics import mean, pstdev
from urllib.parse import urlsplit, urlunsplit

VARIANTS = ("child_only", "parent_child", "page_static", "agentic")
LABELS = {"child_only": "A Child-only", "parent_child": "B Parent-Child", "page_static": "C 固定读页", "agentic": "D Agentic"}
METRICS = ("reference_fact_recall", "rubric_compliance", "faithfulness", "context_recall", "context_precision", "factual_correctness")

def trace_base_url(value):
    if value is None:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Langfuse trace base URL must be an http(s) URL without credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("Langfuse trace base URL must not contain a query or fragment")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))

def read(path):
    return [json.loads(s) for s in path.read_text().splitlines() if s.strip()]

def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

def percentile(values, q):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * q) - 1)] if ordered else None

def missing_bounds(values):
    observed = [v for v in values if v is not None]
    missing = len(values) - len(observed)
    return {"planned_requests": len(values), "missing_requests": missing,
            "lower": sum(observed) / len(values) if values else None,
            "upper": (sum(observed) + missing) / len(values) if values else None}

def value(row, judge, metric):
    if metric == "rubric_itt" and row["result"]["type"] != "answer":
        return 0.0
    name = "rubric_compliance" if metric == "rubric_itt" else metric
    if name == "reference_fact_recall" and not row["ragas_sample"]["retrieved_contexts"]:
        return 0.0
    score = judge.get("scores", {}).get(name)
    return float(score["value"]) if score is not None else None

def bootstrap(deltas, families, seed=20261020, repeats=10000):
    clusters = defaultdict(list)
    for key, val in deltas.items():
        clusters[families[key]].append(val)
    keys = sorted(clusters)
    rng = random.Random(seed)
    values = []
    sums = {k: sum(clusters[k]) for k in keys}
    sizes = {k: len(clusters[k]) for k in keys}
    for _ in range(repeats):
        chosen = rng.choices(keys, k=len(keys))
        values.append(sum(sums[k] for k in chosen) / sum(sizes[k] for k in chosen))
    return {"method": "paired topic-cluster percentile bootstrap", "seed": seed, "resamples": repeats,
            "clusters": len(keys), "low": percentile(values, .025), "high": percentile(values, .975)}

def metric_input(row, metric):
    s = row["ragas_sample"]
    if metric == "factual_correctness":
        return {k: s.get(k) for k in ("response", "reference")}
    if metric in {"context_precision", "context_recall"}:
        return {k: s.get(k) for k in ("user_input", "reference", "retrieved_contexts")}
    if metric == "reference_fact_recall":
        return {k: s.get(k) for k in ("user_input", "reference_facts", "retrieved_contexts")}
    if metric == "faithfulness":
        return {k: s.get(k) for k in ("user_input", "response", "retrieved_contexts")}
    return {k: s.get(k) for k in ("user_input", "response", "reference", "reference_facts", "rubric", "retrieved_contexts")}

def same_input_variation(raw, judges):
    grouped = defaultdict(list)
    for r in raw:
        grouped[(r["variant"], r["case_id"])].append(r)
    result = {}
    for v in VARIANTS:
        result[v] = {}
        for metric in METRICS:
            eligible, changed, fact_changes = [], [], []
            for (group, case), rows in grouped.items():
                if group != v or len(rows) != 3:
                    continue
                hashes = {sha256(json.dumps(metric_input(r, metric), ensure_ascii=False, sort_keys=True).encode()).hexdigest() for r in rows}
                scores = [judges.get((v, r["repetition"], case), {}).get("scores", {}).get(metric, {}).get("value") for r in rows]
                if len(hashes) != 1 or any(x is None for x in scores):
                    continue
                eligible.append(case)
                span = max(scores) - min(scores)
                if span > 1e-9:
                    changed.append({"case_id": case, "range": span,
                        "repetition_values": {str(r["repetition"]): x for r, x in zip(rows, scores)}, "metric_input_sha256": next(iter(hashes))})
                if metric == "reference_fact_recall":
                    facts = [json.loads(judges[(v, r["repetition"], case)]["scores"][metric]["reason"]) for r in rows]
                    names = [[f["fact"] for f in fs] for fs in facts]
                    if names[0] != names[1] or names[0] != names[2]:
                        raise ValueError("RFR fact boundaries differ across repetitions")
                    flips = [{"fact": name, "values": [fs[i]["value"] for fs in facts]}
                             for i, name in enumerate(names[0]) if max(fs[i]["value"] for fs in facts) - min(fs[i]["value"] for fs in facts) > 1e-9]
                    if flips:
                        fact_changes.append({"case_id": case, "macro_cancelled_changes": span <= 1e-9, "facts": flips})
            result[v][metric] = {"same_input_three_valid_scores_cases": len(eligible), "changed_cases": len(changed),
                "max_range": max((x["range"] for x in changed), default=0), "cases": sorted(changed, key=lambda x: -x["range"]),
                "fact_level_changed_cases": len(fact_changes), "fact_level_changes": fact_changes}
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--allow-partial-judge", action="store_true")
    parser.add_argument("--langfuse-trace-base-url", type=trace_base_url,
                        help="Project traces URL for report links; omit to keep trace IDs as plain text")
    args = parser.parse_args()
    root = args.run.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    raw = read(root / "attempts.jsonl")
    if manifest.get("status") != "complete" or len(raw) != 1104:
        raise ValueError("Expected all 1104 attempts, including failed requests")
    keys = {(r["variant"], r["repetition"], r["case_id"]) for r in raw}
    if len(keys) != 1104:
        raise ValueError("Duplicate attempts")
    golden = read(root / "dataset/cases.frozen.jsonl")
    fact_counts = {g["id"]: len(g["expected"]["reference_facts"]) for g in golden}
    ids = {g["id"] for g in golden}
    judgements = {}
    publications = []
    for v in VARIANTS:
        for rep in range(1, 4):
            part = root / "groups" / v / f"r{rep:02d}" / "judge"
            path = part / "results.jsonl"
            rows = read(path) if path.exists() else []
            if not args.allow_partial_judge and (len(rows) != 92 or {r["case_id"] for r in rows} != ids):
                raise ValueError(f"Incomplete judge cohort: {v} r{rep}")
            for j in rows:
                judgements[(v, rep, j["case_id"])] = j
            if (part / "publication.json").exists():
                publications.append({"variant": v, "repetition": rep, **json.loads((part / "publication.json").read_text())})
    families = {r["case_id"]: r["family_id"] for r in raw}
    by_case = defaultdict(list)
    by_request = {(r["variant"], r["repetition"], r["case_id"]): r for r in raw}
    for r in raw:
        by_case[(r["variant"], r["case_id"])].append(r)
    case_means = {}
    for (v, case), rows in by_case.items():
        scores = {}
        for m in (*METRICS, "rubric_itt"):
            values = [value(r, judgements.get((v, r["repetition"], case), {}), m) for r in rows]
            scores[m] = mean(values) if len(values) == 3 and all(x is not None for x in values) else None
        case_means[(v, case)] = scores
    groups = {}
    for v in VARIANTS:
        rows = [r for r in raw if r["variant"] == v]
        metric_summary = {}
        for m in (*METRICS, "rubric_itt"):
            metric_key = "rubric_compliance" if m == "rubric_itt" else m
            scored = [x for r in rows if (x := value(r, judgements.get((v, r["repetition"], r["case_id"]), {}), m)) is not None]
            complete = [d[m] for (group, _), d in case_means.items() if group == v and d[m] is not None]
            means = []
            for rep in range(1, 4):
                vals = [x for r in rows if r["repetition"] == rep and (x := value(r, judgements.get((v, rep, r["case_id"]), {}), m)) is not None]
                means.append({"repetition": rep, "mean": mean(vals) if vals else None, "n": len(vals)})
            metric_summary[m] = {"mean_complete_cases": mean(complete) if complete else None, "complete_cases": len(complete),
                "conditional_request_mean": mean(scored) if scored else None, "request_scored": len(scored),
                "native_scored": sum(metric_key in judgements.get((v, r["repetition"], r["case_id"]), {}).get("scores", {}) for r in rows),
                "native_skipped": sum(metric_key in judgements.get((v, r["repetition"], r["case_id"]), {}).get("skipped", {}) for r in rows),
                "judge_errors": sum(metric_key in judgements.get((v, r["repetition"], r["case_id"]), {}).get("errors", {}) for r in rows),
                "rounds": means, "round_mean_stddev": pstdev([x["mean"] for x in means]) if all(x["mean"] is not None for x in means) else None}
        pages = [list(dict.fromkeys(c["page_id"] for c in r["trace"].get("selected_context", []))) for r in rows]
        hits = [any(p in r["expected"]["must_cite_pages"] for p in ps[:5]) for r, ps in zip(rows, pages)]
        mrr = [next((1 / (i + 1) for i, p in enumerate(ps) if p in r["expected"]["must_cite_pages"]), 0) for r, ps in zip(rows, pages)]
        times = [r["raw_latency_ms"] for r in rows]
        groups[v] = {"planned_requests": 276, "attempted": len(rows), "unique_cases": len({r["case_id"] for r in rows}),
            "answers": sum(r["result"]["type"] == "answer" for r in rows),
            "failures": dict(Counter(r["result"].get("code", r["result"]["type"]) for r in rows if r["result"]["type"] != "answer")),
            "metrics": metric_summary, "evidence_page_hit_at_5": mean(hits), "evidence_page_mrr": mean(mrr),
            "latency_ms": {"mean": mean(times), "p50": percentile(times, .5), "p95": percentile(times, .95), "max": max(times),
                           "round_p95": [percentile([r["raw_latency_ms"] for r in rows if r["repetition"] == rep], .95) for rep in range(1, 4)]},
            "mean_input_tokens": mean(r["all_call_usage"]["input_tokens"] for r in rows),
            "mean_output_tokens": mean(r["all_call_usage"]["output_tokens"] for r in rows),
            "mean_calls": mean(len(r["model_calls"]) for r in rows),
            "mean_evidence_estimated_tokens": mean(r["evidence_tokens"] for r in rows),
            "mean_unique_evidence_pages": mean(len(p) for p in pages),
            "read_failures": dict(Counter(a.get("error_code", "unknown") for r in rows for a in r["read_audit"] if not a["ok"])),
            "truncated_reads": sum(bool(a.get("truncated")) for r in rows for a in r["read_audit"]),
            "agent_forced_finalizations": sum(r["trace"].get("agent", {}).get("forced_finalization_count", 0) for r in rows),
            "agent_citation_retries": sum(r["trace"].get("agent", {}).get("citation_retry_count", 0) for r in rows),
            "mean_recorded_stage_ms": {stage: mean(r["trace"].get("timings", {}).get(stage, 0) or 0 for r in rows)
                for stage in ("router_ms", "embedding_ms", "retrieval_ms", "rerank_ms", "generation_ms")}}
        complete = {i: case_means[(v, i)]["reference_fact_recall"] for i in ids if case_means[(v, i)]["reference_fact_recall"] is not None}
        groups[v]["rfr_missing_score_bounds"] = missing_bounds([
            value(r, judgements.get((v, r["repetition"], r["case_id"]), {}), "reference_fact_recall")
            for r in rows])
        n_facts = sum(fact_counts[i] for i in complete)
        groups[v]["rfr_fact_weighted_complete_cases"] = sum(x * fact_counts[i] for i, x in complete.items()) / n_facts if n_facts else None
        groups[v]["rfr_fact_weighted_denominator"] = n_facts
    pairs = []
    for a, b in (("child_only", "parent_child"), ("parent_child", "page_static"), ("page_static", "agentic"), ("child_only", "agentic")):
        for m in ("reference_fact_recall", "rubric_itt", "faithfulness", "context_recall", "context_precision", "factual_correctness"):
            deltas = {i: case_means[(b, i)][m] - case_means[(a, i)][m] for i in ids
                      if case_means[(a, i)][m] is not None and case_means[(b, i)][m] is not None}
            pairs.append({"before": a, "after": b, "metric": m, "n": len(deltas),
                "delta": mean(deltas.values()) if deltas else None,
                "ci95": bootstrap(deltas, families) if deltas else None,
                "improved": sum(x > 1e-9 for x in deltas.values()), "regressed": sum(x < -1e-9 for x in deltas.values()),
                "tied": sum(abs(x) <= 1e-9 for x in deltas.values()),
                "cases": [{"case_id": i, "delta": x} for i, x in sorted(deltas.items(), key=lambda x: x[1])]})
    checks = {"planned_attempts": 1104, "actual_attempts": len(raw), "scored_outputs": len(judgements),
        "source_links": sum(bool(r.get("langfuse_trace_id") and r.get("langfuse_observation_id")) for r in raw),
        "unique_source_traces": len({r["langfuse_trace_id"] for r in raw}),
        "ab_pairs": 276, "ab_candidates_identical": all(
            by_request[("child_only", rep, i)]["candidate_fingerprint"] == by_request[("parent_child", rep, i)]["candidate_fingerprint"]
            for i in ids for rep in range(1, 4)),
        "budget_violations": sum(r["evidence_tokens"] > 8000 for r in raw),
        "model_calls": sum(len(r["model_calls"]) for r in raw),
        "missing_usage_calls": sum(r["all_call_usage"]["missing_usage_calls"] for r in raw),
        "answer_parameter_settings": sorted({json.dumps({k: c.get(k) for k in ("temperature", "max_output_tokens", "response_model")}, sort_keys=True)
                                             for r in raw for c in r["model_calls"]}),
        "output_length_finishes": sum(c.get("finish_reason", {}).get("unified") == "length" for r in raw for c in r["model_calls"]),
        "valid_scores": sum(len(j.get("scores", {})) for j in judgements.values()),
        "judge_errors": sum(len(j.get("errors", {})) for j in judgements.values()),
        "native_skipped": sum(len(j.get("skipped", {})) for j in judgements.values()),
        "langfuse_publications": len(publications), "families": len(set(families.values()))}
    slices = []
    for field in ("lang", "category"):
        for label in sorted({r[field] for r in raw}):
            subset = {r["case_id"] for r in raw if r[field] == label}
            for v in VARIANTS:
                vals = [case_means[(v, i)]["reference_fact_recall"] for i in subset if case_means[(v, i)]["reference_fact_recall"] is not None]
                slices.append({"field": field, "label": label, "variant": v, "n": len(vals), "rfr": mean(vals) if vals else None})
    analysis = {"manifest": manifest, "checks": checks, "groups": groups, "paired": pairs, "slices": slices,
        "analysis_script_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "judge_execution_phases": [json.loads(path.read_text()) for path in sorted(root.glob("judge-execution-phase-*.json"))],
        "judge_execution_phase_02": json.loads((root / "judge-execution-phase-02.json").read_text()) if (root / "judge-execution-phase-02.json").exists() else None,
        "case_means": [{"variant": v, "case_id": i, **s} for (v, i), s in case_means.items()], "publications": publications,
        "same_metric_input_judge_variation": same_input_variation(raw, judgements)}
    verification_path = root / "langfuse-verification.json"
    if verification_path.exists():
        analysis["langfuse_verification"] = json.loads(verification_path.read_text())
    save(root / "analysis/summary.json", analysis)
    # Select review targets from all three incremental comparisons before inspecting their prose.
    review = set()
    rng = random.Random(20261020)
    for p in pairs:
        if p["metric"] not in {"reference_fact_recall", "rubric_itt"} or p["before"] == "child_only" and p["after"] == "agentic":
            continue
        cases = p["cases"]
        review.update(x["case_id"] for x in cases[:5] + cases[-5:])
        middle = cases[5:-5]
        review.update(x["case_id"] for x in rng.sample(middle, min(5, len(middle))))
    save(root / "analysis/review-targets.json", {"seed": 20261020, "case_ids": sorted(review), "status": "pending evidence-level review"})
    fmt = lambda x: "缺失" if x is None else f"{x:.3f}"
    trace_base = args.langfuse_trace_base_url
    index = ["# 92 题逐题对照与原始 Trace", "",
        "每组列出三次独立运行。链接指向实际取证/回答过程，不是冻结输出上传 Trace。RFR 看证据，rubric_itt 看任务结果；缺失 Judge 分数不填零。", ""]
    for g in golden:
        case = g["id"]
        index += [f"## {case}", "", g["query"], "", "参考事实：", "",
                  *[f"- {f}" for f in g["expected"]["reference_facts"]], "",
                  "| 组 | r1/r2/r3 RFR 与原始 Trace | r1/r2/r3 rubric_itt | 结果 |",
                  "|---|---|---|---|"]
        for v in VARIANTS:
            records = [by_request[(v, rep, case)] for rep in range(1, 4)]
            links, rubrics = [], []
            for r in records:
                j = judgements.get((v, r["repetition"], case), {})
                label = f"r{r['repetition']} {fmt(value(r, j, 'reference_fact_recall'))}"
                trace_id = r.get("langfuse_trace_id")
                observation_id = r.get("langfuse_observation_id")
                links.append(f"[{label}]({trace_base}/{trace_id}?observation={observation_id})"
                             if trace_base and trace_id and observation_id else f"{label} (`{trace_id or 'missing trace'}`)")
                rubrics.append(fmt(value(r, j, "rubric_itt")))
            kinds = [r["result"].get("code", r["result"]["type"]) for r in records]
            index.append(f"| {LABELS[v]} | {' / '.join(links)} | {' / '.join(rubrics)} | {' / '.join(kinds)} |")
        index += [""]
    (root / "analysis/case-index.zh.md").write_text("\n".join(index) + "\n")
    lines = ["# Parent-Child 与 Agentic RAG 全量消融报告", "",
        "范围：92 条中英回归题 × 四组 × 三次独立系统运行，共 1104 次问答尝试。六项指标对每份冻结输出各评一次；不是同一答案的三次重评。", "",
        "这是已反复使用的开发回归集，没有独立未见集或业务专家最终审核，不代表线上准确率。保留已知 Judge 推断分歧；结果不作为自动上线门禁。", "",
        "## 配置与口径", "",
        f"- 实验：`{manifest['experiment_id']}`；回答 `deepseek-flash`，Judge `deepseek-v4-pro`；reranker 关闭。",
        f"- 索引：{manifest['index_counts']}；Embedding `{manifest['embedding_model']}`。",
        f"- Engine HEAD `{manifest['engine_sha']}`；文档 HEAD `{manifest['docs_sha']}`。均有工作区改动，以 source-archive 和 manifest 的 hash 为实际构建证据。",
        f"- 本机环境：{manifest['cpu']}，{manifest['memory_bytes'] / 2 ** 30:.0f} GiB，{manifest['platform']}/{manifest['arch']}，Node {manifest['node']}。Python 与 Ragas/SDK 版本的运行中只读见证在 environment-witness.json。",
        f"- Golden 字节 SHA：`{manifest['golden_source_sha256']}`；92 题合计 {sum(len(g['expected']['reference_facts']) for g in golden)} 个 reference facts。",
        "- `no_page`，空历史，问答串行、case/repetition 区组内随机四组；每份输出无外层补跑。",
        "- `ablation-full-v1` 为显式组合配置：RFR 使用 audited-v3，其余五项使用 audited-v1。严格来源门禁 audited-v4 没有进入主分。",
        "- Judge 初始样本并发 2；29 份最终评分后调至 8，607 份后按用户要求调至 16。已完成评分未重算，两次切换分别最多取消 2 和 8 份在途样本计算，部分已发生调用数未知。实际阶段见 judge-execution-phase-02.json、judge-execution-phase-03.json，不声称全程使用固定并发。",
        "- 先对每题三次系统运行求均值，再对题宏平均。Judge 技术错误保留缺失，未作零分；无证据的全样本 RFR 为 0，非 answer 的 rubric_itt 为 0。",
        "- Context Precision 是按顺序计算的 AP，不能直接解释为有用文本占比。RFR 检查上下文覆盖，不检查答案是否表达该事实。", "",
        "## 完整性", "", "```json", json.dumps(checks, ensure_ascii=False, indent=2), "```", "",
        "## 结果", "", "下表先对具有三轮可用值的题取均值，再跨题宏平均；括号为有效题数/92，补零仅遵循上文的无证据 RFR 和任务未完成 rubric_itt 规则，Judge 错误不补零。逐请求 scored/skipped/error 和逐轮均值见 analysis/summary.json。条件均值分母不同时不能直接相减，应看配对比较。", "",
        "| 组 | answer/276 | RFR (完整题/92) | rubric_itt | Faithfulness | Context Recall | Context Precision | Factual Correctness |",
        "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for v in VARIANTS:
        g = groups[v]; m = g["metrics"]
        lines.append(f"| {LABELS[v]} | {g['answers']}/276 | {fmt(m['reference_fact_recall']['mean_complete_cases'])} ({m['reference_fact_recall']['complete_cases']}/92) | " +
            " | ".join(f"{fmt(m[k]['mean_complete_cases'])} ({m[k]['complete_cases']}/92)" for k in ("rubric_itt", "faithfulness", "context_recall", "context_precision", "factual_correctness")) + " |")
    lines += ["", "### RFR 缺失评分敏感性", "",
        "以下对每组全部 276 次尝试计算，把技术缺失分别设为 0 和 1，仅给出可能均值的上下界，不修改原始分数。这不是置信区间，也不覆盖有效 Judge 判定的语义误差；三轮等权且每题均有三次计划，因此与全 92 题的三轮题均值再宏平均等价。", "",
        "| 组 | 技术缺失/276 | 全样本均值可能区间 |", "|---|---:|---|"]
    for v in VARIANTS:
        bounds = groups[v]["rfr_missing_score_bounds"]
        lines.append(f"| {LABELS[v]} | {bounds['missing_requests']}/276 | [{fmt(bounds['lower'])}, {fmt(bounds['upper'])}] |")
    lines += ["", "## 配对差值", "", "95% CI 使用预先按主题分组的 paired cluster bootstrap，10000 次、seed=20261020。它们是未经多重比较校正的边际区间，仅作探索性描述。主题簇为代码辅助的保守分组，未独立审核，不宣称是独立用户样本；没有报告未经多重比较校正的 p 值。", "",
        "| 比较 | 指标 | 配对题数 | 均值差 | 95% CI | 改善/退步/持平 |", "|---|---|---:|---:|---|---|"]
    for p in pairs:
        if p["metric"] not in {"reference_fact_recall", "rubric_itt"}: continue
        ci = p["ci95"]
        lines.append(f"| {LABELS[p['after']]} - {LABELS[p['before']]} | {p['metric']} | {p['n']}/92 | {fmt(p['delta'])} | [{fmt(ci['low'])}, {fmt(ci['high'])}] | {p['improved']}/{p['regressed']}/{p['tied']} |")
    lines += ["", "## 延迟与代价", "", "本地单机 Runtime 的 warm 请求计时，不含建库、HTTP 代理、Judge 和 Langfuse 上传；不是并发压测，不推算生产 QPS。评分与问答同时运行，共用本机和网关，不能将其当作独占资源的性能基准。Token 为回答链路 provider usage 累计；若有缺失 usage 调用，累计只代表已报告部分，不当作免费调用。费用没有核验单价或账单，不填写金额。", "",
        "| 组 | 平均/P50/P95 ms | 平均 input/output tokens | 平均模型调用 | 证据估算 tokens | Evidence Hit@5 |", "|---|---:|---:|---:|---:|---:|"]
    for v in VARIANTS:
        g = groups[v]; t = g["latency_ms"]
        lines.append(f"| {LABELS[v]} | {t['mean']:.0f}/{t['p50']}/{t['p95']} | {g['mean_input_tokens']:.0f}/{g['mean_output_tokens']:.0f} | {g['mean_calls']:.2f} | {g['mean_evidence_estimated_tokens']:.0f} | {g['evidence_page_hit_at_5']:.3f} |")
    lines += ["", "## 相同输入下的 Judge 波动", "",
        "这是启动后增加的解释性诊断，不改变主指标或原分：仅当同一题三次运行的某项指标输入字节一致、三次都有原生有效分，才检查分差。RFR 不使用 response，因此相同证据但回答不同仍可检查；Factual Correctness 不使用证据，按 response/reference 比较。", "",
        "同输入的分差表明评分不确定性，不能算成系统取证差异。三次输入不同的案例不能用这个方法分离系统与 Judge 噪声；bootstrap 区间也没有完整建模所有 Judge 不确定性。", "",
        "| 组 | 指标 | 同输入且三次评分有效的题 | 分数变化题 | 最大题内分差 |", "|---|---|---:|---:|---:|"]
    for v, metrics in analysis["same_metric_input_judge_variation"].items():
        for metric in ("reference_fact_recall", "context_recall", "context_precision"):
            d = metrics[metric]
            lines.append(f"| {LABELS[v]} | {metric} | {d['same_input_three_valid_scores_cases']} | {d['changed_cases']} | {fmt(d['max_range'])} |")
    lines += ["", "RFR 还逐 fact 检查翻转，避免两个事实一增一减被宏平均抵消；明细及抵消标记见 analysis/summary.json 的 fact_level_changes，不将上表的零宏平均变化写成逐事实完全稳定。"]
    lines += ["", "## 实验与证据入口", ""]
    lines += ["- [92 题逐题对照与 1104 个原始 Trace 链接](./analysis/case-index.zh.md)", ""]
    for p in publications:
        lines.append(f"- [{LABELS[p['variant']]} r{p['repetition']}]({p['url']})：{p['items']} items，{p['score_count']} 有效分数。")
    if "langfuse_verification" in analysis:
        verification = analysis["langfuse_verification"]
        lines += ["", f"远端核验 passed={verification['passed']}：source roots {verification['source_root_matches']}/1104，"
            f"experiment items {verification['remote_items']}/1104，experiment 分数 {verification['experiment_scores_matched']}/{verification['expected_valid_scores']}，"
            f"原始 source 分数 {verification['source_scores_matched']}/{verification['expected_valid_scores']}。完整查询见 langfuse-verification/ 和 langfuse-verification.json。"]
    lines += ["", "发布曾触发 Datasets API 429，后按组间隔 70 秒续传；publication-recovery-complete.json 核验评分 journal 未改动，没有重生成或重评。SDK 对过长的 dataset item metadata 发出丢弃传播属性的警告，reference_answer/reference_facts/rubric 则显式保留在输出中，并逐项通过远端 IO 对比核验。原始 source 分数按具体 Trace ID 查询；session 条件曾返回空列表，不将该空列表当作写入失败或据此重复上传。"]
    lines += ["", "原始问答在 attempts.jsonl，各组各轮正文、分数和逐事实理由在 groups/<variant>/r0N/，source_trace_id 回链原始取证过程。Experiment 中冻结输出上传任务的 latency 不等于推理延迟；真实延迟使用原始 Trace 和 raw_latency_ms。", "",
        "## 解释边界", "",
        "- B-A 是相同 child 候选下 Parent 展开和装箱的增量，不是任意 Parent-Child 分块方案的普遍收益。",
        "- C-B 同时改变页面去重、候选窗口和固定读取；D-C 包含 Agent 规划、工具选择、提示词、停止与修复，不只隔离多轮推理。",
        "- 四组均关闭 reranker；C 是本轮受控静态流程，不是所有可能静态 RAG 的最强配置。不能据此排除重排、扩大读取或较简单查询改写的替代方案。",
        "- 整页和 child 的 Context Precision 粒度不同，整页含一个有用字段也可能判为 useful；结合 RFR、rubric 与证据用量解释。",
        "- Evidence Hit@5 只要求前五个唯一页面至少命中一个 must_cite_pages，不保证目标 API 或全部必要事实已覆盖；不能当作答案准确率。",
        "- Runtime required-fact 词项检查、合法引用 ID 和自动 Judge 都不是逐句语义正确性的证明。",
        "- 公网 URL、v1/v2 wallet 推断、回调终态分组仍需证据级复核，不能按对某组有利的方向改金标或补分。",
        "- 未见集、真实页面提示入口、reranker 开关与生产容量不在本轮范围；跨旧 Golden/旧 Judge 版本的差值不视为系统增益。", ""]
    lines += ["- 远端模型使用别名，未取得不可变权重 revision；跨时段 provider 漂移无法完全排除。凭据未归档，部署地域、实际单价与账单未核验。", ""]
    lines += ["- 原始 Golden 的 81 题带页面提示，本轮统一移除。部分泛称 Cregis API 的问题可能因此失去产品限定，不能把该场景的分数当作实际页面入口表现。原始文件已按启动时 SHA 核验后另存 dataset/cases.source-with-page-hints.jsonl，没有补回运行时，也没有看到胜负后修改标签。", ""]
    (root / "report.zh.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"report": str(root / "report.zh.md"), "checks": checks}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
