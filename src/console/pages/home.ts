/**
 * Home page (project selector) — ARCH §17.3.1 GET /.
 *
 * Sticky header (in layout) · workspace KPI strip · project card grid +
 * inline "add project" card. Invalid projects render with red treatment +
 * reason; clicking the row jumps to the standalone /p/:name diagnostic.
 */

import { html, raw } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import { layout, type Html, type NavContext } from './layout.ts';
import type { ProjectHomeStats, WorkspaceSummary } from '../home-state.ts';

export type HomeViewModel = {
  consolePort: number;
  idleTimeoutMin: number;
  projects: ProjectListing[];
  running: Map<string, RegisteredProcess>;
  projectStats?: Map<string, ProjectHomeStats>;
  workspaceSummary?: WorkspaceSummary;
};

export function renderHome(vm: HomeViewModel): Html {
  const liveSet = new Set<string>();
  for (const [name, r] of vm.running) {
    if (!r.exited) liveSet.add(name);
  }
  const nav: NavContext = {
    projects: vm.projects,
    current: null,
    running: liveSet,
    consolePort: vm.consolePort,
    idleTimeoutMin: vm.idleTimeoutMin,
  };
  const empty = vm.projects.length === 0;
  const body = html`
    <div class="page-head">
      ${empty
        ? html`<h1 class="page-title">projects <span class="sub">— no projects yet</span></h1>`
        : html`<h1 class="page-title">projects</h1>`}
    </div>

    ${!empty && vm.workspaceSummary ? workspaceStrip(vm.workspaceSummary) : ''}
    ${empty ? emptyState() : projectGrid(vm)}
    ${empty ? '' : removeModal()}
    ${addFormScript()}
    ${empty ? '' : cardMenuScript()}
  `;
  return layout({
    title: 'projects',
    body,
    nav,
  });
}

function workspaceStrip(s: WorkspaceSummary): Html {
  return html`
    <div class="strip" style="margin-bottom: var(--s-6);">
      <div class="cell">
        <div class="c-lab">valid · total</div>
        <div class="c-val">${s.projectsValid}<span class="unit">/ ${s.projectsTotal}</span></div>
      </div>
      <div class="cell">
        <div class="c-lab">indexed</div>
        <div class="c-val">${s.projectsIndexed}</div>
      </div>
      <div class="cell">
        <div class="c-lab">running</div>
        <div class="c-val" style="${s.projectsRunning > 0 ? 'color: var(--run);' : 'color: var(--fg-mute);'}">
          ${s.projectsRunning}
        </div>
      </div>
      <div class="cell">
        <div class="c-lab">golden cases</div>
        <div class="c-val">${s.totalCases}</div>
      </div>
      <div class="cell">
        <div class="c-lab">runs · 7d</div>
        <div class="c-val">${s.totalRuns7d}</div>
      </div>
      <div class="cell">
        <div class="c-lab">most recent</div>
        <div class="c-val" style="font-size: var(--t-14); font-family: var(--font-mono);">
          ${s.mostRecentProject ?? '—'}
        </div>
      </div>
    </div>
  `;
}

function emptyState(): Html {
  // Full-page empty state — single inline form for "add your first project".
  return html`
    <div class="empty" style="border: 1px dashed var(--bd-strong); border-radius: var(--r-5); background: var(--bg-elev); padding: 64px 24px;">
      <div class="e-ico" style="width: 56px; height: 56px;">
        <svg style="width: 28px; height: 28px;"><use href="#i-folder"/></svg>
      </div>
      <h3>Add your first documentation project</h3>
      <p>A project is a folder shaped like <code class="inline">pages/&lt;lang&gt;/*.json</code>
        plus <code class="inline">navigation/&lt;lang&gt;.json</code>. Point at a local checkout,
        and the console will index it and let you ask questions against it.</p>
      <form id="add-proj-form" style="display: flex; gap: var(--s-2); align-items: center; width: 100%; max-width: 560px; margin-top: var(--s-4);">
        <input id="add-proj-path" class="input mono" placeholder="~/workspace/your-docs" autocomplete="off" />
        <input id="add-proj-name" class="input" placeholder="display name (optional)" style="max-width: 200px;" autocomplete="off" />
        <button class="btn primary" type="submit">
          <svg><use href="#i-plus"/></svg> add project
        </button>
      </form>
      <p style="margin-top: var(--s-3); font-size: var(--t-12); color: var(--fg-mute);">
        Path must contain <code class="inline">pages/</code> and <code class="inline">navigation/</code>.
        We won't write to it.
      </p>
      <p id="add-proj-msg" class="status" style="font-size: var(--t-12);"></p>
      <details style="margin-top: var(--s-5); width: 100%; max-width: 560px; text-align: left;">
        <summary style="font-size: var(--t-12); color: var(--fg-soft); cursor: pointer;">CLI equivalent</summary>
        <pre class="block" style="margin-top: var(--s-2);"><span class="cmt"># add a project via CLI, same effect</span>
anydocs-ask <span class="kw">workspace add</span> ~/workspace/your-docs --name your-docs</pre>
      </details>
    </div>
  `;
}

