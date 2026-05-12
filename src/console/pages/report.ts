/**
 * Report viewer — ARCH §17.3.1 GET /p/:name/reports/:file.
 *
 * Standalone markdown rendering for a single report file (eval / analyze /
 * golden). Print-friendly. Markdown is parsed in-browser via marked.esm.js;
 * server escapes the body for safe injection.
 */

import { html, raw } from 'hono/html';
import { layout, type Html, type NavContext } from './layout.ts';

export function renderReport(args: {
  projectName: string;
  filename: string;
  body: string;
  nav?: NavContext;
}): Html {
  const safeBody = raw(JSON.stringify(args.body));
  return layout({
    title: `${args.projectName} · ${args.filename}`,
    nav: args.nav,
    pageMaxWidth: '820px',
    body: html`
      <div class="page-head">
        <div class="crumbs">
          <a href="/">projects</a><span class="sep">/</span>
          <a href="/p/${args.projectName}">${args.projectName}</a><span class="sep">/</span>
          <span style="color: var(--fg-soft);">reports</span><span class="sep">/</span>
          <span class="here mono">${args.filename}</span>
        </div>
        <div style="display: flex; gap: var(--s-2);">
          <button class="btn sm" onclick="navigator.clipboard?.writeText(location.href)">
            <svg><use href="#i-copy"/></svg> copy link
          </button>
          <button class="btn sm" onclick="window.print()">print</button>
        </div>
      </div>
      <article id="report-md" class="md card" style="padding: var(--s-8); background: var(--bg-elev);"></article>
      <noscript><pre class="block">${args.body}</pre></noscript>
      <script type="module">${raw(`
        import { marked } from '/console/static/marked.esm.js';
        marked.setOptions({ breaks: true, gfm: true });
        const md = ${safeBody};
        document.getElementById('report-md').innerHTML = marked.parse(md);
      `)}</script>
      <style>
        @media print {
          .app-hdr, .page-head > div:last-child { display: none; }
          body { background: white; }
          #report-md { border: 0; box-shadow: none; padding: 0 !important; }
        }
      </style>
    `,
  });
}
