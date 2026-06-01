/**
 * Web Ask reader page — end-user UI for /v1/ask/stream, aligned with the
 * anydocs design system (design-output/web). Mirrors the running console
 * design tokens (base.css) and the chat shell layout (web.css), minus the
 * console-only chrome (project sidebar, dev tabs, retrieval debug).
 *
 * Served by the same Hono app as /v1/ask, so `anydocs-ask serve` exposes
 * the reader at GET /ask. The page POSTs to /v1/ask/stream and renders
 * SSE deltas live; session_id is round-tripped so γ session dedup works.
 *
 * Multi-turn history is kept in localStorage (the server has no
 * /v1/sessions API yet — see RFC 0001). The drawer can be wired to a real
 * backend later by replacing readLocalSessions() / saveLocalSession().
 *
 * Designed to embed cleanly inside an iframe: no cookies, no auth, the
 * .chat-shell pins to viewport via position:fixed; inset:0.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PromptConfig } from '../config.ts';

const require_ = createRequire(import.meta.url);

/** Resolve `marked` from node_modules so the page can `import` it as ESM. */
export function getMarkedScript(): { contentType: string; body: string } {
  return {
    contentType: 'application/javascript; charset=utf-8',
    body: readFileSync(require_.resolve('marked'), 'utf8'),
  };
}

export type RenderAskPageArgs = {
  prompt: PromptConfig;
};

export function renderAskPage(args: RenderAskPageArgs): string {
  // Sanitize: strip < > so a malicious assistantName can't break out of
  // <title> / <div class="chat-title">. We deliberately do not htmlEscape
  // since these slots accept plain text only and ' " & survive fine.
  const assistantName = (args.prompt.assistantName ?? 'Anydocs-Ask').replace(/[<>]/g, '');
  const titleEsc = htmlEscape(assistantName);
  return PAGE_HTML.replaceAll('__TITLE__', titleEsc);
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ---------------------------------------------------------------------------
// HTML template — single file, inline CSS/JS. Tokens & layout copied from
// design-output/web (base.css + web.css), trimmed to the chat surface only.
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE__</title>
<style>
/* ---------- tokens (light) ---------- */
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

  --link:        #2747c4;
  --accent:      #2747c4;
  --accent-soft: #eaeefb;
  --ok:          #1f7a3a;
  --ok-soft:     #e6f1e7;
  --warn:        #8a5a00;
  --warn-soft:   #fbf1d9;
  --err:         #b41f2a;
  --err-soft:    #fbe6e6;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;

  --t-12: 12px;
  --t-13: 13px;
  --t-14: 14px;
  --t-15: 15px;
  --t-16: 16px;
  --t-18: 18px;
  --t-20: 20px;

  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px;
  --s-6: 24px; --s-7: 28px; --s-8: 32px; --s-10: 40px; --s-12: 48px;

  --r-2: 4px; --r-3: 6px; --r-4: 8px; --r-5: 10px; --r-6: 12px;

  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:        #0e0f10;
    --bg-elev:   #161719;
    --bg-soft:   #1c1d20;
    --bg-tint:   #232427;
    --bd:        #2a2c30;
    --bd-soft:   #1f2024;
    --bd-strong: #3a3c41;
    --fg:        #e8e8e3;
    --fg-soft:   #a4a59f;
    --fg-mute:   #6f7068;
    --link:        #7aa2ff;
    --accent:      #7aa2ff;
    --accent-soft: #1a2238;
    --ok:          #4cb96a;
    --ok-soft:     #16241a;
    --warn:        #d6a142;
    --warn-soft:   #2a2317;
    --err:         #f37077;
    --err-soft:    #2a1818;
    color-scheme: dark;
  }
}
[data-theme="dark"] {
  --bg:        #0e0f10;
  --bg-elev:   #161719;
  --bg-soft:   #1c1d20;
  --bg-tint:   #232427;
  --bd:        #2a2c30;
  --bd-soft:   #1f2024;
  --bd-strong: #3a3c41;
  --fg:        #e8e8e3;
  --fg-soft:   #a4a59f;
  --fg-mute:   #6f7068;
  --link:        #7aa2ff;
  --accent:      #7aa2ff;
  --accent-soft: #1a2238;
  --ok:          #4cb96a;
  --ok-soft:     #16241a;
  --warn:        #d6a142;
  --warn-soft:   #2a2317;
  --err:         #f37077;
  --err-soft:    #2a1818;
  color-scheme: dark;
}
[data-theme="light"] { color-scheme: light; }

/* ---------- reset ---------- */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: var(--t-14);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; cursor: pointer; }
input, textarea, select { font: inherit; color: inherit; }
code, pre, .mono { font-family: var(--font-mono); }
::selection { background: var(--accent-soft); }
:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 2px;
  border-radius: 3px;
}
/* Force native [hidden] to win against display:flex/grid on .hist-drawer,
   .chat-empty, .chat-col, .composer (all of which set display in their
   selectors and would otherwise override the UA stylesheet). */
[hidden] { display: none !important; }

/* ---------- chat shell ---------- */
.chat-shell {
  position: fixed; inset: 0;
  display: flex; flex-direction: column;
  background: var(--bg);
}

