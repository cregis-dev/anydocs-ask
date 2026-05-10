/**
 * Eval tab content for /p/:name — golden 题集概览 + metric cards +
 * baseline pin + run trigger + latest report (markdown rendered in the
 * browser via marked) + history table with sparkline.
 *
 * Rendered server-side; JS layer adds:
 *   - Run eval (POST /api/projects/:name/eval [body.baseline_path])
 *   - Pin / unpin baseline (POST/DELETE /api/projects/:name/eval/pin-baseline)
 *   - Latest-report markdown rendering (marked from /console/static)
 *
 * No standalone route — embedded as a tab panel in renderProject(). The
 * inline script is registered on first project-page load via the main
 * BOOTSTRAP_SCRIPT in project.ts (which checks the tab marker before
 * wiring handlers).
 */

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';
import type { EvalTabSnapshot, EvalReportSummary } from '../eval-state.ts';

export type EvalTabViewModel = {
  projectName: string;
  snapshot: EvalTabSnapshot;
  /** Pre-loaded latest eval report body (markdown). null = no report yet. */
  latestReportBody: string | null;
};

export function renderEvalTab(vm: EvalTabViewModel): Html {
  const { snapshot } = vm;
  const { goldenStats, history, latest, pinned, pinnedSummary } = snapshot;

  return html`
    <div class="eval-tab">
      ${metricRow(latest, pinnedSummary, pinned)}
      ${goldenSummaryCard(goldenStats)}
      ${runCard(history, pinned)}
      ${latestReportCard(vm.projectName, latest, vm.latestReportBody)}
      ${historyCard(vm.projectName, history, pinned?.filename ?? null)}
    </div>
    <style>
      .eval-tab .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
      @media (max-width: 720px) { .eval-tab .metrics { grid-template-columns: 1fr; } }
      .metric-card .num { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
      .metric-card .row { display: grid; grid-template-columns: 100px 1fr auto; gap: 8px 10px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid var(--bd-soft); }
      .metric-card .row:last-child { border-bottom: 0; }
      .metric-card .key { font-size: 11.5px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: .04em; }
      .metric-card .v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; font-weight: 500; }
      .delta-up { color: var(--ok); font-size: 11.5px; }
      .delta-dn { color: var(--err); font-size: 11.5px; }
      .delta-zero { color: var(--fg-mute); font-size: 11.5px; }
      .sparkline { font-family: ui-monospace, monospace; letter-spacing: -1px; font-size: 14px; }
      .sparkline.r5 { color: var(--accent); }
      .sparkline.ct { color: var(--ok); }
      .sparkline.ar { color: var(--warn); }
      .pin-star { color: var(--warn); margin-right: 4px; }
      .bar { display: inline-block; height: 8px; background: var(--accent); vertical-align: middle; border-radius: 2px; }
      .bar-track { display: inline-flex; align-items: center; gap: 6px; width: 100%; }
      .eval-history th { background: var(--bg-soft); }
      .eval-history td { font-size: 12.5px; }
      .eval-history .pin-btn { font-size: 11px; padding: 2px 8px; }
    </style>
  `;
}

// ----------------------------------------------------------------------
// Sub-cards
// ----------------------------------------------------------------------

function metricRow(
  latest: EvalReportSummary | null,
  pinnedSummary: EvalReportSummary | null,
  pinned: { filename: string } | null,
): Html {
  return html`
    <div class="metrics">
      ${latestCard(latest, pinnedSummary)}
      ${baselineCard(pinned, pinnedSummary, latest)}
    </div>
  `;
}

function latestCard(
  latest: EvalReportSummary | null,
  pinnedSummary: EvalReportSummary | null,
): Html {
  if (!latest) {
    return html`
      <div class="card metric-card">
        <h2 style="margin:0 0 8px;">latest eval</h2>
        <p class="empty" style="padding:14px 0;">尚无 eval 记录。点下方 <strong>Run eval</strong> 跑第一次。</p>
      </div>
    `;
  }
  const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(2));
  return html`
    <div class="card metric-card">
      <h2 style="margin: 0 0 8px; display:flex; justify-content:space-between; align-items:baseline;">
        <span>latest eval</span>
        <span class="muted mono" style="font-size: 11px;">${latest.date}</span>
      </h2>
      <div class="row">
        <span class="key">R@5</span>
        <span class="v">${fmt(latest.r_at_5)}</span>
        ${deltaSpan(latest.r_at_5, pinnedSummary?.r_at_5 ?? null)}
      </div>
      <div class="row">
        <span class="key">Citation</span>
        <span class="v">${fmt(latest.citation_pass)}</span>
        ${deltaSpan(latest.citation_pass, pinnedSummary?.citation_pass ?? null)}
      </div>
      <div class="row">
        <span class="key">Answer-rule</span>
        <span class="v">${fmt(latest.answer_rule_pass)}</span>
        ${deltaSpan(latest.answer_rule_pass, pinnedSummary?.answer_rule_pass ?? null)}
      </div>
      <p class="muted" style="font-size: 11.5px; margin: 8px 0 0;">${latest.cases ?? '—'} cases</p>
    </div>
  `;
}