function projectGrid(vm: HomeViewModel): Html {
  const cards = vm.projects.map((p) =>
    projectCard(p, vm.running.get(p.name) ?? null, vm.projectStats?.get(p.name)),
  );
  return html`<div class="proj-cards">${cards}${addCard()}</div>`;
}

function projectCard(
  p: ProjectListing,
  running: RegisteredProcess | null,
  stats: ProjectHomeStats | undefined,
): Html {
  const live = running !== null && !running.exited;
  const portAttr = live ? html`data-port="${running!.port}"` : '';
  const wrapAttrs = html`
    data-name="${p.name}"
    data-path="${p.path}"
    data-valid="${p.valid ? '1' : '0'}"
    data-indexed="${p.indexed ? '1' : '0'}"
    data-running="${live ? '1' : '0'}"
    ${portAttr}
    data-cases="${stats?.cases ?? 0}"
    data-runs7d="${stats?.runs7d ?? 0}"`;

  if (!p.valid) {
    return html`
      <div class="proj-card-wrap" ${wrapAttrs}>
        <div class="card proj-card invalid" aria-disabled="true">
          <div class="pc-hd">
            <div class="pc-name">${p.name}</div>
            <div class="pc-pills">
              <span class="pill err"><span class="dot"></span>invalid</span>
            </div>
          </div>
          <div class="pc-stats" style="color: var(--err);">
            <span>missing: ${p.missing.join(', ')}</span>
          </div>
          <div class="pc-path" title="${p.path}">${shortPath(p.path)}</div>
          <div class="pc-foot">
            <span class="tag err">cannot open</span>
            <span class="muted" style="font-size: var(--t-12);">fix files, refresh</span>
          </div>
        </div>
        ${cardMenu(p)}
      </div>
    `;
  }

  const pills = html`
    ${live
      ? html`<span class="pill run"><span class="dot"></span>running · :${running!.port}</span>`
      : html`<span class="pill"><span class="dot"></span>idle</span>`}
    ${p.indexed
      ? html`<span class="pill ok"><span class="dot"></span>indexed</span>`
      : html`<span class="pill warn"><span class="dot"></span>not indexed</span>`}
  `;
  const statsRow = stats
    ? html`
        <div class="pc-stats">
          <span><b>${stats.cases}</b> cases</span>
          <span><b>${stats.runs7d}</b> runs · 7d</span>
          ${stats.lastEvalDate
            ? html`<span>eval <b>${stats.lastEvalDate}</b></span>`
            : html`<span class="mono" style="color: var(--fg-mute);">no eval yet</span>`}
        </div>
      `
    : '';
  const linkLabel = live ? 'open' : p.indexed ? 'open + start' : 'open + index';
  const href = live ? `/p/${p.name}` : `/p/${p.name}?autostart=1`;
  const runCls = live ? ' run' : '';
  return html`
    <div class="proj-card-wrap" ${wrapAttrs}>
      <a class="card proj-card${raw(runCls)}" href="${href}">
        <div class="pc-hd">
          <div class="pc-name">${p.name}</div>
          <div class="pc-pills">${pills}</div>
        </div>
        ${statsRow}
        <div class="pc-path" title="${p.path}">${shortPath(p.path)}</div>
        <div class="pc-foot">
          <span class="tag">${p.indexed ? 'indexed' : 'unindexed'}</span>
          <span class="pc-link">${linkLabel} <svg><use href="#i-arr-r"/></svg></span>
        </div>
      </a>
      ${cardMenu(p)}
    </div>
  `;
}

