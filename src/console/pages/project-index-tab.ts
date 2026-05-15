/**
 * Index tab — ARCH §17.3.5.
 *
 * Three cards from the redesign:
 *   1. Index KPI strip (on disk · in DB · chunks · embed cache · last indexed)
 *      with reindex action, plus drift warning when on-disk ≠ DB.
 *   2. Pending-changes table when drift exists (shown via warnings list).
 *   3. Content explorer — per-lang inner tabs over a tree of pages.
 *
 * No DB queries here — view-model already contains the on-disk + optional
 * child status snapshot.
 */

import { html, raw } from 'hono/html';
import type { Html } from './layout.ts';
import type { IndexSnapshot, IndexLangSummary, IndexPageInfo } from '../index-state.ts';

export type IndexTabViewModel = {
  projectName: string;
  snapshot: IndexSnapshot;
  childLive: boolean;
};

export function renderIndexTab(vm: IndexTabViewModel): Html {
  const { snapshot, childLive } = vm;
  const drift = computeDrift(snapshot);
  return html`
    <div class="index-tab">
      ${drift.kind === 'drift' ? driftBanner(drift) : ''}
      ${kpiCard(snapshot, childLive, drift)}
      ${snapshot.totalPages === 0
        ? emptyCard(snapshot.projectRoot)
        : explorerCard(snapshot)}
      ${snapshot.warnings.length > 0 ? warningsCard(snapshot.warnings) : ''}
    </div>
    ${langSwitchScript()}
  `;
}

type Drift =
  | { kind: 'in-sync' }
  | { kind: 'no-db' }
  | { kind: 'drift'; expected: number; actual: number; delta: number };

function computeDrift(snap: IndexSnapshot): Drift {
  const db = snap.dbStatus;
  if (!db) return { kind: 'no-db' };
  let unpublished = 0;
  for (const l of snap.langs) {
    for (const p of l.pages) {
      if (!p.missingFile && p.status !== 'published') unpublished++;
    }
    for (const p of l.orphans) {
      if (p.status !== 'published') unpublished++;
    }
  }
  const expected = snap.totalPages - unpublished;
  const actual = db.page_count;
  if (Math.abs(actual - expected) < 1) return { kind: 'in-sync' };
  return { kind: 'drift', expected, actual, delta: actual - expected };
}

function driftBanner(d: Extract<Drift, { kind: 'drift' }>): Html {
  const direction = d.delta < 0 ? 'fewer in DB' : 'more in DB';
  return html`
    <div class="banner warn">
      <span class="b-ico"><svg><use href="#i-alert"/></svg></span>
      <div class="b-bd">
        <div class="b-ti">Index is out of sync with disk</div>
        <div class="b-de">${d.expected} expected, ${d.actual} in DB (${direction}, Δ ${d.delta > 0 ? '+' : ''}${d.delta}).
          Pages won't appear in answers until reindex.</div>
      </div>
      <div class="b-act">
        <button id="btn-reindex-banner" class="btn primary sm" onclick="document.getElementById('btn-reindex')?.click()">
          <svg><use href="#i-act"/></svg> reindex now
        </button>
      </div>
    </div>
  `;
}

