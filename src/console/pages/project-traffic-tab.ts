/**
 * Traffic tab content for /p/:name — ARCH §17.3.6.
 *
 * Replaces the previous "Activity" tab + standalone /p/:name/runs page.
 * Rolling 7-day health strip + filter bar + runs table with expandable
 * rows (full fused retrieval, answer markdown, Re-ask jump to Ask tab).
 *
 * SSR renders the row table; JS layers filter (show/hide) and inline
 * row expansion. Window length default 7d (currently fixed; --days
 * selector is a Phase 2+ polish).
 */

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';
import type { TrafficWindow } from '../traffic-state.ts';
import { runSource } from '../../runs/types.ts';
import type { RunRecord } from '../../runs/types.ts';

export type TrafficTabViewModel = {
  projectName: string;
  window: TrafficWindow;
};

export function renderTrafficTab(vm: TrafficTabViewModel): Html {
  const { window: w } = vm;
  return html`
    <div class="traffic-tab">
      ${healthStrip(w)}
      ${w.records.length === 0 ? emptyState(w.sinceISO) : trafficTable(w)}
    </div>
    <script>${raw(`window.__TRAFFIC__ = ${rawJSON(w.records)};`)}</script>
    <script type="module">${raw(TRAFFIC_SCRIPT)}</script>
    <style>
      .traffic-tab .strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 14px; }
      .traffic-tab .kpi { background: var(--bg-elev); border: 1px solid var(--bd); border-radius: 8px; padding: 12px 14px; }
      .traffic-tab .kpi .k { font-size: 11px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: .05em; }
      .traffic-tab .kpi .v { font-size: 22px; font-weight: 600; font-family: ui-monospace, monospace; letter-spacing: -0.01em; margin-top: 4px; }
      .traffic-tab .kpi .v.warn { color: var(--warn); }
      .traffic-tab .kpi .v.err { color: var(--err); }
      .traffic-tab .kpi .spark { font-family: ui-monospace, monospace; color: var(--accent); font-size: 14px; letter-spacing: -1px; margin-top: 4px; }
      .traffic-filter { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 10px 18px; }
      .traffic-filter input[type=search] { min-width: 200px; max-width: 320px; }
      .traffic-tab .src-pill { display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-left: 4px; vertical-align: 1px; }
      .traffic-tab .src-pill.reader { background: var(--run-bg); color: var(--run); }
      .traffic-tab .src-pill.console { background: var(--warn-bg); color: var(--warn); }
      .traffic-tab .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px 16px; }
      @media (max-width: 900px) { .traffic-tab .detail-grid { grid-template-columns: 1fr; } }
      .traffic-tab .detail-grid h4 { font-size: 11px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px; }
      .traffic-tab .fused-tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
      .traffic-tab .fused-tbl td, .traffic-tab .fused-tbl th { padding: 3px 6px; border-bottom: 1px solid var(--bd-soft); text-align: left; }
      .traffic-tab .fused-tbl th { font-size: 10px; color: var(--fg-mute); text-transform: uppercase; }
      .traffic-tab .detail-meta dl { margin: 0; }
      .traffic-tab .answer-md pre { max-height: 180px; }
      .reask-btn { padding: 2px 10px; font-size: 11.5px; margin-top: 8px; }
    </style>
  `;
}