// Per-card kebab + popover menu. The kebab is a sibling of the card link
// (position:absolute via .pc-menu) so clicking it doesn't navigate. Each
// card has its own menu DOM; bindKebabMenus() in the bootstrap closes any
// other open menu before opening this one. "Open project" is a real link;
// "Copy path" + "Remove from console…" are wired by JS off the card-wrap's
// data-* attrs.
function cardMenu(p: ProjectListing): Html {
  return html`
    <button type="button" class="pc-menu" aria-label="more actions" data-menu-toggle="1">
      <svg><use href="#i-kebab"/></svg>
    </button>
    <div class="menu" hidden style="top: 38px; right: 8px;">
      ${p.valid
        ? html`<a class="menu-item" href="/p/${p.name}">
            <svg><use href="#i-arr-r"/></svg>Open project
          </a>`
        : ''}
      <button type="button" class="menu-item" data-copy-path="1">
        <svg><use href="#i-copy"/></svg>Copy path
      </button>
      <hr class="menu-sep" />
      <button type="button" class="menu-item danger" data-remove="1">
        <svg><use href="#i-trash"/></svg>Remove from console…
      </button>
    </div>
  `;
}

function addCard(): Html {
  return html`
    <div class="add-card">
      <h3>
        <svg style="width: 14px; height: 14px; color: var(--fg-soft);"><use href="#i-plus"/></svg>
        add another project
      </h3>
      <p>Point at a folder with <code class="inline">pages/</code> and <code class="inline">navigation/</code>.</p>
      <form id="add-proj-form" class="row" style="flex-direction: column; gap: var(--s-2);">
        <input id="add-proj-path" class="input mono" placeholder="~/workspace/your-docs" autocomplete="off" />
        <div style="display: flex; gap: var(--s-2);">
          <input id="add-proj-name" class="input" placeholder="display name (optional)" style="flex: 1;" autocomplete="off" />
          <button class="btn primary" type="submit">add</button>
        </div>
        <p id="add-proj-msg" class="status" style="font-size: var(--t-12); margin: 0;"></p>
      </form>
    </div>
  `;
}

function addFormScript(): Html {
  return html`<script>${raw(`
    (function(){
      var form = document.getElementById('add-proj-form');
      if (!form) return;
      form.addEventListener('submit', async function(e){
        e.preventDefault();
        var path = (document.getElementById('add-proj-path').value || '').trim();
        var name = (document.getElementById('add-proj-name').value || '').trim();
        var msg = document.getElementById('add-proj-msg');
        if (!path) { msg.className = 'status err'; msg.textContent = 'path is required'; return; }
        msg.className = 'status'; msg.textContent = 'adding…';
        try {
          var res = await fetch('/api/projects/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ path: path }, name ? { name: name } : {})),
          });
          var j = await res.json();
          if (j.ok) {
            msg.className = 'status ok'; msg.textContent = 'added — reloading…';
            setTimeout(function(){ location.reload(); }, 500);
          } else {
            msg.className = 'status err'; msg.textContent = j.error || 'error';
          }
        } catch (err) {
          msg.className = 'status err'; msg.textContent = String(err);
        }
      });
    })();
  `)}</script>`;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

