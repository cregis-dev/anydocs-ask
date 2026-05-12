/**
 * Read-only Config drawer — ARCH §17.3.9.
 *
 * Right-side slide-over (opened via the header gear). Shows three layered
 * config sources in precedence order: workspace .env · workspace
 * .console.json · per-project anydocs.ask.json. Secrets are partially
 * redacted to first 4 + last 2 chars.
 */

import { html } from 'hono/html';
import type { Html } from './layout.ts';
import type { ConfigViewModel, ConfigFile, RedactedEnvEntry } from '../config-state.ts';

export function renderConfigDrawer(vm: ConfigViewModel): Html {
  return html`
    <div id="config-mask" class="drawer-mask" hidden></div>
    <aside id="config-drawer" class="drawer" role="dialog" aria-labelledby="config-drawer-title" hidden>
      <header class="drawer-hd">
        <h2 id="config-drawer-title">
          <svg style="width: 14px; height: 14px; color: var(--fg-soft); vertical-align: -2px;"><use href="#i-gear"/></svg>
          Effective configuration
        </h2>
        <button id="config-close" class="icon-btn" aria-label="close">
          <svg><use href="#i-x"/></svg>
        </button>
      </header>
      <div class="drawer-bd">
        <div class="banner info" style="margin: 0 0 var(--s-5);">
          <span class="b-ico"><svg><use href="#i-info"/></svg></span>
          <div class="b-bd">
            <div class="b-ti">Read-only view</div>
            <div class="b-de">Values merged in precedence order. Secrets show as <code class="inline">abcd***xy</code>.
              Edit the source files and refresh to apply.</div>
          </div>
        </div>

        ${section({
          title: 'WORKSPACE · .env',
          tag: 'precedence 1 · credentials',
          file: vm.workspaceEnv,
          render: (entries) => envTable(entries as RedactedEnvEntry[]),
        })}

        ${section({
          title: 'WORKSPACE · .console.json',
          tag: 'precedence 2',
          file: vm.consoleJson,
          render: (data) => jsonBlock(data),
        })}

        ${vm.projectAskJson
          ? section({
              title: 'PROJECT · anydocs.ask.json',
              tag: 'precedence 3 · overrides workspace',
              file: vm.projectAskJson,
              render: (data) => jsonBlock(data),
            })
          : ''}

        <div style="font-size: var(--t-12); color: var(--fg-mute); padding-top: var(--s-3); border-top: 1px solid var(--bd-soft); line-height: 1.55;">
          <b>How redaction works:</b> values whose key matches
          <code class="inline">/key|secret|token|password|auth_token|private_key/i</code> show first 4 + last 2 chars only.
        </div>
      </div>
    </aside>
  `;
}

function section<T>(args: {
  title: string;
  tag: string;
  file: ConfigFile<T>;
  render: (data: T) => Html;
}): Html {
  const { title, tag, file } = args;
  const mtime = file.mtimeISO ? file.mtimeISO.slice(0, 16).replace('T', ' ') : null;
  return html`
    <section class="drawer-sec">
      <div class="drawer-sec-hd">
        <h3>${title}</h3>
        <span class="tag">${file.exists ? tag : tag + ' · not present'}</span>
        <span class="path">${file.path}${mtime ? ` · mtime ${mtime}` : ''}</span>
      </div>
      ${!file.exists
        ? html`<p class="miss">No file present. Defaults apply.</p>`
        : file.error
          ? html`<p style="color: var(--err); font-size: var(--t-13);">${file.error}</p>${file.rawText ? html`<pre class="block">${file.rawText}</pre>` : ''}`
          : file.content !== null
            ? args.render(file.content)
            : html`<p class="miss">empty</p>`}
    </section>
  `;
}

function envTable(entries: RedactedEnvEntry[]): Html {
  if (entries.length === 0) {
    return html`<p class="miss">no entries (only comments / blank)</p>`;
  }
  return html`
    <dl>
      ${entries.map(
        (e) => html`
          <dt>${e.key}</dt>
          <dd class="${e.redacted ? 'redact' : ''}">${e.value === ''
            ? html`<span class="muted">(empty)</span>`
            : e.redacted
              ? renderRedacted(e.value)
              : e.value}</dd>
        `,
      )}
    </dl>
  `;
}

function renderRedacted(value: string): Html {
  // Existing redactor returns "first4***last2" — render as text with the
  // *** highlighted via <em>.
  const idx = value.indexOf('***');
  if (idx === -1) return html`${value}`;
  return html`${value.slice(0, idx)}<em>***</em>${value.slice(idx + 3)}`;
}

function jsonBlock(data: unknown): Html {
  return html`<pre class="block" style="max-height: 240px;">${JSON.stringify(data, null, 2)}</pre>`;
}
