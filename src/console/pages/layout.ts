/**
 * Base HTML layout for console pages — ARCH §17.4.
 * Zero build chain: hono/html template tagged literals only, no JSX.
 */

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function layout(args: { title: string; body: Html | Html[] }): Html {
  return html`<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${args.title} · anydocs-ask console</title>
    <style>${BASE_CSS}</style>
  </head>
  <body>
    <header class="hdr">
      <a class="brand" href="/">anydocs-ask console</a>
      <span class="hint">internal · 127.0.0.1</span>
    </header>
    <main class="main">${args.body}</main>
  </body>
</html>`;
}

const BASE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", "PingFang SC", sans-serif; }
  .hdr { display: flex; align-items: baseline; gap: 12px; padding: 10px 18px; border-bottom: 1px solid #ddd2; }
  .hdr .brand { font-weight: 600; text-decoration: none; color: inherit; }
  .hdr .hint { font-size: 12px; color: #888; }
  .main { padding: 20px 18px; max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 24px 0 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #ddd2; vertical-align: top; }
  th { font-weight: 600; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; background: #eee2; color: #555; margin-right: 4px; }
  .tag.ok { background: #34a85322; color: #2a8e44; }
  .tag.warn { background: #f5a62322; color: #b67708; }
  .tag.err { background: #d83a3a22; color: #b6291f; }
  .tag.run { background: #1c7ed633; color: #1864ab; }
  .muted { color: #888; }
  .empty { color: #888; padding: 20px 0; }
  a { color: #1864ab; }
  a:hover { text-decoration: underline; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
`;
