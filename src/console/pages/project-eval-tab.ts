/**
 * Eval tab — golden 题集 + metrics + baseline pin + run + history.
 *
 * Order (redesign top → bottom):
 *   1. Metric row: Latest eval card · Baseline card (side-by-side)
 *   2. Run eval — primary highlighted card with baseline selector + CLI hint
 *   3. Latest report — collapsible <details>, markdown rendered client-side
 *   4. History — table with metrics + sparkline + pin button per row
 *   5. Golden cases — inner tabs (Approved | Pending review)
 *
 * Approve/reject + flush wiring lives in project.ts BOOTSTRAP_SCRIPT.
 */

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';
import type { EvalTabSnapshot, EvalReportSummary, GoldenSetStats } from '../eval-state.ts';
import type { CandidateSnapshot } from '../golden-workshop-state.ts';
import type { GoldenCaseCandidate } from '../../golden/types.ts';

export type EvalTabViewModel = {
  projectName: string;
  snapshot: EvalTabSnapshot;
  latestReportBody: string | null;
  candidates: CandidateSnapshot;
};

export function renderEvalTab(vm: EvalTabViewModel): Html {
  const { snapshot } = vm;
  const { goldenStats, history, latest, pinned, pinnedSummary } = snapshot;
  const hasCases = goldenStats.totalCases > 0;
  return html`
    <div class="eval-tab" style="display: flex; flex-direction: column; gap: var(--s-5);">
      ${!hasCases ? noCasesBanner() : ''}
      <div class="kpis" style="grid-template-columns: 1fr 1fr;">
        ${latestCard(latest, pinnedSummary)}
        ${baselineCard(pinned, pinnedSummary)}
      </div>
      ${runCard(history, pinned, goldenStats.totalCases)}
      ${latestReportDetails(vm.projectName, latest, vm.latestReportBody)}
      ${history.length > 0 ? historyCard(vm.projectName, history, pinned?.filename ?? null) : ''}
      ${goldenCasesCard(goldenStats, vm.candidates)}
    </div>
    ${tabSwitchScript()}
    ${gwExtraStyles()}
  `;
}

function noCasesBanner(): Html {
  return html`
    <div class="banner info">
      <span class="b-ico"><svg><use href="#i-info"/></svg></span>
      <div class="b-bd">
        <div class="b-ti">Seed your golden case set first</div>
        <div class="b-de">Eval runs against approved cases. Generate candidates from your nav structure to bootstrap.</div>
      </div>
      <div class="b-act">
        <button id="btn-gen-structure" class="btn primary sm">
          <svg><use href="#i-plus"/></svg> from structure
        </button>
      </div>
    </div>
  `;
}

function latestCard(
  latest: EvalReportSummary | null,
  pinnedSummary: EvalReportSummary | null,
): Html {
  if (!latest) {
    return html`
      <div class="card">
        <div class="card-hd"><h2>Latest eval</h2></div>
        <div class="card-bd" style="text-align: center; padding: var(--s-6) var(--s-4);">
          <div style="color: var(--fg-mute); font-size: var(--t-13);">No eval run yet · 还没跑过</div>
          <div style="margin-top: var(--s-2); font-size: var(--t-12); color: var(--fg-soft);">
            Run your first eval against the approved case set.
          </div>
        </div>
      </div>
    `;
  }
  const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(2));
  const cases = latest.cases ?? '—';
  return html`
    <div class="card">
      <div class="card-hd"><h2>Latest eval</h2><span class="meta">${latest.date} · ${cases} cases</span></div>
      <div class="card-bd">
        <div class="kpis metric-kpis" style="gap: var(--s-3) var(--s-4);">
          <div>
            <div class="k-lab">R@5</div>
            <div class="k-val" style="font-size: var(--t-24);">${fmt(latest.r_at_5)} ${deltaSpan(latest.r_at_5, pinnedSummary?.r_at_5 ?? null)}</div>
          </div>
          <div>
            <div class="k-lab">Citation</div>
            <div class="k-val" style="font-size: var(--t-24);">${fmt(latest.citation_pass)} ${deltaSpan(latest.citation_pass, pinnedSummary?.citation_pass ?? null)}</div>
          </div>
          <div>
            <div class="k-lab">Answer-rule</div>
            <div class="k-val" style="font-size: var(--t-24);">${fmt(latest.answer_rule_pass)} ${deltaSpan(latest.answer_rule_pass, pinnedSummary?.answer_rule_pass ?? null)}</div>
          </div>
        </div>
        <div style="margin-top: var(--s-3); font-size: var(--t-12); color: var(--fg-soft);">
          ${cases} cases
        </div>
      </div>
    </div>
  `;
}

