/**
 * Per-project page — ARCH §17.3.1 GET /p/:name.
 *
 * Two-column layout:
 *   left  · status + lifecycle (start/stop) + reports + ops triggers
 *   right · ask 体验台 (Answer / Citations / Meta tabs) + activity link
 *
 * The ask response is rendered via the browser-side marked module loaded
 * from /console/static/marked.esm.js. Retrieval trace (fused top-5) is
 * NOT included by the v1 ask response — that arrives with v1.5 ?debug=1
 * (PRD §13.6 / ARCH §17.8). Citations + meta cover what's available.
 */

import { html, raw } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import type { ReportListing } from '../ops.ts';
import { layout, type Html, type NavContext } from './layout.ts';

export type ProjectViewModel = {
  project: ProjectListing;
  running: RegisteredProcess | null;
  reports: ReportListing[];
  /** ?autostart=1 → page-load JS POSTs /start once before user interaction. */
  autostart?: boolean;
  nav?: NavContext;
};

export function renderProject(vm: ProjectViewModel): Html {
  const { project, running } = vm;
  const live = running !== null && !running.exited;
  const autostartFlag = vm.autostart ? 'true' : 'false';

  const body = html`
    <div class="pagehead">
      <span class="crumb mono"><a href="/">projects</a> /</span>
      <h1 class="mono">${project.name}</h1>
      ${statusPill(live, running)}
    </div>

    ${project.valid
      ? html`<div class="grid-2">${sidebar(project, live, running, vm.reports)} ${mainCol(project, live)}</div>`
      : invalidNotice(project)}

    <script>${raw(`
      window.__CONSOLE__ = { name: ${JSON.stringify(project.name)}, valid: ${project.valid}, live: ${live}, autostart: ${autostartFlag} };
    `)}</script>
    <script type="module">${raw(BOOTSTRAP_SCRIPT)}</script>
  `;

  return layout({ title: project.name, body, nav: vm.nav });
}

function statusPill(live: boolean, running: RegisteredProcess | null): Html {
  if (live && running) {
    // JS overrides text/dot once /v1/health resolves warm vs warming.
    return html`<span class="pill" id="status-pill"><span class="dot run" id="status-dot"></span><span id="status-text">running · :${running.port} · pid ${running.pid}</span></span>`;
  }
  return html`<span class="pill" id="status-pill"><span class="dot idle" id="status-dot"></span><span id="status-text">idle</span></span>`;
}

function invalidNotice(project: ProjectListing): Html {
  return html`
    <div class="card">
      <h2 style="color: var(--err);">project invalid</h2>
      <p>missing: <code>${project.missing.join(', ')}</code></p>
      <p class="muted">补齐 <code>pages/</code> 与 <code>navigation/</code>，刷新页面即可。</p>
      <dl class="kv">
        <dt>path</dt><dd class="mono">${project.path}</dd>
        <dt>projectId</dt><dd class="mono">${project.projectId ?? '—'}</dd>
      </dl>
    </div>
  `;
}

function sidebar(
  project: ProjectListing,
  live: boolean,
  running: RegisteredProcess | null,
  reports: ReportListing[],
): Html {
  return html`
    <div>
      ${statusCard(project, live, running)}
      ${lifecycleCard(live)}
      ${opsCard()}
      ${reportsCard(project.name, reports)}
    </div>
  `;
}

function statusCard(
  project: ProjectListing,
  live: boolean,
  running: RegisteredProcess | null,
): Html {
  return html`
    <div class="card">
      <h2>status</h2>
      <dl class="kv">
        <dt>path</dt><dd class="mono">${project.path}</dd>
        <dt>projectId</dt><dd class="mono">${project.projectId ?? '—'}</dd>
        <dt>indexed</dt><dd>${project.indexed ? html`<span class="tag ok">yes</span>` : html`<span class="tag">no</span>`}</dd>
        <dt>process</dt><dd>${live && running ? html`<span class="tag run">:${running.port}</span> <span class="muted mono">pid ${running.pid}</span>` : html`<span class="tag">stopped</span>`}</dd>
      </dl>
    </div>
  `;
}

