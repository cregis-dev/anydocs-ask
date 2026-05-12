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
import type { CandidateSnapshot } from '../golden-workshop-state.ts';
import type { GoldenCaseCandidate } from '../../golden/types.ts';

export type EvalTabViewModel = {
  projectName: string;
  snapshot: EvalTabSnapshot;
  /** Pre-loaded latest eval report body (markdown). null = no report yet. */
  latestReportBody: string | null;
  /** Golden candidate jsonl snapshot — workshop section. */
  candidates: CandidateSnapshot;
};

export function renderEvalTab(vm: EvalTabViewModel): Html {
  const { snapshot } = vm;
  const { goldenStats, history, latest, pinned, pinnedSummary } = snapshot;

  return html`
    <div class="eval-tab">
      ${metricRow(latest, pinnedSummary, pinned)}
      ${runCard(history, pinned)}
      ${latestReportCard(vm.projectName, latest, vm.latestReportBody)}
      ${goldenCasesCard(goldenStats, vm.candidates)}
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
      .gw-card .gw-summary { display:flex; gap:14px; font-size:12.5px; margin-bottom:10px; color: var(--fg-soft); }
      .gw-card .gw-summary .v { font-family: ui-monospace, monospace; font-weight: 600; color: var(--fg); }
      .gw-candidate { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; gap: 12px; padding: 10px 12px; border: 1px solid var(--bd-soft); border-radius: 6px; margin-bottom: 8px; background: var(--bg-soft); align-items: start; }
      .gw-candidate .badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: var(--bg-elev); color: var(--fg-mute); align-self: start; max-width: 130px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gw-candidate .meta { font-size: 11.5px; color: var(--fg-mute); margin-top: 4px; word-break: break-word; }
      .gw-candidate .query { font-size: 13px; font-weight: 500; word-break: break-word; }
      .gw-candidate .actions { display: flex; gap: 6px; align-self: start; }
      .gw-candidate .actions button { font-size: 11.5px; padding: 3px 10px; }
      .gw-candidate .actions .approve { background: var(--ok); border-color: var(--ok); color: white; }
      .gw-candidate .actions .reject { background: var(--err-bg); border-color: var(--err); color: var(--err); }
      .gw-card .empty-q { color: var(--fg-mute); font-size: 12.5px; padding: 18px 0; text-align: center; }
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
        <p class="empty" style="padding:14px 0;">No eval reports yet. Click <strong>▶ run</strong> below to produce the first one.</p>
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
        <p style="font-size: 13px; margin: 4px 0 0;"><span class="muted">not pinned</span></p>
        <p class="muted" style="font-size: 11.5px; margin: 8px 0 0;">
          Eval compares against the previous report by default. Click <code>pin</code>
          in the history table to lock a baseline.
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

type GoldenStats = {
  totalCases: number;
  byLang: Record<string, number>;
  byTag: Record<string, number>;
  byCreatedBy: Record<string, number>;
  lastEditISO: string | null;
  malformed: number;
};

/**
 * Unified Golden cases card — two tabs:
 *   • Approved (cases.jsonl)   the input set Run Eval consumes
 *   • Pending  (cases.candidate.jsonl)  workshop / review queue
 * Default tab is whichever side has work waiting: pending if any, else approved.
 */
function goldenCasesCard(stats: GoldenStats, candidates: CandidateSnapshot): Html {
  const approvedCount = stats.totalCases;
  const pendingCount = candidates.pending.length;
  // Show pending tab by default when there are unreviewed candidates — that's
  // the next thing the author should look at. Otherwise approved.
  const defaultTab: 'approved' | 'pending' = pendingCount > 0 ? 'pending' : 'approved';
  return html`
    <div class="card gc-card">
      <div class="card-head" style="padding: 0 0 10px; border-bottom: 1px solid var(--bd-soft); margin: -2px 0 10px;">
        <h2 style="margin: 0;">Golden cases</h2>
        <span class="muted" style="font-size: 11.5px; margin-left: 10px;">eval 用的题目集合</span>
      </div>
      <div class="tabs gc-tabs" role="tablist" style="margin: 0 0 12px;">
        <button role="tab" data-gc-tab="approved" aria-selected="${defaultTab === 'approved'}">
          Approved <span class="muted" style="font-weight: 400;">${approvedCount}</span>
        </button>
        <button role="tab" data-gc-tab="pending" aria-selected="${defaultTab === 'pending'}">
          Pending review <span class="muted" style="font-weight: 400;">${pendingCount}</span>
          ${pendingCount > 0
            ? html`<span class="gc-dot" style="background: var(--warn); width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-left: 4px; vertical-align: 2px;"></span>`
            : ''}
        </button>
      </div>
      <div data-gc-panel="approved" ${defaultTab === 'approved' ? '' : 'hidden'}>
        ${approvedPanel(stats)}
      </div>
      <div data-gc-panel="pending" ${defaultTab === 'pending' ? '' : 'hidden'}>
        ${pendingPanel(candidates)}
      </div>
    </div>
    <script>(function(){
      var tabs = document.querySelectorAll('.gc-tabs [data-gc-tab]');
      var panels = document.querySelectorAll('[data-gc-panel]');
      tabs.forEach(function(b){
        b.addEventListener('click', function(){
          var t = b.getAttribute('data-gc-tab');
          tabs.forEach(function(x){ x.setAttribute('aria-selected', x.getAttribute('data-gc-tab') === t ? 'true' : 'false'); });
          panels.forEach(function(p){ p.hidden = p.getAttribute('data-gc-panel') !== t; });
        });
      });
    })();</script>
  `;
}

function approvedPanel(stats: GoldenStats): Html {
  if (stats.totalCases === 0) {
    return html`
      <p class="empty" style="padding: 10px 0;">
        还没有审批通过的 case。先到 <strong>Pending review</strong> tab 生成候选并审批。
      </p>
    `;
  }
  const lastEdit = stats.lastEditISO ? stats.lastEditISO.slice(0, 10) : '—';
  return html`
    <p class="muted" style="font-size: 11.5px; margin: 0 0 10px;">
      ${stats.totalCases} cases · last edited ${lastEdit}
      <span style="float: right;"><code class="mono">cases.jsonl</code></span>
    </p>
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; font-size: 12.5px;">
      ${bucketBlock('by lang', stats.byLang)}
      ${bucketBlock('by tag', stats.byTag)}
      ${bucketBlock('by source', stats.byCreatedBy)}
    </div>
    ${stats.malformed > 0
      ? html`<p style="color: var(--err); font-size: 11.5px; margin-top: 10px;">⚠ ${stats.malformed} malformed line(s) — fix with <code>anydocs-ask golden review</code></p>`
      : ''}
  `;
}

function pendingPanel(snap: CandidateSnapshot): Html {
  const hasAny = snap.total > 0;
  const hasApproved = snap.approved > 0;
  return html`
    <div class="gw-summary">
      <span>pending <span class="v">${snap.pending.length}</span></span>
      <span>approved <span class="v">${snap.approved}</span></span>
      <span>rejected <span class="v">${snap.rejected}</span></span>
      ${snap.malformed > 0
        ? html`<span style="color: var(--err);">malformed <span class="v">${snap.malformed}</span></span>`
        : ''}
      <span style="flex: 1;"></span>
      <span class="muted mono" style="font-size: 11.5px;">cases.candidate.jsonl</span>
    </div>
    <div class="btn-row" style="margin-bottom: 10px; flex-wrap: wrap;">
      <button id="btn-gen-structure">+ from structure</button>
      <button id="btn-gen-runs">+ from runs</button>
      <span id="gw-gen-status" class="status muted" style="font-size: 12px;"></span>
      ${hasApproved
        ? html`
            <span style="flex:1;"></span>
            <button id="btn-gw-flush" class="btn-primary">flush ${snap.approved} approved → cases.jsonl</button>
          `
        : ''}
    </div>
    ${!hasAny
      ? html`<p class="empty-q">还没有候选。点上方按钮生成(默认无 LLM 改写;要 <code>--llm-rewrite</code> 请走命令行)。</p>`
      : snap.pending.length === 0
        ? html`<p class="empty-q">全部已审。${hasApproved ? '点 flush 把 approved 移入 cases.jsonl。' : ''}</p>`
        : html`${snap.pending.slice(0, 50).map((c) => candidateRow(c))}
            ${snap.pending.length > 50
              ? html`<p class="muted" style="font-size: 11.5px;">... 另 ${snap.pending.length - 50} 条未显示(继续审上面 50 条后会自动加载下一批)</p>`
              : ''}`}
    <p class="muted" style="font-size: 11px; margin-top: 10px;">
      UI approve/reject 等价改 jsonl 行的 <code>decision</code> 字段;flush 等价
      <code class="mono">anydocs-ask golden review</code>。
    </p>
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

function candidateRow(c: GoldenCaseCandidate): Html {
  const must = c.expected?.must_cite_pages ?? [];
  return html`
    <div class="gw-candidate" data-id="${c.id}">
      <span class="badge mono">${c.template_id ?? c.created_by}</span>
      <div>
        <div class="query">${c.query}</div>
        <div class="meta mono">
          ${c.lang} ·
          must_cite: ${must.length > 0 ? must.join(', ') : '—'}
          ${c.context_pageId ? html` · ctx ${c.context_pageId}` : ''}
        </div>
      </div>
      <div class="actions">
        <button class="approve" data-decide="approved">approve</button>
        <button class="reject" data-decide="rejected">reject</button>
      </div>
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
    <div class="card" style="border-color: var(--accent); box-shadow: 0 0 0 1px var(--run-bg);">
      <h2 style="margin: 0 0 8px; color: var(--accent);">Run eval</h2>
      <div class="btn-row" style="align-items: center;">
        <button id="btn-run-eval" class="btn-primary" style="font-size: 14px; padding: 8px 18px;">▶ run</button>
        <label style="display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--fg-soft);">
          compare against
          <select id="eval-baseline-select" class="proj-switcher" style="min-width: 240px;">
            ${options}
          </select>
        </label>
        <span id="eval-run-status" class="status muted"></span>
      </div>
      <p class="muted" style="font-size: 11.5px; margin: 8px 0 0;">
        Runs every approved case · medium docs take 10–30s.
        <details style="display:inline;"><summary style="display:inline; cursor:pointer; color: var(--fg-soft);">CLI equivalent</summary>
          <code class="mono" style="display:block; margin-top:4px;">anydocs-ask eval &lt;name&gt; --baseline &lt;path&gt;</code>
        </details>
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
