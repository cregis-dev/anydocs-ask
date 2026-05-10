/**
 * Read-only Config drawer — ARCH §17.3.9.
 *
 * Slides in from the right when the header gear is clicked. Shows three
 * config files: workspace .env (secrets redacted), workspace
 * .console.json, project anydocs.ask.json (only on project pages).
 *
 * No edit affordance in Phase 1 — that would require touching the
 * "console 自身零状态" lock and writing into project source files, which
 * deserves a separate decision (see PRD §13 future evaluation).
 */

import { html } from 'hono/html';
import type { Html } from './layout.ts';
import type { ConfigViewModel, ConfigFile, RedactedEnvEntry } from '../config-state.ts';

export function renderConfigDrawer(vm: ConfigViewModel): Html {
  return html`
    <aside id="config-drawer" hidden>
      <div class="config-head">
        <h2 style="margin: 0;">config</h2>
        <button id="config-close" class="icon-btn" title="close">×</button>
      </div>
      <div class="config-body">
        ${section('workspace · .env', vm.workspaceEnv, (entries: RedactedEnvEntry[]) => envTable(entries))}
        ${section('workspace · .console.json', vm.consoleJson, (data) => jsonBlock(data))}
        ${vm.projectAskJson
          ? section('project · anydocs.ask.json', vm.projectAskJson, (data) => jsonBlock(data))
          : ''}
        <p class="muted" style="font-size: 11.5px; margin-top: 14px;">
          read-only · 用编辑器改文件后刷新页面（或 reindex）生效。<br />
          secrets 显示为 <code>abcd***xy</code> 形式，前 4 / 后 2 字符；密码 / token 不在此处暴露。
        </p>
      </div>
    </aside>
    <style>
      #config-drawer {
        position: fixed; top: 48px; right: 0; bottom: 0;
        width: min(520px, 100vw); z-index: 100;
        background: var(--bg-elev);
        border-left: 1px solid var(--bd);
        box-shadow: -6px 0 20px rgba(0,0,0,.18);
        overflow-y: auto;
      }
      #config-drawer .config-head {
        position: sticky; top: 0; z-index: 1;
        display: flex; justify-content: space-between; align-items: baseline;
        padding: 14px 20px; border-bottom: 1px solid var(--bd);
        background: var(--bg-elev);
      }
      #config-drawer .config-body { padding: 14px 20px 32px; }
      #config-drawer .cfg-section { margin-bottom: 18px; }
      #config-drawer .cfg-section h3 {
        font-size: 12px; color: var(--fg-mute);
        text-transform: uppercase; letter-spacing: .06em;
        margin: 0 0 4px; font-weight: 600;
      }
      #config-drawer .cfg-section .meta { font-size: 11px; color: var(--fg-mute); margin-bottom: 6px; }
      #config-drawer .cfg-section .err { color: var(--err); font-size: 12px; }
      #config-drawer .cfg-section pre {
        background: var(--bg-soft);
        border: 1px solid var(--bd-soft);
        border-radius: 6px;
        padding: 10px 12px;
        font-size: 11.5px;
        line-height: 1.55;
        max-height: 320px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }
      #config-drawer .env-table { width: 100%; border-collapse: collapse; }
      #config-drawer .env-table td { padding: 4px 6px; border-bottom: 1px solid var(--bd-soft); font-size: 12px; vertical-align: top; }
      #config-drawer .env-table td.k { font-family: ui-monospace, monospace; color: var(--fg-soft); white-space: nowrap; }
      #config-drawer .env-table td.v { font-family: ui-monospace, monospace; word-break: break-all; }
      #config-drawer .env-table td.v.redacted { color: var(--warn); }
      .icon-btn {
        background: transparent; border: 0; box-shadow: none;
        padding: 4px 10px; font-size: 16px; line-height: 1;
        color: var(--fg-mute); cursor: pointer; border-radius: 6px;
      }
      .icon-btn:hover { background: var(--bg-soft); color: var(--fg); }
      .header-gear {
        background: transparent; border: 0; box-shadow: none;
        padding: 4px 10px; font-size: 15px; line-height: 1;
        color: var(--fg-mute); cursor: pointer; border-radius: 6px;
      }
      .header-gear:hover { background: var(--bg-soft); color: var(--fg); }
    </style>
  `;
}

function section<T>(
  title: string,
  file: ConfigFile<T>,
  renderContent: (data: T) => Html,
): Html {
  return html`
    <div class="cfg-section">
      <h3>${title}</h3>
      <div class="meta mono">${file.path}${file.mtimeISO ? ` · ${file.mtimeISO.slice(0, 16).replace('T', ' ')}` : ''}</div>
      ${!file.exists
        ? html`<p class="muted" style="font-size: 12px;">file does not exist (defaults apply)</p>`
        : file.error
          ? html`<p class="err">${file.error}</p>${file.rawText ? html`<pre>${file.rawText}</pre>` : ''}`
          : file.content
            ? renderContent(file.content)
            : html`<p class="muted" style="font-size: 12px;">empty</p>`}
    </div>
  `;
}

function envTable(entries: RedactedEnvEntry[]): Html {
  if (entries.length === 0) {
    return html`<p class="muted" style="font-size: 12px;">no entries (only comments / blank)</p>`;
  }
  return html`
    <table class="env-table">
      <tbody>
        ${entries.map(
          (e) => html`
            <tr>
              <td class="k">${e.key}</td>
              <td class="v ${e.redacted ? 'redacted' : ''}">${e.value || html`<span class="muted">(empty)</span>`}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

function jsonBlock(data: unknown): Html {
  return html`<pre>${JSON.stringify(data, null, 2)}</pre>`;
}
