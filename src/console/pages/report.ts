/**
 * Report viewer — ARCH §17.3.1 GET /p/:name/reports/:file.
 * Markdown rendered in the browser via marked (loaded as static asset).
 * Server escapes the body for safe injection; client parses markdown.
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
    body: html`
      <div class="pagehead">
        <span class="crumb mono">
          <a href="/">projects</a> /
          <a href="/p/${args.projectName}">${args.projectName}</a> /
          reports
        </span>
        <h1 class="mono">${args.filename}</h1>
      </div>
      <div class="card">
        <div id="report-md" class="md"></div>
        <noscript>
          <pre class="mono">${args.body}</pre>
        </noscript>
      </div>
      <script type="module">${raw(`
        import { marked } from '/console/static/marked.esm.js';
        marked.setOptions({ breaks: true, gfm: true });
        const md = ${safeBody};
        document.getElementById('report-md').innerHTML = marked.parse(md);
      `)}</script>
    `,
  });
}
