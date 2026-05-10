/**
 * Per-project page — ARCH §17.3.1 GET /p/:name.
 *
 * v1 scope (Commit C): status card + start/stop buttons. Ask 体验台 +
 * eval/analyze/golden triggers + reports/runs viewer arrive in Commits
 * D / E.
 */

import { html } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import { layout, type Html } from './layout.ts';

export type ProjectViewModel = {
  project: ProjectListing;
  running: RegisteredProcess | null;
};

export function renderProject(vm: ProjectViewModel): Html {
  const { project, running } = vm;
  const live = running !== null && !running.exited;

  return layout({
    title: project.name,
    body: html`
      <p class="mono"><a href="/">← projects</a></p>
      <h1>${project.name}</h1>

      <table>
        <tbody>
          <tr><th>path</th><td class="mono">${project.path}</td></tr>
          <tr><th>projectId</th><td class="mono">${project.projectId ?? '—'}</td></tr>
          <tr><th>valid</th><td>${
            project.valid
              ? html`<span class="tag ok">yes</span>`
              : html`<span class="tag err">missing: ${project.missing.join(', ')}</span>`
          }</td></tr>
          <tr><th>indexed</th><td>${
            project.indexed
              ? html`<span class="tag ok">yes</span>`
              : html`<span class="tag">no</span>`
          }</td></tr>
          <tr><th>process</th><td>${
            live
              ? html`<span class="tag run">running</span> <span class="mono muted">pid=${running!.pid} port=${running!.port}</span>`
              : html`<span class="tag">stopped</span>`
          }</td></tr>
        </tbody>
      </table>

      <h2>actions</h2>
      ${actionButtons(project.name, live, project.valid)}

      <h2>ask · eval · reports</h2>
      <p class="muted">v1 待实现（Commits D / E）。</p>

      <script>${actionScript(project.name)}</script>
    `,
  });
}

function actionButtons(name: string, running: boolean, valid: boolean): Html {
  if (!valid) {
    return html`<p class="muted">project invalid; fix <code>pages/</code> and <code>navigation/</code> first.</p>`;
  }
  return html`
    <p>
      <button id="btn-start" ${running ? 'disabled' : ''}>start</button>
      <button id="btn-stop" ${running ? '' : 'disabled'}>stop</button>
      <span id="status" class="muted"></span>
    </p>
  `;
}

function actionScript(name: string): Html {
  // Vanilla JS — under 30 lines per ARCH §17.4. Buttons fire fetch() then
  // reload on success; on failure, surface the server error inline.
  // `name` is interpolated as a JSON string to be safe inside the script.
  const safeName = JSON.stringify(name);
  return html`
    (function () {
      var name = ${safeName};
      var status = document.getElementById('status');
      function bind(id, action) {
        var b = document.getElementById(id);
        if (!b) return;
        b.addEventListener('click', async function () {
          b.disabled = true;
          status.textContent = action + '...';
          try {
            var res = await fetch('/api/projects/' + encodeURIComponent(name) + '/' + action, { method: 'POST' });
            var body = await res.json();
            if (!res.ok || body.ok === false) {
              status.textContent = (body.error || res.statusText) + '';
              b.disabled = false;
              return;
            }
            location.reload();
          } catch (e) {
            status.textContent = 'network error: ' + (e && e.message ? e.message : e);
            b.disabled = false;
          }
        });
      }
      bind('btn-start', 'start');
      bind('btn-stop', 'stop');
    })();
  `;
}