function deltaSpan(curr: number | null, base: number | null): Html {
  if (curr === null || base === null) return html``;
  const d = curr - base;
  if (Math.abs(d) < 0.005) return html`<span class="delta flat">±0.00</span>`;
  const sign = d > 0 ? '+' : '−';
  const cls = d > 0 ? 'delta up' : 'delta down';
  return html`<span class="${cls}">${sign}${Math.abs(d).toFixed(2)}</span>`;
}

function baselineCard(
  pinned: { filename: string } | null,
  pinnedSummary: EvalReportSummary | null,
): Html {
  if (!pinned || !pinnedSummary) {
    return html`
      <div class="card">
        <div class="card-hd"><h2>Baseline</h2></div>
        <div class="card-bd" style="text-align: center; padding: var(--s-6) var(--s-4);">
          <div style="color: var(--fg-mute); font-size: var(--t-13);">Not pinned</div>
          <div style="margin-top: var(--s-2); font-size: var(--t-12); color: var(--fg-soft);">
            After a few evals, pin one in the history table to track regressions.
          </div>
        </div>
      </div>
    `;
  }
  const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(2));
  return html`
    <div class="card">
      <div class="card-hd">
        <h2>Baseline
          <span class="tag" style="margin-left: 6px;">
            <svg style="width: 10px; height: 10px; color: var(--accent);"><use href="#i-pin-f"/></svg> pinned
          </span>
        </h2>
        <span class="meta">${pinnedSummary.date}</span>
        <button id="btn-unpin-baseline" class="btn sm ghost" title="unpin">
          <svg><use href="#i-x"/></svg>
        </button>
      </div>
      <div class="card-bd">
        <div class="kpis metric-kpis" style="gap: var(--s-3) var(--s-4);">
          <div><div class="k-lab">R@5</div><div class="k-val" style="font-size: var(--t-20);">${fmt(pinnedSummary.r_at_5)}</div></div>
          <div><div class="k-lab">Citation</div><div class="k-val" style="font-size: var(--t-20);">${fmt(pinnedSummary.citation_pass)}</div></div>
          <div><div class="k-lab">Answer-rule</div><div class="k-val" style="font-size: var(--t-20);">${fmt(pinnedSummary.answer_rule_pass)}</div></div>
        </div>
        <div style="margin-top: var(--s-3); font-size: var(--t-12); color: var(--fg-soft);">
          pinned baseline · ${pinnedSummary.cases ?? '—'} cases
        </div>
      </div>
    </div>
  `;
}

