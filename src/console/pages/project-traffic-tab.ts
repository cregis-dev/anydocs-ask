/**
 * Traffic tab — ARCH §17.3.6.
 *
 * Health KPI strip + filterable runs table + analyze section.
 * Rolls up the rolling 7-day window from `loadTrafficWindow`. The runs
 * table supports expandable rows (full fused retrieval + answer markdown +
 * re-ask) — expansion JS lives in the inline TRAFFIC_SCRIPT below.
 */

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';
import type { TrafficWindow } from '../traffic-state.ts';
import { runSource } from '../../runs/types.ts';
import type { RunRecord } from '../../runs/types.ts';
import type { AnalyzeReportSummary } from '../eval-state.ts';

export type TrafficTabViewModel = {
  projectName: string;
  window: TrafficWindow;
  analyzeHistory: AnalyzeReportSummary[];
  latestAnalyzeBody: string | null;
};

export function renderTrafficTab(vm: TrafficTabViewModel): Html {
  const { window: w } = vm;
  const noRuns = w.records.length === 0;
  const showAnalyze = !noRuns || vm.analyzeHistory.length > 0;
  return html`
    <div class="traffic-tab" style="display: flex; flex-direction: column; gap: var(--s-5);">
      ${noRuns ? '' : trafficHealthBanner(w)}
      ${noRuns ? emptyCard() : html`
        ${healthStrip(w)}
        ${runsCard(w)}
      `}
      ${showAnalyze ? analyzeCard(vm.projectName, vm.analyzeHistory, vm.latestAnalyzeBody) : ''}
    </div>
    <script>${raw(`window.__TRAFFIC__ = ${JSON.stringify([...w.records].reverse())};`)}</script>
    <script type="module">${raw(TRAFFIC_SCRIPT)}</script>
  `;
}

function trafficHealthBanner(w: TrafficWindow): Html {
  // Surface a banner only when something concerning crossed a threshold.
  const t = w.totals;
  if (t.errorRate > 0.05) {
    return html`
      <div class="banner err">
        <span class="b-ico"><svg><use href="#i-err"/></svg></span>
        <div class="b-bd">
          <div class="b-ti">Last ${w.days}d error rate ${(t.errorRate * 100).toFixed(1)}%</div>
          <div class="b-de">Filter kind=error in the table below to see the failing requests.</div>
        </div>
      </div>
    `;
  }
  if (t.p95LatencyMs !== null && t.p95LatencyMs > 3000) {
    return html`
      <div class="banner warn">
        <span class="b-ico"><svg><use href="#i-alert"/></svg></span>
        <div class="b-bd">
          <div class="b-ti">P95 latency ${(t.p95LatencyMs / 1000).toFixed(1)}s</div>
          <div class="b-de">Median is ${t.p50LatencyMs ? Math.round(t.p50LatencyMs) + 'ms' : '—'}. Run analyze for the breakdown.</div>
        </div>
      </div>
    `;
  }
  return html``;
}

function emptyCard(): Html {
  return html`
    <section class="card">
      <div class="card-bd">
        <div class="empty">
          <div class="e-ico"><svg><use href="#i-chart"/></svg></div>
          <h3>No traffic yet</h3>
          <p>Once a Reader client or this console hits <code class="inline">/v1/ask</code>, you'll see
            request volume, confidence, latency, and error trends here over a rolling 7-day window.</p>
          <div class="e-cta">
            <a href="#ask" class="btn primary">
              <svg><use href="#i-chat"/></svg> dogfood from the Ask tab
            </a>
          </div>
        </div>
      </div>
    </section>
  `;
}