/* top bar */
.chat-bar {
  flex: 0 0 auto;
  height: 52px;
  display: flex; align-items: center;
  padding: 0 var(--s-5);
  border-bottom: 1px solid var(--bd-soft);
  background: var(--bg);
  gap: var(--s-3);
}
.chat-bar-l { display: inline-flex; align-items: center; gap: 6px; }
.chat-bar-r { margin-left: auto; display: inline-flex; align-items: center; gap: var(--s-3); }
.chat-title {
  font-family: var(--font-mono);
  font-size: var(--t-14);
  font-weight: 600;
  color: var(--fg);
  letter-spacing: -.01em;
}
.chat-hist-toggle {
  width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-3);
  color: var(--fg-soft);
  cursor: pointer;
  margin-right: 2px;
}
.chat-hist-toggle:hover { background: var(--bg-soft); color: var(--fg); border-color: var(--bd-soft); }
.chat-hist-toggle.open { background: var(--bg-soft); color: var(--fg); border-color: var(--bd-soft); }
.chat-hist-toggle svg { width: 16px; height: 16px; }
.chat-status {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--t-13);
  color: var(--ok);
  font-family: var(--font-mono);
  letter-spacing: .01em;
}
.chat-status .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
}
.chat-status.warn { color: var(--warn); }
.chat-status.warn .dot { animation: pulse 1.6s ease-in-out infinite; }
.chat-status.err  { color: var(--err); }
.chat-status.idle { color: var(--fg-mute); }
.chat-status.run  { color: var(--accent); }
.chat-status.run .dot { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

/* main scroll area */
.chat-main {
  flex: 1 1 auto;
  overflow-y: auto;
  scroll-behavior: smooth;
}
.chat-col {
  max-width: 860px;
  margin: 0 auto;
  padding: var(--s-6) var(--s-6) var(--s-8);
  display: flex; flex-direction: column;
  gap: var(--s-5);
}

/* empty / first run */
.chat-empty {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  text-align: center;
  height: 100%;
  padding: var(--s-12) var(--s-6);
  color: var(--fg-soft);
}
.chat-empty .glyph {
  width: 40px; height: 40px;
  border-radius: 12px;
  background: var(--bg-soft);
  border: 1px solid var(--bd-soft);
  color: var(--fg-soft);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: var(--s-3);
}
.chat-empty .glyph svg { width: 18px; height: 18px; }
.chat-empty h2 {
  margin: 0;
  font-size: var(--t-16);
  font-weight: 600;
  color: var(--fg);
}
.chat-empty p {
  margin: 6px 0 0;
  font-size: var(--t-13);
  color: var(--fg-mute);
  max-width: 44ch;
  line-height: 1.55;
}

/* user message */
.turn-user { display: flex; justify-content: flex-end; }
.bubble-user {
  background: var(--accent-soft);
  color: var(--fg);
  padding: 8px 14px;
  border-radius: 12px;
  font-size: var(--t-14);
  line-height: 1.55;
  max-width: 75%;
  word-break: break-word;
  white-space: pre-wrap;
}

/* assistant message */
.turn-asst {
  display: flex; flex-direction: column;
  gap: var(--s-3);
  max-width: 100%;
}
.asst-notice {
  background: color-mix(in srgb, var(--accent-soft) 50%, var(--bg-soft));
  border: 1px solid var(--bd-soft);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: var(--t-13);
  color: var(--fg-soft);
  font-style: italic;
}
.asst-notice .lab {
  font-style: italic;
  color: var(--fg-soft);
  margin-right: 4px;
}
.asst-notice.warn { background: color-mix(in srgb, var(--warn-soft) 60%, var(--bg-elev)); border-color: color-mix(in srgb, var(--warn) 30%, var(--bd)); color: var(--warn); }
.asst-notice.err  { background: color-mix(in srgb, var(--err-soft) 60%, var(--bg-elev));  border-color: color-mix(in srgb, var(--err) 30%, var(--bd));  color: var(--err); }

.asst-body {
  font-size: var(--t-14);
  line-height: 1.7;
  color: var(--fg);
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.asst-body > *:first-child { margin-top: 0; }
.asst-body > *:last-child { margin-bottom: 0; }
.asst-body p { margin: 0 0 var(--s-3); }
.asst-body h1, .asst-body h2, .asst-body h3 { margin: var(--s-5) 0 var(--s-2); font-weight: 600; letter-spacing: -.01em; }
.asst-body h1 { font-size: var(--t-20); }
.asst-body h2 { font-size: var(--t-16); }
.asst-body h3 { font-size: var(--t-14); }
.asst-body ul, .asst-body ol { padding-left: 22px; margin: 0 0 var(--s-3); }
.asst-body li { margin: 4px 0; }
.asst-body li b, .asst-body li strong { font-weight: 600; color: var(--fg); }
.asst-body blockquote {
  border-left: 3px solid var(--bd);
  padding-left: var(--s-3);
  margin: var(--s-3) 0;
  color: var(--fg-soft);
}
.asst-body code {
  font-family: var(--font-mono);
  font-size: .92em;
  background: var(--bg-soft);
  padding: 1px 5px;
  border-radius: var(--r-2);
  border: 1px solid var(--bd-soft);
}
.asst-body pre {
  background: var(--bg-soft);
  border: 1px solid var(--bd-soft);
  border-radius: var(--r-3);
  padding: var(--s-3) var(--s-4);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--t-13);
  line-height: 1.55;
  margin: 0 0 var(--s-3);
}
.asst-body pre code { background: transparent; border: 0; padding: 0; }
.asst-body a { color: var(--link); }
.asst-body table { border-collapse: collapse; margin: 0 0 var(--s-3); font-size: var(--t-13); width: 100%; }
.asst-body th, .asst-body td { padding: 8px 10px; border-bottom: 1px solid var(--bd-soft); text-align: left; }
.asst-body th { font-weight: 600; color: var(--fg-soft); font-size: var(--t-12); background: var(--bg-soft); }

/* inline citation pill */
.asst-body .cit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  margin: 0 2px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  vertical-align: 2px;
  text-decoration: none;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  transition: background .12s, border-color .12s;
}
.asst-body .cit:hover {
  background: color-mix(in srgb, var(--accent) 16%, var(--accent-soft));
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  text-decoration: none;
  color: var(--accent);
}
.cite-row:target {
  background: color-mix(in srgb, var(--accent-soft) 60%, var(--bg));
  border-radius: var(--r-3);
  padding-left: var(--s-3);
  padding-right: var(--s-3);
  margin-left: calc(var(--s-3) * -1);
  margin-right: calc(var(--s-3) * -1);
}