function kpiCard(snap: IndexSnapshot, childLive: boolean, drift: Drift): Html {
  const db = snap.dbStatus;
  const isDrift = drift.kind === 'drift';
  const chunksAvg = db && snap.totalPages > 0 ? (db.chunk_count / snap.totalPages).toFixed(1) : '—';
  return html`
    <section class="card primary">
      <div class="card-hd">
        <h2><svg style="width: 14px; height: 14px;"><use href="#i-folder"/></svg> Index</h2>
        <div class="actions">
          <button id="btn-reindex" class="btn ${isDrift ? 'primary' : ''}" ${childLive ? '' : 'disabled'}>
            <svg><use href="#i-act"/></svg> reindex
          </button>
          <span id="reindex-status" class="status"></span>
        </div>
      </div>
      <div class="card-bd">
        ${childLive ? '' : html`<p class="muted" style="font-size: 12px; margin-bottom: var(--s-3);">child idle — start the project to reindex.</p>`}
        <div class="kpis">
          <div class="kpi">
            <div class="k-lab">on disk</div>
            <div class="k-val">${snap.totalPages}<span class="unit">pages</span></div>
            <div class="k-foot">${snap.langs.length} lang${snap.langs.length !== 1 ? 's' : ''}</div>
          </div>
          <div class="kpi${isDrift ? ' warn' : ''}">
            <div class="k-lab">in DB</div>
            <div class="k-val">${db ? db.page_count : '—'}<span class="unit">pages</span></div>
            <div class="k-foot">${!db
              ? 'child idle'
              : drift.kind === 'in-sync'
                ? 'matches disk'
                : drift.kind === 'drift'
                  ? html`<span style="color: var(--warn);">Δ ${drift.delta > 0 ? '+' : ''}${drift.delta}</span>`
                  : ''}</div>
          </div>
          <div class="kpi">
            <div class="k-lab">chunks</div>
            <div class="k-val">${db ? db.chunk_count : '—'}</div>
            <div class="k-foot">avg ${chunksAvg} / page</div>
          </div>
          <div class="kpi">
            <div class="k-lab">embed cache</div>
            <div class="k-val">${db ? db.embedding_cache_size : '—'}<span class="unit">vectors</span></div>
            <div class="k-foot">${db?.embedding_model ?? ''}</div>
          </div>
          <div class="kpi">
            <div class="k-lab">last indexed</div>
            <div class="k-val" style="font-size: var(--t-15);">${db?.last_indexed_at ? formatTs(db.last_indexed_at) : '—'}</div>
            <div class="k-foot">${db?.llm_model ?? ''}</div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function emptyCard(projectRoot: string): Html {
  return html`
    <section class="card">
      <div class="card-bd">
        <div class="empty">
          <div class="e-ico"><svg><use href="#i-folder"/></svg></div>
          <h3>No pages found on disk</h3>
          <p>Drop JSON page records into <code class="inline">${projectRoot}/pages/&lt;lang&gt;/</code>
            and click reindex. The console will pick them up automatically.</p>
        </div>
        <details style="margin-top: var(--s-2);">
          <summary style="font-size: var(--t-13); color: var(--fg-soft); cursor: pointer;">expected folder shape</summary>
          <pre class="block" style="margin-top: var(--s-2);">&lt;project&gt;/
├── <span class="kw">pages/</span>
│   ├── en/
│   │   ├── introducing-feature.json
│   │   └── install-macos.json
│   └── zh/
└── <span class="kw">navigation/</span>
    ├── en.json
    └── zh.json</pre>
        </details>
      </div>
    </section>
  `;
}

function warningsCard(warnings: string[]): Html {
  return html`
    <section class="card">
      <div class="card-hd"><h2>Validation</h2><span class="meta">${warnings.length}</span></div>
      <div class="card-bd">
        <ul style="margin: 0; padding-left: 20px;">
          ${warnings.map((w) => html`<li style="font-size: var(--t-13); color: var(--warn); margin: 4px 0;">${w}</li>`)}
        </ul>
      </div>
    </section>
  `;
}

function explorerCard(snap: IndexSnapshot): Html {
  const langs = snap.langs;
  if (langs.length === 0) return html``;
  return html`
    <section class="card">
      <div class="card-hd">
        <h2>Content explorer</h2>
        <div class="actions">
          <div style="position: relative;">
            <svg style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: 13px; height: 13px; color: var(--fg-mute);"><use href="#i-search"/></svg>
            <input id="idx-filter" class="input" placeholder="filter pages…" style="padding-left: 28px; height: 30px; width: 240px; font-size: var(--t-13);" autocomplete="off" />
          </div>
          <nav class="tabs inner lang-tabs" style="margin: 0; border: 0; padding: 0;">
            ${langs.map(
              (l, i) => html`
                <button class="tab ${i === 0 ? 'active' : ''}" role="tab" data-lang="${l.lang}" aria-selected="${i === 0 ? 'true' : 'false'}" style="padding: 6px 10px; font-size: var(--t-12);">
                  ${l.lang} <span class="cnt">${l.pages.length + l.orphans.length}</span>
                </button>
              `,
            )}
          </nav>
        </div>
      </div>
      <div class="card-bd" style="padding: var(--s-3);">
        ${langs.map(
          (l, i) => html`
            <div class="lang-panel" data-lang="${l.lang}" ${i === 0 ? '' : 'hidden'}>
              ${navTree(l)}
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function navTree(l: IndexLangSummary): Html {
  return html`
    <div class="tree">
      ${l.pages.length === 0
        ? html`<p class="muted" style="font-size: var(--t-12); padding: var(--s-2);">no pages referenced in navigation/${l.lang}.json</p>`
        : groupByBreadcrumb(l.pages)}
      ${l.orphans.length > 0
        ? html`
            <div class="tree-sec">
              <div class="tree-sec-hd" style="color: var(--err);">
                <svg style="width: 12px; height: 12px;"><use href="#i-chev-d"/></svg>
                orphans (pages/ ∖ navigation/) <span style="color: var(--fg-mute); font-weight: 400;">· ${l.orphans.length}</span>
              </div>
              ${l.orphans.map((p) => pageRow(p, true))}
            </div>
          `
        : ''}
    </div>
  `;
}

function groupByBreadcrumb(pages: IndexPageInfo[]): Html {
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
        <div class="tree-sec">
          <div class="tree-sec-hd">
            <svg style="width: 12px; height: 12px;"><use href="#i-chev-d"/></svg>
            ${b.trail.length > 0 ? b.trail.join(' › ') : '(root)'}
            <span style="color: var(--fg-mute); font-weight: 400;">· ${b.pages.length}</span>
          </div>
          ${b.pages.map((p) => pageRow(p, false))}
        </div>
      `,
    )}
  `;
}

function pageRow(p: IndexPageInfo, isOrphan: boolean): Html {
  const cls = p.missingFile ? 'err' : p.status === 'published' ? 'ok' : '';
  const tagText = p.missingFile ? 'missing file' : isOrphan ? 'orphan' : p.status;
  return html`
    <div class="tree-row" data-search="${(p.title + ' ' + p.id).toLowerCase()}">
      <span class="t-ti">
        <svg style="width: 12px; height: 12px; color: var(--fg-mute);"><use href="#i-doc"/></svg>
        <span>${p.title}</span>
      </span>
      <span class="t-slug">${p.slug ?? p.id}</span>
      <span class="tag ${cls}">${tagText}</span>
    </div>
  `;
}

function langSwitchScript(): Html {
  return html`<script>${raw(`
    (function(){
      var tabs = document.querySelectorAll('.lang-tabs [role=tab]');
      tabs.forEach(function(b){
        b.addEventListener('click', function(){
          var lang = b.dataset.lang;
          tabs.forEach(function(t){
            t.setAttribute('aria-selected', t.dataset.lang === lang ? 'true' : 'false');
            if (t.dataset.lang === lang) t.classList.add('active'); else t.classList.remove('active');
          });
          document.querySelectorAll('.lang-panel').forEach(function(p){
            p.hidden = p.dataset.lang !== lang;
          });
        });
      });
      var filter = document.getElementById('idx-filter');
      if (filter) {
        filter.addEventListener('input', function(){
          var q = filter.value.trim().toLowerCase();
          document.querySelectorAll('.tree-row').forEach(function(r){
            if (!q) { r.style.display = ''; return; }
            r.style.display = (r.dataset.search || '').includes(q) ? '' : 'none';
          });
        });
      }
    })();
  `)}</script>`;
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