function healthStrip(w: TrafficWindow): Html {
  const t = w.totals;
  const fmt = (n: number | null, d = 2): string => (n === null ? '—' : n.toFixed(d));
  const ms = (n: number | null): string =>
    n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const sparkCount = svgPolyline(w.perDay.map((d) => d.count), 'accent');
  const sparkConf = svgPolyline(w.perDay.map((d) => d.meanConfidence), 'ok');
  const latencyWarn = t.p95LatencyMs !== null && t.p95LatencyMs > 3000;
  const errWarn = t.errorRate > 0.05;
  return html`
    <div class="kpis" style="grid-template-columns: repeat(4, 1fr);">
      <div class="kpi">
        <div class="k-lab">queries · ${w.days}d</div>
        <div class="k-val">${t.count}</div>
        <div class="k-foot">reader ${t.countReader} · console ${t.countConsole}</div>
        ${raw(`<div style="margin-top:6px;">${sparkCount}</div>`)}
      </div>
      <div class="kpi">
        <div class="k-lab">mean confidence</div>
        <div class="k-val">${fmt(t.meanConfidence)}</div>
        <div class="k-foot" style="color: ${t.meanConfidence !== null && t.meanConfidence < 0.5 ? 'var(--warn)' : 'var(--ok)'};">
          across all kinds
        </div>
        ${raw(`<div style="margin-top:6px;">${sparkConf}</div>`)}
      </div>
      <div class="kpi${latencyWarn ? ' warn' : ''}">
        <div class="k-lab">p95 latency</div>
        <div class="k-val">${ms(t.p95LatencyMs)}</div>
        <div class="k-foot">p50 ${ms(t.p50LatencyMs)}${latencyWarn ? html` · <span style="color: var(--warn);">slow</span>` : ''}</div>
      </div>
      <div class="kpi${errWarn ? ' err' : ''}">
        <div class="k-lab">non-answer rate</div>
        <div class="k-val">${pct(t.errorRate + t.clarifyRate)}</div>
        <div class="k-foot">${pct(t.errorRate)} error · ${pct(t.clarifyRate)} clarify</div>
      </div>
    </div>
  `;
}

function svgPolyline(values: Array<number | null>, cls: 'accent' | 'ok' | 'warn' | 'err'): string {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length < 2) return '';
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
  return `<svg class="spark ${cls}" viewBox="0 0 80 22" style="width:100%;"><polyline points="${pts}"/></svg>`;
}

function runsCard(w: TrafficWindow): Html {
  const ordered = [...w.records].reverse();
  return html`
    <section class="card flush">
      <div class="card-hd">
        <h2>Recent runs</h2>
        <div class="actions" style="display: flex; gap: var(--s-2); align-items: center;">
          <div style="position: relative;">
            <svg style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: 13px; height: 13px; color: var(--fg-mute);"><use href="#i-search"/></svg>
            <input id="tf-q" class="input" type="search" placeholder="filter query, source, kind…" style="padding-left: 28px; height: 30px; width: 280px; font-size: var(--t-13);" autocomplete="off" />
          </div>
          <select id="tf-source" class="select" style="height: 30px; padding: 0 24px 0 10px; font-size: var(--t-12); width: auto;">
            <option value="">all sources</option>
            <option value="reader">reader</option>
            <option value="console">console</option>
          </select>
          <select id="tf-kind" class="select" style="height: 30px; padding: 0 24px 0 10px; font-size: var(--t-12); width: auto;">
            <option value="">all kinds</option>
            <option value="answer">answer</option>
            <option value="clarify">clarify</option>
            <option value="error">error</option>
          </select>
          <select id="tf-conf" class="select" style="height: 30px; padding: 0 24px 0 10px; font-size: var(--t-12); width: auto;">
            <option value="">conf any</option>
            <option value="0.8">conf ≥ 0.8</option>
            <option value="0.6">conf ≥ 0.6</option>
            <option value="0.4">conf ≥ 0.4</option>
          </select>
        </div>
      </div>
      <div class="card-bd flush">
        <table class="tbl" id="traffic-tbl">
          <thead>
            <tr>
              <th style="width: 80px;">time</th>
              <th style="width: 90px;">source</th>
              <th>question</th>
              <th class="num" style="width: 70px;">kind</th>
              <th class="num" style="width: 56px;">conf</th>
              <th class="num" style="width: 70px;">latency</th>
            </tr>
          </thead>
          <tbody id="tf-body">${ordered.map((r, i) => trafficRow(r, i))}</tbody>
        </table>
      </div>
    </section>
  `;
}

function trafficRow(r: RunRecord, idx: number): Html {
  const a = r.answer;
  const kindCls = a.kind === 'answer' ? 'ok' : a.kind === 'clarify' ? 'warn' : 'err';
  const conf = a.confidence !== null ? a.confidence.toFixed(2) : '—';
  const src = runSource(r);
  const latencyText = a.latency_ms >= 1000 ? `${(a.latency_ms / 1000).toFixed(1)}s` : `${Math.round(a.latency_ms)}ms`;
  return html`
    <tr class="expandable" data-idx="${idx}"
        data-kind="${a.kind}"
        data-conf="${a.confidence ?? -1}"
        data-source="${src}"
        data-q="${(r.query ?? '').toLowerCase()}">
      <td class="mono">${r.ts.slice(11, 19)}</td>
      <td><span class="tag">${src}</span></td>
      <td>${r.query}</td>
      <td class="num"><span class="tag ${kindCls}">${a.kind}</span></td>
      <td class="num">${conf === '—' ? html`<span class="muted">—</span>` : conf}</td>
      <td class="num">${latencyText}</td>
    </tr>
  `;
}

