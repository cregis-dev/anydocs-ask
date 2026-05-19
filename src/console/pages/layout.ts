/**
 * Base HTML layout for console pages — ARCH §17.4.
 *
 * Hono html template only, no JSX. CSS variables follow the
 * design_handoff_console_redesign tokens; light + dark themes are
 * activated via prefers-color-scheme OR `[data-theme]` on <html>.
 *
 * The icons.svg sprite is inlined into <body> as a hidden <svg>; all
 * pages reference symbols via `<svg><use href="#i-name" /></svg>`.
 */

import { html, raw } from 'hono/html';
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
  /** Override page <main> max-width (e.g. report viewer uses narrower). */
  pageMaxWidth?: string;
  /** When true, suppress the page <main> wrapper — page body provides its own. */
  bareBody?: boolean;
}): Html {
  const styleAttr = args.pageMaxWidth
    ? ` style="max-width:${args.pageMaxWidth}"`
    : '';
  return html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${args.title} · anydocs-ask console</title>
    <style>${raw(BASE_CSS)}</style>
  </head>
  <body>
    ${raw(ICON_SPRITE)}
    ${header(args.nav)}
    ${args.bareBody
      ? args.body
      : html`<main class="page"${raw(styleAttr)}>${args.body}</main>`}
  </body>
</html>`;
}

function header(nav?: NavContext): Html {
  return html`
    <header class="app-hdr">
      <div class="app-hdr-inner">
        <a class="brand" href="/">
          <span class="brand-mark"></span>
          <b>anydocs-ask</b><span class="sep">/</span><span class="sub">console</span>
        </a>
        ${nav ? projectSwitcher(nav) : ''}
        <div class="hdr-spacer"></div>
        ${nav ? html`<span class="hdr-host">127.0.0.1:${nav.consolePort}</span>` : ''}
      </div>
    </header>
  `;
}

function projectSwitcher(nav: NavContext): Html {
  const valid = nav.projects.filter((p) => p.valid);
  if (valid.length === 0) return html``;
  const opts = valid.map((p) => {
    const sel = p.name === nav.current ? 'selected' : '';
    const marker = nav.running.has(p.name) ? '● ' : '○ ';
    return html`<option value="${p.name}" ${sel}>${marker}${p.name}</option>`;
  });
  // Plain styled-select for v1 — design's button-with-dropdown is a stretch
  // goal (README "open questions"). The select keeps native keyboard nav.
  return html`
    <select class="proj-switch-sel" onchange="if(this.value)location.href='/p/'+encodeURIComponent(this.value)" aria-label="switch project">
      ${nav.current ? '' : html`<option value="">→ open project</option>`}
      ${opts}
    </select>
  `;
}

// ---------------------------------------------------------------------------
// Inline icon sprite — keeps zero-network-roundtrip and survives offline.
// Source: design-output/icons.svg (22 symbols).
// ---------------------------------------------------------------------------

const ICON_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
  <symbol id="i-play" viewBox="0 0 16 16"><path d="M4 3.5v9a.5.5 0 0 0 .8.4l7-4.5a.5.5 0 0 0 0-.8l-7-4.5A.5.5 0 0 0 4 3.5Z" fill="currentColor"/></symbol>
  <symbol id="i-stop" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></symbol>
  <symbol id="i-chev-r" viewBox="0 0 16 16"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-chev-d" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-arr-r" viewBox="0 0 16 16"><path d="M3 8h10m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-arr-u" viewBox="0 0 16 16"><path d="M8 12V4m-3 3 3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-arr-d" viewBox="0 0 16 16"><path d="M8 4v8m-3-3 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-gear" viewBox="0 0 16 16"><path d="M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm5.6 1.7-1-.2-.4-1 .5-1-1.1-1.1-1 .5-1-.4-.2-1H7.6l-.2 1-1 .4-1-.5-1.1 1.1.5 1-.4 1-1 .2v1.6l1 .2.4 1-.5 1 1.1 1.1 1-.5 1 .4.2 1h1.6l.2-1 1-.4 1 .5 1.1-1.1-.5-1 .4-1 1-.2V7.2Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></symbol>
  <symbol id="i-plus" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
  <symbol id="i-check" viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-x" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
  <symbol id="i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m12.5 12.5-2.7-2.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
  <symbol id="i-info" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v4M8 5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
  <symbol id="i-alert" viewBox="0 0 16 16"><path d="M8 2 1.5 13h13L8 2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3M8 11v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
  <symbol id="i-err" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m6 6 4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
  <symbol id="i-doc" viewBox="0 0 16 16"><path d="M3.5 2h5l4 4v8h-9V2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8.5 2v4h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
  <symbol id="i-folder" viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6.5A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
  <symbol id="i-act" viewBox="0 0 16 16"><path d="M1.5 8h3l2-4 3 8 2-4h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-term" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m4.5 7 2 1.5-2 1.5M8 10h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-chart" viewBox="0 0 16 16"><path d="M2 12V4M2 12h12M5 10l3-4 2 2 3-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-chat" viewBox="0 0 16 16"><path d="M2.5 3h11A1.5 1.5 0 0 1 15 4.5v6A1.5 1.5 0 0 1 13.5 12H7l-3 2.5V12H2.5A1.5 1.5 0 0 1 1 10.5v-6A1.5 1.5 0 0 1 2.5 3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
  <symbol id="i-copy" viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>
  <symbol id="i-pin" viewBox="0 0 16 16"><path d="M9.5 1.5 14.5 6.5m-7 .5L4 11l-2 3 3-2 3.5-3.5M5.5 4.5l6 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-pin-f" viewBox="0 0 16 16"><path d="m10 1.5 4.5 4.5L11 7.5l-1 3-4-4 3-1L10 1.5ZM6 10 2 14" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></symbol>
  <symbol id="i-trash" viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5v-1A1 1 0 0 1 7.5 2.5h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2M6.8 7v4M9.2 7v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-kebab" viewBox="0 0 16 16"><circle cx="8" cy="3.5" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="12.5" r="1.2" fill="currentColor"/></symbol>
  <symbol id="i-edit" viewBox="0 0 16 16"><path d="M11 2.5 13.5 5 5.5 13H3v-2.5l8-8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10 3.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.3"/></symbol>
  <symbol id="i-ext" viewBox="0 0 16 16"><path d="M9 2h5v5M14 2 7.5 8.5M12 9.5v3.5A1 1 0 0 1 11 14H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>`;

// ---------------------------------------------------------------------------
// Design-system CSS — verbatim from design_handoff_console_redesign/styles.css
// with two console-only additions (.proj-switch-sel for the SSR <select>
// and .next-action banner used by computeNextAction). No selector here
// conflicts with the per-tab scoped styles emitted by individual page modules.
// ---------------------------------------------------------------------------

const BASE_CSS = `
/* tokens ----------------------------------------------------------- */
:root {
  --bg:        #f7f7f5;
  --bg-elev:   #ffffff;
  --bg-soft:   #f1f1ee;
  --bg-tint:   #ecedea;
  --bd:        #e3e3df;
  --bd-soft:   #ecedea;
  --bd-strong: #cfd0cb;

  --fg:        #1a1a17;
  --fg-soft:   #5a5b56;
  --fg-mute:   #8a8b85;

  --link:      #2747c4;
  --accent:    #2747c4;
  --accent-soft: #eaeefb;
  --ok:        #1f7a3a;
  --ok-soft:   #e6f1e7;
  --warn:      #8a5a00;
  --warn-soft: #fbf1d9;
  --err:       #b41f2a;
  --err-soft:  #fbe6e6;
  --run:       #2747c4;
  --run-soft:  #eaeefb;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;

  --t-12: 12px; --t-13: 13px; --t-14: 14px; --t-15: 15px; --t-16: 16px;
  --t-18: 18px; --t-20: 20px; --t-24: 24px; --t-32: 32px;

  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px;
  --s-6: 24px; --s-7: 28px; --s-8: 32px; --s-10: 40px; --s-12: 48px; --s-16: 64px;

  --r-2: 4px; --r-3: 6px; --r-4: 8px; --r-5: 10px; --r-6: 12px;

  --sh-1: 0 1px 0 rgba(20,20,18,.04);
  --sh-2: 0 1px 2px rgba(20,20,18,.06), 0 1px 1px rgba(20,20,18,.04);
  --sh-3: 0 4px 12px rgba(20,20,18,.08), 0 1px 2px rgba(20,20,18,.04);
  --sh-pop: 0 18px 48px rgba(20,20,18,.18), 0 4px 12px rgba(20,20,18,.08);

  --w-max: 1240px;
  --w-side: 320px;
  --hdr-h: 52px;

  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0f10; --bg-elev: #161719; --bg-soft: #1c1d20; --bg-tint: #232427;
    --bd: #2a2c30; --bd-soft: #1f2024; --bd-strong: #3a3c41;
    --fg: #e8e8e3; --fg-soft: #a4a59f; --fg-mute: #6f7068;
    --link: #7aa2ff; --accent: #7aa2ff; --accent-soft: #1a2238;
    --ok: #4cb96a; --ok-soft: #16241a;
    --warn: #d6a142; --warn-soft: #2a2317;
    --err: #f37077; --err-soft: #2a1818;
    --run: #7aa2ff; --run-soft: #1a2238;
    --sh-1: 0 1px 0 rgba(0,0,0,.4);
    --sh-2: 0 1px 2px rgba(0,0,0,.5);
    --sh-3: 0 4px 12px rgba(0,0,0,.5);
    --sh-pop: 0 18px 48px rgba(0,0,0,.6);
    color-scheme: dark;
  }
}
[data-theme="dark"] {
  --bg: #0e0f10; --bg-elev: #161719; --bg-soft: #1c1d20; --bg-tint: #232427;
  --bd: #2a2c30; --bd-soft: #1f2024; --bd-strong: #3a3c41;
  --fg: #e8e8e3; --fg-soft: #a4a59f; --fg-mute: #6f7068;
  --link: #7aa2ff; --accent: #7aa2ff; --accent-soft: #1a2238;
  --ok: #4cb96a; --ok-soft: #16241a;
  --warn: #d6a142; --warn-soft: #2a2317;
  --err: #f37077; --err-soft: #2a1818;
  --run: #7aa2ff; --run-soft: #1a2238;
  --sh-1: 0 1px 0 rgba(0,0,0,.4);
  --sh-2: 0 1px 2px rgba(0,0,0,.5);
  --sh-3: 0 4px 12px rgba(0,0,0,.5);
  --sh-pop: 0 18px 48px rgba(0,0,0,.6);
  color-scheme: dark;
}
[data-theme="light"] { color-scheme: light; }

/* reset ------------------------------------------------------------ */
*, *::before, *::after { box-sizing: border-box; }
/* Universal hide via [hidden] — author rules like .banner { display: flex }
 * otherwise override the UA-default [hidden] { display: none }, leaving
 * elements visible despite their hidden attribute. !important is justified
 * because [hidden] is meant to be an absolute "hide me" signal. */
[hidden] { display: none !important; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--fg);
  font-family: var(--font-sans);
  font-size: var(--t-14); line-height: 1.5;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; cursor: pointer; }
input, textarea, select { font: inherit; color: inherit; }
code, pre, .mono { font-family: var(--font-mono); }
hr { border: 0; border-top: 1px solid var(--bd); margin: var(--s-4) 0; }
::selection { background: var(--accent-soft); }

/* header ----------------------------------------------------------- */
.app-hdr {
  position: sticky; top: 0; z-index: 10;
  height: var(--hdr-h);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: saturate(140%) blur(8px);
  -webkit-backdrop-filter: saturate(140%) blur(8px);
  border-bottom: 1px solid var(--bd);
}
.app-hdr-inner {
  max-width: var(--w-max); margin: 0 auto; height: 100%;
  padding: 0 var(--s-6);
  display: flex; align-items: center; gap: var(--s-4);
}
.brand { display: inline-flex; align-items: center; gap: var(--s-2); color: var(--fg); font-size: var(--t-13); }
.brand:hover { text-decoration: none; }
.brand-mark { width: 14px; height: 14px; display: inline-block; transform: rotate(45deg); background: var(--fg); border-radius: 2px; }
.brand b { font-weight: 600; }
.brand span.sep { color: var(--fg-mute); margin: 0 2px; }
.brand .sub { color: var(--fg-soft); font-weight: 500; }

.proj-switch-sel {
  appearance: none; -webkit-appearance: none;
  height: 30px; padding: 0 24px 0 var(--s-3);
  border: 1px solid var(--bd); border-radius: var(--r-4);
  background: var(--bg-elev); color: var(--fg);
  font-size: var(--t-13); cursor: pointer;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='%238a8b85' d='M5 7L1.5 3.5h7z'/></svg>");
  background-repeat: no-repeat; background-position: right 8px center;
}
.proj-switch-sel:hover { border-color: var(--bd-strong); }

.hdr-spacer { flex: 1; }
.hdr-host { font-family: var(--font-mono); font-size: var(--t-12); color: var(--fg-mute); letter-spacing: .005em; }

.icon-btn {
  width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent; border-radius: var(--r-3);
  color: var(--fg-soft);
}
.icon-btn:hover { background: var(--bg-soft); color: var(--fg); }
.icon-btn svg { width: 16px; height: 16px; }

/* page shell ------------------------------------------------------- */
.page {
  max-width: var(--w-max); margin: 0 auto;
  padding: var(--s-8) var(--s-6) var(--s-16);
}
.page-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--s-4); margin-bottom: var(--s-6); flex-wrap: wrap;
}
.proj-toolbar {
  display: inline-flex; align-items: center; gap: 6px;
  margin-left: var(--s-3); padding-left: var(--s-3);
  border-left: 1px solid var(--bd-soft);
}
.proj-toolbar .btn { padding: 4px 10px; font-size: var(--t-12); }
.proj-toolbar .btn svg { width: 12px; height: 12px; }
.crumbs {
  font-size: var(--t-13); color: var(--fg-soft);
  display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap;
}
.crumbs a { color: var(--fg-soft); }
.crumbs .here { color: var(--fg); font-weight: 600; }
.crumbs .sep { color: var(--fg-mute); }

h1.page-title { font-size: var(--t-24); font-weight: 600; letter-spacing: -.01em; margin: 0; }
h1.page-title .sub { font-weight: 400; color: var(--fg-soft); font-size: var(--t-15); margin-left: var(--s-2); }


/* cards ------------------------------------------------------------ */
.card { background: var(--bg-elev); border: 1px solid var(--bd); border-radius: var(--r-5); box-shadow: var(--sh-1); }
.card.flush { background: transparent; box-shadow: none; }
.card.primary {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--bd));
  box-shadow: var(--sh-2), 0 0 0 3px color-mix(in srgb, var(--accent) 8%, transparent);
}
.card-hd {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--s-3); padding: var(--s-3) var(--s-5);
  border-bottom: 1px solid var(--bd-soft);
}
.card-hd h2, .card-hd h3 {
  margin: 0; font-size: var(--t-13); font-weight: 600; letter-spacing: .01em;
  color: var(--fg); display: inline-flex; align-items: center; gap: var(--s-2);
}
.card-hd .meta { font-size: var(--t-12); color: var(--fg-mute); font-family: var(--font-mono); }
.card-hd .actions { display: inline-flex; gap: var(--s-2); align-items: center; }
.card-bd { padding: var(--s-5); }
.card-bd.flush { padding: 0; }

/* pills / tags ---------------------------------------------------- */
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 8px; border-radius: 999px;
  font-size: var(--t-12);
  background: var(--bg-soft); color: var(--fg-soft);
  border: 1px solid var(--bd); white-space: nowrap;
}
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .9; }
.pill.ok   { color: var(--ok);   background: var(--ok-soft);   border-color: color-mix(in srgb, var(--ok) 25%, transparent); }
.pill.warn { color: var(--warn); background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 25%, transparent); }
.pill.err  { color: var(--err);  background: var(--err-soft);  border-color: color-mix(in srgb, var(--err) 25%, transparent); }
.pill.run  { color: var(--run);  background: var(--run-soft);  border-color: color-mix(in srgb, var(--run) 25%, transparent); }
.pill.run .dot { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

.tag {
  display: inline-flex; align-items: center; gap: 4px;
  height: 18px; padding: 0 6px; border-radius: var(--r-2);
  font-size: 11px; background: var(--bg-soft); color: var(--fg-soft);
  border: 1px solid var(--bd);
  font-family: var(--font-mono); letter-spacing: .01em;
}
.tag.ok   { color: var(--ok);   background: var(--ok-soft);   border-color: color-mix(in srgb, var(--ok) 22%, transparent); }
.tag.warn { color: var(--warn); background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 22%, transparent); }
.tag.err  { color: var(--err);  background: var(--err-soft);  border-color: color-mix(in srgb, var(--err) 22%, transparent); }
.tag.run  { color: var(--run);  background: var(--run-soft);  border-color: color-mix(in srgb, var(--run) 22%, transparent); }

/* buttons ---------------------------------------------------------- */
.btn {
  display: inline-flex; align-items: center; gap: var(--s-2);
  height: 32px; padding: 0 var(--s-3);
  border-radius: var(--r-3); border: 1px solid var(--bd);
  background: var(--bg-elev); color: var(--fg);
  font-size: var(--t-13); font-weight: 500; white-space: nowrap;
  transition: background .12s, border-color .12s, box-shadow .12s;
}
.btn:hover { background: var(--bg-soft); border-color: var(--bd-strong); }
.btn:active { transform: translateY(.5px); }
.btn[disabled], .btn.disabled { opacity: .55; cursor: not-allowed; pointer-events: none; }
.btn.primary {
  background: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 80%, black);
  color: white;
}
.btn.primary:hover { background: color-mix(in srgb, var(--accent) 88%, black); color: white; text-decoration: none; }
.btn.danger { background: var(--err); border-color: color-mix(in srgb, var(--err) 80%, black); color: white; }
.btn.ghost { background: transparent; border-color: transparent; color: var(--fg-soft); }
.btn.ghost:hover { background: var(--bg-soft); color: var(--fg); }
.btn.lg { height: 36px; padding: 0 var(--s-4); font-size: var(--t-14); }
.btn.sm { height: 26px; padding: 0 var(--s-2); font-size: var(--t-12); }
.btn svg { width: 14px; height: 14px; }
.btn .kbd {
  font-family: var(--font-mono); font-size: var(--t-12);
  color: color-mix(in srgb, currentColor 60%, transparent);
  padding-left: 4px;
}
.btn.primary .kbd { color: color-mix(in srgb, currentColor 80%, transparent); }
.kbd-key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 4px; border: 1px solid var(--bd); background: var(--bg-soft);
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-soft);
}

/* form ------------------------------------------------------------- */
.field { display: flex; flex-direction: column; gap: 6px; }
.field label, .label { font-size: var(--t-12); color: var(--fg-soft); letter-spacing: .01em; }
.field .helper { font-size: var(--t-12); color: var(--fg-mute); }
.input, .textarea, .select {
  width: 100%; background: var(--bg-elev); color: var(--fg);
  border: 1px solid var(--bd); border-radius: var(--r-3);
  padding: 8px 10px; font-size: var(--t-14); outline: 0;
  transition: border-color .12s, box-shadow .12s;
}
.input:focus, .textarea:focus, .select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.input::placeholder, .textarea::placeholder { color: var(--fg-mute); }
.textarea { min-height: 120px; resize: vertical; font-family: var(--font-sans); }
.input.mono, .textarea.mono { font-family: var(--font-mono); font-size: var(--t-13); }
.check {
  display: inline-flex; align-items: center; gap: var(--s-2);
  font-size: var(--t-13); color: var(--fg-soft); cursor: pointer; user-select: none;
}
.check input { accent-color: var(--accent); }

/* tabs ------------------------------------------------------------- */
.tabs { display: flex; align-items: center; gap: var(--s-1); border-bottom: 1px solid var(--bd); margin-bottom: var(--s-5); }
.tab {
  position: relative; display: inline-flex; align-items: center; gap: var(--s-2);
  padding: var(--s-3); font-size: var(--t-14); color: var(--fg-soft);
  background: transparent; border: 0; border-bottom: 2px solid transparent;
  margin-bottom: -1px; transition: color .12s;
}
.tab:hover { color: var(--fg); text-decoration: none; }
.tab[aria-selected="true"], .tab.active { color: var(--fg); border-bottom-color: var(--fg); font-weight: 600; }
.tabs .tab[aria-selected="true"], .tabs .tab.active { box-shadow: inset 0 -3px 0 0 var(--accent); }
.tab .cnt { font-size: var(--t-12); color: var(--fg-mute); font-family: var(--font-mono); }
.tab[aria-selected="true"] .cnt { color: var(--fg-soft); }
.tabs.inner { border-bottom: 1px solid var(--bd-soft); }
.tabs.inner .tab { padding: var(--s-2) var(--s-3); font-size: var(--t-13); }
.tab-panel[hidden] { display: none; }

/* KPI tiles -------------------------------------------------------- */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--s-3); }
.kpi { background: var(--bg-elev); border: 1px solid var(--bd); border-radius: var(--r-4); padding: var(--s-4); }
.kpi .k-lab { font-size: var(--t-12); color: var(--fg-soft); letter-spacing: .01em; display: flex; align-items: center; gap: var(--s-2); }
.kpi .k-val { font-size: var(--t-24); font-weight: 600; letter-spacing: -.01em; font-variant-numeric: tabular-nums; margin-top: 2px; display: flex; align-items: baseline; gap: var(--s-2); flex-wrap: wrap; }
.kpi .k-val .unit { font-size: var(--t-13); color: var(--fg-mute); font-weight: 500; }
.kpi .k-foot { margin-top: var(--s-2); font-size: var(--t-12); color: var(--fg-mute); display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
.delta { font-size: var(--t-12); font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
.delta.up   { color: var(--ok); }
.delta.down { color: var(--err); }
.delta.flat { color: var(--fg-mute); }

.metric-kpis { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
.metric-kpis .k-lab { white-space: nowrap; }
.metric-kpis .k-val { white-space: nowrap; }

/* sparkline svg --------------------------------------------------- */
.spark { width: 80px; height: 22px; display: block; }
.spark path, .spark polyline { fill: none; stroke: var(--fg-soft); stroke-width: 1.3; }
.spark.ok path, .spark.ok polyline { stroke: var(--ok); }
.spark.warn path, .spark.warn polyline { stroke: var(--warn); }
.spark.err path, .spark.err polyline { stroke: var(--err); }
.spark.accent path, .spark.accent polyline { stroke: var(--accent); }

/* banner ----------------------------------------------------------- */
.banner {
  display: flex; align-items: flex-start; gap: var(--s-3);
  padding: var(--s-3) var(--s-4); border: 1px solid var(--bd);
  border-radius: var(--r-4); background: var(--bg-elev);
  box-shadow: var(--sh-1); margin-bottom: var(--s-5);
}
.banner .b-ico {
  flex: 0 0 auto; width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; margin-top: 1px;
}
.banner .b-bd { flex: 1; min-width: 0; }
.banner .b-ti { font-weight: 600; font-size: var(--t-14); color: var(--fg); }
.banner .b-de { font-size: var(--t-13); color: var(--fg-soft); margin-top: 2px; }
.banner .b-act { flex: 0 0 auto; display: flex; gap: var(--s-2); }
.banner.info { border-color: color-mix(in srgb, var(--accent) 35%, var(--bd)); background: color-mix(in srgb, var(--accent-soft) 55%, var(--bg-elev)); }
.banner.info .b-ico { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
.banner.warn { border-color: color-mix(in srgb, var(--warn) 40%, var(--bd)); background: color-mix(in srgb, var(--warn-soft) 60%, var(--bg-elev)); }
.banner.warn .b-ico { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.banner.err  { border-color: color-mix(in srgb, var(--err) 40%, var(--bd));  background: color-mix(in srgb, var(--err-soft) 60%, var(--bg-elev)); }
.banner.err .b-ico { background: color-mix(in srgb, var(--err) 20%, transparent); color: var(--err); }
.banner svg { width: 14px; height: 14px; }

/* empty state ------------------------------------------------------ */
.empty {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: var(--s-12) var(--s-6); gap: var(--s-3);
}
.empty .e-ico {
  width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
  border-radius: var(--r-5); background: var(--bg-soft); color: var(--fg-soft);
  border: 1px solid var(--bd); margin-bottom: var(--s-2);
}
.empty .e-ico svg { width: 22px; height: 22px; }
.empty h3 { font-size: var(--t-16); font-weight: 600; margin: 0; }
.empty p { max-width: 56ch; margin: 0; font-size: var(--t-13); color: var(--fg-soft); line-height: 1.55; }
.empty .e-cta { margin-top: var(--s-3); display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; justify-content: center; }

/* two-column ------------------------------------------------------- */
.proj-grid { display: grid; grid-template-columns: var(--w-side) minmax(0, 1fr); gap: var(--s-6); align-items: start; }
.side-stack { display: flex; flex-direction: column; gap: var(--s-4); }
.main-stack { display: flex; flex-direction: column; gap: var(--s-5); min-width: 0; }
@media (max-width: 880px) { .proj-grid { grid-template-columns: 1fr; } }

/* status kv -------------------------------------------------------- */
.kv { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 6px var(--s-3); font-size: var(--t-13); }
.kv dt { color: var(--fg-soft); }
.kv dd { margin: 0; color: var(--fg); min-width: 0; }
.kv dd .mono, .kv dd code { font-family: var(--font-mono); font-size: var(--t-12); color: var(--fg-soft); }
.kv dd code.inline { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.kv .yes { color: var(--ok); font-weight: 500; }
.kv .no  { color: var(--fg-mute); }

/* code / pre ------------------------------------------------------- */
code.inline, .codechip {
  font-family: var(--font-mono); font-size: .92em;
  background: var(--bg-soft); border: 1px solid var(--bd-soft);
  padding: 1px 5px; border-radius: var(--r-2); color: var(--fg);
}
pre.block {
  background: var(--bg-soft); border: 1px solid var(--bd);
  border-radius: var(--r-3); padding: var(--s-3);
  font-size: var(--t-13); line-height: 1.55; overflow-x: auto;
}
pre.block .cmt { color: var(--fg-mute); }
pre.block .kw  { color: var(--accent); }
pre {
  background: var(--bg-soft); border: 1px solid var(--bd-soft);
  border-radius: var(--r-3); padding: var(--s-3); overflow-x: auto;
  line-height: 1.5; font-size: var(--t-13);
}
pre code { background: transparent; padding: 0; border: 0; }

/* citation chip --------------------------------------------------- */
.cite {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent);
  font-size: 11px; font-weight: 600; font-family: var(--font-mono);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  vertical-align: 2px;
}
.cite-list { display: flex; flex-direction: column; }
.cite-item {
  display: grid; grid-template-columns: 28px 1fr; gap: var(--s-2);
  padding: var(--s-3) var(--s-3); border-top: 1px solid var(--bd-soft);
}
.cite-item:first-child { border-top: 0; }
.cite-item .cite { align-self: start; }
.cite-item .meta { font-size: var(--t-12); color: var(--fg-mute); margin-bottom: 4px; font-family: var(--font-mono); }
.cite-item .snippet { font-size: var(--t-13); color: var(--fg-soft); margin-top: 4px; line-height: 1.55; word-break: break-word; }

/* citation list (eval-style) -------------------------------------- */
.cit { display: flex; gap: var(--s-3); padding: var(--s-3) 0; border-top: 1px solid var(--bd-soft); }
.cit:first-child { border-top: 0; }
.cit .ci-no { flex: 0 0 auto; }
.cit .ci-bd { min-width: 0; }
.cit .ci-ti { font-weight: 600; font-size: var(--t-13); }
.cit .ci-sl { font-family: var(--font-mono); font-size: 11px; color: var(--fg-mute); }
.cit .ci-sn { font-size: var(--t-13); color: var(--fg-soft); margin-top: 4px; line-height: 1.55; }

/* markdown body --------------------------------------------------- */
.md { font-size: var(--t-14); line-height: 1.6; color: var(--fg); }
.md p { margin: 0 0 var(--s-3); }
.md p:last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3 { margin: var(--s-5) 0 var(--s-2); font-weight: 600; letter-spacing: -.01em; }
.md h1 { font-size: var(--t-20); }
.md h2 { font-size: var(--t-16); }
.md h3 { font-size: var(--t-14); }
.md ul, .md ol { padding-left: 22px; margin: 0 0 var(--s-3); }
.md li { margin: 2px 0; }
.md code { font-family: var(--font-mono); font-size: .92em; background: var(--bg-soft); padding: 1px 5px; border-radius: var(--r-2); border: 1px solid var(--bd-soft); }
.md pre { background: var(--bg-soft); border: 1px solid var(--bd); border-radius: var(--r-3); padding: var(--s-3) var(--s-4); overflow-x: auto; font-family: var(--font-mono); font-size: var(--t-13); margin: 0 0 var(--s-3); }
.md pre code { background: transparent; border: 0; padding: 0; }
.md a { color: var(--link); }
.md table { width: 100%; border-collapse: collapse; font-size: var(--t-13); margin: 0 0 var(--s-3); }
.md th, .md td { padding: 8px 10px; border-bottom: 1px solid var(--bd-soft); text-align: left; }
.md th { font-weight: 600; color: var(--fg-soft); font-size: var(--t-12); letter-spacing: .02em; }
.md blockquote { border-left: 3px solid var(--bd); padding: 2px 0 2px 12px; color: var(--fg-soft); margin: 0 0 var(--s-3); }

/* home strip ------------------------------------------------------- */
.strip {
  display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
  border: 1px solid var(--bd); border-radius: var(--r-5);
  background: var(--bg-elev); overflow: hidden;
}
.strip .cell { padding: var(--s-3) var(--s-4); border-right: 1px solid var(--bd-soft); }
.strip .cell:last-child { border-right: 0; }
.strip .c-lab { font-size: var(--t-12); color: var(--fg-soft); }
.strip .c-val { display: flex; align-items: baseline; gap: var(--s-2); font-size: var(--t-18); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.005em; margin-top: 2px; }
.strip .c-val .unit { font-size: var(--t-12); font-weight: 500; color: var(--fg-mute); }
@media (max-width: 1080px) {
  .strip { grid-template-columns: repeat(3, 1fr); }
  .strip .cell { border-bottom: 1px solid var(--bd-soft); }
  .strip .cell:nth-child(3n) { border-right: 0; }
  .strip .cell:nth-last-child(-n+3) { border-bottom: 0; }
}
@media (max-width: 720px) {
  .strip { grid-template-columns: 1fr 1fr; }
  .strip .cell { border-right: 0; border-bottom: 1px solid var(--bd-soft); }
}

/* project cards (home) -------------------------------------------- */
.proj-cards {
  display: grid; gap: var(--s-4);
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
}
.proj-card {
  display: flex; flex-direction: column; gap: var(--s-3);
  padding: var(--s-4);
  background: var(--bg-elev); border: 1px solid var(--bd);
  border-radius: var(--r-5); box-shadow: var(--sh-1); color: inherit;
  transition: border-color .12s, box-shadow .12s, transform .12s;
}
.proj-card:hover { border-color: var(--bd-strong); box-shadow: var(--sh-2); text-decoration: none; }
.proj-card .pc-hd { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); }
.proj-card .pc-name { font-family: var(--font-mono); font-size: var(--t-15); font-weight: 600; color: var(--fg); }
.proj-card .pc-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.proj-card .pc-stats { display: flex; gap: var(--s-4); font-size: var(--t-12); color: var(--fg-soft); flex-wrap: wrap; }
.proj-card .pc-stats b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.proj-card .pc-path {
  font-family: var(--font-mono); font-size: var(--t-12); color: var(--fg-mute);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.proj-card .pc-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: auto; padding-top: var(--s-2); border-top: 1px solid var(--bd-soft);
}
.proj-card .pc-link {
  color: var(--accent); font-size: var(--t-13); font-weight: 600;
  display: inline-flex; align-items: center; gap: 4px;
}
.proj-card .pc-link:hover { text-decoration: none; }
.proj-card .pc-link svg { width: 12px; height: 12px; }
.tag svg { width: 10px; height: 10px; }
.proj-card.invalid { background: color-mix(in srgb, var(--err-soft) 30%, var(--bg-elev)); border-color: color-mix(in srgb, var(--err) 25%, var(--bd)); }
.proj-card.invalid .pc-name { color: var(--fg-soft); }
.proj-card.run { border-left: 3px solid var(--run); }

/* hover-revealed kebab on each project card */
.proj-card-wrap { position: relative; min-width: 0; }
.proj-card-wrap .pc-menu {
  position: absolute; top: 8px; right: 8px;
  width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent;
  border-radius: var(--r-3); color: var(--fg-mute); cursor: pointer;
  opacity: 0;
  transition: opacity .12s, background .12s, color .12s, border-color .12s;
  z-index: 2;
}
.proj-card-wrap .pc-menu svg { width: 14px; height: 14px; }
.proj-card-wrap:hover .pc-menu,
.proj-card-wrap:focus-within .pc-menu,
.proj-card-wrap .pc-menu.open { opacity: 1; }
.proj-card-wrap .pc-menu:hover,
.proj-card-wrap .pc-menu.open {
  background: var(--bg-elev); border-color: var(--bd);
  color: var(--fg); box-shadow: var(--sh-1);
}
.proj-card-wrap .proj-card .pc-name { padding-right: 28px; }

/* popover menu (used for card actions; reusable) */
.menu {
  position: absolute; min-width: 220px;
  background: var(--bg-elev); border: 1px solid var(--bd);
  border-radius: var(--r-4); box-shadow: var(--sh-pop);
  padding: 4px; z-index: 30;
}
.menu .menu-item {
  display: flex; align-items: center; gap: var(--s-2);
  width: 100%; padding: 7px 10px;
  background: transparent; border: 0; border-radius: var(--r-3);
  font-size: var(--t-13); color: var(--fg);
  text-align: left; cursor: pointer; font-family: var(--font-sans);
  text-decoration: none;
}
.menu .menu-item:hover { background: var(--bg-soft); text-decoration: none; }
.menu .menu-item svg { width: 14px; height: 14px; color: var(--fg-soft); flex-shrink: 0; }
.menu .menu-item .kbd-key { margin-left: auto; }
.menu .menu-item.danger { color: var(--err); }
.menu .menu-item.danger svg { color: var(--err); }
.menu .menu-item.danger:hover { background: var(--err-soft); }
.menu .menu-item[disabled] { color: var(--fg-mute); pointer-events: none; }
.menu .menu-item[disabled] svg { color: var(--fg-mute); }
.menu hr.menu-sep { margin: 4px 2px; border-top: 1px solid var(--bd-soft); }
.menu .menu-lab {
  padding: 6px 10px 2px; font-size: 11px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--fg-mute);
}

/* status-acts (button row inside Status card) ---------------------- */
.status-acts {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin-top: var(--s-3); padding-top: var(--s-3);
  border-top: 1px solid var(--bd-soft);
}
.status-acts .btn {
  height: 26px; padding: 0 8px;
  font-size: var(--t-12); font-weight: 500;
  font-family: var(--font-mono); letter-spacing: .01em;
}
.status-acts .btn svg { width: 12px; height: 12px; opacity: .8; }
.status-acts .btn.reader { color: var(--accent); }
.status-acts .btn.reader:hover { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, var(--bd)); }

.add-card {
  display: flex; flex-direction: column; gap: var(--s-3);
  padding: var(--s-4); background: var(--bg-elev);
  border: 1px dashed var(--bd-strong); border-radius: var(--r-5);
}
.add-card h3 { margin: 0; font-size: var(--t-14); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.add-card p { margin: 0; font-size: var(--t-13); color: var(--fg-soft); }
.add-card .row { display: flex; gap: var(--s-2); }
.add-card .row .input { flex: 1; }

/* table ------------------------------------------------------------ */
.tbl { width: 100%; border-collapse: collapse; font-size: var(--t-13); }
.tbl th {
  text-align: left; font-weight: 600; font-size: var(--t-12);
  letter-spacing: .02em; color: var(--fg-soft);
  padding: 10px var(--s-4); border-bottom: 1px solid var(--bd);
  background: var(--bg-soft);
}
.tbl td { padding: 10px var(--s-4); border-bottom: 1px solid var(--bd-soft); font-variant-numeric: tabular-nums; vertical-align: top; }
.tbl tr:last-child td { border-bottom: 0; }
.tbl tbody tr:hover { background: var(--bg-soft); }
.tbl .mono { font-family: var(--font-mono); font-size: var(--t-12); color: var(--fg-soft); }
.tbl .num { text-align: right; }
.tbl tr.expandable { cursor: pointer; }
.tbl tr.expanded > td { background: var(--bg-soft); }
.tbl tbody tr.clickable { cursor: pointer; }
.tbl tbody tr.clickable:hover { background: var(--bg-soft); }
.tbl tbody tr.clickable td:last-child::after {
  content: "↗"; display: inline-block; margin-left: 6px;
  color: var(--fg-mute); opacity: 0; transition: opacity .12s;
  font-family: var(--font-mono);
}
.tbl tbody tr.clickable:hover td:last-child::after { opacity: 1; }
.tbl tr.sel > td { background: color-mix(in srgb, var(--accent-soft) 60%, transparent); }

/* candidate list -------------------------------------------------- */
.cand-list { display: flex; flex-direction: column; }
.cand-row {
  display: grid; grid-template-columns: 130px 1fr auto;
  gap: var(--s-3); padding: var(--s-3) var(--s-5);
  border-bottom: 1px solid var(--bd-soft); align-items: start;
}
.cand-row:last-child { border-bottom: 0; }
.cand-row:hover { background: var(--bg-soft); }
.cand-row .c-badge { display: flex; align-items: center; gap: 6px; }
.cand-row .c-q { font-size: var(--t-14); line-height: 1.45; word-break: break-word; }
.cand-row .c-meta { font-size: var(--t-12); color: var(--fg-mute); margin-top: 4px; display: flex; gap: var(--s-3); font-family: var(--font-mono); flex-wrap: wrap; }
.cand-row .c-act { display: flex; gap: 6px; align-items: center; }

/* tree (index) ---------------------------------------------------- */
.tree { font-size: var(--t-13); }
.tree-sec { padding: var(--s-2) 0; }
.tree-sec-hd {
  display: flex; align-items: center; gap: var(--s-2);
  padding: 4px var(--s-2);
  font-size: var(--t-12); color: var(--fg-soft);
  letter-spacing: .02em; font-weight: 600;
}
.tree-row {
  display: grid; grid-template-columns: 1fr auto auto;
  align-items: center; gap: var(--s-3);
  padding: 6px var(--s-2) 6px 26px;
  border-radius: var(--r-2);
}
.tree-row:hover { background: var(--bg-soft); }
.tree-row .t-ti { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tree-row .t-ti span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-row .t-slug { font-family: var(--font-mono); font-size: 11px; color: var(--fg-mute); }

/* bars (eval golden) --------------------------------------------- */
.bars { display: flex; flex-direction: column; gap: 6px; font-size: var(--t-12); }
.bar-row { display: grid; grid-template-columns: 80px 1fr 36px; gap: var(--s-2); align-items: center; }
.bar-row .b-lab { color: var(--fg-soft); font-family: var(--font-mono); }
.bar-row .b-bar { height: 6px; border-radius: 999px; background: var(--bg-soft); overflow: hidden; }
.bar-row .b-bar i { display: block; height: 100%; background: var(--accent); }
.bar-row .b-num { font-variant-numeric: tabular-nums; text-align: right; color: var(--fg); }

/* progress -------------------------------------------------------- */
.progress {
  height: 6px; border-radius: 999px;
  background: var(--bg-soft); overflow: hidden; position: relative;
}
.progress > i {
  display: block; height: 100%; background: var(--accent);
  border-radius: inherit; transition: width .3s;
}
.progress.indeterminate > i {
  width: 35%; animation: indet 1.4s ease-in-out infinite;
}
@keyframes indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(285%); } }

/* drawer ---------------------------------------------------------- */
.drawer-mask {
  position: fixed; inset: 0;
  background: rgba(20,20,18,.36);
  z-index: 20;
}
.drawer {
  position: fixed; top: 0; right: 0;
  width: 480px; max-width: 100vw; height: 100vh;
  background: var(--bg-elev); border-left: 1px solid var(--bd);
  box-shadow: var(--sh-pop); z-index: 21;
  display: flex; flex-direction: column;
}
.drawer[hidden], .drawer-mask[hidden] { display: none; }
.drawer-hd {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--bd);
}
.drawer-hd h2 { margin: 0; font-size: var(--t-15); font-weight: 600; }
.drawer-bd { padding: var(--s-5); overflow-y: auto; flex: 1; }
.drawer-sec { margin-bottom: var(--s-7); }
.drawer-sec-hd {
  display: grid; grid-template-columns: 1fr auto;
  column-gap: var(--s-3); row-gap: 4px; align-items: center;
  padding-bottom: var(--s-3); margin-bottom: var(--s-3);
  border-bottom: 1px solid var(--bd-soft);
}
.drawer-sec-hd h3 {
  margin: 0; font-size: var(--t-12); font-weight: 600;
  letter-spacing: .08em; text-transform: uppercase; color: var(--fg);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.drawer-sec-hd h3 .h3-sub { color: var(--fg-soft); font-weight: 500; }
.drawer-sec-hd .tag { justify-self: end; white-space: nowrap; text-transform: none; letter-spacing: 0; }
.drawer-sec-hd .path { grid-column: 1 / -1; font-family: var(--font-mono); font-size: 11px; color: var(--fg-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.drawer-sec dl { display: grid; grid-template-columns: minmax(140px, max-content) minmax(0, 1fr); gap: 6px var(--s-4); font-family: var(--font-mono); font-size: var(--t-12); margin: 0; }
.drawer-sec dt { color: var(--fg-soft); }
.drawer-sec dd { margin: 0; color: var(--fg); word-break: break-all; min-width: 0; }
.drawer-sec .miss { color: var(--fg-mute); font-style: italic; font-family: var(--font-sans); }
.redact { color: var(--fg); }
.redact em { font-style: normal; color: var(--fg-mute); }

/* misc utils ------------------------------------------------------ */
.muted { color: var(--fg-mute); }
.soft  { color: var(--fg-soft); }
.row-gap { display: flex; gap: var(--s-3); flex-wrap: wrap; }

/* status text ----------------------------------------------------- */
.status { color: var(--fg-mute); font-size: var(--t-12); min-height: 16px; }
.status.ok  { color: var(--ok); }
.status.err { color: var(--err); }

/* modal ----------------------------------------------------------- */
.modal-mask {
  position: fixed; inset: 0;
  background: rgba(20,20,18,.36);
  z-index: 40; display: none;
  align-items: center; justify-content: center;
  padding: var(--s-5);
}
.modal-mask.show { display: flex; }
.modal {
  background: var(--bg); border: 1px solid var(--bd);
  border-radius: var(--r-5); box-shadow: var(--sh-pop);
  width: min(720px, 100%); max-height: calc(100vh - 2 * var(--s-5));
  display: flex; flex-direction: column; overflow: hidden;
}
.modal-hd {
  display: flex; align-items: baseline; gap: var(--s-3);
  padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--bd);
}
.modal-hd h2 { margin: 0; font-size: var(--t-15); font-weight: 600; }
.modal-hd .modal-sub { font-family: var(--font-mono); font-size: var(--t-13); color: var(--fg-soft); }
.modal-hd .x { margin-left: auto; }
.modal-bd { padding: var(--s-4) var(--s-5); overflow-y: auto; flex: 1; }
.modal-ft {
  display: flex; justify-content: flex-end; gap: var(--s-2);
  padding: var(--s-3) var(--s-5);
  border-top: 1px solid var(--bd); background: var(--bg-elev);
}

/* danger modal — subtle red top accent + summary card --------- */
.modal.danger { border-color: color-mix(in srgb, var(--err) 35%, var(--bd)); }
.modal.danger .modal-hd {
  background: color-mix(in srgb, var(--err-soft) 55%, var(--bg-elev));
  border-bottom-color: color-mix(in srgb, var(--err) 25%, var(--bd));
}
.modal.danger .modal-hd .b-ico {
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--err) 20%, transparent);
  color: var(--err); border-radius: 50%;
}
.modal.danger .modal-hd .b-ico svg { width: 12px; height: 12px; }

.del-target {
  display: flex; align-items: center; gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  background: var(--bg-soft); border: 1px solid var(--bd); border-radius: var(--r-4);
}
.del-target .dt-name { font-family: var(--font-mono); font-size: var(--t-14); font-weight: 600; color: var(--fg); }
.del-target .dt-path { font-family: var(--font-mono); font-size: var(--t-12); color: var(--fg-mute); margin-top: 2px; word-break: break-all; }
.del-target .dt-stats {
  display: flex; gap: var(--s-3); font-size: var(--t-12);
  color: var(--fg-soft); margin-top: 6px; flex-wrap: wrap;
}
.del-target .dt-stats .sep { color: var(--fg-mute); }
.del-target .dt-stats b { color: var(--fg); font-variant-numeric: tabular-nums; }

.del-effect {
  display: grid; grid-template-columns: 20px 1fr;
  gap: 6px var(--s-3); font-size: var(--t-13);
  margin: var(--s-4) 0 var(--s-2);
}
.del-effect .e-ico {
  color: var(--fg-mute); display: inline-flex;
  align-items: center; justify-content: center; padding-top: 2px;
}
.del-effect .e-ico svg { width: 14px; height: 14px; }
.del-effect .e-ico.ok { color: var(--ok); }
.del-effect .e-ico.err { color: var(--err); }
.del-effect b { font-weight: 600; }
.del-effect span { color: var(--fg-soft); }
.del-effect span b { color: var(--fg); }

.confirm-type { margin-top: var(--s-4); display: flex; flex-direction: column; gap: 6px; }
.confirm-type label { font-size: var(--t-13); color: var(--fg-soft); }
.confirm-type label .mono-strong {
  font-family: var(--font-mono); font-weight: 600; color: var(--fg);
  background: var(--bg-soft); padding: 1px 5px;
  border-radius: var(--r-2); border: 1px solid var(--bd-soft);
}
.confirm-type input { font-family: var(--font-mono); }
.confirm-type input.match {
  border-color: color-mix(in srgb, var(--err) 60%, var(--bd));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--err) 18%, transparent);
}

.form-grid {
  display: grid; grid-template-columns: 140px 1fr;
  gap: var(--s-3) var(--s-4); align-items: start;
}
.form-grid > .lab {
  font-size: var(--t-13); color: var(--fg-soft);
  font-family: var(--font-mono); padding-top: 8px; white-space: nowrap;
}
.form-grid > .lab .req { color: var(--err); margin-left: 2px; }
.form-grid > .val { min-width: 0; }
.form-grid > .val .ro {
  font-family: var(--font-mono); font-size: var(--t-13);
  color: var(--fg-soft); padding-top: 8px;
}
.form-grid .input, .form-grid .select, .form-grid .textarea {
  font-family: var(--font-mono); font-size: var(--t-13);
}
.form-grid .textarea { min-height: 64px; }
.form-grid .textarea.tall { min-height: 96px; }

/* focus ----------------------------------------------------------- */
:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 2px; border-radius: 3px;
}
`;
