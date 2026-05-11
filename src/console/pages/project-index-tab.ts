/**
 * Index tab content for /p/:name — ARCH §17.3.5.
 *
 * Three cards:
 *   1. DB index status (from child /v1/index/status) + reindex button
 *   2. Validation issues (loader warnings + missing files + orphans)
 *   3. Content explorer — per-lang navigation tree with pages flagged
 *
 * No DB queries; everything renders from disk (loadProject) + optional
 * child status response. Reindex action goes through the console reverse
 * proxy at POST /api/projects/:name/reindex.
 */

import { html } from 'hono/html';
import type { Html } from './layout.ts';
import type { IndexSnapshot, IndexLangSummary, IndexPageInfo } from '../index-state.ts';

export type IndexTabViewModel = {
  projectName: string;
  snapshot: IndexSnapshot;
  /** True when the child serve subprocess is running. Reindex requires it. */
  childLive: boolean;
};

export function renderIndexTab(vm: IndexTabViewModel): Html {
  const { snapshot, childLive } = vm;
  return html`
    <div class="index-tab">
      ${statusCard(snapshot, childLive)}
      ${snapshot.warnings.length > 0 ? warningsCard(snapshot.warnings) : ''}
      ${snapshot.totalPages === 0 ? firstTimeHint(snapshot.projectRoot) : explorerCard(snapshot)}
    </div>
    <style>
      .index-tab .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
      .index-tab .stat { padding: 10px 12px; background: var(--bg-soft); border-radius: 6px; }
      .index-tab .stat .v { font-size: 18px; font-weight: 600; font-family: ui-monospace, monospace; }
      .index-tab .stat .k { font-size: 11px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: .04em; }
      .index-tab .warnings { background: var(--warn-bg); border-left: 3px solid var(--warn); padding: 10px 14px; }
      .index-tab .warnings ul { margin: 4px 0 0; padding-left: 20px; }
      .index-tab .warnings li { font-size: 12.5px; color: var(--warn); }
      .nav-tree { font-size: 13px; line-height: 1.7; }
      .nav-tree .section { font-weight: 600; color: var(--fg-soft); margin-top: 6px; }
      .nav-tree .page { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; padding: 3px 0 3px 18px; border-bottom: 1px solid var(--bd-soft); }
      .nav-tree .page:last-child { border-bottom: 0; }
      .nav-tree .page .title { font-family: ui-monospace, monospace; font-size: 12.5px; }
      .nav-tree .page .meta { font-size: 11px; color: var(--fg-mute); }
      .nav-tree .page.missing .title { color: var(--err); }
      .lang-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--bd); margin: 0 -18px 14px; padding: 0 18px; }
      .lang-tabs button { border: 0; background: transparent; box-shadow: none; padding: 6px 12px; margin-bottom: -1px; color: var(--fg-mute); font-size: 13px; border-bottom: 2px solid transparent; border-radius: 0; }
      .lang-tabs button[aria-selected=true] { color: var(--accent); border-bottom-color: var(--accent); }
      .lang-panel[hidden] { display: none; }
    </style>
  `;
}

function statusCard(snap: IndexSnapshot, childLive: boolean): Html {
  const db = snap.dbStatus;
  // Indexer hard-filter is `status === 'published'`; orphans (nav-missing)
  // still get indexed per PRD §4.5. So `expected in DB` = published count.
  let unpublishedCount = 0;
  let orphanCount = 0;
  for (const l of snap.langs) {
    for (const p of l.pages) {
      if (!p.missingFile && p.status !== 'published') unpublishedCount++;
    }
    for (const p of l.orphans) {
      orphanCount++;
      if (p.status !== 'published') unpublishedCount++;
    }
  }
  const expectedInDb = snap.totalPages - unpublishedCount;
  const drift = db ? db.page_count - expectedInDb : 0;
  return html`
    <div class="card">
      <div class="card-head" style="padding: 0 0 10px; border-bottom: 1px solid var(--bd-soft); margin: -2px 0 12px; display:flex; justify-content:space-between; align-items:baseline;">
        <h2 style="margin: 0;">index</h2>
        <span class="muted mono" style="font-size: 11.5px;">${snap.projectRoot}</span>
      </div>
      <div class="status-grid">
        <div class="stat">
          <div class="k">on disk</div>
          <div class="v">${snap.totalPages}</div>
          <div class="muted" style="font-size: 11px;">
            ${unpublishedCount > 0 || orphanCount > 0
              ? html`
                  ${unpublishedCount > 0
                    ? html`<span style="color: var(--warn);">${unpublishedCount} draft</span>`
                    : ''}
                  ${orphanCount > 0
                    ? html`${unpublishedCount > 0 ? ' · ' : ''}<span style="color: var(--fg-soft);">${orphanCount} orphan</span>`
                    : ''}
                  · ${expectedInDb} expected indexed
                `
              : 'pages'}
          </div>
        </div>
        <div class="stat">
          <div class="k">in DB</div>
          <div class="v">${db ? db.page_count : '—'}</div>
          <div class="muted" style="font-size: 11px;">
            ${!db
              ? 'child idle'
              : drift === 0
                ? html`<span style="color: var(--ok);">✓ in sync</span>`
                : html`<span style="color: var(--warn);">Δ ${drift > 0 ? '+' : ''}${drift}</span>`}
          </div>
        </div>
        <div class="stat">
          <div class="k">chunks</div>
          <div class="v">${db ? db.chunk_count : '—'}</div>
          <div class="muted" style="font-size: 11px;">${db ? `${snap.totalPages > 0 ? Math.round(db.chunk_count / snap.totalPages) : 0}/page avg` : ''}</div>
        </div>
        <div class="stat">
          <div class="k">embed cache</div>
          <div class="v">${db ? db.embedding_cache_size : '—'}</div>
          <div class="muted" style="font-size: 11px;">vectors</div>
        </div>
        <div class="stat">
          <div class="k">last indexed</div>
          <div class="v" style="font-size: 14px;">${db?.last_indexed_at ? formatTs(db.last_indexed_at) : '—'}</div>
          <div class="muted" style="font-size: 11px;">${db?.embedding_model ?? ''}</div>
        </div>
      </div>
      <div class="btn-row" style="margin-top: 12px; align-items: center;">
        <button id="btn-reindex" class="btn-primary" ${childLive ? '' : 'disabled'}>
          ⟳ reindex
        </button>
        <span id="reindex-status" class="status muted"></span>
        ${childLive ? '' : html`<span class="muted" style="font-size: 12px;">child idle — start project first</span>`}
      </div>
    </div>
  `;
}