function analyzeCard(
  projectName: string,
  history: AnalyzeReportSummary[],
  latestBody: string | null,
): Html {
  const latest = history[0];
  const latestBodyJson = latestBody !== null ? raw(JSON.stringify(latestBody)) : 'null';
  return html`
    <section class="card">
      <div class="card-hd">
        <h2><svg style="width: 14px; height: 14px;"><use href="#i-chart"/></svg> Analyze runs</h2>
        ${latest
          ? html`<span class="meta">latest · ${latest.date}</span>`
          : html`<span class="meta">no report yet</span>`}
      </div>
      <div class="card-bd">
        <div style="display: flex; align-items: flex-end; gap: var(--s-4); flex-wrap: wrap;">
          <div style="flex: 1; min-width: 260px;">
            <div style="font-weight: 600; font-size: var(--t-15); margin-bottom: 4px;">Roll up the last 7 days into a markdown report</div>
            <div style="font-size: var(--t-13); color: var(--fg-soft);">Clusters questions, finds low-confidence buckets, recall cliffs, and citation regressions.</div>
          </div>
          <label class="check">
            <input type="checkbox" id="analyze-include-console" /> include console traffic
          </label>
          <button id="btn-traffic-analyze" class="btn primary lg">
            <svg><use href="#i-play"/></svg> run analyze · 7d
          </button>
        </div>
        <p id="traffic-analyze-status" class="status" style="margin-top: var(--s-3);"></p>
        ${latest && latestBody !== null
          ? html`
            <div style="margin-top: var(--s-5); padding-top: var(--s-4); border-top: 1px solid var(--bd-soft);">
              <details open>
                <summary style="cursor: pointer; font-size: var(--t-12); color: var(--fg-soft); margin-bottom: var(--s-2);">latest report inline</summary>
                <div id="analyze-md" class="md"></div>
                <p style="margin-top: var(--s-2);"><a href="/p/${projectName}/reports/${latest.filename}" class="muted" style="font-size: var(--t-12);">open standalone →</a></p>
              </details>
              <script type="module">${raw(`
                import { marked } from '/console/static/marked.esm.js';
                marked.setOptions({ breaks: true, gfm: true });
                var body = ${latestBodyJson};
                if (body) document.getElementById('analyze-md').innerHTML = marked.parse(body);
              `)}</script>
            </div>
          `
          : ''}
        ${history.length > 1
          ? html`
            <details style="margin-top: var(--s-3);">
              <summary style="cursor: pointer; font-size: var(--t-12); color: var(--fg-soft);">history (${history.length})</summary>
              <ul style="list-style: none; padding: 0; margin: var(--s-2) 0 0;">
                ${history.slice(1).map(
                  (h) => html`<li style="padding: 4px 0; font-size: var(--t-12);">
                    <span class="mono muted">${h.date}</span> ·
                    <a class="mono" href="/p/${projectName}/reports/${h.filename}">${h.filename}</a>
                  </li>`,
                )}
              </ul>
            </details>
          `
          : ''}
        <p class="muted" style="font-size: 11px; margin-top: var(--s-3);">
          Excludes <code class="inline">source=console</code> by default — tick "include console" to mix in dogfood.
        </p>
      </div>
    </section>
  `;
}