/* citation list */
.asst-cites {
  margin-top: var(--s-4);
  padding-top: var(--s-4);
  border-top: 1px solid var(--bd-soft);
}
.cites-hd {
  font-size: var(--t-12);
  font-family: var(--font-mono);
  color: var(--fg-mute);
  letter-spacing: .12em;
  margin-bottom: var(--s-4);
}
.cite-row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: var(--s-3) var(--s-4);
  padding: var(--s-3) 0;
  align-items: start;
}
.cite-row + .cite-row { border-top: 1px solid var(--bd-soft); }
.cit-chip {
  display: inline-flex;
  align-items: center; justify-content: center;
  width: 26px; height: 26px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
  font-family: var(--font-mono);
  font-size: var(--t-12);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}
.cite-row:hover .cit-chip {
  background: color-mix(in srgb, var(--accent) 14%, var(--accent-soft));
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.cite-bd { min-width: 0; }
.cite-ti { font-size: var(--t-14); font-weight: 600; color: var(--fg); }
.cite-ti a { color: var(--fg); text-decoration: none; }
.cite-ti a:hover { color: var(--accent); text-decoration: underline; }
.cite-ti .lang-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  height: 16px;
  line-height: 16px;
  border-radius: var(--r-2);
  background: var(--warn-soft);
  color: var(--warn);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  vertical-align: 2px;
  border: 1px solid color-mix(in srgb, var(--warn) 25%, transparent);
}
/* Section suffix appended to the cite title when two chunks of the same page
   appear — keeps each row visually distinct without changing the bold title.
   Mirrors the Console F4 fix (project.ts:citeSectionLabel). */
.cite-ti .cite-section {
  font-weight: 400;
  color: var(--fg-mute);
  margin-left: 4px;
}
.cite-slug {
  font-family: var(--font-mono);
  font-size: var(--t-12);
  color: var(--fg-mute);
  margin-top: 2px;
  word-break: break-all;
}
.cite-sn {
  font-size: var(--t-13);
  color: var(--fg-soft);
  line-height: 1.6;
  margin-top: 6px;
  word-wrap: break-word;
}

/* feedback bar */
.asst-fb {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--s-4);
  padding-top: var(--s-3);
  border-top: 1px solid var(--bd-soft);
}
.asst-fb .lab {
  font-size: var(--t-12);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  letter-spacing: .02em;
  margin-right: auto;
}
.asst-fb .meta {
  font-size: var(--t-12);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  letter-spacing: .02em;
  margin-right: auto;
}
.asst-fb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--fg-mute);
  font-family: var(--font-sans);
  font-size: var(--t-12);
  cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
.asst-fb-btn:hover {
  background: var(--bg-soft);
  color: var(--fg);
  border-color: var(--bd-soft);
}
.asst-fb-btn svg { width: 14px; height: 14px; }
.asst-fb-btn.up.active {
  color: var(--ok);
  background: var(--ok-soft);
  border-color: color-mix(in srgb, var(--ok) 30%, var(--bd));
}
.asst-fb-btn.dn.active {
  color: var(--err);
  background: var(--err-soft);
  border-color: color-mix(in srgb, var(--err) 30%, var(--bd));
}
.asst-fb-btn.copied {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 30%, var(--bd));
}
.asst-fb-sep {
  display: inline-block;
  width: 1px; height: 14px;
  background: var(--bd-soft);
  margin: 0 4px;
}

/* clarify suggestion buttons */
.clarify-opts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: var(--s-3);
}
.clarify-opts button {
  background: var(--bg-elev);
  border: 1px solid var(--bd);
  border-radius: var(--r-3);
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: var(--t-13);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.clarify-opts button:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--bd-strong)); background: var(--bg-soft); }
.clarify-opts .label { font-weight: 500; }
.clarify-opts .crumb {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-mute);
}
.clarify-opts .samples {
  font-size: var(--t-12);
  color: var(--fg-soft);
  margin-top: 4px;
  line-height: 1.5;
}
.clarify-opts .samples .sep { color: var(--fg-mute); margin: 0 6px; opacity: .6; }

/* streaming cursor */
.cursor {
  display: inline-block;
  width: 6px; height: 1em;
  background: var(--accent);
  vertical-align: -2px;
  margin-left: 1px;
  animation: blink 0.9s infinite;
}
@keyframes blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }

