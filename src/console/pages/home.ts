/**
 * Home page (project selector) — ARCH §17.3.1 GET /.
 * Lists scanProjects() + per-project running status from the registry.
 */

import { html } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import { layout, type Html } from './layout.ts';

export type HomeViewModel = {
  workspacePath: string;
  consolePort: number;
  projects: ProjectListing[];
  running: Map<string, RegisteredProcess>;
};

export function renderHome(vm: HomeViewModel): Html {
  const body =
    vm.projects.length === 0
      ? html`<p class="empty">workspace 内 <code>projects/</code> 目录为空。<br />
        把 anydocs 项目放入 <code class="mono">${vm.workspacePath}/projects/</code>，或用 symlink 接入既有仓库。</p>`
      : projectsTable(vm);

  return layout({
    title: 'projects',
    body: html`
      <h1>projects</h1>
      <p class="muted mono">
        workspace · ${vm.workspacePath} <br />
        console · 127.0.0.1:${vm.consolePort}
      </p>
      ${body}
    `,
  });
}

function projectsTable(vm: HomeViewModel): Html {
  const rows = vm.projects.map((p) => projectRow(p, vm.running.get(p.name) ?? null));
  return html`
    <table>
      <thead>
        <tr>
          <th>name</th>
          <th>status</th>
          <th>indexed</th>
          <th>state</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function projectRow(p: ProjectListing, running: RegisteredProcess | null): Html {
  const validTag = p.valid
    ? html`<span class="tag ok">valid</span>`
    : html`<span class="tag err" title="missing: ${p.missing.join(', ')}">invalid</span>`;
  const runTag = running
    ? html`<span class="tag run">running · :${running.port}</span>`
    : html`<span class="tag">stopped</span>`;
  const indexedTag = p.indexed ? html`<span class="tag ok">yes</span>` : html`<span class="tag">no</span>`;
  const action = p.valid
    ? html`<a href="/p/${p.name}">open →</a>`
    : html`<span class="muted">—</span>`;
  return html`
    <tr>
      <td><span class="mono">${p.name}</span>${
        p.projectId && p.projectId !== p.name
          ? html` <span class="muted mono">(id=${p.projectId})</span>`
          : ''
      }</td>
      <td>${validTag} ${runTag}</td>
      <td>${indexedTag}</td>
      <td>${
        p.projectId
          ? html`<span class="mono muted">state/${p.projectId}/</span>`
          : html`<span class="muted">—</span>`
      }</td>
      <td>${action}</td>
    </tr>
  `;
}