function healthStrip(w: TrafficWindow): Html {
  const { totals, perDay } = w;
  const fmt = (n: number | null, digits = 2): string => (n === null ? '—' : n.toFixed(digits));
  const ms = (n: number | null): string => (n === null ? '—' : `${Math.round(n)}ms`);
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const sparkCount = sparkline(perDay.map((d) => d.count));
  const sparkConf = sparkline(perDay.map((d) => d.meanConfidence));
  const sparkLat = sparkline(perDay.map((d) => d.p95LatencyMs));
  return html`
    <div class="strip">
      <div class="kpi">
        <div class="k">queries · ${w.days}d</div>
        <div class="v">${totals.count}</div>
        <div class="muted" style="font-size: 11px;">
          reader ${totals.countReader} · console ${totals.countConsole}
        </div>
        <div class="spark">${sparkCount}</div>
      </div>
      <div class="kpi">
        <div class="k">mean confidence</div>
        <div class="v ${totals.meanConfidence !== null && totals.meanConfidence < 0.5 ? 'warn' : ''}">
          ${fmt(totals.meanConfidence)}
        </div>
        <div class="muted" style="font-size: 11px;">across all kinds</div>
        <div class="spark">${sparkConf}</div>
      </div>
      <div class="kpi">
        <div class="k">P95 latency</div>
        <div class="v ${totals.p95LatencyMs !== null && totals.p95LatencyMs > 5000 ? 'warn' : ''}">${ms(totals.p95LatencyMs)}</div>
        <div class="muted" style="font-size: 11px;">P50 ${ms(totals.p50LatencyMs)}</div>
        <div class="spark">${sparkLat}</div>
      </div>
      <div class="kpi">
        <div class="k">non-answer rate</div>
        <div class="v ${totals.errorRate > 0.05 ? 'err' : totals.clarifyRate > 0.2 ? 'warn' : ''}">
          ${pct(totals.errorRate + totals.clarifyRate)}
        </div>
        <div class="muted" style="font-size: 11px;">
          error ${pct(totals.errorRate)} · clarify ${pct(totals.clarifyRate)}
        </div>
      </div>
    </div>
  `;
}

function emptyState(sinceISO: string): Html {
  return html`
    <div class="card">
      <p class="empty">since ${sinceISO} 暂无 runs.</p>
      <p class="muted" style="font-size: 12px;">
        作者本机 dogfood：右上打开 Ask tab 的 <strong>persist</strong> 开关，提问会写
        <code>source=console</code> 行<br />
        真实流量：让 Reader / 直 curl 子进程 <code class="mono">/v1/ask</code>
      </p>
    </div>
  `;
}

function trafficTable(w: TrafficWindow): Html {
  // Newest-first display order
  const ordered = [...w.records].reverse();
  return html`
    <div class="card flush">
      <div class="card-head traffic-filter">
        <h2 style="margin:0;">runs · ${ordered.length}</h2>
        <input id="tf-q" type="search" placeholder="filter query…" />
        <select id="tf-source" class="proj-switcher">
          <option value="">all sources</option>
          <option value="reader">reader only</option>
          <option value="console">console only</option>
        </select>
        <select id="tf-kind" class="proj-switcher">
          <option value="">all kinds</option>
          <option value="answer">answer</option>
          <option value="clarify">clarify</option>
          <option value="error">error</option>
        </select>
        <select id="tf-conf" class="proj-switcher">
          <option value="">conf any</option>
          <option value="0.8">conf ≥ 0.8</option>
          <option value="0.6">conf ≥ 0.6</option>
          <option value="0.4">conf ≥ 0.4</option>
        </select>
      </div>
      <table id="traffic-tbl">
        <thead>
          <tr>
            <th style="width: 80px;">ts</th>
            <th style="width: 100px;">kind</th>
            <th style="width: 56px;">conf</th>
            <th style="width: 70px;">latency</th>
            <th>query</th>
            <th>citations</th>
          </tr>
        </thead>
        <tbody id="tf-body">${ordered.map((r, i) => trafficRow(r, i))}</tbody>
      </table>
    </div>
  `;
}