function lifecycleCard(live: boolean): Html {
  return html`
    <div class="card">
      <h2>lifecycle</h2>
      <div class="btn-row">
        <button id="btn-start" class="btn-primary" ${live ? 'disabled' : ''}>start</button>
        <button id="btn-stop" ${live ? '' : 'disabled'}>stop</button>
      </div>
      <p class="status muted" id="lifecycle-status" style="margin-top: 8px; font-size: 12px; min-height: 16px;"></p>
    </div>
  `;
}

function opsCard(): Html {
  return html`
    <div class="card">
      <h2>测评 · golden</h2>
      <div class="btn-row">
        <button id="btn-eval">run eval</button>
        <button id="btn-analyze">analyze runs · 7d</button>
      </div>
      <div class="btn-row" style="margin-top: 8px;">
        <button id="btn-golden-structure">golden ← structure</button>
        <button id="btn-golden-runs">golden ← runs</button>
      </div>
      <p id="op-status" class="status muted" style="margin-top: 10px; font-size: 12px; min-height: 16px;"></p>
      <p class="muted" style="font-size: 11.5px; margin-top: 6px;">
        默认无 LLM 改写；要 <code>--llm-rewrite</code> 走命令行 <code class="mono">anydocs-ask golden generate</code>。
      </p>
    </div>
  `;
}