function deltaSpan(curr: number | null, base: number | null): Html {
  if (curr === null || base === null) return html`<span class="delta-zero">—</span>`;
  const d = curr - base;
  if (Math.abs(d) < 0.005) return html`<span class="delta-zero">±0.00</span>`;
  const sign = d > 0 ? '+' : '';
  const cls = d > 0 ? 'delta-up' : 'delta-dn';
  return html`<span class="${cls}">${sign}${d.toFixed(2)}</span>`;
}

function baselineCard(
  pinned: { filename: string } | null,
  pinnedSummary: EvalReportSummary | null,
  latest: EvalReportSummary | null,
): Html {
  if (!pinned || !pinnedSummary) {
    return html`
      <div class="card metric-card">
        <h2 style="margin: 0 0 8px;">baseline</h2>
        <p style="font-size: 13px; margin: 4px 0 0;"><span class="muted">未 pin</span></p>
        <p class="muted" style="font-size: 11.5px; margin: 8px 0 0;">
          eval 默认对比"上一份报告"。在下面 history 表点 <code>pin</code> 钉一份当金准。
        </p>
        ${latest
          ? html`<p class="muted" style="font-size: 11.5px; margin: 6px 0 0;">last vs prior: see report below</p>`
          : ''}
      </div>
    `;
  }
  const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(2));
  return html`
    <div class="card metric-card">
      <h2 style="margin: 0 0 8px; display:flex; justify-content:space-between; align-items:baseline;">
        <span><span class="pin-star">★</span>baseline</span>
        <button id="btn-unpin-baseline" class="pin-btn">unpin</button>
      </h2>
      <div class="row">
        <span class="key">date</span>
        <span class="v mono">${pinnedSummary.date}</span>
        <span></span>
      </div>
      <div class="row">
        <span class="key">R@5</span>
        <span class="v">${fmt(pinnedSummary.r_at_5)}</span>
        <span></span>
      </div>
      <div class="row">
        <span class="key">Citation</span>
        <span class="v">${fmt(pinnedSummary.citation_pass)}</span>
        <span></span>
      </div>
      <div class="row">
        <span class="key">Answer-rule</span>
        <span class="v">${fmt(pinnedSummary.answer_rule_pass)}</span>
        <span></span>
      </div>
    </div>
  `;
}

function goldenSummaryCard(stats: {
  totalCases: number;
  byLang: Record<string, number>;
  byTag: Record<string, number>;
  byCreatedBy: Record<string, number>;
  lastEditISO: string | null;
  malformed: number;
}): Html {
  if (stats.totalCases === 0) {
    return html`
      <div class="card">
        <h2 style="margin: 0 0 8px;">golden 题集</h2>
        <p class="empty" style="padding: 10px 0;">
          尚无已批准 case。先 <strong>golden ← structure</strong> 或 <strong>golden ← runs</strong> 生成候选，<br />
          再编辑 <code class="mono">cases.candidate.jsonl</code> 把 decision 改为 <code>approved</code>，<br />
          运行 <code class="mono">anydocs-ask golden review</code> 入库。
        </p>
      </div>
    `;
  }
  const lastEdit = stats.lastEditISO ? stats.lastEditISO.slice(0, 10) : '—';
  return html`
    <div class="card">
      <h2 style="margin: 0 0 8px; display:flex; justify-content:space-between; align-items:baseline;">
        <span>golden 题集</span>
        <span class="muted mono" style="font-size: 11.5px;">${stats.totalCases} cases · last ${lastEdit}</span>
      </h2>
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; font-size: 12.5px;">
        ${bucketBlock('by lang', stats.byLang)}
        ${bucketBlock('by tag', stats.byTag)}
        ${bucketBlock('by source', stats.byCreatedBy)}
      </div>
      ${stats.malformed > 0
        ? html`<p style="color: var(--err); font-size: 11.5px; margin-top: 10px;">⚠ ${stats.malformed} malformed line(s) in cases.jsonl — see <code>anydocs-ask golden review</code></p>`
        : ''}
    </div>
  `;
}

