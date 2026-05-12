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
import { renderConfigDrawer } from './config-drawer.ts';
import type { ConfigViewModel } from '../config-state.ts';

export type HomeViewModel = {
  workspacePath: string;
  consolePort: number;
  idleTimeoutMin: number;
  projects: ProjectListing[];
  running: Map<string, RegisteredProcess>;
  projectStats?: Map<string, ProjectHomeStats>;
  workspaceSummary?: WorkspaceSummary;
  configView?: ConfigViewModel;
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
      <div class="page-meta">${vm.workspacePath}</div>
    </div>

    ${!empty && vm.workspaceSummary ? workspaceStrip(vm.workspaceSummary) : ''}
    ${empty ? emptyState() : projectGrid(vm)}
    ${addFormScript()}
  `;
  return layout({
    title: 'projects',
    body,
    nav,
    ...(vm.configView ? { configDrawer: renderConfigDrawer(vm.configView) } : {}),
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

  if (!p.valid) {
    return html`
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
