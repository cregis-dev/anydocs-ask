/**
 * Per-project page — ARCH §17.3.1 GET /p/:name.
 *
 * v1 scope (Commit C): status card + start/stop buttons. Ask 体验台 +
 * eval/analyze/golden triggers + reports/runs viewer arrive in Commits
 * D / E.
 */

import { html, raw } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import type { ReportListing } from '../ops.ts';
import { layout, type Html } from './layout.ts';

export type ProjectViewModel = {
  project: ProjectListing;
  running: RegisteredProcess | null;
  reports: ReportListing[];
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

      ${project.valid ? askPanel(project.name) : ''}

      ${project.valid ? evalPanel(project.name) : ''}

      <h2>reports</h2>
      ${vm.reports.length === 0
        ? html`<p class="muted">尚无报告。点上方按钮跑 eval / analyze 即可生成。</p>`
        : reportsList(project.name, vm.reports)}

      <h2>runs</h2>
      <p><a href="/p/${project.name}/runs">查看最近 runs →</a></p>

      <script>${actionScript(project.name)}</script>
    `,
  });
}

function evalPanel(name: string): Html {
  void name;
  return html`
    <h2>测评 · golden</h2>
    <p>
      <button id="btn-eval">run eval</button>
      <button id="btn-analyze">analyze runs (since 7d)</button>
      <button id="btn-golden-structure">golden generate (from structure, no LLM)</button>
      <button id="btn-golden-runs">golden generate (from runs)</button>
      <span id="op-status" class="muted"></span>
    </p>
    <p class="muted" style="font-size: 12px;">
      golden generate 默认走 --no-llm-rewrite 以避免意外费用；如需 LLM 改写，
      用命令行 <code class="mono">anydocs-ask golden generate</code>。
    </p>
  `;
}

function reportsList(name: string, reports: ReportListing[]): Html {
  const rows = reports.map(
    (r) => html`
      <tr>
        <td class="mono">${r.date}</td>
        <td><span class="tag">${r.kind}</span></td>
        <td><a class="mono" href="/p/${name}/reports/${r.filename}">${r.filename}</a></td>
        <td class="mono muted" style="font-size: 12px;">${r.sizeBytes}B</td>
      </tr>
    `,
  );
  return html`
    <table>
      <thead><tr><th>date</th><th>kind</th><th>file</th><th>size</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function askPanel(name: string): Html {
  return html`
    <h2>ask 体验台 <span class="muted" style="font-size: 12px;">(dry-run · 不写 runs)</span></h2>
    <p>
      <textarea id="ask-q" rows="3" style="width: 100%; font-family: inherit; font-size: 13px;"
                placeholder="提一个问题，例如：JWT 怎么续期"></textarea>
    </p>
    <p>
      <button id="btn-ask">ask</button>
      <span id="ask-status" class="muted"></span>
    </p>
    <pre id="ask-out" class="mono" style="background: #f5f5f522; padding: 10px; border-radius: 4px; max-height: 480px; overflow: auto; white-space: pre-wrap; word-break: break-word;"></pre>
  `;
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
  // `name` is interpolated as a JSON string; raw() prevents hono's html
  // tag from escaping the surrounding double quotes (browsers don't HTML-
  // decode <script> contents, so &quot; would produce a JS SyntaxError).
  const safeName = raw(JSON.stringify(name));
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

      var opStatus = document.getElementById('op-status');
      function bindOp(id, path) {
        var b = document.getElementById(id);
        if (!b || !opStatus) return;
        b.addEventListener('click', async function () {
          b.disabled = true;
          opStatus.textContent = id.replace('btn-', '') + '...';
          var t0 = Date.now();
          try {
            var res = await fetch('/api/projects/' + encodeURIComponent(name) + path, { method: 'POST' });
            var body = await res.json();
            var dt = Date.now() - t0;
            if (!res.ok || body.ok === false) {
              opStatus.textContent = 'failed (' + dt + 'ms): ' + (body.error || res.statusText);
            } else if (body.reportPath) {
              opStatus.textContent = 'done (' + dt + 'ms) — reload for new report';
              setTimeout(function () { location.reload(); }, 600);
            } else {
              opStatus.textContent = 'done (' + dt + 'ms): ' + (body.message || 'ok');
              setTimeout(function () { location.reload(); }, 600);
            }
          } catch (e) {
            opStatus.textContent = 'network error: ' + (e && e.message ? e.message : e);
          } finally {
            b.disabled = false;
          }
        });
      }
      bindOp('btn-eval', '/eval');
      bindOp('btn-analyze', '/analyze');
      bindOp('btn-golden-structure', '/golden/generate?from=structure');
      bindOp('btn-golden-runs', '/golden/generate?from=runs');

      var askBtn = document.getElementById('btn-ask');
      var askQ = document.getElementById('ask-q');
      var askOut = document.getElementById('ask-out');
      var askStatus = document.getElementById('ask-status');
      if (askBtn && askQ && askOut && askStatus) {
        askBtn.addEventListener('click', async function () {
          var question = askQ.value.trim();
          if (!question) { askStatus.textContent = '请输入问题'; return; }
          askBtn.disabled = true;
          askStatus.textContent = 'asking...';
          askOut.textContent = '';
          var t0 = Date.now();
          try {
            var res = await fetch('/api/projects/' + encodeURIComponent(name) + '/ask', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ question: question })
            });
            var text = await res.text();
            var pretty;
            try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { pretty = text; }
            askOut.textContent = pretty;
            askStatus.textContent = 'http ' + res.status + ' · ' + (Date.now() - t0) + 'ms';
          } catch (e) {
            askStatus.textContent = 'network error: ' + (e && e.message ? e.message : e);
          } finally {
            askBtn.disabled = false;
          }
        });
      }
    })();
  `;
}
