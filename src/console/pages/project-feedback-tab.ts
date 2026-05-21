/**
 * Feedback tab — RFC 0002 T1-a (skeleton) + T1-b (KPI + list + chips).
 *
 * States from console-redesign-brief §7.5.1 covered here:
 *   1. disabled                — `feedback.enabled = false` (PRD §11.4 #6)
 *   2. enabled, empty          — switch on, table empty
 *   3. enabled, <10 records    — KPI tiles + onboarding banner
 *   4. enabled, healthy        — KPI + filterable list
 *
 * State 5 (right-side detail drawer) is still T1-d.
 */

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';
import type {
  FeedbackFilter,
  FeedbackRowVM,
  FeedbackTabSnapshot,
  FilterCounts,
} from '../feedback-state.ts';

export type FeedbackTabViewModel = {
  projectName: string;
  snapshot: FeedbackTabSnapshot;
};

const FILTER_LABELS: Record<FeedbackFilter, string> = {
  all: 'all',
  thumbs_up: '👍',
  thumbs_down: '👎',
  implicit: 'implicit',
  no_citations: 'no citations',
};

export function renderFeedbackTab(vm: FeedbackTabViewModel): Html {
  if (!vm.snapshot.enabled) return disabledCard();
  return enabledLayout(vm.projectName, vm.snapshot);
}

// ---------------------------------------------------------------------------
// State 1 — disabled
// ---------------------------------------------------------------------------