function bucketBlock(label: string, bucket: Record<string, number>): Html {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return html`<div><p class="muted" style="font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 4px;">${label}</p><p class="muted">—</p></div>`;
  }
  const max = Math.max(...entries.map(([, v]) => v));
  return html`
    <div>
      <p class="muted" style="font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px;">${label}</p>
      ${entries.map(
        ([k, v]) => html`
          <div style="display: grid; grid-template-columns: 80px 1fr auto; gap: 6px; align-items: center; padding: 2px 0;">
            <span class="mono" style="font-size: 11.5px;">${k}</span>
            <span class="bar-track"><span class="bar" style="width: ${Math.round((v / max) * 100)}%;"></span></span>
            <span class="mono muted" style="font-size: 11px;">${v}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function runCard(history: EvalReportSummary[], pinned: { filename: string } | null): Html {
  const options = [
    html`<option value="">previous eval (default)</option>`,
    ...(pinned
      ? [html`<option value="${pinned.filename}" selected>★ pinned baseline (${pinned.filename.slice(0, 10)})</option>`]
      : []),
    ...history
      .filter((h) => !pinned || h.filename !== pinned.filename)
      .map(
        (h) =>
          html`<option value="${h.filename}">${h.date} · R@5 ${h.r_at_5?.toFixed(2) ?? '—'}</option>`,
      ),
  ];
  return html`
    <div class="card">
      <h2 style="margin: 0 0 8px;">run eval</h2>
      <div class="btn-row" style="align-items: center;">
        <label style="display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px;">
          baseline:
          <select id="eval-baseline-select" class="proj-switcher" style="min-width: 240px;">
            ${options}
          </select>
        </label>
        <button id="btn-run-eval" class="btn-primary">▶ run</button>
        <span id="eval-run-status" class="status muted"></span>
      </div>
      <p class="muted" style="font-size: 11.5px; margin: 8px 0 0;">
        runs 全部已批准 cases；中型 docs 大概 10–30s。LLM 改写候选请走命令行
        <code class="mono">anydocs-ask eval &lt;name&gt; --baseline &lt;path&gt;</code>。
      </p>
    </div>
  `;
}

function latestReportCard(
  projectName: string,
  latest: EvalReportSummary | null,
  body: string | null,
): Html {
  if (!latest || body === null) return html``;
  const bodyJson = raw(JSON.stringify(body));
  return html`
    <details class="card" id="latest-report-card" style="padding: 0;" open>
      <summary style="padding: 14px 18px; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: baseline; gap: 10px;">
        <span style="font-size: 14px; font-weight: 600; color: var(--fg-soft); text-transform: uppercase; letter-spacing: .06em;">latest report · ${latest.filename}</span>
        <span><a href="/p/${projectName}/reports/${latest.filename}" style="font-size: 12px;">open standalone →</a></span>
      </summary>
      <div style="padding: 0 18px 16px;">
        <div id="latest-report-md" class="md"></div>
        <noscript><pre class="mono" style="white-space:pre-wrap;">${body}</pre></noscript>
        <script type="module">${raw(`
          import { marked } from '/console/static/marked.esm.js';
          marked.setOptions({ breaks: true, gfm: true });
          document.getElementById('latest-report-md').innerHTML = marked.parse(${bodyJson});
        `)}</script>
      </div>
    </details>
  `;
}

function historyCard(
  projectName: string,
  history: EvalReportSummary[],
  pinnedFilename: string | null,
): Html {
  if (history.length === 0) return html``;
  // Sparklines on chronological order (oldest → newest).
  const chrono = [...history].reverse();
  const sparkR = sparkline(chrono.map((h) => h.r_at_5));
  const sparkC = sparkline(chrono.map((h) => h.citation_pass));
  const sparkA = sparkline(chrono.map((h) => h.answer_rule_pass));
  return html`
    <div class="card flush">
      <div class="card-head" style="display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline;">
        <h2 style="margin: 0;">history</h2>
        ${chrono.length >= 3
          ? html`
              <span class="muted" style="font-size: 11.5px;">trend (oldest → newest):</span>
              <span class="sparkline r5" title="R@5">R@5 ${sparkR}</span>
              <span class="sparkline ct" title="Citation">Cit ${sparkC}</span>
              <span class="sparkline ar" title="Answer-rule">Ans ${sparkA}</span>
            `
          : ''}
      </div>
      <table class="eval-history">
        <thead>
          <tr>
            <th>date</th>
            <th style="width: 60px;">R@5</th>
            <th style="width: 60px;">Cit</th>
            <th style="width: 60px;">Ans</th>
            <th style="width: 60px;">cases</th>
            <th style="width: 110px;">action</th>
          </tr>
        </thead>
        <tbody>
          ${history.map((h) => historyRow(projectName, h, pinnedFilename))}
        </tbody>
      </table>
    </div>
  `;
}

function historyRow(
  projectName: string,
  h: EvalReportSummary,
  pinnedFilename: string | null,
): Html {
  const isPinned = h.filename === pinnedFilename;
  const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(2));
  const action = isPinned
    ? html`<span class="tag warn">★ baseline</span>`
    : html`<button class="pin-btn" data-pin-filename="${h.filename}">pin</button>`;
  return html`
    <tr>
      <td>
        <a class="mono" href="/p/${projectName}/reports/${h.filename}">${h.date}</a>
      </td>
      <td class="mono">${fmt(h.r_at_5)}</td>
      <td class="mono">${fmt(h.citation_pass)}</td>
      <td class="mono">${fmt(h.answer_rule_pass)}</td>
      <td class="mono">${h.cases ?? '—'}</td>
      <td>${action}</td>
    </tr>
  `;
}

// ----------------------------------------------------------------------
// Sparkline (unicode block, zero deps)
// ----------------------------------------------------------------------

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values: Array<number | null>): string {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return SPARK_CHARS[0]!.repeat(values.length);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return values
    .map((v) => {
      if (v === null) return ' ';
      if (max === min) return SPARK_CHARS[3]!;
      const i = Math.round(((v - min) / (max - min)) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[i]!;
    })
    .join('');
}
