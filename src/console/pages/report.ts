/**
 * Render a single report file as raw markdown inside <pre>. v1 keeps the
 * dependency surface zero — a real markdown renderer is a v1.5+ polish.
 */

import { html } from 'hono/html';
import { layout, type Html } from './layout.ts';

export function renderReport(args: {
  projectName: string;
  filename: string;
  body: string;
}): Html {
  return layout({
    title: `${args.projectName} · ${args.filename}`,
    body: html`
      <p class="mono"><a href="/p/${args.projectName}">← ${args.projectName}</a></p>
      <h1>${args.filename}</h1>
      <pre class="mono" style="background: #f5f5f522; padding: 14px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; line-height: 1.5;">${args.body}</pre>
    `,
  });
}
