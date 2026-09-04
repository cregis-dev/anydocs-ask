import { html, raw } from 'hono/html';

export type ConsoleBootstrap = Record<string, unknown> & {
  kind: 'home' | 'project' | 'runs' | 'run-detail' | 'report';
};

export function renderReactApp(title: string, bootstrap: ConsoleBootstrap) {
  const payload = JSON.stringify(bootstrap)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex,nofollow" />
        <meta name="color-scheme" content="light" />
        <title>${title} · anydocs-ask console</title>
        <link rel="stylesheet" href="/console/static/console-app.css" />
      </head>
      <body>
        <div id="console-app-root"></div>
        <noscript>This console requires JavaScript.</noscript>
        <script>${raw(`window.__CONSOLE_APP__ = ${payload};`)}</script>
        <script type="module" src="/console/static/console-app.js"></script>
      </body>
    </html>`;
}
