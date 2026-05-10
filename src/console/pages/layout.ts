/**
 * Base HTML layout for console pages — ARCH §17.4.
 *
 * Hono html template only, no JSX. Optional NavContext renders a
 * sticky header with a project switcher; pages outside the home view
 * pass it so the author can hop between projects without bouncing.
 */

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { ProjectListing } from '../../workspace.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export type NavContext = {
  projects: ProjectListing[];
  /** Active project name; non-null on /p/:name pages. */
  current: string | null;
  /** Names of projects currently running (subset of projects[]). */
  running: Set<string>;
  consolePort: number;
  idleTimeoutMin: number;
};

export function layout(args: {
  title: string;
  body: Html | Html[];
  nav?: NavContext;
}): Html {
  return html`<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${args.title} · anydocs-ask console</title>
    <style>${BASE_CSS}</style>
  </head>
  <body>
    ${header(args.nav)}
    <main class="main">${args.body}</main>
    ${footer(args.nav)}
  </body>
</html>`;
}

function header(nav?: NavContext): Html {
  return html`
    <header class="hdr">
      <a class="brand" href="/">
        <span class="brand-mark">⚙</span>
        <span class="brand-text">anydocs-ask <span class="muted">/ console</span></span>
      </a>
      ${nav ? projectSwitcher(nav) : ''}
      <span class="hdr-spacer"></span>
      <span class="hdr-hint mono muted">127.0.0.1:${nav?.consolePort ?? ''}</span>
    </header>
  `;
}

function projectSwitcher(nav: NavContext): Html {
  const valid = nav.projects.filter((p) => p.valid);
  if (valid.length === 0) return html``;
  const opts = valid.map((p) => {
    const sel = p.name === nav.current ? 'selected' : '';
    const dot = nav.running.has(p.name) ? '● ' : '○ ';
    return html`<option value="${p.name}" ${sel}>${dot}${p.name}</option>`;
  });
  return html`
    <select class="proj-switcher" onchange="if(this.value)location.href='/p/'+encodeURIComponent(this.value)+(this.dataset.autostart==='1'?'?autostart=1':'')" data-autostart="1">
      ${nav.current ? '' : html`<option value="">→ open project</option>`}
      ${opts}
    </select>
  `;
}

function footer(nav?: NavContext): Html {
  if (!nav) return html``;
  return html`
    <footer class="ftr mono muted">
      <span>console · :${nav.consolePort}</span>
      <span>·</span>
      <span>idle reap · ${nav.idleTimeoutMin}min</span>
      <span>·</span>
      <span>${nav.running.size} running / ${nav.projects.filter((p) => p.valid).length} valid</span>
    </footer>
  `;
}

