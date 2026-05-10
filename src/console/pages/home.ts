/**
 * Home page (project selector) — ARCH §17.3.1 GET /.
 * Card grid; each card shows name + status pills + indexed flag and links
 * into /p/:name. Invalid projects render with grayed treatment + reason.
 */

import { html } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import { layout, type Html, type NavContext } from './layout.ts';
import type { ProjectHomeStats, WorkspaceSummary } from '../home-state.ts';

export type HomeViewModel = {
  workspacePath: string;
  consolePort: number;
  idleTimeoutMin: number;
  projects: ProjectListing[];
  running: Map<string, RegisteredProcess>;
  /** Per-project state extras for card decoration. */
  projectStats?: Map<string, ProjectHomeStats>;
  /** Workspace-level rollup for the top strip. */
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
  const body = html`
    <div class="pagehead">
      <h1>projects</h1>
      <span class="crumb mono">workspace · ${vm.workspacePath}</span>
    </div>
    ${vm.workspaceSummary && vm.projects.length > 0 ? workspaceStrip(vm.workspaceSummary) : ''}
    ${vm.projects.length === 0 ? emptyState(vm.workspacePath) : projectGrid(vm)}
  `;
  return layout({ title: 'projects', body, nav });
}

function workspaceStrip(s: WorkspaceSummary): Html {
  return html`
    <div class="ws-strip">
      <div class="ws-kpi">
        <span class="ws-v">${s.projectsValid}/${s.projectsTotal}</span>
        <span class="ws-k">valid projects</span>
      </div>
      <div class="ws-kpi">
        <span class="ws-v">${s.projectsIndexed}</span>
        <span class="ws-k">indexed</span>
      </div>
      <div class="ws-kpi">
        <span class="ws-v">${s.projectsRunning}</span>
        <span class="ws-k">running</span>
      </div>
      <div class="ws-kpi">
        <span class="ws-v">${s.totalCases}</span>
        <span class="ws-k">golden cases</span>
      </div>
      <div class="ws-kpi">
        <span class="ws-v">${s.totalRuns7d}</span>
        <span class="ws-k">runs · 7d</span>
      </div>
      ${s.mostRecentProject
        ? html`<div class="ws-kpi"><span class="ws-v mono" style="font-size: 13px;">${s.mostRecentProject}</span><span class="ws-k">most recent</span></div>`
        : ''}
    </div>
    <style>
      .ws-strip { display: flex; gap: 18px; flex-wrap: wrap; padding: 12px 16px; margin: 0 0 14px; background: var(--bg-elev); border: 1px solid var(--bd); border-radius: 8px; }
      .ws-kpi { display: flex; flex-direction: column; min-width: 100px; }
      .ws-v { font-size: 17px; font-weight: 600; font-family: ui-monospace, monospace; letter-spacing: -0.01em; }
      .ws-k { font-size: 11px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }
    </style>
  `;
}

function emptyState(workspacePath: string): Html {
  return html`
    <div class="card">
      <p class="empty">workspace 内 <code>projects/</code> 目录为空。</p>
      <p class="muted" style="text-align:center;">
        把 anydocs 项目放入 <code class="mono">${workspacePath}/projects/</code>，<br />
        或用 symlink 接入既有仓库。
      </p>
    </div>
  `;
}

function projectGrid(vm: HomeViewModel): Html {
  const cards = vm.projects.map((p) =>
    projectCard(p, vm.running.get(p.name) ?? null, vm.projectStats?.get(p.name)),
  );
  return html`
    <div class="proj-grid">${cards}</div>
    <style>
      .proj-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
      .proj-card { display: flex; flex-direction: column; min-height: 152px; }
      .proj-card .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
      .proj-card .name { font-weight: 600; font-size: 15px; }
      .proj-card .id { font-size: 11.5px; color: var(--fg-mute); }
      .proj-card .pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 8px; }
      .proj-card .stats { display: flex; gap: 12px; font-size: 11.5px; color: var(--fg-mute); margin-bottom: 10px; }
      .proj-card .stats .v { color: var(--fg-soft); font-family: ui-monospace, monospace; font-weight: 500; }
      .proj-card .footer { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; }
      .proj-card.invalid { opacity: .68; }
      .proj-card.invalid .name { color: var(--fg-soft); }
      .proj-card .invalid-msg { color: var(--err); font-size: 12px; margin-bottom: 10px; }
    </style>
  `;
}

function projectCard(
  p: ProjectListing,
  running: RegisteredProcess | null,
  stats: ProjectHomeStats | undefined,
): Html {
  const live = running !== null && !running.exited;
  const idAttr =
    p.projectId && p.projectId !== p.name
      ? html`<span class="id mono">id=${p.projectId}</span>`
      : '';
  if (!p.valid) {
    return html`
      <div class="card proj-card invalid">
        <div class="head">
          <span class="name mono">${p.name}</span>
          ${idAttr}
        </div>
        <div class="invalid-msg">missing: ${p.missing.join(', ')}</div>
        <div class="footer">
          <span class="muted mono" title="${p.path}">${shortPath(p.path)}</span>
          <span class="muted">—</span>
        </div>
      </div>
    `;
  }
  const pills = html`
    <span class="pill"><span class="dot ${live ? 'run' : 'idle'}"></span>${live ? `running · :${running!.port}` : 'idle'}</span>
    ${p.indexed
      ? html`<span class="pill"><span class="dot run"></span>indexed</span>`
      : html`<span class="pill"><span class="dot idle"></span>not indexed</span>`}
  `;
  const statsRow = stats
    ? html`
        <div class="stats">
          <span><span class="v">${stats.cases}</span> cases</span>
          <span><span class="v">${stats.runs7d}</span> runs·7d</span>
          ${stats.lastEvalDate
            ? html`<span>eval <span class="v">${stats.lastEvalDate}</span></span>`
            : html`<span class="muted">no eval yet</span>`}
        </div>
      `
    : '';
  const action = live
    ? html`<a class="btn btn-primary" href="/p/${p.name}">open →</a>`
    : html`<a class="btn btn-primary" href="/p/${p.name}?autostart=1">open + start →</a>`;
  return html`
    <div class="card proj-card">
      <div class="head">
        <span class="name mono">${p.name}</span>
        ${idAttr}
      </div>
      <div class="pills">${pills}</div>
      ${statsRow}
      <div class="footer">
        <span class="muted mono" title="${p.path}">${shortPath(p.path)}</span>
        ${action}
      </div>
    </div>
  `;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
