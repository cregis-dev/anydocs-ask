/**
 * Recent runs viewer — ARCH §17.3.1 GET /p/:name/runs.
 *
 * SSR renders the table rows; JS layered on top wires filtering (by query,
 * kind, min confidence) and inline row expansion (answer markdown + meta).
 * Filtering toggles row visibility — server-rendered rows remain the source
 * of truth so JS-disabled clients still see the data.
 */

import { html, raw } from 'hono/html';
import type { RunsLine, RunRecord } from '../../runs/types.ts';
import { layout, type Html, type NavContext } from './layout.ts';

export function renderRuns(args: {
  projectName: string;
  lines: RunsLine[];
  limit: number;
  nav?: NavContext;
}): Html {
  const records = args.lines.filter((l): l is RunRecord => 'answer' in l);
  const ordered = [...records].reverse(); // newest first
  const payload = raw(JSON.stringify(ordered));
  const body = html`
    <div class="page-head">
      <div class="crumbs">
        <a href="/">projects</a><span class="sep">/</span>
        <a href="/p/${args.projectName}">${args.projectName}</a><span class="sep">/</span>
        <span class="here">recent runs</span>
      </div>
      <span class="muted mono">${ordered.length}/${args.limit}</span>
    </div>
    ${ordered.length === 0
      ? html`<div class="card"><div class="card-bd"><p class="empty" style="padding:24px 0;">尚无 runs（或本周文件不存在）。</p></div></div>`
      : runsCard(ordered)}
    <script>${raw(`window.__RUNS__ = ${payload};`)}</script>
    <script type="module">${raw(RUNS_SCRIPT)}</script>
  `;
  return layout({ title: `${args.projectName} · runs`, body, nav: args.nav });
}

function runsCard(records: RunRecord[]): Html {
  return html`
    <div class="card flush">
      <div class="card-hd" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <h2 style="margin:0;">runs</h2>
        <input id="filter-q" class="input" type="search" placeholder="filter query…" style="flex:1; min-width:160px; max-width:320px;" />
        <select id="filter-kind" class="select" style="width: auto;">
          <option value="">all kinds</option>
          <option value="answer">answer</option>
          <option value="clarify">clarify</option>
          <option value="error">error</option>
        </select>
        <select id="filter-conf" class="select" style="width: auto;">
          <option value="">conf any</option>
          <option value="0.8">conf ≥ 0.8</option>
          <option value="0.6">conf ≥ 0.6</option>
          <option value="0.4">conf ≥ 0.4</option>
        </select>
      </div>
      <table class="tbl" id="runs-table">
        <thead>
          <tr>
            <th style="width: 70px;">ts</th>
            <th style="width: 70px;">kind</th>
            <th style="width: 56px;">conf</th>
            <th style="width: 70px;">latency</th>
            <th>query</th>
            <th>citations</th>
          </tr>
        </thead>
        <tbody id="runs-body">${records.map(runRow)}</tbody>
      </table>
    </div>
  `;
}

function runRow(r: RunRecord, idx: number): Html {
  const a = r.answer;
  const kindCls = a.kind === 'answer' ? 'ok' : a.kind === 'clarify' ? 'warn' : 'err';
  const conf = a.confidence !== null ? a.confidence.toFixed(2) : '—';
  const cits =
    a.kind === 'answer' && a.citations.length > 0
      ? a.citations.map((c) => c.page).join(', ')
      : '—';
  return html`
    <tr class="expandable" data-idx="${idx}" data-kind="${a.kind}" data-conf="${a.confidence ?? -1}" data-q="${(r.query ?? '').toLowerCase()}">
      <td class="mono muted" style="font-size: 11px;">${r.ts.slice(11, 19)}</td>
      <td><span class="tag ${kindCls}">${a.kind}</span></td>
      <td class="mono">${conf}</td>
      <td class="mono">${a.latency_ms}ms</td>
      <td>${r.query}</td>
      <td class="mono muted" style="font-size: 12px;">${cits}</td>
    </tr>
  `;
}

const RUNS_SCRIPT = `
const $ = (id) => document.getElementById(id);
const all = window.__RUNS__ || [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function applyFilter() {
  const tbody = $('runs-body');
  if (!tbody) return;
  const q = ($('filter-q').value || '').toLowerCase();
  const k = $('filter-kind').value;
  const minC = parseFloat($('filter-conf').value);
  for (const tr of tbody.querySelectorAll('tr.expandable')) {
    const trQ = tr.dataset.q || '';
    const trK = tr.dataset.kind || '';
    const trC = parseFloat(tr.dataset.conf || '-1');
    let show = true;
    if (q && !trQ.includes(q)) show = false;
    if (k && trK !== k) show = false;
    if (!isNaN(minC) && (trC < minC)) show = false;
    tr.style.display = show ? '' : 'none';
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('expanded') && next.dataset.detailFor === tr.dataset.idx) {
      next.style.display = show ? '' : 'none';
    }
  }
}

function detailHtml(r) {
  const a = r.answer || {};
  const md = a.md || '';
  const fused = Array.isArray(r.retrieval?.fused) ? r.retrieval.fused.length : null;
  const meta = [
    ['model', a.model],
    ['tokens_in', a.tokens_in],
    ['tokens_out', a.tokens_out],
    ['error_code', a.error_code],
    ['fused_count', fused],
  ].filter((kv) => kv[1] != null);
  const metaHtml = meta.map((kv) => '<dt>' + kv[0] + '</dt><dd class="mono">' + escapeHtml(String(kv[1])) + '</dd>').join('');
  return (
    '<tr class="expanded" data-detail-for="' + r._idx + '">' +
    '<td colspan="6" style="padding:14px 18px;">' +
    (metaHtml ? '<dl class="kv" style="margin-bottom:10px;">' + metaHtml + '</dl>' : '') +
    '<pre class="mono" style="font-size:12px; white-space:pre-wrap; word-break:break-word; max-height:320px;">' + escapeHtml(md) + '</pre>' +
    '</td></tr>'
  );
}

function bindRowClicks() {
  const tbody = $('runs-body');
  if (!tbody) return;
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr.expandable');
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('expanded')) {
      next.remove();
      return;
    }
    const idx = Number(tr.dataset.idx);
    const r = all[idx];
    if (!r) return;
    r._idx = String(idx);
    tr.insertAdjacentHTML('afterend', detailHtml(r));
  });
}

if ($('runs-body')) {
  bindRowClicks();
  ['filter-q', 'filter-kind', 'filter-conf'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', applyFilter);
  });
}
`;