function reportsCard(name: string, reports: ReportListing[]): Html {
  if (reports.length === 0) {
    return html`
      <div class="card">
        <h2>reports</h2>
        <p class="empty" style="padding: 8px 0;">尚无报告。</p>
      </div>
    `;
  }
  const grouped = groupByKind(reports);
  const blocks = (['eval', 'analyze', 'golden'] as const).map((kind) => {
    const list = grouped[kind] ?? [];
    if (list.length === 0) return html``;
    return html`
      <h3>${kind} <span class="muted" style="font-size: 11px;">${list.length}</span></h3>
      <ul style="list-style: none; padding: 0; margin: 0 0 10px;">
        ${list.slice(0, 8).map(
          (r) => html`
            <li style="padding: 4px 0; display: flex; gap: 8px; align-items: baseline;">
              <span class="mono muted" style="font-size: 11.5px;">${r.date}</span>
              <a class="mono" href="/p/${name}/reports/${r.filename}" style="font-size: 12px;">${r.filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')}</a>
            </li>
          `,
        )}
      </ul>
    `;
  });
  return html`
    <div class="card">
      <h2>reports <span class="muted" style="font-size: 11px;">${reports.length}</span></h2>
      ${blocks}
    </div>
  `;
}

function groupByKind(reports: ReportListing[]): Record<string, ReportListing[]> {
  const out: Record<string, ReportListing[]> = {};
  for (const r of reports) {
    const list = out[r.kind] ?? (out[r.kind] = []);
    list.push(r);
  }
  return out;
}

function mainCol(project: ProjectListing, live: boolean): Html {
  return html`
    <div>
      ${askCard(live)}
      <div class="card">
        <h2>activity</h2>
        <p>
          <a href="/p/${project.name}/runs">查看最近 runs →</a>
        </p>
        <p class="muted" style="font-size: 12px;">
          ask 体验台默认 <code>?dry_run=1</code>，本页发起的提问 <strong>不会</strong> 写入 runs。<br />
          想看真实流量，去 Reader 直调 <code>/v1/ask</code>，或在 v1.5 用"灌真实流量"开关。
        </p>
      </div>
    </div>
  `;
}

function askCard(live: boolean): Html {
  return html`
    <div class="card">
      <div class="card-head" style="padding: 0 0 10px; border-bottom: 1px solid var(--bd-soft); margin: -2px 0 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
        <h2 style="margin: 0;">ask 体验台</h2>
        <label id="persist-toggle-wrap" style="display:inline-flex; align-items:center; gap:6px; font-size: 12px; cursor: pointer; user-select: none;">
          <input type="checkbox" id="persist-toggle" style="margin: 0; accent-color: var(--err);" />
          <span id="persist-toggle-label" class="muted">dry-run · 不写 runs</span>
        </label>
      </div>
      <div id="persist-warning" hidden style="background: var(--err-bg); border: 1px solid var(--err); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 12.5px; color: var(--err);">
        ⚠ <strong>persist 已开启</strong>：这次提问会写入 runs jsonl，标记 source=console。
        analyze / golden generate 默认排除，需要时 <code class="mono">--include-console</code> 显式纳入。
        刷新页面会自动回到 dry-run。
      </div>
      <textarea
        id="ask-q"
        rows="3"
        placeholder="试一个问题，例如：JWT 怎么续期&#10;Cmd/Ctrl + Enter 提交"
        ${live ? '' : 'disabled'}
      ></textarea>
      <div class="btn-row" style="margin-top: 8px;">
        <button id="btn-ask" class="btn-primary" ${live ? '' : 'disabled'}>ask <span class="muted" style="font-size: 11px; font-weight: normal; margin-left: 4px;">⌘↵</span></button>
        <span id="ask-status" class="status muted"></span>
      </div>

      <div id="ask-result" hidden style="margin-top: 14px;">
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="answer" aria-selected="true">answer</button>
          <button role="tab" data-tab="citations">citations <span id="cit-count" class="muted" style="font-size: 11px;"></span></button>
          <button role="tab" data-tab="meta">meta</button>
        </div>
        <div id="tab-answer" class="tab-panel" data-tab="answer">
          <div id="ask-answer-md" class="md"></div>
          <div id="ask-clarify" hidden></div>
          <div id="ask-error" hidden style="color: var(--err);"></div>
        </div>
        <div id="tab-citations" class="tab-panel" data-tab="citations" hidden>
          <div id="ask-cite-list" class="cite-list"></div>
          <p id="ask-cite-empty" class="empty" hidden>无 citations。</p>
        </div>
        <div id="tab-meta" class="tab-panel" data-tab="meta" hidden>
          <dl id="ask-meta" class="kv"></dl>
          <h3 style="margin-top: 14px;">raw response</h3>
          <pre id="ask-raw" class="mono" style="font-size: 11.5px; max-height: 360px;"></pre>
          <p class="muted" style="font-size: 11.5px; margin-top: 8px;">
            完整 retrieval trace (fused top-5 / vec_rank / bm25_rank) 留给 v1.5 <code>?debug=1</code>（ARCH §17.8）。
          </p>
        </div>
      </div>
    </div>
  `;
}

const BOOTSTRAP_SCRIPT = `
import { marked } from '/console/static/marked.esm.js';

marked.setOptions({ breaks: true, gfm: true });

const cfg = window.__CONSOLE__ || { name: '', valid: false, live: false, autostart: false };

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------
// warm state machine — surfaces child runtime.warm via /v1/health.
// ------------------------------------------------------------------
//
// The child HTTP server binds before runtime.warm flips (embedder load +
// fullReindex can take 5-30s). We poll /api/projects/:name/health every
// 1.2s; status pill / Ask gating react. A pending question entered during
// warmup is queued and auto-submitted on warm.
const warmState = {
  warm: false,
  polling: false,
  pollStartedAt: 0,
  pendingQuestion: null,
  abortPoll: false,
};
let warmTickTimer = null;

function setStatusPill(dotCls, text) {
  const dot = $('status-dot');
  const txt = $('status-text');
  if (dot) dot.className = 'dot ' + dotCls;
  if (txt) txt.textContent = text;
}

function elapsedSec() {
  if (!warmState.pollStartedAt) return 0;
  return Math.floor((Date.now() - warmState.pollStartedAt) / 1000);
}

function tickWarmingPill() {
  if (warmState.warm) return;
  setStatusPill('idle', 'warming · ' + elapsedSec() + 's');
}

async function pollHealth() {
  if (warmState.polling) return;
  warmState.polling = true;
  warmState.abortPoll = false;
  warmState.pollStartedAt = Date.now();
  setStatusPill('idle', 'warming · 0s');
  if (warmTickTimer) clearInterval(warmTickTimer);
  warmTickTimer = setInterval(tickWarmingPill, 500);
  while (!warmState.abortPoll) {
    let warm = false;
    let body = null;
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/health');
      if (res.status === 200) {
        body = await res.json();
        warm = body && body.warm === true;
      } else if (res.status === 502) {
        // Child not running — registry says no entry. Stop polling.
        warmState.polling = false;
        warmState.abortPoll = true;
        if (warmTickTimer) { clearInterval(warmTickTimer); warmTickTimer = null; }
        setStatusPill('idle', 'idle');
        return;
      } else {
        try { body = await res.json(); } catch (_) {}
      }
    } catch (_) {
      // network blip — keep polling
    }
    if (warm) {
      warmState.warm = true;
      warmState.polling = false;
      if (warmTickTimer) { clearInterval(warmTickTimer); warmTickTimer = null; }
      onWarmReady(body);
      return;
    }
    await sleep(1200);
  }
  warmState.polling = false;
  if (warmTickTimer) { clearInterval(warmTickTimer); warmTickTimer = null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function onWarmReady(body) {
  // Reflect on pill — keep port info from SSR text if present.
  const txt = $('status-text');
  const existing = (txt && txt.textContent) || '';
  const portMatch = existing.match(/:[0-9]+/);
  const tail = portMatch ? ' · ' + portMatch[0] : '';
  setStatusPill('run', 'ready' + tail);
  if (warmState.pendingQuestion) {
    const q = warmState.pendingQuestion;
    warmState.pendingQuestion = null;
    if (askStatus) {
      askStatus.textContent = 'warm-up done · re-submitting';
      askStatus.className = 'status ok';
    }
    if (askQ) askQ.value = q;
    submitAsk();
  } else if (askStatus) {
    askStatus.textContent = 'ready';
    askStatus.className = 'status ok';
    setTimeout(() => {
      if (askStatus && askStatus.textContent === 'ready') {
        askStatus.textContent = '';
      }
    }, 1500);
  }
}

function lifecycleClick(action) {
  return async () => {
    const btn = $('btn-' + action);
    const status = $('lifecycle-status');
    if (!btn) return;
    btn.disabled = true;
    status.textContent = action + '...';
    status.className = 'status muted';
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/' + action, { method: 'POST' });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        status.textContent = body.error || res.statusText;
        status.className = 'status err';
        btn.disabled = false;
        return;
      }
      status.textContent = action + ' ok';
      status.className = 'status ok';
      setTimeout(() => location.reload(), 350);
    } catch (e) {
      status.textContent = 'network error: ' + (e && e.message ? e.message : e);
      status.className = 'status err';
      btn.disabled = false;
    }
  };
}

if ($('btn-start')) $('btn-start').addEventListener('click', lifecycleClick('start'));
if ($('btn-stop')) $('btn-stop').addEventListener('click', lifecycleClick('stop'));

function bindOp(id, path) {
  const btn = $(id);
  const status = $('op-status');
  if (!btn || !status) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = id.replace('btn-', '') + '...';
    status.className = 'status muted';
    const t0 = Date.now();
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + path, { method: 'POST' });
      const body = await res.json();
      const dt = Date.now() - t0;
      if (!res.ok || body.ok === false) {
        status.textContent = 'failed (' + dt + 'ms): ' + (body.error || res.statusText);
        status.className = 'status err';
      } else if (body.reportPath) {
        status.textContent = 'done (' + dt + 'ms) — reload for new report';
        status.className = 'status ok';
        setTimeout(() => location.reload(), 600);
      } else {
        status.textContent = 'done (' + dt + 'ms): ' + (body.message || 'ok');
        status.className = 'status ok';
        setTimeout(() => location.reload(), 600);
      }
    } catch (e) {
      status.textContent = 'network error: ' + (e && e.message ? e.message : e);
      status.className = 'status err';
    } finally {
      btn.disabled = false;
    }
  });
}
bindOp('btn-eval', '/eval');
bindOp('btn-analyze', '/analyze');
bindOp('btn-golden-structure', '/golden/generate?from=structure');
bindOp('btn-golden-runs', '/golden/generate?from=runs');

function setActiveTab(name) {
  document.querySelectorAll('[role=tab]').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.hidden = p.dataset.tab !== name;
  });
}
document.querySelectorAll('[role=tab]').forEach((b) => {
  b.addEventListener('click', () => setActiveTab(b.dataset.tab));
});

// persist toggle — defaults OFF every page load (no localStorage / cookie
// per PRD §13 decision: avoid accidentally leaving runs on for days).
function setPersistUI(on) {
  const label = $('persist-toggle-label');
  const warn = $('persist-warning');
  const btn = $('btn-ask');
  if (on) {
    if (label) { label.textContent = '⚠ persist · 写入 runs (source=console)'; label.className = ''; label.style.color = 'var(--err)'; label.style.fontWeight = '600'; }
    if (warn) warn.hidden = false;
    if (btn) { btn.style.background = 'var(--err)'; btn.style.borderColor = 'var(--err)'; }
  } else {
    if (label) { label.textContent = 'dry-run · 不写 runs'; label.className = 'muted'; label.style.color = ''; label.style.fontWeight = ''; }
    if (warn) warn.hidden = true;
    if (btn) { btn.style.background = ''; btn.style.borderColor = ''; }
  }
}
const persistToggle = $('persist-toggle');
if (persistToggle) {
  persistToggle.checked = false;
  persistToggle.addEventListener('change', () => setPersistUI(persistToggle.checked));
  setPersistUI(false);
}
function isPersist() {
  return !!(persistToggle && persistToggle.checked);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function renderAnswer(body) {
  const result = $('ask-result');
  const ansEl = $('ask-answer-md');
  const clarEl = $('ask-clarify');
  const errEl = $('ask-error');
  ansEl.innerHTML = '';
  clarEl.hidden = true;
  clarEl.innerHTML = '';
  errEl.hidden = true;
  errEl.textContent = '';
  result.hidden = false;

  if (body && body.type === 'answer') {
    let md = body.answer_md || '';
    if (body.translation_notice) {
      md = '> _translation notice:_ ' + body.translation_notice + '\\n\\n' + md;
    }
    ansEl.innerHTML = marked.parse(md);
  } else if (body && body.type === 'clarify') {
    clarEl.hidden = false;
    let h = '<p class="muted" style="margin-bottom:8px;">需要澄清，请选一个范围：</p>';
    h += '<p>' + escapeHtml(body.message || '') + '</p>';
    if (Array.isArray(body.options) && body.options.length) {
      h += '<ul style="padding-left:18px;">' + body.options.map((o) => '<li>' + escapeHtml(o.label || o.scope_id) + '</li>').join('') + '</ul>';
    }
    clarEl.innerHTML = h;
  } else if (body && body.type === 'error') {
    errEl.hidden = false;
    errEl.textContent = (body.code || 'error') + ': ' + (body.message || '');
  } else {
    errEl.hidden = false;
    errEl.textContent = 'unexpected response shape';
  }
}

function renderCitations(body) {
  const list = $('ask-cite-list');
  const empty = $('ask-cite-empty');
  const cnt = $('cit-count');
  list.innerHTML = '';
  if (!body || body.type !== 'answer' || !Array.isArray(body.citations) || body.citations.length === 0) {
    empty.hidden = false;
    cnt.textContent = '';
    return;
  }
  empty.hidden = true;
  cnt.textContent = '· ' + body.citations.length;
  for (const c of body.citations) {
    const div = document.createElement('div');
    div.className = 'cite-item';
    const crumb = Array.isArray(c.breadcrumb) ? c.breadcrumb.map((b) => b.title).join(' › ') : '';
    const inPath = c.in_page_path || '';
    const langTag = c.source_lang && c.source_lang !== c.lang ? ' <span class="tag warn">cross-lang ' + escapeHtml(c.source_lang) + '→' + escapeHtml(c.lang) + '</span>' : '';
    div.innerHTML =
      '<span class="cite">' + escapeHtml(c.citation_id || '·') + '</span>' +
      '<div>' +
      '  <div class="meta mono">' + escapeHtml(c.page_id || '') + (inPath ? ' · ' + escapeHtml(inPath) : '') + langTag + '</div>' +
      '  <div style="font-weight:600; margin-bottom:4px;">' + escapeHtml(c.title || '') + '</div>' +
      (crumb ? '<div class="muted" style="font-size:11.5px; margin-bottom:6px;">' + escapeHtml(crumb) + '</div>' : '') +
      '  <div class="snippet">' + escapeHtml(c.snippet || '') + '</div>' +
      '</div>';
    list.appendChild(div);
  }
}

function renderMeta(body, latencyMs, httpStatus) {
  const meta = $('ask-meta');
  const raw = $('ask-raw');
  meta.innerHTML = '';
  function row(k, v) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.className = 'mono';
    dd.textContent = v == null ? '—' : String(v);
    meta.appendChild(dt);
    meta.appendChild(dd);
  }
  row('http', httpStatus);
  row('round-trip', latencyMs + ' ms');
  if (body && body.type) row('type', body.type);
  if (body && body.type === 'answer') {
    row('latency_ms', body.latency_ms);
    row('used_chunks', body.used_chunks);
    row('answer_lang', body.answer_lang);
    row('model', body.model);
    if (body.translation_notice) row('translation', body.translation_notice);
  }
  row('dry_run', body && body._dry_run ? 'true' : 'false');
  if (body && body._persisted) {
    row('persisted', 'true');
    row('source', body._source || 'console');
  }
  raw.textContent = JSON.stringify(body, null, 2);
}

const askBtn = $('btn-ask');
const askQ = $('ask-q');
const askStatus = $('ask-status');

async function submitAsk() {
  if (!askQ || !askBtn) return;
  const question = askQ.value.trim();
  if (!question) {
    askStatus.textContent = '请输入问题';
    askStatus.className = 'status err';
    return;
  }
  // If we know the child is warming, queue instead of hitting /ask blindly.
  if (!warmState.warm) {
    warmState.pendingQuestion = question;
    askStatus.textContent = 'queued · waiting for warm-up...';
    askStatus.className = 'status muted';
    pollHealth();
    return;
  }
  askBtn.disabled = true;
  askStatus.textContent = 'asking...';
  askStatus.className = 'status muted';
  const t0 = Date.now();
  const persist = isPersist();
  try {
    const payload = persist ? { question, persist: true } : { question };
    const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { type: 'error', code: 'invalid_response', message: text }; }
    const dt = Date.now() - t0;
    // Race: child flipped back to warming (rare; e.g. forceReindex) — re-queue.
    if (res.status === 503 && body && body.code === 'warming') {
      warmState.warm = false;
      warmState.pendingQuestion = question;
      askStatus.textContent = 'child still warming · re-queued';
      askStatus.className = 'status muted';
      pollHealth();
      return;
    }
    const persistedTail = body && body._persisted ? ' · ✎ wrote runs (source=console)' : '';
    askStatus.textContent = 'http ' + res.status + ' · ' + dt + 'ms' + persistedTail;
    askStatus.className = res.ok ? 'status ok' : 'status err';
    renderAnswer(body);
    renderCitations(body);
    renderMeta(body, dt, res.status);
    setActiveTab('answer');
  } catch (e) {
    askStatus.textContent = 'network error: ' + (e && e.message ? e.message : e);
    askStatus.className = 'status err';
  } finally {
    askBtn.disabled = false;
  }
}
if (askBtn) askBtn.addEventListener('click', submitAsk);
if (askQ) {
  askQ.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitAsk();
    }
  });
}

// Autostart: if /p/:name?autostart=1 and child is not yet live, kick off
// /start once on page load. Idempotent — registry returns reused:true if
// the child is already running between the request landing and JS firing.
// After a successful start, jump straight into health polling instead of
// reloading — preserves any question the author already typed.
if (cfg.valid && cfg.autostart && !cfg.live) {
  const status = $('lifecycle-status');
  if (status) { status.textContent = 'auto-starting...'; status.className = 'status muted'; }
  fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/start', { method: 'POST' })
    .then((r) => r.json())
    .then((body) => {
      if (body && body.ok) {
        if (status) { status.textContent = 'started · :' + body.port + ' · warming...'; status.className = 'status muted'; }
        setStatusPill('idle', 'warming · 0s');
        pollHealth();
        // Clean ?autostart=1 from the URL so a manual refresh won't re-trigger.
        history.replaceState({}, '', location.pathname);
      } else if (status) {
        status.textContent = (body && body.error) || 'autostart failed';
        status.className = 'status err';
      }
    })
    .catch((e) => {
      if (status) { status.textContent = 'autostart err: ' + e.message; status.className = 'status err'; }
    });
} else if (cfg.valid && cfg.live) {
  // Already live on SSR; verify warm state. Child may have been warm for a
  // while (instant resolve) or could be mid-fullReindex (poll until warm).
  pollHealth();
}
`;