// One global remove-project modal — opened by the per-card kebab "Remove
// from console…" item. Populated from the clicked card's data-* attrs;
// type-to-confirm enables the Remove button. Running projects swap to a
// "Stop & remove" path via force_stop=true on the DELETE; the server also
// returns 409 if a running project is removed without force_stop, as a
// defense-in-depth check.
function removeModal(): Html {
  return html`
    <div class="modal-mask" id="rm-modal" role="dialog" aria-modal="true" aria-labelledby="rm-title" aria-hidden="true">
      <div class="modal danger">
        <header class="modal-hd">
          <span class="b-ico"><svg><use href="#i-trash"/></svg></span>
          <h2 id="rm-title">Remove project from console</h2>
          <span class="modal-sub" id="rm-sub"></span>
          <button type="button" class="icon-btn x" id="rm-close" aria-label="close"><svg><use href="#i-x"/></svg></button>
        </header>
        <div class="modal-bd">
          <div class="del-target">
            <div style="flex: 1; min-width: 0;">
              <div class="dt-name" id="rm-name"></div>
              <div class="dt-path" id="rm-path"></div>
              <div class="dt-stats" id="rm-stats"></div>
            </div>
            <span class="pill" id="rm-pill"></span>
          </div>

          <div class="banner warn" id="rm-running-banner" hidden style="margin: var(--s-4) 0 var(--s-2);">
            <span class="b-ico"><svg><use href="#i-alert"/></svg></span>
            <div class="b-bd">
              <div class="b-ti">Stop the embedder before removing</div>
              <div class="b-de" id="rm-running-de"></div>
            </div>
          </div>

          <p style="font-size: var(--t-13); color: var(--fg-soft); margin: var(--s-4) 0 var(--s-2);">
            This only removes the project from this console.
            Your <b style="color: var(--fg);">files on disk are not touched</b>.
            You can re-add the folder later.
          </p>

          <div class="del-effect">
            <span class="e-ico" id="rm-eff-stop-ico" hidden><svg><use href="#i-stop"/></svg></span>
            <span id="rm-eff-stop-txt" hidden>Embedder <b>stopped</b> <span style="color: var(--fg-mute);">— graceful, ~2s</span></span>
            <span class="e-ico"><svg><use href="#i-x"/></svg></span>
            <span>Workspace entry &amp; saved settings <b>removed</b></span>
            <span class="e-ico"><svg><use href="#i-x"/></svg></span>
            <span>Index database in <code class="inline">state/&lt;projectId&gt;/</code> <b>deleted</b> <span style="color: var(--fg-mute);">if "Also delete" is checked</span></span>
            <span class="e-ico"><svg><use href="#i-x"/></svg></span>
            <span>Eval history &amp; runs <b>deleted</b> <span style="color: var(--fg-mute);">if "Also delete" is checked</span></span>
            <span class="e-ico ok"><svg><use href="#i-check"/></svg></span>
            <span>Source markdown files on disk <b>kept untouched</b></span>
          </div>

          <label class="check" style="margin-top: var(--s-3);">
            <input type="checkbox" id="rm-purge" checked />
            Also delete the index DB and golden cases
            <span style="color: var(--fg-mute); margin-left: 4px;">(uncheck to keep them for re-use)</span>
          </label>

          <div class="confirm-type">
            <label>Type <span class="mono-strong" id="rm-confirm-name"></span> to confirm</label>
            <input id="rm-confirm-input" class="input mono" placeholder="" autocomplete="off" />
          </div>
        </div>
        <footer class="modal-ft">
          <span class="status" id="rm-status" style="margin-right: auto;"></span>
          <button type="button" class="btn" id="rm-cancel">Cancel</button>
          <button type="button" class="btn danger" id="rm-remove" disabled>
            <svg><use href="#i-trash"/></svg>Remove project
          </button>
          <button type="button" class="btn danger" id="rm-stop-remove" hidden disabled>
            <svg><use href="#i-stop"/></svg>Stop &amp; remove
          </button>
        </footer>
      </div>
    </div>
  `;
}