function trafficRow(r: RunRecord, idx: number): Html {
  const a = r.answer;
  const kindCls = a.kind === 'answer' ? 'ok' : a.kind === 'clarify' ? 'warn' : 'err';
  const conf = a.confidence !== null ? a.confidence.toFixed(2) : '—';
  const cits =
    a.kind === 'answer' && a.citations.length > 0
      ? a.citations.map((c) => c.page).join(', ')
      : '—';
  const src = runSource(r);
  return html`
    <tr class="expandable" data-idx="${idx}"
        data-kind="${a.kind}"
        data-conf="${a.confidence ?? -1}"
        data-source="${src}"
        data-q="${(r.query ?? '').toLowerCase()}">
      <td class="mono muted" style="font-size: 11px;">${r.ts.slice(11, 19)}</td>
      <td>
        <span class="tag ${kindCls}">${a.kind}</span>
        <span class="src-pill ${src}">${src}</span>
      </td>
      <td class="mono">${conf}</td>
      <td class="mono">${a.latency_ms}ms</td>
      <td>${r.query}</td>
      <td class="mono muted" style="font-size: 12px;">${cits}</td>
    </tr>
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
});

function detailHtml(r, idx) {
  const a = r.answer || {};
  const fused = (r.retrieval && r.retrieval.fused) || [];
  let fusedTbl = '';
  if (fused.length > 0) {
    fusedTbl = '<table class="fused-tbl"><thead><tr><th>page</th><th>final</th><th>rrf</th><th>vec</th><th>bm25</th><th>nav</th></tr></thead><tbody>';
    for (const f of fused.slice(0, 8)) {
      fusedTbl += '<tr>' +
        '<td>' + escapeHtml(f.page || '') + '</td>' +
        '<td>' + (f.final_score != null ? f.final_score.toFixed(3) : '—') + '</td>' +
        '<td>' + (f.rrf_score != null ? f.rrf_score.toFixed(3) : '—') + '</td>' +
        '<td>' + (f.vec_rank ?? '—') + '</td>' +
        '<td>' + (f.bm25_rank ?? '—') + '</td>' +
        '<td>' + (f.nav_index ?? '—') + '</td>' +
        '</tr>';
    }
    fusedTbl += '</tbody></table>';
    if (fused.length > 8) {
      fusedTbl += '<p class="muted" style="font-size:11px; margin-top:4px;">... ' + (fused.length - 8) + ' more</p>';
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
  const metaHtml = meta.map((kv) => '<div class="row" style="display:grid; grid-template-columns:92px 1fr; gap:6px; font-size:12px;"><span class="muted">' + kv[0] + '</span><span class="mono">' + escapeHtml(String(kv[1])) + '</span></div>').join('');

  const ansHtml = a.md ? marked.parse(a.md) : '<p class="muted">no answer body</p>';
  const cits = Array.isArray(a.citations) ? a.citations : [];
  const citsHtml = cits.length > 0
    ? '<div class="muted" style="font-size:11.5px; margin-top:8px;">citations: ' + cits.map((c) => escapeHtml(c.page || '')).join(', ') + '</div>'
    : '';

  return (
    '<tr class="expanded" data-detail-for="' + idx + '">' +
    '<td colspan="6" style="padding:0;">' +
    '<div class="detail-grid">' +
      '<div>' +
        '<h4>retrieval · fused top ' + Math.min(fused.length, 8) + '/' + fused.length + '</h4>' +
        fusedTbl +
        '<h4 style="margin-top:14px;">meta</h4>' +
        '<div class="detail-meta">' + (metaHtml || '<p class="muted" style="font-size:12px;">no metadata</p>') + '</div>' +
        '<button class="reask-btn btn-primary" data-reask-query="' + escapeHtml(r.query || '') + '">↩ Re-ask in Ask tab</button>' +
      '</div>' +
      '<div>' +
        '<h4>answer</h4>' +
        '<div class="md answer-md">' + ansHtml + '</div>' +
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
    // Re-ask button — jump to Ask tab, prefill textarea
    if (e.target && e.target.classList && e.target.classList.contains('reask-btn')) {
      const q = e.target.dataset.reaskQuery || '';
      const askQ = document.getElementById('ask-q');
      if (askQ) {
        askQ.value = q;
        askQ.focus();
      }
      // switch project tab to Ask
      const tabs = document.querySelectorAll('[data-project-tab]');
      tabs.forEach((el) => {
        if (el.getAttribute('role') === 'tab') {
          el.setAttribute('aria-selected', el.dataset.projectTab === 'ask' ? 'true' : 'false');
        } else {
          el.hidden = el.dataset.projectTab !== 'ask';
        }
      });
      if (history.replaceState) history.replaceState({}, '', location.pathname + '#ask');
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

// ----------------------------------------------------------------------
// Sparkline (same algo as eval tab — unicode block, zero deps)
// ----------------------------------------------------------------------

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values: Array<number | null>): string {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return SPARK_CHARS[0]!.repeat(Math.max(1, values.length));
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

function rawJSON(records: RunRecord[]): string {
  return JSON.stringify(records);
}
