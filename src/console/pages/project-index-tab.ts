/**
 * React-powered Index workspace mount.
 *
 * The rest of the Console stays server-rendered. Index is the first complex
 * workspace moved to React because it needs coordinated page, chunk, filter,
 * and detail state. Hono still owns auth, data access, and lifecycle routes.
 */

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';
import type { IndexSnapshot } from '../index-state.ts';

export type IndexTabViewModel = {
  projectName: string;
  snapshot: IndexSnapshot;
  childLive: boolean;
};

export function renderIndexTab(vm: IndexTabViewModel): Html {
  const payload = JSON.stringify({
    projectName: vm.projectName,
    childLive: vm.childLive,
    totalPages: vm.snapshot.totalPages,
    langs: vm.snapshot.langs,
    warnings: vm.snapshot.warnings,
    dbStatus: vm.snapshot.dbStatus,
  }).replaceAll('<', '\\u003c');

  return html`
    <link rel="stylesheet" href="/console/static/index-app.css" />
    <div id="index-explorer-root" class="index-explorer-mount">
      <div class="card"><div class="card-bd"><p class="empty" style="padding: 24px 0;">Loading index workspace…</p></div></div>
    </div>
    <script>${raw(`window.__INDEX_EXPLORER__ = ${payload};`)}</script>
    <script type="module" src="/console/static/index-app.js"></script>
  `;
}