function runCard(
  history: EvalReportSummary[],
  pinned: { filename: string } | null,
  totalCases: number,
): Html {
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
    html`<option value="__none__">nothing — show raw values</option>`,
  ];
  const headline = totalCases === 0
    ? 'No approved cases yet — generate from structure first'
    : `Run all ${totalCases} approved case${totalCases === 1 ? '' : 's'} against the live project`;
  return html`
    <section class="card primary">
      <div class="card-hd">
        <h2><svg style="width: 14px; height: 14px;"><use href="#i-act"/></svg> Run eval</h2>
      </div>
      <div class="card-bd">
        <div style="display: flex; align-items: flex-end; gap: var(--s-4); flex-wrap: wrap;">
          <div style="flex: 1; min-width: 260px;">
            <div style="font-weight: 600; font-size: var(--t-15); margin-bottom: 4px;">${headline}</div>
            <div style="font-size: var(--t-13); color: var(--fg-soft);">
              Medium docs take 10–30s. Results are written to <code class="inline">YYYY-MM-DD-eval.md</code> under reports/.
            </div>
          </div>
          <div class="field" style="min-width: 200px;">
            <label>compare to</label>
            <select id="eval-baseline-select" class="select">${options}</select>
          </div>
          <button id="btn-run-eval" class="btn primary lg" ${totalCases === 0 ? 'disabled' : ''}>
            <svg><use href="#i-play"/></svg> run eval
          </button>
        </div>
        <p id="eval-run-status" class="status" style="margin-top: var(--s-3);"></p>
        <details style="margin-top: var(--s-4);">
          <summary style="font-size: var(--t-12); color: var(--fg-soft); cursor: pointer;">CLI equivalent</summary>
          <pre class="block" style="margin-top: var(--s-2);">anydocs-ask <span class="kw">eval</span> &lt;project&gt;${pinned ? ` --baseline ${pinned.filename.slice(0, 10)}` : ''}</pre>
        </details>
      </div>
    </section>
  `;
}

