/**
 * Read-only Config drawer — ARCH §17.3.9.
 *
 * Right-side slide-over (opened via the header gear). Shows the layered
 * config sources in precedence order: workspace .env · workspace
 * .console.json · per-project anydocs.ask.json · per-project ask.local.json.
 * Secrets are partially redacted to first 4 + last 2 chars.
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
            <div class="b-de">Sources are merged top-to-bottom — later files override earlier ones.
              Secrets show as <code class="inline">abcd…wxyz</code>. Edit the source files and refresh to apply.</div>
          </div>
        </div>

        ${section({
          title: '.env',
          tag: 'base',
          file: vm.workspaceEnv,
          render: (entries) => envTable(entries as RedactedEnvEntry[]),
        })}

        ${section({
          title: '.console.json',
          tag: 'base',
          file: vm.consoleJson,
          render: (data) => jsonBlock(data),
        })}

        ${vm.projectAskJson
          ? section({
              title: 'anydocs.ask.json',
              sub: '— project',
              tag: 'override',
              file: vm.projectAskJson,
              render: (data) => jsonBlock(data),
            })
          : ''}

        ${vm.projectAskLocalJson
          ? section({
              title: 'ask.local.json',
              sub: '— project, gitignored',
              tag: 'override',
              file: vm.projectAskLocalJson,
              render: (data) => jsonBlock(data),
            })
          : ''}

        <div style="font-size: var(--t-12); color: var(--fg-mute); padding-top: var(--s-3); border-top: 1px solid var(--bd-soft); line-height: 1.55;">
          <b>How redaction works:</b> values whose key matches
          <code class="inline">/key|secret|token|password|auth_token|private_key/i</code> show first 4 + last 4 chars only.
        </div>
      </div>
    </aside>
  `;
}

function section<T>(args: {
  title: string;
  /** Dimmed qualifier after the title, e.g. "— project". */
  sub?: string;
  tag: string;
  file: ConfigFile<T>;
  render: (data: T) => Html;
}): Html {
  const { title, sub, tag, file } = args;
  const mtime = file.mtimeISO ? file.mtimeISO.slice(0, 16).replace('T', ' ') : null;
  return html`
    <section class="drawer-sec">
      <div class="drawer-sec-hd">
        <h3>${title}${sub
          ? html` <span class="sub" style="font-weight: 400; color: var(--fg-mute);">${sub}</span>`
          : ''}</h3>
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
  // Redactor returns "first4…last4" — render as text with the ellipsis
  // highlighted via <em>. ('…' is one code unit; very short secrets fall
  // back to "***", which has no '…' and renders verbatim.)
  const idx = value.indexOf('…');
  if (idx === -1) return html`${value}`;
  return html`${value.slice(0, idx)}<em>…</em>${value.slice(idx + 1)}`;
}

function jsonBlock(data: unknown): Html {
  return html`<pre class="block" style="max-height: 240px;">${JSON.stringify(data, null, 2)}</pre>`;
}