function warningsCard(warnings: string[]): Html {
  return html`
    <div class="card warnings">
      <strong style="font-size: 13px;">⚠ validation (${warnings.length})</strong>
      <ul>
        ${warnings.map((w) => html`<li>${w}</li>`)}
      </ul>
    </div>
  `;
}

function firstTimeHint(projectRoot: string): Html {
  return html`
    <div class="card">
      <h2 style="margin: 0 0 8px;">first-time setup</h2>
      <p>该项目还没有 page 文件。放入 anydocs 格式的页面：</p>
      <pre class="mono" style="background: var(--bg-soft); padding: 10px; font-size: 12px;">${projectRoot}/
  navigation/
    zh.json          # 导航树（每个 lang 一份）
  pages/
    zh/
      &lt;page-id&gt;.json # 页面内容</pre>
      <p class="muted" style="font-size: 12px;">
        参考 <code>@anydocs/core</code> 的页 schema；或用 symlink 接入既有仓库。<br />
        放好后点 <strong>⟳ reindex</strong>。
      </p>
    </div>
  `;
}

function explorerCard(snap: IndexSnapshot): Html {
  const langs = snap.langs;
  if (langs.length === 0) return html``;
  return html`
    <div class="card">
      <h2 style="margin: 0 0 10px;">content explorer</h2>
      <div class="lang-tabs" role="tablist">
        ${langs.map(
          (l, i) => html`
            <button role="tab" data-lang="${l.lang}" aria-selected="${i === 0 ? 'true' : 'false'}">
              ${l.lang} <span class="muted" style="font-size: 11px;">${l.pages.length + l.orphans.length}</span>
            </button>
          `,
        )}
      </div>
      ${langs.map(
        (l, i) => html`
          <div class="lang-panel" data-lang="${l.lang}" ${i === 0 ? '' : 'hidden'}>
            ${navTree(l)}
          </div>
        `,
      )}
      <script>${html`(function(){
        var tabs = document.querySelectorAll('.lang-tabs [role=tab]');
        tabs.forEach(function(b){
          b.addEventListener('click', function(){
            var lang = b.dataset.lang;
            tabs.forEach(function(t){ t.setAttribute('aria-selected', t.dataset.lang === lang ? 'true' : 'false'); });
            document.querySelectorAll('.lang-panel').forEach(function(p){ p.hidden = p.dataset.lang !== lang; });
          });
        });
      })();`}</script>
    </div>
  `;
}

function navTree(l: IndexLangSummary): Html {
  return html`
    <div class="nav-tree">
      ${l.pages.length === 0
        ? html`<p class="muted" style="font-size: 12px;">no pages referenced in navigation/${l.lang}.json</p>`
        : groupByBreadcrumb(l.pages)}
      ${l.orphans.length > 0
        ? html`
            <div class="section" style="color: var(--err); margin-top: 14px;">
              orphans (in pages/ but not navigation/) · ${l.orphans.length}
            </div>
            ${l.orphans.map((p) => pageRow(p, true))}
          `
        : ''}
    </div>
  `;
}

function groupByBreadcrumb(pages: IndexPageInfo[]): Html {
  // Group consecutive pages sharing a breadcrumb trail.
  const blocks: Array<{ trail: string[]; pages: IndexPageInfo[] }> = [];
  for (const p of pages) {
    const last = blocks[blocks.length - 1];
    if (last && arrEq(last.trail, p.breadcrumb)) {
      last.pages.push(p);
    } else {
      blocks.push({ trail: p.breadcrumb, pages: [p] });
    }
  }
  return html`
    ${blocks.map(
      (b) => html`
        ${b.trail.length > 0
          ? html`<div class="section">${b.trail.join(' › ')}</div>`
          : html`<div class="section">(root)</div>`}
        ${b.pages.map((p) => pageRow(p, false))}
      `,
    )}
  `;
}

function pageRow(p: IndexPageInfo, isOrphan: boolean): Html {
  return html`
    <div class="page ${p.missingFile ? 'missing' : ''}">
      <span class="title">${p.title}</span>
      <span class="meta">${p.id}${p.slug ? ` · /${p.slug}` : ''}</span>
      <span class="meta">${p.missingFile ? '⚠ missing file' : isOrphan ? 'orphan' : p.status}</span>
    </div>
  `;
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time}`;
}