function disabledCard(): Html {
  return html`
    <section class="card" data-feedback-state="disabled">
      <div class="card-bd">
        <div class="empty">
          <div class="e-ico"><svg><use href="#i-info"/></svg></div>
          <h3>Feedback loop is off</h3>
          <p>
            <code class="inline">feedback.enabled</code> is <code class="inline">false</code> in this
            project's <code class="inline">anydocs.ask.json</code>. With it off the query pipeline
            stays byte-equivalent to v1 (no β/γ rows written, no inbox populated). Turn it on to
            start collecting the signal that powers RFC 0001 + 0002.
          </p>
          <div class="e-cta">
            <a href="#settings" class="btn primary">
              <svg><use href="#i-gear"/></svg> open Settings · feedback
            </a>
          </div>
        </div>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// States 2-4 — enabled
// ---------------------------------------------------------------------------

function enabledLayout(projectName: string, snap: FeedbackTabSnapshot): Html {
  const state = snap.totalCount === 0 ? 'empty' : 'list';
  const showInteractive = snap.totalCount > 0;
  return html`
    <div
      class="feedback-tab"
      data-feedback-state="${state}"
      data-feedback-total="${snap.totalCount}"
      style="display: flex; flex-direction: column; gap: var(--s-5);"
    >
      ${snap.totalCount > 0 && snap.totalCount < 10 ? onboardingBanner(snap.totalCount) : ''}
      ${kpiStrip(snap)}
      ${snap.totalCount === 0 ? emptyListCard() : listCard(projectName, snap)}
    </div>
    ${showInteractive ? drawerShell() : ''}
    ${showInteractive
      ? html`<script>${raw(`window.__FEEDBACK__ = ${JSON.stringify({
          projectName,
          filter: snap.filter,
        })};`)}</script>
        <script type="module">${raw(FEEDBACK_SCRIPT)}</script>`
      : ''}
  `;
}

function drawerShell(): Html {
  // T1-d drawer skeleton — mirrors Traffic tab's pattern (.drawer-mask +
  // <aside class="drawer">), filled async by the inline JS on row click.
  return html`
    <div class="drawer-mask" id="fb-drawer-mask" hidden></div>
    <aside
      class="drawer"
      id="fb-drawer"
      hidden
      role="dialog"
      aria-label="Feedback detail"
      aria-modal="true"
    >
      <div class="drawer-hd" id="fb-drawer-hd"></div>
      <div class="drawer-bd" id="fb-drawer-bd"></div>
    </aside>
  `;
}

function onboardingBanner(totalCount: number): Html {
  const label = totalCount === 1 ? 'signal' : 'signals';
  return html`
    <div class="banner info" data-feedback-banner="collected">
      <span class="b-ico"><svg><use href="#i-info"/></svg></span>
      <div class="b-bd">
        <div class="b-ti">${totalCount} feedback ${label} collected</div>
        <div class="b-de">
          A+ failure-cluster diagnosis unlocks at 50 signals (PRD §10.3). Until then the list
          below is the raw feed; the right-side per-row drawer ships in T1-d.
        </div>
      </div>
    </div>
  `;
}

function kpiStrip(snap: FeedbackTabSnapshot): Html {
  const k = snap.kpi;
  const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);
  const conf = (n: number | null): string => (n === null ? '—' : n.toFixed(2));
  const lowConf = k.meanConfidence !== null && k.meanConfidence < 0.5;
  const highNonAns = k.nonAnswerRate > 0.2;
  return html`
    <div class="kpis" style="grid-template-columns: repeat(5, 1fr);" data-feedback-kpi>
      <div class="kpi">
        <div class="k-lab">feedback · ${snap.days}d</div>
        <div class="k-val">${k.count}</div>
        <div class="k-foot">β ${k.explicitCount} · γ ${k.implicitCount}</div>
      </div>
      <div class="kpi">
        <div class="k-lab">explicit %</div>
        <div class="k-val">${pct(k.explicitShare)}</div>
        <div class="k-foot">👍 / 👎 vs γ implicit</div>
      </div>
      <div class="kpi${lowConf ? ' warn' : ''}">
        <div class="k-lab">mean confidence</div>
        <div class="k-val">${conf(k.meanConfidence)}</div>
        <div class="k-foot" style="color: ${lowConf ? 'var(--warn)' : 'var(--fg-mute)'};">
          across rated runs
        </div>
      </div>
      <div class="kpi${highNonAns ? ' warn' : ''}">
        <div class="k-lab">non-answer rate</div>
        <div class="k-val">${pct(k.nonAnswerRate)}</div>
        <div class="k-foot">error + clarify</div>
      </div>
      <div class="kpi">
        <div class="k-lab">A+ candidates</div>
        <div class="k-val">—</div>
        <div class="k-foot">unlocks at 50 (PRD §10.3)</div>
      </div>
    </div>
  `;
}

function emptyListCard(): Html {
  // State 2 — `feedback.enabled = true` but the table is empty.
  return html`
    <section class="card">
      <div class="card-bd">
        <div class="empty">
          <div class="e-ico"><svg><use href="#i-chat"/></svg></div>
          <h3>No feedback yet</h3>
          <p>
            Once readers tap 👍 / 👎 (β channel) or the server detects a same-session re-ask
            within 5 min (γ channel), rows will appear here. Until then the loop has nothing to
            chew on — try the Ask tab, or wait for real traffic.
          </p>
          <div class="e-cta">
            <a href="#ask" class="btn primary">
              <svg><use href="#i-chat"/></svg> dogfood from the Ask tab
            </a>
            <a href="#traffic" class="btn">
              <svg><use href="#i-chart"/></svg> check live traffic
            </a>
          </div>
        </div>
      </div>
    </section>
  `;
}

function listCard(projectName: string, snap: FeedbackTabSnapshot): Html {
  return html`
    <section class="card" data-feedback-list-card>
      <div class="card-hd">
        <h2><svg style="width:14px;height:14px;"><use href="#i-chat"/></svg> Recent feedback</h2>
        <span class="meta" id="feedback-meta">
          ${snap.rows.length} of ${snap.filterCounts[snap.filter]} in last ${snap.days}d
        </span>
      </div>
      <div class="card-bd flush">
        ${chipBar(snap.filterCounts, snap.filter)}
        <div id="feedback-rows">
          ${snap.rows.length === 0 ? emptyFilterRow(snap.filter) : rowsTable(snap.rows)}
        </div>
        ${snap.hasMore
          ? html`<div class="meta" style="padding: var(--s-3) var(--s-5); color: var(--fg-mute);">
              Showing newest 50 — older signals via
              <code class="inline">GET /api/projects/${projectName}/feedback?limit=200</code>.
            </div>`
          : ''}
      </div>
    </section>
  `;
}

function chipBar(counts: FilterCounts, active: FeedbackFilter): Html {
  const chips: FeedbackFilter[] = [
    'all',
    'thumbs_up',
    'thumbs_down',
    'implicit',
    'no_citations',
  ];
  return html`
    <nav class="feedback-chips"
         role="tablist"
         aria-label="Feedback filter"
         style="display: flex; gap: var(--s-2); padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--bd-soft); flex-wrap: wrap;">
      ${chips.map(
        (f) => html`
          <button
            type="button"
            class="tag${f === active ? ' warn' : ''}"
            role="tab"
            aria-selected="${f === active ? 'true' : 'false'}"
            data-feedback-chip="${f}"
            style="cursor: pointer; border-style: solid;"
          >
            ${FILTER_LABELS[f]}
            <span class="cnt" style="margin-left: 6px; color: var(--fg-mute);">${counts[f]}</span>
          </button>
        `,
      )}
    </nav>
  `;
}

function rowsTable(rows: FeedbackRowVM[]): Html {
  return html`
    <ul class="feedback-rows" style="list-style: none; margin: 0; padding: 0;">
      ${rows.map((r) => rowItem(r))}
    </ul>
  `;
}

function rowItem(r: FeedbackRowVM): Html {
  const ratingBadge = ratingBadgeFor(r);
  const confPill =
    r.confidence === null
      ? html`<span class="tag" style="color: var(--fg-mute);">conf —</span>`
      : html`<span class="tag${r.confidence < 0.5 ? ' warn' : ''}">conf ${r.confidence.toFixed(2)}</span>`;
  return html`
    <li
      class="feedback-row"
      data-feedback-row="${r.feedback_id}"
      data-feedback-answer-id="${r.answerId}"
      style="display: grid; grid-template-columns: 90px 80px 90px minmax(0, 1fr) minmax(0, 1fr);
             gap: var(--s-3); padding: var(--s-3) var(--s-5);
             border-top: 1px solid var(--bd-soft); align-items: center;
             cursor: pointer;"
    >
      <span class="mono" style="font-size: var(--t-12); color: var(--fg-mute);">
        ${r.ts.slice(11, 19)}
      </span>
      ${ratingBadge}
      ${confPill}
      <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        ${r.question}
      </span>
      ${breadcrumbCell(r)}
    </li>
  `;
}

function breadcrumbCell(r: FeedbackRowVM): Html {
  // 3 branches:
  //   • breadcrumb present → render title chain with ` › ` separators
  //   • page_id present but no breadcrumb (unpublished / deleted page) → raw id, dimmed
  //   • no page_id at all → em-dash
  if (r.breadcrumb && r.breadcrumb.length > 0) {
    const title = r.breadcrumb.map((n) => n.title).join(' › ');
    return html`<span
      title="${title}"
      style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-12); color: var(--fg-soft);"
    >${title}</span>`;
  }
  if (r.currentPageId) {
    return html`<span
      class="mono"
      title="page row missing (unpublished or deleted since feedback was written)"
      style="font-size: var(--t-12); color: var(--fg-mute);"
    >${r.currentPageId}</span>`;
  }
  return html`<span class="mono" style="font-size: var(--t-12); color: var(--fg-mute);">—</span>`;
}

function ratingBadgeFor(r: FeedbackRowVM): Html {
  if (r.signal_source === 'implicit') {
    return html`<span class="tag" title="γ implicit signal">γ ⏱</span>`;
  }
  if (r.rating !== null && r.rating > 0) {
    return html`<span class="tag ok">👍</span>`;
  }
  if (r.rating !== null && r.rating < 0) {
    return html`<span class="tag err">👎</span>`;
  }
  return html`<span class="tag">β ?</span>`;
}

function emptyFilterRow(filter: FeedbackFilter): Html {
  return html`
    <div
      style="padding: var(--s-8) var(--s-5); text-align: center; color: var(--fg-soft); font-size: var(--t-13);"
    >
      No rows match
      <code class="inline">${filter}</code>
      in this window. Try another chip or widen the window with
      <code class="inline">?days=30</code>.
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Inline bootstrap — chip click → fetch endpoint → swap DOM
// ---------------------------------------------------------------------------