/* composer */
.chat-composer {
  flex: 0 0 auto;
  background: var(--bg);
  border-top: 1px solid var(--bd-soft);
}
.composer-col {
  max-width: 860px;
  margin: 0 auto;
  padding: var(--s-4) var(--s-6) var(--s-3);
}
.composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--s-3);
  align-items: end;
}
.composer textarea {
  background: var(--bg-elev);
  border: 1px solid var(--bd);
  border-radius: 10px;
  padding: 12px 14px;
  font-family: var(--font-sans);
  font-size: var(--t-14);
  line-height: 1.55;
  color: var(--fg);
  resize: none;
  min-height: 44px;
  max-height: 200px;
  outline: 0;
  transition: border-color .12s, box-shadow .12s;
}
.composer textarea::placeholder { color: var(--fg-mute); }
.composer textarea:focus {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--bd));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}
.btn-send {
  display: inline-flex; align-items: center; justify-content: center;
  height: 44px;
  padding: 0 22px;
  border-radius: 10px;
  background: var(--accent);
  color: white;
  border: 0;
  font-size: var(--t-14);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn-send:hover { background: color-mix(in srgb, var(--accent) 88%, black); }
.btn-send:disabled, .btn-send.disabled { opacity: .55; cursor: not-allowed; }
.composer-hint {
  margin-top: 6px;
  font-size: var(--t-12);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  text-align: center;
}
.composer-hint .k {
  border: 1px solid var(--bd-soft);
  border-radius: 3px;
  padding: 0 4px;
  margin: 0 1px;
  background: var(--bg-soft);
}

/* history drawer */
.hist-mask {
  position: fixed; inset: 0;
  background: rgba(20,20,18,.28);
  z-index: 40;
  animation: fadein .12s;
}
.hist-drawer {
  position: fixed;
  top: 0; left: 0;
  width: 320px; max-width: 90vw;
  height: 100vh;
  background: var(--bg-elev);
  border-right: 1px solid var(--bd);
  box-shadow: 8px 0 24px rgba(20,20,18,.10);
  z-index: 41;
  display: flex; flex-direction: column;
  animation: slidein .14s ease-out;
}
@keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
@keyframes slidein { from { transform: translateX(-100%); } to { transform: none; } }
.hist-hd {
  display: flex; align-items: center;
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--bd-soft);
  gap: var(--s-2);
  height: 52px;
}
.hist-hd h2 {
  margin: 0;
  font-size: var(--t-13);
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--fg-soft);
}
.hist-hd .grow { flex: 1; }
.hist-hd .x {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r-3);
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-soft);
  cursor: pointer;
}
.hist-hd .x:hover { background: var(--bg-soft); color: var(--fg); }
.hist-hd .x svg { width: 14px; height: 14px; }
.hist-new {
  display: flex; align-items: center; gap: 8px;
  margin: var(--s-3) var(--s-3) var(--s-2);
  padding: 10px 12px;
  border-radius: var(--r-3);
  background: var(--bg-soft);
  border: 1px solid var(--bd-soft);
  color: var(--fg);
  font-size: var(--t-13);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
.hist-new:hover { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 25%, var(--bd)); color: var(--accent); }
.hist-new svg { width: 14px; height: 14px; }
.hist-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--s-2) var(--s-2) var(--s-4);
}
.hist-grp {
  padding: var(--s-3) var(--s-3) 4px;
  font-size: 11px;
  color: var(--fg-mute);
  font-family: var(--font-mono);
  letter-spacing: .08em;
  text-transform: uppercase;
}
.hist-item {
  display: block;
  padding: 8px 12px;
  margin: 1px var(--s-1);
  border-radius: var(--r-3);
  color: var(--fg);
  text-decoration: none;
  cursor: pointer;
  border: 0;
  background: transparent;
  width: calc(100% - var(--s-2));
  text-align: left;
}
.hist-item:hover { background: var(--bg-soft); }
.hist-item.active { background: var(--accent-soft); }
.hist-item.active .hi-ti { color: var(--accent); }
.hist-item .hi-ti {
  font-size: var(--t-13);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist-item .hi-meta {
  font-size: 11px;
  color: var(--fg-mute);
  font-family: var(--font-mono);
  margin-top: 2px;
  display: flex; gap: 8px;
}
.hist-empty {
  padding: var(--s-6) var(--s-4);
  text-align: center;
  font-size: var(--t-13);
  color: var(--fg-mute);
}

/* tiny inline toast for copy */
.toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  background: var(--fg);
  color: var(--bg);
  font-size: var(--t-12);
  padding: 6px 12px;
  border-radius: 999px;
  z-index: 60;
  opacity: 0;
  pointer-events: none;
  transition: opacity .15s;
}
.toast.show { opacity: 1; }

/* responsive */
@media (max-width: 720px) {
  .chat-bar { padding: 0 var(--s-3); }
  .chat-col, .composer-col { padding-left: var(--s-4); padding-right: var(--s-4); }
  .bubble-user { max-width: 88%; }
  .hist-drawer { width: 100vw; max-width: 100vw; }
}
</style>
</head>
<body>
<script>
// Theme: ?theme=dark|light overrides system preference.
(function () {
  try {
    const q = new URLSearchParams(location.search).get('theme');
    if (q === 'dark' || q === 'light') document.documentElement.setAttribute('data-theme', q);
  } catch (_) {}
})();
</script>

<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
  <symbol id="i-copy" viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>
  <symbol id="i-check" viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>

<div class="chat-shell">
  <header class="chat-bar">
    <div class="chat-bar-l">
      <button class="chat-hist-toggle" id="hist-toggle" aria-label="history" title="History">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 8a6 6 0 1 1 1.8 4.3"/>
          <path d="M2 13v-3h3"/>
          <path d="M8 5v3.3l2 1.3"/>
        </svg>
      </button>
      <div class="chat-title">__TITLE__</div>
    </div>
    <div class="chat-bar-r">
      <span class="chat-status idle" id="status"><span class="dot"></span><span id="status-lab">connecting…</span></span>
    </div>
  </header>

  <main class="chat-main" id="main">
    <div class="chat-empty" id="empty">
      <div class="glyph">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 3h11A1.5 1.5 0 0 1 15 4.5v6A1.5 1.5 0 0 1 13.5 12H7l-3 2.5V12H2.5A1.5 1.5 0 0 1 1 10.5v-6A1.5 1.5 0 0 1 2.5 3Z"/>
        </svg>
      </div>
      <h2>Ask a question to start</h2>
      <p>Type a question below. We'll search the docs and reply with a grounded answer and citations.</p>
    </div>
    <div class="chat-col" id="col" hidden></div>
  </main>

  <footer class="chat-composer">
    <div class="composer-col">
      <form class="composer" id="composer">
        <textarea id="q" rows="1" placeholder="Ask a question... (⌘↵ to send)" autofocus></textarea>
        <button type="submit" class="btn-send" id="send">Send</button>
      </form>
      <div class="composer-hint">
        Enter for newline · <span class="k">⌘↵</span> / <span class="k">Ctrl↵</span> to send
      </div>
    </div>
  </footer>
</div>

<div class="hist-mask" id="hist-mask" hidden></div>
<aside class="hist-drawer" id="hist-drawer" hidden role="dialog" aria-label="Conversation history">
  <header class="hist-hd">
    <h2>History</h2>
    <span class="grow"></span>
    <button class="x" id="hist-close" type="button" aria-label="close">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>
    </button>
  </header>
  <button type="button" class="hist-new" id="hist-new">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
    New chat
  </button>
  <div class="hist-list" id="hist-list"></div>
</aside>

<div class="toast" id="toast">Copied</div>