const TRAFFIC_SCRIPT = `
import { marked } from '/console/static/marked.esm.js';
marked.setOptions({ breaks: true, gfm: true });

const $ = (id) => document.getElementById(id);
const records = window.__TRAFFIC__ || [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function applyFilter() {
  const tbody = $('tf-body');
  if (!tbody) return;
  const q = ($('tf-q').value || '').toLowerCase();
  const k = $('tf-kind').value;
  const s = $('tf-source').value;
  const minC = parseFloat($('tf-conf').value);
  for (const tr of tbody.querySelectorAll('tr.expandable')) {
    const trQ = tr.dataset.q || '';
    const trK = tr.dataset.kind || '';
    const trS = tr.dataset.source || '';
    const trC = parseFloat(tr.dataset.conf || '-1');
    let show = true;
    if (q && !trQ.includes(q)) show = false;
    if (k && trK !== k) show = false;
    if (s && trS !== s) show = false;
    if (!isNaN(minC) && trC < minC) show = false;
    tr.style.display = show ? '' : 'none';
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('expanded')) {
      next.style.display = show ? '' : 'none';
    }
  }
}
['tf-q', 'tf-kind', 'tf-source', 'tf-conf'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('input', applyFilter);
  if (el) el.addEventListener('change', applyFilter);
});

function detailHtml(r, idx) {
  const a = r.answer || {};
  const fused = (r.retrieval && r.retrieval.fused) || [];
  let fusedTbl = '';
  if (fused.length > 0) {
    fusedTbl = '<table class="tbl" style="font-size:11.5px;"><thead><tr><th>page</th><th class="num">final</th><th class="num">rrf</th><th class="num">vec</th><th class="num">bm25</th><th class="num">nav</th></tr></thead><tbody>';
    for (const f of fused.slice(0, 8)) {
      fusedTbl += '<tr>' +
        '<td>' + escapeHtml(f.page || '') + '</td>' +
        '<td class="num">' + (f.final_score != null ? f.final_score.toFixed(3) : '—') + '</td>' +
        '<td class="num">' + (f.rrf_score != null ? f.rrf_score.toFixed(3) : '—') + '</td>' +
        '<td class="num">' + (f.vec_rank != null ? f.vec_rank : '—') + '</td>' +
        '<td class="num">' + (f.bm25_rank != null ? f.bm25_rank : '—') + '</td>' +
        '<td class="num">' + (f.nav_index != null ? f.nav_index : '—') + '</td>' +
        '</tr>';
    }
    fusedTbl += '</tbody></table>';
    if (fused.length > 8) {
      fusedTbl += '<p class="muted" style="font-size:11px; margin-top:4px;">… ' + (fused.length - 8) + ' more</p>';
    }
  } else {
    fusedTbl = '<p class="muted" style="font-size:12px;">no fused trace</p>';
  }

  const meta = [
    ['model', a.model],
    ['answer_id', a.answer_id],
    ['request_id', r.request_id],
    ['tokens_in', a.tokens_in],
    ['tokens_out', a.tokens_out],
    ['error_code', a.error_code],
  ].filter((kv) => kv[1] != null);
  const metaHtml = meta.map((kv) => '<dt>' + kv[0] + '</dt><dd class="mono">' + escapeHtml(String(kv[1])) + '</dd>').join('');

  const ansHtml = a.md ? marked.parse(a.md) : '<p class="muted">no answer body</p>';
  const cits = Array.isArray(a.citations) ? a.citations : [];
  const citsHtml = cits.length > 0
    ? '<div class="muted" style="font-size:11.5px; margin-top:8px;">citations: ' + cits.map((c) => escapeHtml(c.page || '')).join(', ') + '</div>'
    : '';

  return (
    '<tr class="expanded" data-detail-for="' + idx + '">' +
    '<td colspan="6" style="padding:0;">' +
    '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:var(--s-4); padding:var(--s-4) var(--s-5);">' +
      '<div>' +
        '<h4 style="font-size:11px; color:var(--fg-mute); text-transform:uppercase; letter-spacing:.05em; margin:0 0 var(--s-2);">retrieval · fused top ' + Math.min(fused.length, 8) + ' of ' + fused.length + '</h4>' +
        fusedTbl +
        '<h4 style="font-size:11px; color:var(--fg-mute); text-transform:uppercase; letter-spacing:.05em; margin:var(--s-3) 0 var(--s-2);">meta</h4>' +
        '<dl class="kv">' + (metaHtml || '<dd class="muted">no metadata</dd>') + '</dl>' +
        '<button class="btn sm primary" data-reask-query="' + escapeHtml(r.query || '') + '" style="margin-top:var(--s-2);">↩ re-ask in Ask</button>' +
      '</div>' +
      '<div>' +
        '<h4 style="font-size:11px; color:var(--fg-mute); text-transform:uppercase; letter-spacing:.05em; margin:0 0 var(--s-2);">answer</h4>' +
        '<div class="md">' + ansHtml + '</div>' +
        citsHtml +
      '</div>' +
    '</div>' +
    '</td></tr>'
  );
}

function bindRowClicks() {
  const tbody = $('tf-body');
  if (!tbody) return;
  tbody.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-reask-query]')) {
      const t = e.target.closest('[data-reask-query]');
      const q = t.dataset.reaskQuery || '';
      window.dispatchEvent(new CustomEvent('console:reask', { detail: { query: q } }));
      e.stopPropagation();
      return;
    }
    const tr = e.target.closest('tr.expandable');
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('expanded')) {
      next.remove();
      return;
    }
    const idx = Number(tr.dataset.idx);
    const r = records[idx];
    if (!r) return;
    tr.insertAdjacentHTML('afterend', detailHtml(r, idx));
  });
}
bindRowClicks();
`;