const FEEDBACK_SCRIPT = `
const FB = window.__FEEDBACK__;
const rowsRoot = document.getElementById('feedback-rows');
const metaEl = document.getElementById('feedback-meta');
const chipBar = document.querySelector('[data-feedback-chip="all"]')?.parentElement;
const RATING_LABELS = { up: '👍', down: '👎' };
const CHIP_LABELS = {
  all: 'all',
  thumbs_up: '👍',
  thumbs_down: '👎',
  implicit: 'implicit',
  no_citations: 'no citations',
};
const FILTER_FALLBACK_HINT = 'Try another chip or widen the window with <code class="inline">?days=30</code>.';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderRow(r) {
  let badge;
  if (r.signal_source === 'implicit') {
    badge = '<span class="tag" title="γ implicit signal">γ ⏱</span>';
  } else if (r.rating !== null && r.rating > 0) {
    badge = '<span class="tag ok">👍</span>';
  } else if (r.rating !== null && r.rating < 0) {
    badge = '<span class="tag err">👎</span>';
  } else {
    badge = '<span class="tag">β ?</span>';
  }
  const confTag = r.confidence === null
    ? '<span class="tag" style="color: var(--fg-mute);">conf —</span>'
    : '<span class="tag' + (r.confidence < 0.5 ? ' warn' : '') + '">conf ' + r.confidence.toFixed(2) + '</span>';
  let breadcrumbCell;
  if (Array.isArray(r.breadcrumb) && r.breadcrumb.length > 0) {
    const chain = r.breadcrumb.map((n) => n.title).join(' › ');
    breadcrumbCell =
      '<span title="' + escapeHtml(chain) + '"' +
      ' style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-12); color: var(--fg-soft);">' +
      escapeHtml(chain) + '</span>';
  } else if (r.currentPageId) {
    breadcrumbCell =
      '<span class="mono" title="page row missing (unpublished or deleted since feedback was written)"' +
      ' style="font-size: var(--t-12); color: var(--fg-mute);">' +
      escapeHtml(r.currentPageId) + '</span>';
  } else {
    breadcrumbCell = '<span class="mono" style="font-size: var(--t-12); color: var(--fg-mute);">—</span>';
  }
  return (
    '<li class="feedback-row"' +
    ' data-feedback-row="' + r.feedback_id + '"' +
    ' data-feedback-answer-id="' + escapeHtml(r.answerId) + '"' +
    ' style="display: grid; grid-template-columns: 90px 80px 90px minmax(0, 1fr) minmax(0, 1fr);' +
    ' gap: var(--s-3); padding: var(--s-3) var(--s-5);' +
    ' border-top: 1px solid var(--bd-soft); align-items: center; cursor: pointer;">' +
    '<span class="mono" style="font-size: var(--t-12); color: var(--fg-mute);">' + escapeHtml(r.ts.slice(11, 19)) + '</span>' +
    badge +
    confTag +
    '<span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + escapeHtml(r.question) + '</span>' +
    breadcrumbCell +
    '</li>'
  );
}

function emptyFilterCopy(filter) {
  return (
    '<div style="padding: var(--s-8) var(--s-5); text-align: center; color: var(--fg-soft); font-size: var(--t-13);">' +
    'No rows match <code class="inline">' + escapeHtml(filter) + '</code> in this window. ' +
    FILTER_FALLBACK_HINT +
    '</div>'
  );
}

async function load(filter) {
  if (!rowsRoot) return;
  rowsRoot.setAttribute('aria-busy', 'true');
  let res, body;
  try {
    res = await fetch(
      '/api/projects/' + encodeURIComponent(FB.projectName) + '/feedback?filter=' + encodeURIComponent(filter),
    );
    body = await res.json();
  } catch (err) {
    rowsRoot.innerHTML = '<div style="padding: var(--s-8) var(--s-5); text-align: center; color: var(--err);">Failed to load: ' + escapeHtml(String(err)) + '</div>';
    rowsRoot.setAttribute('aria-busy', 'false');
    return;
  }
  if (!body || body.ok === false) {
    rowsRoot.innerHTML = '<div style="padding: var(--s-8) var(--s-5); text-align: center; color: var(--err);">Failed: ' + escapeHtml((body && body.error) || res.statusText) + '</div>';
    rowsRoot.setAttribute('aria-busy', 'false');
    return;
  }
  rowsRoot.innerHTML = body.rows.length === 0
    ? emptyFilterCopy(filter)
    : '<ul class="feedback-rows" style="list-style: none; margin: 0; padding: 0;">' + body.rows.map(renderRow).join('') + '</ul>';
  if (metaEl) {
    metaEl.textContent = body.rows.length + ' of ' + body.filterCounts[filter] + ' in last 7d';
  }
  // Update chip badges + aria-selected state.
  if (chipBar) {
    chipBar.querySelectorAll('[data-feedback-chip]').forEach((b) => {
      const f = b.getAttribute('data-feedback-chip');
      const cnt = body.filterCounts[f] ?? 0;
      const active = f === filter;
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.classList.toggle('warn', active);
      const cntEl = b.querySelector('.cnt');
      if (cntEl) cntEl.textContent = String(cnt);
    });
  }
  rowsRoot.setAttribute('aria-busy', 'false');
  FB.filter = filter;
}

if (chipBar) {
  chipBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feedback-chip]');
    if (!btn) return;
    const f = btn.getAttribute('data-feedback-chip');
    if (!f || f === FB.filter) return;
    load(f);
  });
}

// ---------------------------------------------------------------------------
// T1-d — per-row drawer
// ---------------------------------------------------------------------------

const drawerMask = document.getElementById('fb-drawer-mask');
const drawerEl = document.getElementById('fb-drawer');
const drawerHd = document.getElementById('fb-drawer-hd');
const drawerBd = document.getElementById('fb-drawer-bd');

// Stale-response guard: each openDrawer() bumps this token, and the async
// fetch only writes to the DOM if the token is still the one captured at
// call time. closeDrawer() also bumps it so a pending fetch can't reopen
// the drawer after the user dismissed it.
let drawerReqToken = 0;

function closeDrawer() {
  // Bump the token so any pending openDrawer fetch sees a token mismatch
  // and skips its DOM write — otherwise a slow response could reopen the
  // drawer the user just closed.
  drawerReqToken++;
  if (drawerMask) drawerMask.hidden = true;
  if (drawerEl) drawerEl.hidden = true;
  document.body.style.overflow = '';
  if (rowsRoot) {
    const prev = rowsRoot.querySelector('.feedback-row.sel');
    if (prev) prev.classList.remove('sel');
  }
}

function setDrawerLoading(qPreview) {
  if (!drawerHd || !drawerBd) return;
  drawerHd.innerHTML =
    '<div style="display:flex; justify-content:space-between; align-items:center; gap:var(--s-3);">' +
      '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;">' + escapeHtml(qPreview) + '</span>' +
      '<button class="icon-btn" id="fb-drawer-close" title="close" aria-label="close"><svg><use href="#i-x"/></svg></button>' +
    '</div>';
  drawerBd.innerHTML = '<p class="muted" style="padding: var(--s-5);">loading…</p>';
}

function ratingLine(d) {
  if (d.signal_source === 'implicit') return 'γ ⏱ implicit (same-session re-ask)';
  if (d.signal_source === 'curated')   return '★ curated (post-review)';
  if (d.rating !== null && d.rating > 0) return '👍 explicit positive';
  if (d.rating !== null && d.rating < 0) return '👎 explicit negative';
  return 'β explicit (rating absent)';
}

function fmtConf(n) {
  return typeof n === 'number' ? n.toFixed(2) : '—';
}

function breadcrumbLine(d) {
  if (Array.isArray(d.breadcrumb) && d.breadcrumb.length > 0) {
    return escapeHtml(d.breadcrumb.map((n) => n.title).join(' › '));
  }
  if (d.currentPageId) return '<span class="mono" style="color:var(--fg-mute);">' + escapeHtml(d.currentPageId) + '</span>';
  return '<span style="color:var(--fg-mute);">—</span>';
}

function renderFusedTable(fused) {
  if (!Array.isArray(fused) || fused.length === 0) {
    return '<p class="muted" style="font-size:var(--t-12); margin:0;">no fused retrieval trace</p>';
  }
  let body = '<table class="tbl" style="font-size:var(--t-12); margin:0;"><thead><tr>' +
    '<th>page · chunk</th><th class="num">final</th><th class="num">rrf</th>' +
    '<th class="num">vec</th><th class="num">bm25</th><th class="num">nav</th>' +
  '</tr></thead><tbody>';
  fused.slice(0, 8).forEach((f) => {
    body += '<tr><td>' + escapeHtml(f.page || '') +
      ' <span class="mono" style="color:var(--fg-mute);">#' + (f.chunkId ?? '—') + '</span></td>' +
      '<td class="num">' + (f.finalScore != null ? f.finalScore.toFixed(3) : '—') + '</td>' +
      '<td class="num">' + (f.rrfScore != null ? f.rrfScore.toFixed(3) : '—') + '</td>' +
      '<td class="num">' + (f.vecRank != null ? f.vecRank : '—') + '</td>' +
      '<td class="num">' + (f.bm25Rank != null ? f.bm25Rank : '—') + '</td>' +
      '<td class="num">' + (f.navIndex != null ? f.navIndex : '—') + '</td></tr>';
  });
  body += '</tbody></table>';
  return body;
}

function renderCitations(cits) {
  if (!Array.isArray(cits) || cits.length === 0) {
    return '<p class="muted" style="font-size:var(--t-12); margin:0;">no citations on this answer</p>';
  }
  let out = '<div>';
  cits.forEach((c, i) => {
    out += '<div class="cit"><span class="ci-no"><span class="cite">' + (i + 1) + '</span></span>' +
      '<div class="ci-bd"><div class="ci-ti">' + escapeHtml(c.page || '') + '</div>' +
      (c.quote ? '<div class="ci-sn">' + escapeHtml(c.quote) + '</div>' : '') +
      '</div></div>';
  });
  out += '</div>';
  return out;
}

function drawerSec(title, sub, body) {
  return '<div class="drawer-sec"><div class="drawer-sec-hd"><h3>' + title + '</h3>' +
    (sub ? '<span class="meta">' + sub + '</span>' : '') + '</div>' +
    '<div class="drawer-sec-bd">' + body + '</div></div>';
}

function renderDrawerHead(d) {
  return (
    '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:var(--s-3);">' +
      '<div style="min-width:0; flex:1;">' +
        '<div class="meta" style="font-size:var(--t-12);">' + escapeHtml(d.ts.slice(0, 19).replace('T', ' ')) + ' · ' + escapeHtml(ratingLine(d)) + '</div>' +
        '<h2 style="margin:4px 0 0; font-size:var(--t-16); font-weight:600; line-height:1.35;">' + escapeHtml(d.question) + '</h2>' +
      '</div>' +
      '<button class="icon-btn" id="fb-drawer-close" title="close" aria-label="close"><svg><use href="#i-x"/></svg></button>' +
    '</div>'
  );
}

function renderDrawerBody(d) {
  let out = '';
  const metaBits = [
    'conf ' + fmtConf(d.confidence),
    d.run ? ('latency ' + (d.run.latencyMs >= 1000 ? (d.run.latencyMs / 1000).toFixed(1) + 's' : d.run.latencyMs + 'ms')) : 'latency —',
    d.run && d.run.model ? 'model ' + escapeHtml(d.run.model) : 'model —',
    d.hadNoCitations ? '<span class="tag warn">no citations</span>' : null,
  ].filter(Boolean).join(' · ');
  out += drawerSec('META', '', '<div style="font-size:var(--t-12); color:var(--fg-soft);">' + metaBits + '</div>' +
    '<div style="font-size:var(--t-12); color:var(--fg-soft); margin-top:4px;">page: ' + breadcrumbLine(d) + '</div>');
  out += drawerSec('ANSWER',
    d.run && d.run.kind ? ('kind ' + d.run.kind) : '',
    '<pre style="white-space:pre-wrap; font-family:inherit; font-size:var(--t-13); margin:0; max-height:240px; overflow:auto;">' +
      escapeHtml(d.answerMd && d.answerMd.length > 0 ? d.answerMd : (d.run && d.run.errorCode ? 'error · ' + d.run.errorCode : '(no answer body)')) +
    '</pre>');
  if (d.correction) {
    out += drawerSec('CORRECTION', '— from reviewer',
      '<pre style="white-space:pre-wrap; font-family:inherit; font-size:var(--t-13); margin:0;">' + escapeHtml(d.correction) + '</pre>');
  }
  out += drawerSec('CITATIONS', d.citations.length ? '· ' + d.citations.length : '', renderCitations(d.citations));
  if (d.run) {
    out += drawerSec('RETRIEVAL', '· ' + d.run.fused.length + ' fused' +
      (d.run.subtreeAskTriggered ? ' · subtree-ask' : ''),
      renderFusedTable(d.run.fused));
  } else {
    out += drawerSec('RETRIEVAL', '', '<p class="muted" style="font-size:var(--t-12); margin:0;">no linked run line (rolled out of 30d window or runs disabled)</p>');
  }
  // RFC 0002 §5.1 cross-journey jumps. Payloads are serialised onto data-
  // attrs and consumed by bindDrawerControls so the JSON-encoding stays
  // out of the listener.
  const citePages = Array.isArray(d.citations)
    ? d.citations.map((c) => c.page).filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  const addGoldenPayload = JSON.stringify({
    query: d.question,
    context_pageId: d.currentPageId,
    citation_pages: citePages,
  });
  const jumpEnabled = typeof d.currentPageId === 'string' && d.currentPageId.length > 0;
  out += drawerSec('ACTIONS', '',
    '<div style="display:flex; gap:var(--s-2); flex-wrap:wrap;">' +
      '<button class="btn sm primary" data-replay-query="' + escapeHtml(d.question) + '">' +
        '<svg><use href="#i-act"/></svg> replay in Ask →</button>' +
      '<button class="btn sm" data-add-golden-payload="' + escapeHtml(addGoldenPayload) + '">' +
        '<svg><use href="#i-plus"/></svg> add to golden →</button>' +
      (jumpEnabled
        ? '<button class="btn sm" data-jump-page-id="' + escapeHtml(d.currentPageId) + '">' +
            '<svg><use href="#i-folder"/></svg> jump to doc section →</button>'
        : '<span class="tag" title="no current_page_id on this row">jump to doc section — n/a</span>') +
    '</div>');
  return out;
}

async function openDrawer(feedbackId, rowEl, qPreview) {
  if (!drawerEl || !drawerMask || !drawerBd) return;
  if (rowsRoot) {
    const prev = rowsRoot.querySelector('.feedback-row.sel');
    if (prev) prev.classList.remove('sel');
  }
  if (rowEl) rowEl.classList.add('sel');
  const myToken = ++drawerReqToken;
  setDrawerLoading(qPreview);
  drawerMask.hidden = false;
  drawerEl.hidden = false;
  document.body.style.overflow = 'hidden';
  let body;
  try {
    const res = await fetch('/api/projects/' + encodeURIComponent(FB.projectName) + '/feedback/' + feedbackId);
    body = await res.json();
  } catch (err) {
    if (myToken !== drawerReqToken) return;
    drawerBd.innerHTML = '<p style="padding: var(--s-5); color: var(--err);">Failed to load: ' + escapeHtml(String(err)) + '</p>';
    bindDrawerControls();
    return;
  }
  if (myToken !== drawerReqToken) return; // a newer click superseded us
  if (!body || body.ok === false) {
    drawerBd.innerHTML = '<p style="padding: var(--s-5); color: var(--err);">Failed: ' + escapeHtml((body && body.error) || 'unknown') + '</p>';
    bindDrawerControls();
    return;
  }
  const d = body.detail;
  if (drawerHd) drawerHd.innerHTML = renderDrawerHead(d);
  drawerBd.innerHTML = renderDrawerBody(d);
  drawerBd.scrollTop = 0;
  bindDrawerControls();
}

function bindDrawerControls() {
  const closeBtn = document.getElementById('fb-drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (!drawerBd) return;
  // Replay-in-Ask delegates to the existing console:reask receiver in
  // project.ts BOOTSTRAP_SCRIPT — fills #ask-q and switches the tab.
  const replay = drawerBd.querySelector('[data-replay-query]');
  if (replay) {
    replay.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('console:reask', {
        detail: { query: replay.dataset.replayQuery || '' },
      }));
      closeDrawer();
    });
  }
  // Add-to-golden: reuse the existing console:add-golden handler that
  // Traffic drawer already wires (POST + toast + tab switch). Payload
  // shape identical → no new endpoint.
  const addGold = drawerBd.querySelector('[data-add-golden-payload]');
  if (addGold) {
    addGold.addEventListener('click', () => {
      let payload;
      try {
        payload = JSON.parse(addGold.dataset.addGoldenPayload || '{}');
      } catch (e) {
        payload = null;
      }
      if (!payload || !payload.query) return;
      window.dispatchEvent(new CustomEvent('console:add-golden', { detail: payload }));
      closeDrawer();
    });
  }
  // Jump-to-doc-section: switch hash to #index?focus=<pageId>. The hash
  // change triggers project.ts's hashchange listener (switches the tab)
  // and the Index tab's own focus receiver (scrolls + flashes the row).
  const jump = drawerBd.querySelector('[data-jump-page-id]');
  if (jump) {
    jump.addEventListener('click', () => {
      const pageId = jump.dataset.jumpPageId || '';
      if (!pageId) return;
      closeDrawer();
      location.hash = '#index?focus=' + encodeURIComponent(pageId);
    });
  }
}

// Row click → fetch detail → open drawer. We delegate from rowsRoot so the
// handler keeps working after chip swaps replace innerHTML.
if (rowsRoot) {
  rowsRoot.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;
    const row = e.target.closest('.feedback-row');
    if (!row) return;
    const idAttr = row.getAttribute('data-feedback-row');
    if (!idAttr) return;
    const id = Number(idAttr);
    if (!Number.isFinite(id)) return;
    const qCell = row.children[3];
    const qPreview = qCell ? qCell.textContent.trim() : '';
    openDrawer(id, row, qPreview);
  });
}

if (drawerMask) drawerMask.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerEl && !drawerEl.hidden) closeDrawer();
});
`;