<script type="module">
import { marked } from '/ask/marked.esm.js';
marked.setOptions({ breaks: true, gfm: true });

const $ = (id) => document.getElementById(id);
const main = $('main');
const col = $('col');
const empty = $('empty');
const composer = $('composer');
const qEl = $('q');
const sendBtn = $('send');
const statusEl = $('status');
const statusLab = $('status-lab');
const histToggle = $('hist-toggle');
const histMask = $('hist-mask');
const histDrawer = $('hist-drawer');
const histClose = $('hist-close');
const histNew = $('hist-new');
const histList = $('hist-list');
const toast = $('toast');

const HIST_KEY = 'anydocs-ask:history:v1';
const HIST_MAX = 50;

// ----------------------------------------------------------------
// State
// ----------------------------------------------------------------
let sessionId = null;          // assigned by server on first reply
let pending = false;
let pendingScope = null;       // scope_id from a clarify pick (single-use)
let turnSeq = 0;               // citation namespacing across turns
const turns = [];              // { user, asst: {markdown, citations, answerId, model, latencyMs, usedChunks, fb} }
let currentLocalId = makeLocalId();

function makeLocalId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ----------------------------------------------------------------
// Health probe
// ----------------------------------------------------------------
function setStatus(label, kind) {
  statusEl.className = 'chat-status' + (kind ? ' ' + kind : '');
  statusLab.textContent = label;
}
async function probeHealth() {
  try {
    const r = await fetch('/v1/health', { cache: 'no-store' });
    if (r.status === 200) { setStatus('ready'); return true; }
    if (r.status === 503) { setStatus('warming…', 'warn'); return false; }
  } catch (_) {}
  setStatus('offline', 'err');
  return false;
}
let warmTimer = null;
function pollWarmth() {
  if (warmTimer) return;
  warmTimer = setInterval(async () => {
    const ok = await probeHealth();
    if (ok) { clearInterval(warmTimer); warmTimer = null; }
  }, 1500);
}
probeHealth();

// ----------------------------------------------------------------
// History (localStorage)
// ----------------------------------------------------------------
function loadHistory() {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch (_) {}
}
function upsertCurrent() {
  if (turns.length === 0) return;
  const list = loadHistory().filter((c) => c.localId !== currentLocalId);
  list.unshift({
    localId: currentLocalId,
    sessionId,
    title: turns[0].user.slice(0, 80),
    turns: turns.length,
    updatedAt: Date.now(),
    snapshot: turns,
  });
  saveHistory(list);
  // F9 (dogfood 2026-05-23) — if the HISTORY drawer is already open when
  // we land a turn, re-render so the user sees the new conversation appear
  // instead of the stale "No conversations yet" empty state. openHistory()
  // already reads fresh on each open, so the bug only bites the
  // "drawer-open-then-first-answer" sequence.
  if (histDrawer && !histDrawer.hidden) renderHistory();
}
function deleteLocal(localId) {
  saveHistory(loadHistory().filter((c) => c.localId !== localId));
}
function groupForTs(ts) {
  const now = new Date();
  const t = new Date(ts);
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(now);
  if (ts >= todayStart) return 'Today';
  if (ts >= todayStart - dayMs) return 'Yesterday';
  if (ts >= todayStart - 7 * dayMs) return 'This week';
  return 'Older';
}
function fmtRelative(ts) {
  const dt = Date.now() - ts;
  const m = Math.floor(dt / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = new Date(ts);
  const today = new Date();
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString();
}
function renderHistory() {
  const list = loadHistory();
  histList.innerHTML = '';
  if (list.length === 0) {
    const e = document.createElement('div');
    e.className = 'hist-empty';
    e.textContent = 'No conversations yet';
    histList.appendChild(e);
    return;
  }
  let lastGroup = null;
  for (const item of list) {
    const grp = groupForTs(item.updatedAt);
    if (grp !== lastGroup) {
      lastGroup = grp;
      const g = document.createElement('div');
      g.className = 'hist-grp';
      g.textContent = grp;
      histList.appendChild(g);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hist-item' + (item.localId === currentLocalId ? ' active' : '');
    btn.innerHTML =
      '<div class="hi-ti"></div>' +
      '<div class="hi-meta"><span></span><span>·</span><span></span></div>';
    btn.querySelector('.hi-ti').textContent = item.title || '(untitled)';
    const metas = btn.querySelectorAll('.hi-meta span');
    metas[0].textContent = item.turns + (item.turns === 1 ? ' turn' : ' turns');
    metas[2].textContent = fmtRelative(item.updatedAt);
    btn.addEventListener('click', () => {
      loadConversation(item);
      closeHistory();
    });
    histList.appendChild(btn);
  }
}
function loadConversation(item) {
  // Restore in-memory turns and re-render. We keep sessionId so the
  // server-side γ table stays consistent if the user reuses the slot.
  currentLocalId = item.localId;
  sessionId = item.sessionId || null;
  turns.length = 0;
  for (const t of (item.snapshot || [])) turns.push(t);
  turnSeq = turns.length;
  rerenderAll();
}
function newConversation() {
  upsertCurrent();
  currentLocalId = makeLocalId();
  sessionId = null;
  turns.length = 0;
  turnSeq = 0;
  pendingScope = null;
  rerenderAll();
  qEl.focus();
}

function openHistory() {
  renderHistory();
  histMask.hidden = false;
  histDrawer.hidden = false;
  histToggle.classList.add('open');
  histToggle.setAttribute('aria-expanded', 'true');
}
function closeHistory() {
  histMask.hidden = true;
  histDrawer.hidden = true;
  histToggle.classList.remove('open');
  histToggle.setAttribute('aria-expanded', 'false');
}
histToggle.addEventListener('click', () => {
  histDrawer.hidden ? openHistory() : closeHistory();
});
histMask.addEventListener('click', closeHistory);
histClose.addEventListener('click', closeHistory);
histNew.addEventListener('click', newConversation);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !histDrawer.hidden) closeHistory();
});