function latestReportDetails(
  projectName: string,
  latest: EvalReportSummary | null,
  body: string | null,
): Html {
  if (!latest || body === null) return html``;
  const bodyJson = raw(JSON.stringify(body));
  const kb = (latest.sizeBytes / 1024).toFixed(1);
  return html`
    <details id="latest-report-card">
      <summary style="font-size: var(--t-13); color: var(--fg); cursor: pointer; padding: var(--s-3) var(--s-4); border: 1px solid var(--bd); border-radius: var(--r-4); background: var(--bg-elev); display: flex; justify-content: space-between; align-items: center; box-shadow: var(--sh-1);">
        <span><b>Latest eval report</b> <span style="color: var(--fg-soft); font-weight: 400;">· ${latest.filename} · ${kb} KB</span></span>
        <span style="color: var(--fg-soft); font-size: var(--t-12);">
          <a href="/p/${projectName}/reports/${latest.filename}">open standalone →</a>
        </span>
      </summary>
      <div class="card" style="border-top: 0; border-top-left-radius: 0; border-top-right-radius: 0; margin-top: -1px; padding: var(--s-5);">
        <div id="latest-report-md" class="md"></div>
        <noscript><pre class="block">${body}</pre></noscript>
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
  // Build per-metric sparkline points (oldest → newest)
  const chrono = [...history].reverse();
  return html`
    <section class="card flush">
      <div class="card-hd" style="padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--bd-soft);">
        <h2>History</h2>
        <span class="meta">${history.length} run${history.length === 1 ? '' : 's'}</span>
      </div>
      <div class="card-bd flush">
        <table class="tbl">
          <thead>
            <tr>
              <th>date</th>
              <th class="num">R@5</th>
              <th class="num">Citation</th>
              <th class="num">Answer-rule</th>
              <th>trend</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${history.map((h, idx) => historyRow(projectName, h, chrono, idx, pinnedFilename))}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function historyRow(
  projectName: string,
  h: EvalReportSummary,
  chrono: EvalReportSummary[],
  newestIdx: number,
  pinnedFilename: string | null,
): Html {
  const isPinned = h.filename === pinnedFilename;
  const fmt = (x: number | null): string => (x === null ? '—' : x.toFixed(2));
  // sparkline for R@5 across all history, anchor the latest with the row's
  // own value. Show as polyline svg matching the design.
  const sparkVals = chrono.map((c) => c.r_at_5);
  const polyline = svgPolyline(sparkVals);
  const action = isPinned
    ? html`<button id="btn-unpin-baseline" class="icon-btn" title="unpin"><svg><use href="#i-x"/></svg></button>`
    : html`<button class="icon-btn" data-pin-filename="${h.filename}" title="pin as baseline"><svg><use href="#i-pin"/></svg></button>`;
  const isNewest = newestIdx === 0;
  void isNewest;
  const rowStyle = isPinned
    ? 'background: color-mix(in srgb, var(--accent-soft) 50%, transparent);'
    : '';
  return html`
    <tr style="${rowStyle}">
      <td><a class="mono" href="/p/${projectName}/reports/${h.filename}">${h.date}</a></td>
      <td class="num">${newestIdx === 0 ? html`<b>${fmt(h.r_at_5)}</b>` : fmt(h.r_at_5)}</td>
      <td class="num">${newestIdx === 0 ? html`<b>${fmt(h.citation_pass)}</b>` : fmt(h.citation_pass)}</td>
      <td class="num">${newestIdx === 0 ? html`<b>${fmt(h.answer_rule_pass)}</b>` : fmt(h.answer_rule_pass)}</td>
      <td>${isPinned
        ? html`<span class="tag" style="color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 25%, transparent);">
            <svg style="width: 10px; height: 10px;"><use href="#i-pin-f"/></svg> baseline
          </span>`
        : raw(polyline)}</td>
      <td>${action}</td>
    </tr>
  `;
}

function svgPolyline(values: Array<number | null>): string {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length < 2) {
    return `<span class="muted" style="font-size:11px;">—</span>`;
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * 80;
      const y = v === null ? 11 : 20 - ((v - min) / span) * 18;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  // Slope: increasing → green, decreasing → red, flat → muted
  const first = valid[0]!;
  const last = valid[valid.length - 1]!;
  const cls = last > first + 0.005 ? 'ok' : last < first - 0.005 ? 'err' : '';
  return `<svg class="spark ${cls}" viewBox="0 0 80 22"><polyline points="${pts}"/></svg>`;
}

function goldenCasesCard(stats: GoldenSetStats, candidates: CandidateSnapshot): Html {
  const approvedCount = stats.totalCases;
  const pendingCount = candidates.pending.length;
  const defaultTab: 'approved' | 'pending' = pendingCount > 0 ? 'pending' : 'approved';
  return html`
    <section class="card gc-card">
      <div class="card-hd">
        <h2>Golden cases</h2>
        <nav class="tabs inner gc-tabs" role="tablist" style="margin: 0; border: 0; padding: 0;">
          <button class="tab ${defaultTab === 'approved' ? 'active' : ''}" role="tab" data-gc-tab="approved" aria-selected="${defaultTab === 'approved'}" style="padding: 6px 10px;">
            Approved <span class="cnt">${approvedCount}</span>
          </button>
          <button class="tab ${defaultTab === 'pending' ? 'active' : ''}" role="tab" data-gc-tab="pending" aria-selected="${defaultTab === 'pending'}" style="padding: 6px 10px;">
            Pending review <span class="cnt">${pendingCount}</span>
          </button>
        </nav>
      </div>
      <div data-gc-panel="approved" ${defaultTab === 'approved' ? '' : 'hidden'}>
        ${approvedPanel(stats)}
      </div>
      <div data-gc-panel="pending" ${defaultTab === 'pending' ? '' : 'hidden'}>
        ${pendingPanel(candidates)}
      </div>
    </section>
  `;
}

function approvedPanel(stats: GoldenSetStats): Html {
  if (stats.totalCases === 0) {
    return html`
      <div class="card-bd">
        <div class="empty">
          <div class="e-ico"><svg><use href="#i-check"/></svg></div>
          <h3>No golden cases yet</h3>
          <p>Golden cases are questions you've vetted as "should be answerable from these docs". Generate candidates from your nav structure, approve the good ones, then run eval.</p>
          <div class="e-cta">
            <button id="btn-gen-structure" class="btn primary">
              <svg><use href="#i-plus"/></svg> generate from structure
            </button>
            <button id="btn-gen-runs" class="btn">from past runs</button>
          </div>
        </div>
      </div>
    `;
  }
  const lastEdit = stats.lastEditISO ? stats.lastEditISO.slice(0, 10) : '—';
  const kb = '—'; // size unknown without statting the file here
  void kb;
  return html`
    <div class="card-bd">
      <div style="display: flex; gap: var(--s-4); font-size: var(--t-13); color: var(--fg-soft); margin-bottom: var(--s-4);">
        <span><b style="color: var(--fg);">${stats.totalCases}</b> active cases</span>
        <span>edited <b style="color: var(--fg);">${lastEdit}</b></span>
        <span><code class="inline">cases.jsonl</code></span>
      </div>
      <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-5);">
        ${bucketBlock('by lang', stats.byLang)}
        ${bucketBlock('by tag', stats.byTag)}
        ${bucketBlock('by source', stats.byCreatedBy)}
      </div>
      ${stats.malformed > 0
        ? html`<p style="color: var(--err); font-size: var(--t-12); margin-top: var(--s-3);">⚠ ${stats.malformed} malformed line(s) — fix with <code class="inline">anydocs-ask golden review</code></p>`
        : ''}
    </div>
  `;
}

const PENDING_PAGE_SIZE = 20;

function pendingPanel(snap: CandidateSnapshot): Html {
  const hasAny = snap.total > 0;
  const hasApproved = snap.approved > 0;
  const pendingJson = raw(JSON.stringify(snap.pending));
  return html`
    <div class="card-bd" style="display: flex; gap: var(--s-4); align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--bd-soft); padding: var(--s-3) var(--s-5);">
      <div style="display: flex; gap: var(--s-4); font-size: var(--t-13);">
        <span><b style="color: var(--warn);">${snap.pending.length}</b> <span style="color: var(--fg-soft);">pending</span></span>
        <span><b style="color: var(--ok);">${snap.approved}</b> <span style="color: var(--fg-soft);">newly approved</span></span>
        <span><b style="color: var(--fg-mute);">${snap.rejected}</b> <span style="color: var(--fg-soft);">rejected</span></span>
        ${snap.malformed > 0
          ? html`<span style="color: var(--err);">⚠ ${snap.malformed} malformed</span>`
          : ''}
      </div>
      <div style="margin-left: auto; display: flex; gap: var(--s-2); align-items: center;">
        <button id="btn-gen-structure" class="btn"><svg><use href="#i-plus"/></svg> from structure</button>
        <label class="muted" style="display: inline-flex; align-items: center; gap: 4px; font-size: var(--t-12);">
          limit
          <input id="gw-gen-limit" class="input" type="number" min="1" max="500" value="50" style="width: 64px; padding: 4px 6px;" />
        </label>
        <button id="btn-gen-runs" class="btn"><svg><use href="#i-plus"/></svg> from runs</button>
        ${hasApproved
          ? html`<button id="btn-gw-flush" class="btn primary">flush ${snap.approved} → cases.jsonl</button>`
          : ''}
      </div>
    </div>
    <p id="gw-gen-status" class="status" style="padding: 0 var(--s-5); margin: var(--s-2) 0 0;"></p>
    <pre id="gw-gen-log" class="gw-gen-log" hidden></pre>
    <div class="card-bd flush">
      ${!hasAny
        ? html`<div class="empty"><div class="e-ico"><svg><use href="#i-plus"/></svg></div><h3>No candidates yet</h3><p>Click "from structure" or "from runs" above to seed.
          Generation runs LLM rewrite by default; it falls back to template phrasing when Anthropic credentials are absent.</p></div>`
        : snap.pending.length === 0
          ? html`<div class="empty"><div class="e-ico"><svg><use href="#i-check"/></svg></div><h3>All reviewed</h3><p>${hasApproved ? 'Click flush to move approved candidates into cases.jsonl.' : ''}</p></div>`
          : html`
            <div class="cand-list" id="gw-pending-list" data-page-size="${PENDING_PAGE_SIZE}">
              ${snap.pending.map((c, idx) => candidateRow(c, idx))}
            </div>
            ${snap.pending.length > PENDING_PAGE_SIZE
              ? html`
                  <div class="gw-pager" id="gw-pager">
                    <button id="gw-pager-prev" class="btn sm" type="button">‹ prev</button>
                    <span class="info" id="gw-pager-info"></span>
                    <button id="gw-pager-next" class="btn sm" type="button">next ›</button>
                  </div>
                `
              : ''}
          `}
    </div>
    <script>${raw(`window.__GW_PENDING__ = ${pendingJson};`)}</script>
    ${snap.pending.length > 0 ? editModal() : ''}
  `;
}

function bucketBlock(label: string, bucket: Record<string, number>): Html {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return html`<div>
      <div style="font-size: var(--t-12); color: var(--fg-soft); letter-spacing: .04em; margin-bottom: 8px; text-transform: uppercase;">${label}</div>
      <p class="muted" style="font-size: var(--t-12);">—</p>
    </div>`;
  }
  const max = Math.max(...entries.map(([, v]) => v));
  return html`
    <div>
      <div style="font-size: var(--t-12); color: var(--fg-soft); letter-spacing: .04em; margin-bottom: 8px; text-transform: uppercase;">${label}</div>
      <div class="bars">
        ${entries.map(
          ([k, v]) => html`
            <div class="bar-row">
              <span class="b-lab">${k}</span>
              <div class="b-bar"><i style="width: ${Math.round((v / max) * 100)}%;"></i></div>
              <span class="b-num">${v}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function candidateRow(c: GoldenCaseCandidate, idx: number): Html {
  const must = c.expected?.must_cite_pages ?? [];
  return html`
    <div class="cand-row gw-candidate" data-id="${c.id}" data-idx="${idx}">
      <span class="c-badge">
        <span class="tag">${c.template_id ?? c.created_by}</span>
      </span>
      <div>
        <div class="c-q">${c.query}</div>
        <div class="c-meta">
          <span>${c.lang}</span>
          <span>must_cite: ${must.length > 0 ? must.join(', ') : '—'}</span>
          ${c.context_pageId ? html`<span>ctx: ${c.context_pageId}</span>` : ''}
        </div>
      </div>
      <div class="c-act">
        <button class="btn sm ghost" data-edit="1">edit</button>
        <button class="btn sm" data-decide="approved">
          <svg><use href="#i-check"/></svg> approve
        </button>
        <button class="btn sm ghost" data-decide="rejected" title="reject">
          <svg><use href="#i-x"/></svg>
        </button>
      </div>
    </div>
  `;
}

function tabSwitchScript(): Html {
  return html`<script>${raw(`
    (function(){
      var tabs = document.querySelectorAll('.gc-tabs [data-gc-tab]');
      var panels = document.querySelectorAll('[data-gc-panel]');
      tabs.forEach(function(b){
        b.addEventListener('click', function(){
          var t = b.getAttribute('data-gc-tab');
          tabs.forEach(function(x){
            x.setAttribute('aria-selected', x.getAttribute('data-gc-tab') === t ? 'true' : 'false');
            if (x.getAttribute('data-gc-tab') === t) x.classList.add('active'); else x.classList.remove('active');
          });
          panels.forEach(function(p){ p.hidden = p.getAttribute('data-gc-panel') !== t; });
        });
      });
    })();
  `)}</script>`;
}

// Edit-candidate modal. Read-only fields (template_id, created_by) show in
// the header for context; the rest are editable and POSTed as a patch by
// bindGwEdit in project.ts BOOTSTRAP_SCRIPT.
function editModal(): Html {
  return html`
    <div class="gw-modal-backdrop" id="gw-edit-backdrop" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="gw-modal">
        <h3>Edit candidate <span class="ro" id="gw-edit-id" style="margin-left: 8px;"></span></h3>
        <div class="body">
          <div class="row"><label>template_id</label><span class="ro" id="gw-edit-template"></span></div>
          <div class="row"><label>created_by</label><span class="ro" id="gw-edit-created-by"></span></div>
          <div class="row">
            <label>query *</label>
            <textarea id="gw-edit-query" class="textarea" rows="2" style="min-height: 0;"></textarea>
          </div>
          <div class="row">
            <label>lang</label>
            <select id="gw-edit-lang" class="select">
              <option value="zh">zh</option>
              <option value="en">en</option>
            </select>
          </div>
          <div class="row">
            <label>context_pageId</label>
            <input id="gw-edit-context" class="input" type="text" placeholder="(none)" />
          </div>
          <div class="row">
            <label>filters.audience</label>
            <input id="gw-edit-audience" class="input" type="text" placeholder="(none)" />
          </div>
          <div class="row">
            <label>filters.version</label>
            <input id="gw-edit-version" class="input" type="text" placeholder="(none)" />
          </div>
          <div class="row">
            <label>tags</label>
            <input id="gw-edit-tags" class="input" type="text" placeholder="comma-separated" />
          </div>
          <div class="row">
            <label>must_cite_pages</label>
            <textarea id="gw-edit-mustcite" class="textarea mono" rows="2" placeholder="comma-separated page slugs" style="min-height: 0;"></textarea>
          </div>
          <div class="row">
            <label>must_contain</label>
            <textarea id="gw-edit-mustcontain" class="textarea mono" rows="2" placeholder="comma-separated substrings" style="min-height: 0;"></textarea>
          </div>
          <div class="row">
            <label>forbid_contain</label>
            <textarea id="gw-edit-forbid" class="textarea mono" rows="2" placeholder="comma-separated substrings" style="min-height: 0;"></textarea>
          </div>
          <div class="row">
            <label>note</label>
            <textarea id="gw-edit-note" class="textarea" rows="2" style="min-height: 0;"></textarea>
          </div>
        </div>
        <div class="foot">
          <span class="status" id="gw-edit-status"></span>
          <button type="button" id="gw-edit-cancel" class="btn">cancel</button>
          <button type="button" id="gw-edit-save" class="btn primary">save</button>
        </div>
      </div>
    </div>
  `;
}

// Scoped styles for the golden-workshop additions merged from main: the
// streaming generate log, the pending-review pager, and the edit modal.
// These cohabit with the design-system tokens in layout.ts BASE_CSS.
function gwExtraStyles(): Html {
  return html`<style>${raw(`
    .gw-gen-log {
      font-family: var(--font-mono); font-size: var(--t-12); line-height: 1.55;
      max-height: 220px; overflow-y: auto;
      background: var(--bg-elev); border: 1px solid var(--bd-soft);
      border-radius: var(--r-3); padding: var(--s-3);
      margin: var(--s-2) var(--s-5) 0; white-space: pre-wrap; word-break: break-word;
      color: var(--fg-soft);
    }
    .gw-gen-log .ok { color: var(--ok); }
    .gw-gen-log .err { color: var(--err); }
    .gw-gen-log .dim { color: var(--fg-mute); }
    .gw-pager {
      display: flex; gap: var(--s-2); align-items: center; justify-content: center;
      padding: var(--s-3) var(--s-5); font-size: var(--t-12);
      border-top: 1px solid var(--bd-soft);
    }
    .gw-pager .info { color: var(--fg-mute); font-family: var(--font-mono); }
    .gw-modal-backdrop {
      position: fixed; inset: 0; background: rgba(20,20,18,.36);
      display: none; z-index: 100; align-items: center; justify-content: center;
      padding: var(--s-5);
    }
    .gw-modal-backdrop.show { display: flex; }
    .gw-modal {
      background: var(--bg-elev); border: 1px solid var(--bd);
      border-radius: var(--r-5); box-shadow: var(--sh-pop);
      width: 100%; max-width: 640px; max-height: calc(100vh - 40px);
      display: flex; flex-direction: column;
    }
    .gw-modal h3 {
      margin: 0; padding: var(--s-4) var(--s-5);
      border-bottom: 1px solid var(--bd-soft); font-size: var(--t-15); font-weight: 600;
    }
    .gw-modal .body { padding: var(--s-4) var(--s-5); overflow-y: auto; }
    .gw-modal .row {
      display: grid; grid-template-columns: 130px 1fr;
      gap: var(--s-3); align-items: baseline; padding: 6px 0;
    }
    .gw-modal .row label { font-size: var(--t-12); color: var(--fg-soft); }
    .gw-modal .row .ro { color: var(--fg-mute); font-family: var(--font-mono); font-size: var(--t-12); }
    .gw-modal .foot {
      padding: var(--s-3) var(--s-5); border-top: 1px solid var(--bd-soft);
      display: flex; gap: var(--s-2); justify-content: flex-end; align-items: center;
    }
    .gw-modal .foot .status { flex: 1; }
  `)}</style>`;
}