const BASE_CSS = `
  :root {
    color-scheme: light dark;
    --bg: #fafafa;
    --bg-elev: #ffffff;
    --bg-soft: #f3f4f6;
    --bd: #e5e7eb;
    --bd-soft: #eef0f2;
    --fg: #1f2328;
    --fg-soft: #57606a;
    --fg-mute: #8b939c;
    --link: #0969da;
    --link-hov: #0550ae;
    --accent: #0969da;
    --ok: #1f883d;
    --ok-bg: #dcfce722;
    --warn: #9a6700;
    --warn-bg: #fff8c522;
    --err: #cf222e;
    --err-bg: #ffebe933;
    --run: #0969da;
    --run-bg: #ddf4ff44;
    --shadow: 0 1px 0 rgba(31,35,40,.04), 0 0 0 1px rgba(31,35,40,.05);
    --shadow-elev: 0 4px 14px rgba(31,35,40,.06), 0 0 0 1px rgba(31,35,40,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --bg-elev: #161b22;
      --bg-soft: #1c2128;
      --bd: #30363d;
      --bd-soft: #21262d;
      --fg: #e6edf3;
      --fg-soft: #9da7b3;
      --fg-mute: #6e7681;
      --link: #4493f8;
      --link-hov: #58a6ff;
      --accent: #4493f8;
      --ok: #3fb950;
      --ok-bg: #1f6c2c33;
      --warn: #d29922;
      --warn-bg: #6b491233;
      --err: #f85149;
      --err-bg: #ad353a33;
      --run: #4493f8;
      --run-bg: #1f4f8e33;
      --shadow: 0 0 0 1px rgba(255,255,255,.06);
      --shadow-elev: 0 6px 18px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.06);
    }
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--fg); }
  body { margin: 0; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", sans-serif; }
  a { color: var(--link); text-decoration: none; }
  a:hover { color: var(--link-hov); text-decoration: underline; }

  /* header */
  .hdr {
    position: sticky; top: 0; z-index: 50;
    display: flex; align-items: center; gap: 14px;
    padding: 10px 22px; height: 48px;
    background: var(--bg-elev); border-bottom: 1px solid var(--bd);
    backdrop-filter: saturate(1.1) blur(6px);
  }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--fg); }
  .brand:hover { text-decoration: none; }
  .brand-mark { font-size: 16px; opacity: .8; }
  .brand-text { letter-spacing: -0.01em; }
  .proj-switcher {
    appearance: none; -webkit-appearance: none;
    background: var(--bg-soft); color: var(--fg);
    border: 1px solid var(--bd); border-radius: 6px;
    padding: 4px 26px 4px 10px;
    font: inherit; font-size: 13px;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='%238b939c' d='M5 7L1.5 3.5h7z'/></svg>");
    background-repeat: no-repeat; background-position: right 8px center;
    cursor: pointer;
  }
  .proj-switcher:hover { border-color: var(--fg-mute); }
  .hdr-spacer { flex: 1; }
  .hdr-hint { font-size: 12px; }

  /* footer */
  .ftr { display: flex; gap: 10px; padding: 10px 22px; font-size: 11px; border-top: 1px solid var(--bd); margin-top: 32px; }

  /* main */
  .main { padding: 24px 22px 16px; max-width: 1240px; margin: 0 auto; }

  /* type */
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 14px; margin: 22px 0 10px; color: var(--fg-soft); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  h3 { font-size: 13px; margin: 14px 0 8px; color: var(--fg-soft); font-weight: 600; }
  p { margin: 0 0 10px; }
  .pagehead { display: flex; align-items: baseline; gap: 14px; margin: 0 0 22px; flex-wrap: wrap; }
  .pagehead .crumb { font-size: 12.5px; color: var(--fg-mute); }
  .pagehead .crumb a { color: var(--fg-soft); }

  /* card system */
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--bd);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 16px 18px;
    margin: 0 0 14px;
  }
  .card.flush { padding: 0; overflow: hidden; }
  .card-head { display: flex; align-items: baseline; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--bd-soft); }
  .card-head h2 { margin: 0; }
  .card-body { padding: 14px 18px; }
  .grid-2 { display: grid; gap: 14px; grid-template-columns: minmax(280px, 320px) 1fr; align-items: start; }
  @media (max-width: 880px) { .grid-2 { grid-template-columns: 1fr; } }

  /* table */
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--bd-soft); vertical-align: top; }
  th { font-weight: 600; font-size: 11px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: .05em; background: var(--bg-soft); }
  tr:last-child td { border-bottom: 0; }
  tr.expandable { cursor: pointer; }
  tr.expandable:hover td { background: var(--bg-soft); }
  tr.expanded td { background: var(--bg-soft); }
  td.nowrap { white-space: nowrap; }
  .kv { display: grid; grid-template-columns: 92px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv > dt { color: var(--fg-mute); font-size: 12px; padding-top: 1px; }
  .kv > dd { margin: 0; min-width: 0; word-break: break-word; }

  /* tags */
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; background: var(--bg-soft); color: var(--fg-soft); margin-right: 4px; line-height: 1.7; }
  .tag.ok { background: var(--ok-bg); color: var(--ok); }
  .tag.warn { background: var(--warn-bg); color: var(--warn); }
  .tag.err { background: var(--err-bg); color: var(--err); }
  .tag.run { background: var(--run-bg); color: var(--run); }

  /* buttons */
  .btn, button {
    appearance: none; -webkit-appearance: none;
    font: inherit; font-size: 13px;
    background: var(--bg-elev); color: var(--fg);
    border: 1px solid var(--bd); border-radius: 6px;
    padding: 6px 12px; cursor: pointer;
    box-shadow: var(--shadow);
    transition: background .12s, border-color .12s;
  }
  .btn:hover, button:hover { background: var(--bg-soft); border-color: var(--fg-mute); }
  .btn[disabled], button[disabled] { opacity: .5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn-primary:hover { background: var(--link-hov); border-color: var(--link-hov); color: white; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .btn-row .status { color: var(--fg-mute); font-size: 12px; min-height: 18px; }
  .btn-row .status.ok { color: var(--ok); }
  .btn-row .status.err { color: var(--err); }

  /* form */
  textarea, input[type=text], input[type=search] {
    background: var(--bg-elev); color: var(--fg);
    border: 1px solid var(--bd); border-radius: 6px;
    padding: 8px 10px; font: inherit; font-size: 13px;
    width: 100%; resize: vertical;
  }
  textarea:focus, input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }

  /* utils */
  .muted { color: var(--fg-mute); }
  .soft { color: var(--fg-soft); }
  .mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, "DejaVu Sans Mono", monospace; font-size: 12.5px; }
  code { background: var(--bg-soft); padding: 1px 5px; border-radius: 3px; }
  pre { background: var(--bg-soft); border: 1px solid var(--bd-soft); border-radius: 6px; padding: 12px; overflow: auto; line-height: 1.5; }
  pre code { background: transparent; padding: 0; }
  hr { border: 0; border-top: 1px solid var(--bd-soft); margin: 18px 0; }
  .empty { color: var(--fg-mute); padding: 24px 0; text-align: center; font-size: 13px; }
  .row-gap { display: flex; gap: 14px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; background: var(--bg-soft); border: 1px solid var(--bd); font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-mute); display: inline-block; }
  .dot.run { background: var(--ok); box-shadow: 0 0 0 2px var(--ok-bg); }
  .dot.idle { background: var(--fg-mute); }

  /* tabs */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--bd); margin: 0 -18px 0; padding: 0 18px; }
  .tabs button {
    border: 0; background: transparent; box-shadow: none;
    padding: 8px 12px; margin-bottom: -1px;
    color: var(--fg-mute); font-size: 13px; font-weight: 500;
    border-bottom: 2px solid transparent; border-radius: 0;
  }
  .tabs button:hover { color: var(--fg); background: transparent; }
  .tabs button[aria-selected=true] { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-panel { padding: 14px 0 4px; }
  .tab-panel[hidden] { display: none; }

  /* citation chip */
  .cite { display: inline-block; min-width: 18px; height: 18px; line-height: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: white; font-size: 11px; font-weight: 600; text-align: center; vertical-align: 1px; }
  .cite-list { display: grid; gap: 8px; margin: 8px 0 0; }
  .cite-item { display: grid; grid-template-columns: 28px 1fr; gap: 8px; padding: 10px 12px; background: var(--bg-soft); border: 1px solid var(--bd-soft); border-radius: 6px; }
  .cite-item .cite { margin-top: 2px; }
  .cite-item .meta { font-size: 12px; color: var(--fg-mute); margin-bottom: 4px; }
  .cite-item .snippet { font-size: 12.5px; line-height: 1.5; word-break: break-word; }

  /* markdown rendered */
  .md { font-size: 14px; line-height: 1.65; }
  .md h1, .md h2, .md h3 { color: var(--fg); text-transform: none; letter-spacing: 0; font-weight: 600; }
  .md h1 { font-size: 18px; margin: 16px 0 8px; }
  .md h2 { font-size: 15px; margin: 14px 0 6px; }
  .md h3 { font-size: 14px; margin: 12px 0 6px; }
  .md p { margin: 0 0 10px; }
  .md ul, .md ol { padding-left: 22px; margin: 0 0 10px; }
  .md code { font-size: 12.5px; }
  .md pre { margin: 0 0 12px; }
  .md a { word-break: break-all; }
  .md blockquote { border-left: 3px solid var(--bd); padding: 2px 0 2px 12px; color: var(--fg-soft); margin: 0 0 10px; }
`;