// ----------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------
function showCol() {
  if (turns.length === 0) {
    empty.hidden = false;
    col.hidden = true;
  } else {
    empty.hidden = true;
    col.hidden = false;
  }
}

function scrollToBottom() {
  const atBottom = main.scrollHeight - main.clientHeight - main.scrollTop < 120;
  if (atBottom) main.scrollTop = main.scrollHeight;
}

// Replace [cit_<id>] tokens with anchor pills. Citation ids are namespaced
// per-turn (turnIdx-id) so identical "1" markers across turns don't collide.
function transformCitations(md, turnIdx) {
  return md.replace(/\\[cit_([A-Za-z0-9_-]+)\\]/g, (_, id) => {
    const anchor = 'cit-' + turnIdx + '-' + id;
    return '<a class="cit" href="#' + anchor + '">' + id + '</a>';
  });
}
function renderMarkdown(md, turnIdx, streaming) {
  const transformed = transformCitations(md || '', turnIdx);
  const html = marked.parse(transformed);
  return streaming ? html + '<span class="cursor"></span>' : html;
}

function renderUserTurn(text) {
  const wrap = document.createElement('div');
  wrap.className = 'turn-user';
  const b = document.createElement('div');
  b.className = 'bubble-user';
  b.textContent = text;
  wrap.appendChild(b);
  col.appendChild(wrap);
}

function renderAsstShell(turnIdx) {
  const wrap = document.createElement('div');
  wrap.className = 'turn-asst';
  wrap.dataset.turn = String(turnIdx);
  const body = document.createElement('div');
  body.className = 'asst-body';
  body.innerHTML = '<span class="cursor"></span>';
  wrap.appendChild(body);
  col.appendChild(wrap);
  return wrap;
}

// Server emits citation_id as the full marker string "cit_1" / "cit_2"
// (matching the [cit_N] tokens it injects into answer_md). The chat UI
// shows the bare number N inside the chip / inline pill, and uses N to
// build the in-page anchor — so the inline <a class="cit"> link and the
// .cite-row id agree on a single namespace ("cit-{turn}-{N}").
function citNum(id) {
  const m = /^cit_(\\w+)$/.exec(String(id || ''));
  return m ? m[1] : String(id || '');
}

// in_page_path is "<headingId>/p[N]" (section chunk) or "p[N]" (page-top
// chunk). Pull the heading part so two citations from the same page render
// with distinct section labels next to the title — otherwise two chunks of
// one page look like a duplicate citation (dogfood 2026-05-14 F4, Reader-
// side counterpart of console/pages/project.ts:citeSectionLabel). Bare
// "p[N]" has no useful disambiguator, so return ''.
function citeSectionLabel(inPath) {
  if (!inPath) return '';
  const i = String(inPath).lastIndexOf('/p[');
  return i > 0 ? String(inPath).slice(0, i) : '';
}

function renderCitations(citations, turnIdx) {
  if (!Array.isArray(citations) || citations.length === 0) return null;
  const box = document.createElement('div');
  box.className = 'asst-cites';
  const hd = document.createElement('div');
  hd.className = 'cites-hd';
  hd.textContent = citations.length + (citations.length === 1 ? ' CITATION' : ' CITATIONS');
  box.appendChild(hd);
  for (const c of citations) {
    const n = citNum(c.citation_id);
    const row = document.createElement('div');
    row.className = 'cite-row';
    row.id = 'cit-' + turnIdx + '-' + n;
    const chip = document.createElement('span');
    chip.className = 'cit-chip';
    chip.textContent = n || '·';
    row.appendChild(chip);
    const bd = document.createElement('div');
    bd.className = 'cite-bd';
    const ti = document.createElement('div');
    ti.className = 'cite-ti';
    const titleText = c.title || c.page_id || '(untitled)';
    if (c.url) {
      const a = document.createElement('a');
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = titleText;
      ti.appendChild(a);
    } else {
      ti.textContent = titleText;
    }
    const section = citeSectionLabel(c.in_page_path);
    if (section) {
      const sec = document.createElement('span');
      sec.className = 'cite-section';
      sec.textContent = '· §' + section;
      ti.appendChild(sec);
    }
    if (c.source_lang && c.lang && c.source_lang !== c.lang) {
      const tag = document.createElement('span');
      tag.className = 'lang-tag';
      tag.textContent = c.source_lang + ' → ' + c.lang;
      ti.appendChild(tag);
    }
    bd.appendChild(ti);
    const slug = document.createElement('div');
    slug.className = 'cite-slug';
    let slugText = c.page_id || '';
    if (c.in_page_path) slugText += ' · ' + c.in_page_path;
    slug.textContent = slugText;
    bd.appendChild(slug);
    if (c.snippet) {
      const sn = document.createElement('div');
      sn.className = 'cite-sn';
      sn.textContent = c.snippet;
      bd.appendChild(sn);
    }
    row.appendChild(bd);
    box.appendChild(row);
  }
  return box;
}

