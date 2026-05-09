/**
 * Markdown rendering for `analyze runs` reports — ARCH §16.6.1 skeleton.
 *
 * The report goes to `<state>/reports/<YYYY-MM-DD>-analyze.md`. Stable
 * structure so a human can diff successive reports and see whether
 * the same recall failures keep firing.
 *
 * v1 keeps page-suggestion hints inline under D1 rather than splitting
 * into `feedback/suggestions/<YYYY-Www>.md` (that path lands in v1.5
 * §15.5 with the rest of the feedback data dir).
 */

import type { DimensionFindings, LatencyBucket } from './dimensions.ts';

export type RenderInput = {
  projectId: string;
  sinceISO: string;
  date: string;
  totalRuns: number;
  windowDays: number;
  findings: DimensionFindings;
};

export function renderAnalyzeReport(input: RenderInput): string {
  const { findings, totalRuns, windowDays, sinceISO, projectId, date } = input;
  const lines: string[] = [];
  lines.push(`# Analyze — ${projectId} — since ${sinceISO}`);
  lines.push('');
  const perDay = windowDays > 0 ? (totalRuns / windowDays).toFixed(1) : totalRuns.toFixed(0);
  lines.push(`Total runs: ${totalRuns} (avg ${perDay}/day over ${windowDays}d window) — generated ${date}`);
  lines.push('');

  // ---------- D1 ----------
  lines.push(`## 1. Recall failures (n=${findings.recall.count})`);
  if (findings.recall.count === 0) {
    lines.push('');
    lines.push('_None — no runs tripped the recall-failure triggers in this window._');
    lines.push('');
  } else {
    lines.push('');
    lines.push(
      'Trigger keys: `lc` = confidence below floor, `nc` = no citations, `ra` = re-asked within 30s.',
    );
    lines.push('');
    for (const c of findings.recall.clusters) {
      const trig = c.triggers.length > 0 ? ` [${c.triggers.map(triggerCode).join(',')}]` : '';
      const variantList = c.cluster.variants.slice(0, 3);
      const variantStr = variantList.map((v) => JSON.stringify(v)).join(' / ');
      const more = c.cluster.variants.length > variantList.length
        ? ` (+${c.cluster.variants.length - variantList.length} more)`
        : '';
      lines.push(`- ${variantStr}${more} (×${c.cluster.items.length})${trig}`);
      if (c.topPagesAtRank1.length > 0) {
        const list = c.topPagesAtRank1
          .map((p) => `${p.page}×${p.count}`)
          .join(', ');
        lines.push(`  - top retrieved page: ${list}`);
      }
      lines.push(
        `  - suggestion: confirm whether \`${c.topPagesAtRank1[0]?.page ?? '(none)'}\` actually answers — if not, check navigation/编排 for missing page or wrong subtree placement.`,
      );
    }
    lines.push('');
  }

  // ---------- D2 ----------
  lines.push('## 2. Latency anomalies');
  if (findings.latency.count === 0) {
    lines.push('');
    lines.push(
      `_None — 0 runs exceeded ${findings.latency.threshold}ms across ${findings.latency.total} total._`,
    );
    lines.push('');
  } else {
    const pct = findings.latency.total > 0
      ? ((findings.latency.count / findings.latency.total) * 100).toFixed(1)
      : '0';
    lines.push('');
    lines.push(
      `Threshold: ${findings.latency.threshold}ms — ${findings.latency.count}/${findings.latency.total} runs (${pct}%) exceeded.`,
    );
    lines.push('');
    lines.push('### By query length');
    renderBuckets(findings.latency.byQueryLen, lines);
    lines.push('');
    lines.push('### By fused-chunk count');
    renderBuckets(findings.latency.byFusedCount, lines);
    lines.push('');
  }

  // ---------- D3 ----------
  lines.push('## 3. Disambiguation cliffs');
  if (findings.disambig.total === 0) {
    lines.push('');
    lines.push('_None — `subtree_ask_triggered` did not fire in this window._');
    lines.push('');
  } else {
    const ratePct = totalRuns > 0
      ? ((findings.disambig.total / totalRuns) * 100).toFixed(1)
      : '0';
    lines.push('');
    lines.push(
      `Clarify rate: ${ratePct}% (${findings.disambig.total} / ${totalRuns}); ` +
        `${findings.disambig.unfollowed} of those had no follow-up within 5min.`,
    );
    lines.push('');
    lines.push('Bucketed by top-fused page (proxy for nav subtree — see ARCH §16.6 D3).');
    lines.push('');
    for (const b of findings.disambig.buckets.slice(0, 10)) {
      lines.push(
        `- \`${b.page}\` — ${b.count} clarify (${b.unfollowed} unfollowed)`,
      );
      for (const ex of b.examples) {
        lines.push(`  - ${JSON.stringify(ex)}`);
      }
    }
    if (findings.disambig.buckets.length > 10) {
      lines.push(`- _…(+${findings.disambig.buckets.length - 10} more pages)_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderBuckets(buckets: LatencyBucket[], lines: string[]): void {
  if (buckets.length === 0) {
    lines.push('_(no buckets)_');
    return;
  }
  for (const b of buckets) {
    lines.push(`- ${b.label} — n=${b.count}, worst ${b.worst}ms`);
    for (const ex of b.examples) {
      const q = ex.query.length > 60 ? `${ex.query.slice(0, 57)}...` : ex.query;
      lines.push(`  - ${JSON.stringify(q)} (${ex.latency_ms}ms)`);
    }
  }
}

function triggerCode(t: 'low-confidence' | 'no-citations' | 'reask-30s'): string {
  return t === 'low-confidence' ? 'lc' : t === 'no-citations' ? 'nc' : 'ra';
}