function cardMenuScript(): Html {
  return html`<script>${raw(`
    // ----- per-card kebab popover ------------------------------------
    (function bindKebabMenus(){
      function closeAll(){
        document.querySelectorAll('.proj-card-wrap .menu').forEach(function(m){ m.hidden = true; });
        document.querySelectorAll('.pc-menu.open').forEach(function(b){ b.classList.remove('open'); });
      }
      document.querySelectorAll('.pc-menu[data-menu-toggle]').forEach(function(btn){
        btn.addEventListener('click', function(e){
          e.preventDefault(); e.stopPropagation();
          var wrap = btn.closest('.proj-card-wrap');
          var menu = wrap.querySelector('.menu');
          var open = !menu.hidden;
          closeAll();
          if (!open) { menu.hidden = false; btn.classList.add('open'); }
        });
      });
      // clicks inside the menu shouldn't bubble to the document handler
      document.querySelectorAll('.proj-card-wrap .menu').forEach(function(m){
        m.addEventListener('click', function(e){ e.stopPropagation(); });
      });
      document.addEventListener('click', closeAll);
      document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeAll(); });
    })();

    // ----- copy path ------------------------------------------------
    (function bindCopyPath(){
      document.querySelectorAll('[data-copy-path]').forEach(function(btn){
        btn.addEventListener('click', function(e){
          e.preventDefault();
          var wrap = btn.closest('.proj-card-wrap');
          var path = wrap.dataset.path || '';
          if (navigator.clipboard) navigator.clipboard.writeText(path);
        });
      });
    })();

    // ----- remove-project modal -------------------------------------
    (function bindRemove(){
      var modal = document.getElementById('rm-modal');
      if (!modal) return;
      var els = {
        name: document.getElementById('rm-name'),
        path: document.getElementById('rm-path'),
        stats: document.getElementById('rm-stats'),
        pill: document.getElementById('rm-pill'),
        sub: document.getElementById('rm-sub'),
        banner: document.getElementById('rm-running-banner'),
        bannerDe: document.getElementById('rm-running-de'),
        effStopIco: document.getElementById('rm-eff-stop-ico'),
        effStopTxt: document.getElementById('rm-eff-stop-txt'),
        confirmName: document.getElementById('rm-confirm-name'),
        confirmInput: document.getElementById('rm-confirm-input'),
        purge: document.getElementById('rm-purge'),
        btnRemove: document.getElementById('rm-remove'),
        btnStopRemove: document.getElementById('rm-stop-remove'),
        btnCancel: document.getElementById('rm-cancel'),
        btnClose: document.getElementById('rm-close'),
        status: document.getElementById('rm-status'),
      };
      var current = null;

      function open(d){
        current = d;
        els.name.textContent = d.name;
        els.path.textContent = d.path;
        els.sub.textContent = d.name;
        els.confirmName.textContent = d.name;
        els.confirmInput.value = '';
        els.confirmInput.placeholder = d.name;
        els.confirmInput.classList.remove('match');
        els.btnRemove.disabled = true;
        els.btnStopRemove.disabled = true;
        els.status.textContent = ''; els.status.className = 'status';

        var statsHtml = '<span><b>' + (d.cases||0) + '</b> golden cases</span>'
          + '<span class="sep">·</span><span><b>' + (d.runs7d||0) + '</b> runs · 7d</span>';
        if (d.indexed) statsHtml += '<span class="sep">·</span><span>indexed</span>';
        els.stats.innerHTML = statsHtml;

        if (d.running) {
          els.pill.className = 'pill run';
          els.pill.innerHTML = '<span class="dot"></span>running · :' + d.port;
          els.banner.hidden = false;
          els.bannerDe.innerHTML = 'This project is serving live traffic on <code class="inline">127.0.0.1:'
            + d.port + '</code>. Removing now would terminate any in-flight requests and orphan its index lock.';
          els.btnRemove.hidden = true;
          els.btnStopRemove.hidden = false;
          els.effStopIco.hidden = false;
          els.effStopTxt.hidden = false;
        } else if (!d.valid) {
          els.pill.className = 'pill err';
          els.pill.innerHTML = '<span class="dot"></span>invalid';
          els.banner.hidden = true;
          els.btnRemove.hidden = false;
          els.btnStopRemove.hidden = true;
          els.effStopIco.hidden = true;
          els.effStopTxt.hidden = true;
        } else {
          els.pill.className = 'pill';
          els.pill.innerHTML = '<span class="dot"></span>idle';
          els.banner.hidden = true;
          els.btnRemove.hidden = false;
          els.btnStopRemove.hidden = true;
          els.effStopIco.hidden = true;
          els.effStopTxt.hidden = true;
        }

        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        setTimeout(function(){ els.confirmInput.focus(); }, 50);
      }

      function close(){
        current = null;
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
      }

      function checkMatch(){
        var ok = current && els.confirmInput.value === current.name;
        if (ok) els.confirmInput.classList.add('match');
        else els.confirmInput.classList.remove('match');
        els.btnRemove.disabled = !ok;
        els.btnStopRemove.disabled = !ok;
      }

      async function doRemove(forceStop){
        if (!current) return;
        els.status.className = 'status'; els.status.textContent = 'removing…';
        els.btnRemove.disabled = true; els.btnStopRemove.disabled = true;
        var qs = '?purge_state=' + (els.purge.checked ? 'true' : 'false');
        if (forceStop) qs += '&force_stop=true';
        try {
          var res = await fetch('/api/projects/' + encodeURIComponent(current.name) + qs, { method: 'DELETE' });
          var j = await res.json();
          if (!res.ok || !j.ok) {
            els.status.className = 'status err';
            els.status.textContent = (j && j.error) || ('HTTP ' + res.status);
            checkMatch(); // re-enable based on input
            return;
          }
          els.status.className = 'status ok';
          els.status.textContent = 'removed — reloading…';
          setTimeout(function(){ location.reload(); }, 400);
        } catch (e) {
          els.status.className = 'status err';
          els.status.textContent = (e && e.message) ? e.message : String(e);
          checkMatch();
        }
      }

      document.querySelectorAll('[data-remove]').forEach(function(btn){
        btn.addEventListener('click', function(e){
          e.preventDefault(); e.stopPropagation();
          var wrap = btn.closest('.proj-card-wrap');
          var d = wrap.dataset;
          open({
            name: d.name,
            path: d.path,
            valid: d.valid === '1',
            indexed: d.indexed === '1',
            running: d.running === '1',
            port: d.port || '',
            cases: parseInt(d.cases||'0', 10),
            runs7d: parseInt(d.runs7d||'0', 10),
          });
        });
      });
      els.confirmInput.addEventListener('input', checkMatch);
      els.btnCancel.addEventListener('click', close);
      els.btnClose.addEventListener('click', close);
      modal.addEventListener('click', function(e){ if (e.target === modal) close(); });
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape' && modal.classList.contains('show')) close();
      });
      els.btnRemove.addEventListener('click', function(){ doRemove(false); });
      els.btnStopRemove.addEventListener('click', function(){ doRemove(true); });
    })();
  `)}</script>`;
}