function renderFeedbackBar(result, turn) {
  const wrap = document.createElement('div');
  wrap.className = 'asst-fb';
  const meta = document.createElement('span');
  meta.className = 'meta';
  const parts = [];
  if (result.model) parts.push(result.model);
  if (typeof result.latency_ms === 'number') parts.push(result.latency_ms + 'ms');
  if (typeof result.used_chunks === 'number') parts.push(result.used_chunks + ' chunks');
  meta.textContent = parts.length ? parts.join(' · ') : '这条回答';
  wrap.appendChild(meta);
  if (!result.answer_id) return wrap;

  const up = document.createElement('button');
  up.type = 'button'; up.className = 'asst-fb-btn up';
  up.title = 'helpful';
  up.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7v6.5H2.5V7Z"/><path d="M5 7 7.5 2.2A1 1 0 0 1 9 2.4c.8.5.8 2.2.3 3.5L8.5 7h3.7a1.5 1.5 0 0 1 1.5 1.8L13 12.2a1.5 1.5 0 0 1-1.5 1.3H5"/></svg><span>有帮助</span>';
  const dn = document.createElement('button');
  dn.type = 'button'; dn.className = 'asst-fb-btn dn';
  dn.title = 'not helpful';
  dn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9V2.5H2.5V9Z"/><path d="M5 9 7.5 13.8A1 1 0 0 0 9 13.6c.8-.5.8-2.2.3-3.5L8.5 9h3.7a1.5 1.5 0 0 0 1.5-1.8L13 3.8a1.5 1.5 0 0 0-1.5-1.3H5"/></svg><span>无帮助</span>';
  const sep = document.createElement('span'); sep.className = 'asst-fb-sep';
  const cp = document.createElement('button');
  cp.type = 'button'; cp.className = 'asst-fb-btn copy';
  cp.title = '复制回答';
  cp.innerHTML = '<svg><use href="#i-copy"/></svg><span>复制</span>';

  if (turn && turn.asst && turn.asst.fb) {
    if (turn.asst.fb === 1) up.classList.add('active');
    else if (turn.asst.fb === -1) dn.classList.add('active');
  }

  async function sendFb(rating, btn, other) {
    const wasActive = btn.classList.contains('active');
    up.classList.remove('active'); dn.classList.remove('active');
    if (!wasActive) btn.classList.add('active');
    const next = wasActive ? 0 : rating;
    if (turn && turn.asst) { turn.asst.fb = next; upsertCurrent(); }
    if (next === 0) return; // no API call for "cleared" — keep UX local
    try {
      await fetch('/v1/ask/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer_id: result.answer_id,
          rating: next,
          generated: result.answer_md || '',
        }),
      });
    } catch (_) {}
  }
  up.addEventListener('click', () => sendFb(1, up, dn));
  dn.addEventListener('click', () => sendFb(-1, dn, up));

  cp.addEventListener('click', async () => {
    const text = (result.answer_md || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      cp.classList.add('copied');
      cp.querySelector('span').textContent = '已复制';
      showToast('Copied');
      setTimeout(() => {
        cp.classList.remove('copied');
        cp.querySelector('span').textContent = '复制';
      }, 1600);
    } catch (_) {
      showToast('Copy failed');
    }
  });

  wrap.appendChild(up); wrap.appendChild(dn); wrap.appendChild(sep); wrap.appendChild(cp);
  return wrap;
}

function renderClarifyOptions(options, turnEl) {
  if (!Array.isArray(options) || options.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'clarify-opts';
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Continue under ' + (o.label || o.scope_id || '(unnamed)');
    b.appendChild(label);
    // breadcrumb path — only render when distinct from label
    const crumbTitles = Array.isArray(o.breadcrumb)
      ? o.breadcrumb.map((x) => x && x.title).filter(Boolean)
      : [];
    const crumb = crumbTitles.join(' › ');
    if (crumb && crumb !== o.label) {
      const c = document.createElement('div');
      c.className = 'crumb';
      c.textContent = crumb;
      b.appendChild(c);
    }
    // sample page titles — gives the user a concrete sense of what's in this scope
    if (Array.isArray(o.sample_pages) && o.sample_pages.length) {
      const s = document.createElement('div');
      s.className = 'samples';
      const titles = o.sample_pages.slice(0, 3).map((p) => p && p.title).filter(Boolean);
      titles.forEach((t, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'sep';
          sep.textContent = '·';
          s.appendChild(sep);
        }
        const span = document.createElement('span');
        span.textContent = t;
        s.appendChild(span);
      });
      b.appendChild(s);
    }
    b.addEventListener('click', () => {
      pendingScope = o.scope_id;
      // Re-ask the most recent user turn under this scope
      const last = turns[turns.length - 1];
      if (last && last.user) submitAsk(last.user, /*append=*/ false);
    });
    wrap.appendChild(b);
  }
  turnEl.appendChild(wrap);
}

function rerenderAll() {
  col.innerHTML = '';
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    renderUserTurn(t.user);
    if (t.asst) {
      const wrap = renderAsstShell(i);
      const body = wrap.querySelector('.asst-body');
      if (t.asst.kind === 'answer') {
        const md = (t.asst.notice ? '> _translation notice:_ ' + t.asst.notice + '\\n\\n' : '') + (t.asst.markdown || '');
        body.innerHTML = renderMarkdown(md, i, false);
        const cites = renderCitations(t.asst.citations, i);
        if (cites) wrap.appendChild(cites);
        wrap.appendChild(renderFeedbackBar({
          model: t.asst.model,
          latency_ms: t.asst.latencyMs,
          used_chunks: t.asst.usedChunks,
          answer_id: t.asst.answerId,
          answer_md: t.asst.markdown,
        }, t));
      } else if (t.asst.kind === 'clarify') {
        body.innerHTML = '';
        const n = document.createElement('div');
        n.className = 'asst-notice';
        n.innerHTML = '<span class="lab">clarify:</span> ';
        const span = document.createElement('span');
        span.textContent = t.asst.markdown || 'Which scope?';
        n.appendChild(span);
        wrap.appendChild(n);
        wrap.removeChild(body);
        renderClarifyOptions(t.asst.options || [], wrap);
      } else if (t.asst.kind === 'error') {
        body.innerHTML = '';
        const n = document.createElement('div');
        n.className = 'asst-notice err';
        n.innerHTML = '<span class="lab">' + escapeHtml(t.asst.code || 'error') + ':</span> ';
        const span = document.createElement('span');
        span.textContent = t.asst.markdown || '';
        n.appendChild(span);
        wrap.appendChild(n);
        wrap.removeChild(body);
      }
    }
  }
  showCol();
  scrollToBottom();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ----------------------------------------------------------------
