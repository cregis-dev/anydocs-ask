/**
 * Home page (project selector) — ARCH §17.3.1 GET /.
 * Card grid; each card shows name + status pills + indexed flag and links
 * into /p/:name. Invalid projects render with grayed treatment + reason.
 */

import { html } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import { layout, type Html, type NavContext } from './layout.ts';

export type HomeViewModel = {
  workspacePath: string;
  consolePort: number;
  idleTimeoutMin: number;
  projects: ProjectListing[];
  running: Map<string, RegisteredProcess>;
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
    ${vm.projects.length === 0 ? emptyState(vm.workspacePath) : projectGrid(vm)}
  `;
  return layout({ title: 'projects', body, nav });
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
  const cards = vm.projects.map((p) => projectCard(p, vm.running.get(p.name) ?? null));
  return html`
    <div class="proj-grid">${cards}</div>
    <style>
      .proj-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
      .proj-card { display: flex; flex-direction: column; min-height: 132px; }
      .proj-card .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
      .proj-card .name { font-weight: 600; font-size: 15px; }
      .proj-card .id { font-size: 11.5px; color: var(--fg-mute); }
      .proj-card .pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 12px; }
      .proj-card .footer { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; }
      .proj-card.invalid { opacity: .68; }
      .proj-card.invalid .name { color: var(--fg-soft); }
      .proj-card .invalid-msg { color: var(--err); font-size: 12px; margin-bottom: 10px; }
    </style>
  `;
}

function projectCard(p: ProjectListing, running: RegisteredProcess | null): Html {
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