// SSE consumer
// ----------------------------------------------------------------
async function streamAsk(question, turnIdx, wrap, body) {
  const payload = { question };
  if (sessionId) payload.session_id = sessionId;
  if (pendingScope) {
    payload.context = { scope_id: pendingScope };
    pendingScope = null;
  }

  let res;
  try {
    res = await fetch('/v1/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    finalizeError({ code: 'network', message: (e && e.message) || String(e) }, turnIdx, wrap, body);
    return;
  }

  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch (_) {}
    if (res.status === 503) {
      finalizeError({ code: 'warming', message: 'service is still warming up — try again in a few seconds' }, turnIdx, wrap, body);
      pollWarmth();
    } else {
      finalizeError(parsed || { code: 'http_' + res.status, message: res.statusText }, turnIdx, wrap, body);
    }
    return;
  }
  if (!res.body) {
    finalizeError({ code: 'no_stream', message: 'no response body' }, turnIdx, wrap, body);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answerSoFar = '';
  let final = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\\n\\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const ev = parseSseFrame(frame);
      if (!ev) continue;
      if (ev.event === 'status') {
        if (ev.data && ev.data.stage) setStatus(ev.data.stage + '…', 'run');
      } else if (ev.event === 'delta') {
        if (ev.data && typeof ev.data.text === 'string') {
          answerSoFar += ev.data.text;
          body.innerHTML = renderMarkdown(answerSoFar, turnIdx, true);
          scrollToBottom();
        }
      } else if (ev.event === 'result') {
        final = ev.data;
      }
    }
  }

  if (final && final.session_id) sessionId = final.session_id;
  if (!final) {
    finalizeError({ code: 'no_result', message: 'stream ended without a result' }, turnIdx, wrap, body);
    return;
  }
  if (final.type === 'answer') {
    finalizeAnswer(final, turnIdx, wrap, body, answerSoFar);
  } else if (final.type === 'clarify') {
    finalizeClarify(final, turnIdx, wrap, body);
  } else if (final.type === 'error') {
    finalizeError(final, turnIdx, wrap, body);
  } else {
    finalizeError({ code: 'unknown', message: 'unexpected response shape' }, turnIdx, wrap, body);
  }
  setStatus('ready');
}

function finalizeAnswer(result, turnIdx, wrap, body, streamed) {
  const md = result.answer_md || streamed || '';
  const fullMd = (result.translation_notice ? '> _translation notice:_ ' + result.translation_notice + '\\n\\n' : '') + md;
  body.innerHTML = renderMarkdown(fullMd, turnIdx, false);
  const cites = renderCitations(result.citations, turnIdx);
  if (cites) wrap.appendChild(cites);
  const t = turns[turnIdx];
  t.asst = {
    kind: 'answer',
    markdown: md,
    notice: result.translation_notice || null,
    citations: result.citations || [],
    answerId: result.answer_id || null,
    model: result.model || null,
    latencyMs: result.latency_ms || null,
    usedChunks: result.used_chunks || null,
    fb: 0,
  };
  wrap.appendChild(renderFeedbackBar({
    model: t.asst.model,
    latency_ms: t.asst.latencyMs,
    used_chunks: t.asst.usedChunks,
    answer_id: t.asst.answerId,
    answer_md: t.asst.markdown,
  }, t));
  upsertCurrent();
  scrollToBottom();
}

function finalizeClarify(result, turnIdx, wrap, body) {
  body.innerHTML = '';
  wrap.removeChild(body);
  const n = document.createElement('div');
  n.className = 'asst-notice';
  n.innerHTML = '<span class="lab">clarify:</span> ';
  const span = document.createElement('span');
  span.textContent = result.message || 'Which scope would you like to use?';
  n.appendChild(span);
  wrap.appendChild(n);
  renderClarifyOptions(result.options || [], wrap);
  const t = turns[turnIdx];
  t.asst = { kind: 'clarify', markdown: result.message || '', options: result.options || [] };
  upsertCurrent();
  scrollToBottom();
}

function finalizeError(result, turnIdx, wrap, body) {
  body.innerHTML = '';
  wrap.removeChild(body);
  const n = document.createElement('div');
  n.className = 'asst-notice err';
  n.innerHTML = '<span class="lab">' + escapeHtml(result.code || 'error') + ':</span> ';
  const span = document.createElement('span');
  span.textContent = result.message || '';
  n.appendChild(span);
  wrap.appendChild(n);
  const t = turns[turnIdx];
  t.asst = { kind: 'error', code: result.code || 'error', markdown: result.message || '' };
  upsertCurrent();
  scrollToBottom();
  setStatus('ready');
}

function parseSseFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split('\\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\\n');
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = raw; }
  return { event, data };
}

// ----------------------------------------------------------------
// Composer
// ----------------------------------------------------------------
function setBusy(busy) {
  pending = busy;
  sendBtn.disabled = busy;
  qEl.disabled = busy;
  if (busy) setStatus('thinking…', 'run');
}

async function submitAsk(text, append) {
  const q = (text != null ? text : qEl.value).trim();
  if (!q || pending) return;
  if (text == null) { qEl.value = ''; autosize(); }
  setBusy(true);
  // Record turn (append=true unless we're re-asking a clarify with the same user text)
  const shouldAppend = append !== false;
  if (shouldAppend) {
    turns.push({ user: q, asst: null });
  }
  const turnIdx = turns.length - 1;
  // Render user bubble + assistant shell
  if (shouldAppend) renderUserTurn(q);
  const wrap = renderAsstShell(turnIdx);
  const body = wrap.querySelector('.asst-body');
  showCol();
  scrollToBottom();
  try {
    await streamAsk(q, turnIdx, wrap, body);
  } finally {
    setBusy(false);
    qEl.focus();
  }
}

composer.addEventListener('submit', (e) => { e.preventDefault(); submitAsk(); });
qEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    submitAsk();
  }
});

function autosize() {
  qEl.style.height = 'auto';
  qEl.style.height = Math.min(qEl.scrollHeight, 200) + 'px';
}
qEl.addEventListener('input', autosize);
autosize();

// ----------------------------------------------------------------
// Toast
// ----------------------------------------------------------------
let toastTimer = null;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
}

// Boot: show empty state until first turn arrives.
showCol();
</script>
</body>
</html>
`;
