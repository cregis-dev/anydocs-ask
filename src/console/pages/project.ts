/**
 * Per-project page — ARCH §17.3.1 GET /p/:name.
 *
 * Layout (redesign):
 *   proj-grid:
 *     side-stack    Status card (status pill + path + indexed + process row +
 *                                start/stop buttons + open-reader / view-log
 *                                actions) · Reports card
 *     main-stack    top tabs (Ask/Index/Eval/Traffic) · next-action banner ·
 *                   tab panel
 *
 * The page-head breadcrumb is gone — the design collapses it; project name
 * is conveyed by the header's project switcher, and lifecycle/status moved
 * into the Status card. Status pill + dot + text reflect idle / warming /
 * ready / asking / error states and are updated by the
 * bootstrap script via /api/projects/:name/health polling.
 */

import { html, raw } from 'hono/html';
import type { ProjectListing } from '../../workspace.ts';
import type { RegisteredProcess } from '../registry.ts';
import type { ReportListing } from '../ops.ts';
import { layout, type Html, type NavContext } from './layout.ts';
import { renderEvalTab } from './project-eval-tab.ts';
import { renderIndexTab } from './project-index-tab.ts';
import { renderTrafficTab } from './project-traffic-tab.ts';
import type { EvalTabSnapshot } from '../eval-state.ts';
import type { IndexSnapshot } from '../index-state.ts';
import type { TrafficWindow } from '../traffic-state.ts';
import type { CandidateSnapshot } from '../golden-workshop-state.ts';
import type { AnalyzeReportSummary } from '../eval-state.ts';
import { computeNextAction, type NextAction } from '../next-action.ts';
import type { AskConfigView } from '../ask-config-state.ts';
import type { ResolvedConfig } from '../../config.ts';

export type ProjectViewModel = {
  project: ProjectListing;
  running: RegisteredProcess | null;
  reports: ReportListing[];
  autostart?: boolean;
  nav?: NavContext;
  evalSnapshot?: EvalTabSnapshot;
  latestEvalReportBody?: string | null;
  indexSnapshot?: IndexSnapshot;
  trafficWindow?: TrafficWindow;
  candidates?: CandidateSnapshot;
  analyzeHistory?: AnalyzeReportSummary[];
  latestAnalyzeBody?: string | null;
  askConfig?: AskConfigView;
};

export function renderProject(vm: ProjectViewModel): Html {
  const { project, running } = vm;
  const live = running !== null && !running.exited;
  const autostartFlag = vm.autostart ? 'true' : 'false';

  const nextAction = computeNextAction({
    indexSnapshot: vm.indexSnapshot,
    evalSnapshot: vm.evalSnapshot,
    trafficWindow: vm.trafficWindow,
    childLive: live,
    projectValid: project.valid,
  });

  const body = html`
    ${project.valid
      ? html`
        <div class="proj-grid">
          ${sidebar(project, live, running, vm.reports, vm.indexSnapshot)}
          <div class="main-stack">
            ${renderTabs()}
            ${nextAction ? nextActionBanner(nextAction) : ''}
            ${tabPanels(project, live, vm)}
          </div>
        </div>
      `
      : invalidNotice(project)}

    <script>${raw(`
      window.__CONSOLE__ = { name: ${JSON.stringify(project.name)}, valid: ${project.valid}, live: ${live}, autostart: ${autostartFlag} };
    `)}</script>
    <script type="module">${raw(BOOTSTRAP_SCRIPT)}</script>
  `;

  return layout({
    title: project.name,
    body,
    nav: vm.nav,
  });
}

function statusPill(
  live: boolean,
  running: RegisteredProcess | null,
  valid: boolean,
): Html {
  if (!valid) {
    return html`<span class="pill err" id="status-pill"><span class="dot" id="status-dot"></span><span id="status-text">invalid</span></span>`;
  }
  if (live && running) {
    return html`<span class="pill run" id="status-pill"><span class="dot" id="status-dot"></span><span id="status-text">running · :${running.port} · pid ${running.pid}</span></span>`;
  }
  return html`<span class="pill" id="status-pill"><span class="dot" id="status-dot"></span><span id="status-text">idle</span></span>`;
}

function nextActionBanner(na: NextAction): Html {
  const cls = na.level === 'err' ? 'banner err' : na.level === 'warn' ? 'banner warn' : 'banner info';
  const icon = na.level === 'err' ? 'i-err' : na.level === 'warn' ? 'i-alert' : 'i-info';
  return html`
    <div class="${cls}">
      <span class="b-ico"><svg><use href="#${icon}"/></svg></span>
      <div class="b-bd">
        <div class="b-ti">${na.title}</div>
        ${na.detail ? html`<div class="b-de">${na.detail}</div>` : ''}
      </div>
      <div class="b-act">
        <a href="#${na.cta.targetTab}" class="btn sm primary">${na.cta.label} →</a>
      </div>
    </div>
  `;
}

function invalidNotice(project: ProjectListing): Html {
  return html`
    <div class="banner err">
      <span class="b-ico"><svg><use href="#i-err"/></svg></span>
      <div class="b-bd">
        <div class="b-ti">This folder doesn't look like a docs project</div>
        <div class="b-de">missing: ${project.missing.join(', ')} · expected <code class="inline">pages/&lt;lang&gt;/*.json</code> and <code class="inline">navigation/&lt;lang&gt;.json</code>.</div>
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><h2>diagnostic</h2><span class="meta">${project.path}</span></div>
      <div class="card-bd">
        <dl class="kv">
          <dt>path</dt><dd class="mono">${project.path}</dd>
          <dt>projectId</dt><dd class="mono">${project.projectId ?? '—'}</dd>
          <dt>indexed</dt><dd>${project.indexed ? html`<span class="yes">yes</span>` : html`<span class="no">no</span>`}</dd>
          <dt>missing</dt><dd class="mono">${project.missing.join(', ')}</dd>
        </dl>
      </div>
    </div>
    <p class="muted" style="margin-top: var(--s-4); font-size: var(--t-13);">
      Fix the folder shape (add <code class="inline">pages/</code> and <code class="inline">navigation/</code>) and refresh,
      or remove from the workspace with <code class="inline">anydocs-ask workspace rm ${project.name}</code>.
    </p>
  `;
}

function sidebar(
  project: ProjectListing,
  live: boolean,
  running: RegisteredProcess | null,
  reports: ReportListing[],
  indexSnapshot: IndexSnapshot | undefined,
): Html {
  return html`
    <aside class="side-stack">
      ${statusCard(project, live, running, indexSnapshot)}
      ${reportsCard(project.name, reports)}
    </aside>
  `;
}

function statusCard(
  project: ProjectListing,
  live: boolean,
  running: RegisteredProcess | null,
  indexSnapshot: IndexSnapshot | undefined,
): Html {
  // The redesign collapses the breadcrumb row entirely — Status pill,
  // start/stop buttons, and the open-reader/view-log actions all moved
  // into this card. Button IDs (#btn-start / #btn-stop) stay the same so
  // the BOOTSTRAP_SCRIPT click handlers and the existing tests still hook
  // through. The "process" row keeps the <span class="tag">stopped</span>
  // markup that tests pin.
  const pages = indexSnapshot?.totalPages ?? null;
  const chunks = indexSnapshot?.dbStatus?.chunk_count ?? null;
  const indexedExtra =
    pages !== null && pages > 0
      ? html`<span style="color: var(--fg-mute); font-family: var(--font-mono); font-size: 11px; margin-left: 4px;">·
          ${pages} pages${chunks !== null ? html` · ${chunks} chunks` : ''}</span>`
      : '';
  return html`
    <section class="card">
      <div class="card-hd">
        <h2>Status</h2>
        ${statusPill(live, running, project.valid)}
      </div>
      <div class="card-bd">
        <dl class="kv">
          <dt>path</dt>
          <dd><code class="inline" title="${project.path}">${shortPath(project.path)}</code></dd>
          <dt>indexed</dt>
          <dd>${project.indexed
            ? html`<span class="yes">yes</span>${indexedExtra}`
            : html`<span class="no">no</span>`}</dd>
          <dt>process</dt>
          <dd>
            ${live && running
              ? html`<span class="tag run">:${running.port}</span>
                  <span class="mono" style="color: var(--fg-mute); font-size: 11px;">pid ${running.pid}</span>`
              : html`<span class="tag">stopped</span>`}
          </dd>
        </dl>

        <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3);">
          <button id="btn-start" class="btn primary" ${live ? 'disabled' : ''} style="flex: 1;">
            <svg><use href="#i-play"/></svg> start
          </button>
          <button id="btn-stop" class="btn" ${live ? '' : 'disabled'} style="flex: 1;">
            <svg><use href="#i-stop"/></svg> stop
          </button>
        </div>

        <!-- The design's open-reader / view-log .status-acts row was here.
             Both lack a real backend in this codebase (anydocs-ask serve only
             mounts /v1/* — no reader UI on /; and the console doesn't expose
             a tail-child-stdout endpoint), so showing non-working affordances
             would mislead. Add the row back when the features land. The icon
             (i-ext) + .status-acts CSS stay in layout.ts for that future. -->
      </div>
    </section>
  `;
}

function reportsCard(name: string, reports: ReportListing[]): Html {
  if (reports.length === 0) return html``;
  // Group by kind (eval / analyze / golden) with a small subheader,
  // matching the design's stacked list in the sidebar.
  const grouped: Record<string, ReportListing[]> = {};
  for (const r of reports) {
    (grouped[r.kind] ?? (grouped[r.kind] = [])).push(r);
  }
  const order = ['eval', 'analyze', 'golden', 'baseline'] as const;
  return html`
    <section class="card">
      <div class="card-hd"><h2>Reports</h2><span class="meta">${reports.length}</span></div>
      <div class="card-bd flush" style="padding: 6px 0 var(--s-3);">
        ${order.map((kind, i) => {
          const list = (grouped[kind] ?? []).slice(0, 6);
          if (list.length === 0) return html``;
          const sep = i === 0 ? '' : 'margin-top: 4px; border-top: 1px solid var(--bd-soft); padding-top: 10px;';
          return html`
            <div style="padding: 6px var(--s-5); font-size: 11px; color: var(--fg-soft); letter-spacing: .04em; text-transform: uppercase; ${raw(sep)}">${kind}</div>
            ${list.map(
              (r) => html`<a href="/p/${name}/reports/${r.filename}" style="display: flex; justify-content: space-between; padding: 6px var(--s-5); color: var(--fg);">
                <span class="mono" style="font-size: var(--t-12);">${r.date}</span>
                <span style="color: var(--fg-soft); font-size: var(--t-12);">${kind}</span>
              </a>`,
            )}
          `;
        })}
      </div>
    </section>
  `;
}

function renderTabs(): Html {
  // Top tabs are anchor links that switch the visible panel and update
  // location.hash. Initial render marks #ask selected; the bootstrap
  // script reconciles on hashchange / page load.
  return html`
    <nav class="tabs" role="tablist" id="project-tabs">
      <a class="tab" role="tab" data-project-tab="ask" href="#ask" aria-selected="true">
        <svg style="width:14px;height:14px;opacity:.7;"><use href="#i-chat"/></svg> Ask
      </a>
      <a class="tab" role="tab" data-project-tab="index" href="#index" aria-selected="false">
        <svg style="width:14px;height:14px;opacity:.7;"><use href="#i-folder"/></svg> Index
      </a>
      <a class="tab" role="tab" data-project-tab="eval" href="#eval" aria-selected="false">
        <svg style="width:14px;height:14px;opacity:.7;"><use href="#i-check"/></svg> Eval
      </a>
      <a class="tab" role="tab" data-project-tab="traffic" href="#traffic" aria-selected="false">
        <svg style="width:14px;height:14px;opacity:.7;"><use href="#i-chart"/></svg> Traffic
      </a>
      <a class="tab" role="tab" data-project-tab="settings" href="#settings" aria-selected="false">
        <svg style="width:14px;height:14px;opacity:.7;"><use href="#i-gear"/></svg> Settings
      </a>
    </nav>
  `;
}

function tabPanels(
  project: ProjectListing,
  live: boolean,
  vm: ProjectViewModel,
): Html {
  return html`
    <div id="ptab-ask" class="tab-panel" data-project-tab="ask">
      ${askCard(live)}
    </div>
    <div id="ptab-index" class="tab-panel" data-project-tab="index" hidden>
      ${vm.indexSnapshot
        ? renderIndexTab({ projectName: project.name, snapshot: vm.indexSnapshot, childLive: live })
        : html`<div class="card"><div class="card-bd"><p class="empty" style="padding: 24px 0;">Index status unavailable.</p></div></div>`}
    </div>
    <div id="ptab-eval" class="tab-panel" data-project-tab="eval" hidden>
      ${vm.evalSnapshot
        ? renderEvalTab({
            projectName: project.name,
            snapshot: vm.evalSnapshot,
            latestReportBody: vm.latestEvalReportBody ?? null,
            candidates: vm.candidates ?? { total: 0, pending: [], approved: 0, rejected: 0, malformed: 0 },
          })
        : html`<div class="card"><div class="card-bd"><p class="empty" style="padding: 24px 0;">Eval status unavailable.</p></div></div>`}
    </div>
    <div id="ptab-traffic" class="tab-panel" data-project-tab="traffic" hidden>
      ${vm.trafficWindow
        ? renderTrafficTab({
            projectName: project.name,
            window: vm.trafficWindow,
            analyzeHistory: vm.analyzeHistory ?? [],
            latestAnalyzeBody: vm.latestAnalyzeBody ?? null,
          })
        : html`<div class="card"><div class="card-bd"><p class="empty" style="padding: 24px 0;">Traffic status unavailable.</p></div></div>`}
    </div>
    <div id="ptab-settings" class="tab-panel" data-project-tab="settings" hidden>
      ${vm.askConfig
        ? renderSettingsTab(vm.askConfig)
        : html`<div class="card"><div class="card-bd"><p class="empty" style="padding: 24px 0;">Settings unavailable (invalid project).</p></div></div>`}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Settings tab — structured form over the full anydocs.ask.json schema.
// Every section in ResolvedConfig (prompt / llm / embedding / retrieval /
// clarify / indexing / runs / analyze / feedback / server) gets a group of
// fields; the bootstrap script reads `data-cfg-path` + `data-cfg-type` on
// each control to reconstruct the JSON object on submit. Save POSTs the
// full file to /api/projects/:name/ask-config — server re-validates.
// ---------------------------------------------------------------------------

function renderSettingsTab(view: AskConfigView): Html {
  const c = view.config;
  const mtimeAttr = view.mtimeISO ?? '';
  const mtimeText = view.mtimeISO ? `mtime ${view.mtimeISO.slice(0, 16).replace('T', ' ')}` : 'new file';
  const exists = view.exists;

  return html`
    <section class="card">
      <div class="card-hd">
        <h2><svg style="width: 14px; height: 14px;"><use href="#i-gear"/></svg> Settings</h2>
        <span class="meta">${view.path} · ${exists ? mtimeText : 'new file'}</span>
      </div>
      <form id="settings-form" class="card-bd" data-mtime="${mtimeAttr}">
        ${view.parseError
          ? html`
            <div class="banner err" style="margin: 0 0 var(--s-4);">
              <span class="b-ico"><svg><use href="#i-err"/></svg></span>
              <div class="b-bd">
                <div class="b-ti">Config file failed to parse</div>
                <div class="b-de">${view.parseError}. Saving will overwrite the file with the form values below (which start from defaults).</div>
              </div>
            </div>`
          : ''}
        <div id="settings-warnings" class="banner warn" ${view.warnings.length === 0 ? 'hidden' : ''} style="margin: 0 0 var(--s-4);">
          ${view.warnings.length > 0
            ? html`
              <span class="b-ico"><svg><use href="#i-alert"/></svg></span>
              <div class="b-bd">
                <div class="b-ti">${view.warnings.length} validation warning${view.warnings.length > 1 ? 's' : ''}</div>
                <ul style="margin: var(--s-1) 0 0; padding-left: var(--s-5);">
                  ${view.warnings.map((w) => html`<li style="font-size: var(--t-12);">${w}</li>`)}
                </ul>
              </div>`
            : ''}
        </div>

        <p class="muted" style="font-size: var(--t-13); margin: 0 0 var(--s-4);">
          Project-scoped configuration written to <code class="inline">anydocs.ask.json</code>. Restart the project after saving for runtime changes (LLM / embedding / retrieval) to take effect.
        </p>

        ${promptSection(c)}
        ${llmSection(c)}
        ${embeddingSection(c)}
        ${retrievalSection(c)}
        ${clarifySection(c)}
        ${feedbackSection(c)}
        ${indexingSection(c)}
        ${runsSection(c)}
        ${analyzeSection(c)}
        ${serverSection(c)}

        <div style="position: sticky; bottom: 0; background: var(--bg-elev); padding: var(--s-3) 0; border-top: 1px solid var(--bd-soft); margin-top: var(--s-5); display: flex; align-items: center; gap: var(--s-3);">
          <button id="settings-save" class="btn primary" type="submit">save</button>
          <button id="settings-reset" class="btn" type="button">reset</button>
          <span id="settings-status" class="status"></span>
        </div>
      </form>
    </section>
  `;
}

// ---- Section groups -----------------------------------------------------

function fieldGroup(title: string, hint: string, fields: Html[]): Html {
  return html`
    <fieldset style="border: 1px solid var(--bd-soft); border-radius: 6px; padding: var(--s-3) var(--s-4) var(--s-4); margin: 0 0 var(--s-4);">
      <legend style="padding: 0 var(--s-2); font-weight: 600; font-size: var(--t-13); color: var(--fg);">${title}</legend>
      ${hint
        ? html`<p class="muted" style="font-size: 11.5px; margin: 0 0 var(--s-3);">${hint}</p>`
        : ''}
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3) var(--s-4);">
        ${fields}
      </div>
    </fieldset>
  `;
}

function promptSection(c: ResolvedConfig): Html {
  return fieldGroup('Prompt', 'Optional assistant identity + domain guidance layered onto the system prompt.', [
    textField({ path: 'prompt.assistantName', label: 'Assistant name', value: c.prompt.assistantName, nullable: true, placeholder: 'e.g. Cregis AI Assistant', span: 2 }),
    textareaField({ path: 'prompt.systemInstructions', label: 'System instructions (one per line)', value: c.prompt.systemInstructions, rows: 5, span: 2 }),
  ]);
}

function llmSection(c: ResolvedConfig): Html {
  return fieldGroup('LLM', 'Answer-generation model + API key env var.', [
    selectField({ path: 'llm.provider', label: 'Provider', value: c.llm.provider, options: ['anthropic', 'openai', 'mock'] }),
    textField({ path: 'llm.model', label: 'Model', value: c.llm.model }),
    textField({ path: 'llm.apiKeyEnv', label: 'API key env var', value: c.llm.apiKeyEnv, hint: 'name of the env var holding the API key (the value never lives in the file)' }),
  ]);
}

function embeddingSection(c: ResolvedConfig): Html {
  return fieldGroup('Embedding', 'Local BGE-M3 for vector retrieval. Quantized = smaller / faster, full precision = slightly better recall.', [
    selectField({ path: 'embedding.provider', label: 'Provider', value: c.embedding.provider, options: ['local'] }),
    textField({ path: 'embedding.model', label: 'Model', value: c.embedding.model }),
    textField({ path: 'embedding.cacheDir', label: 'Cache dir (absolute path)', value: c.embedding.cacheDir, nullable: true, placeholder: '(~/.cache/huggingface/anydocs-ask/transformers)', span: 2 }),
    checkboxField({ path: 'embedding.preferQuantized', label: 'Prefer quantized weights', checked: c.embedding.preferQuantized }),
    checkboxField({ path: 'embedding.allowSingleLangFallback', label: 'Allow single-lang fallback', checked: c.embedding.allowSingleLangFallback }),
  ]);
}

function retrievalSection(c: ResolvedConfig): Html {
  return fieldGroup('Retrieval', 'Vector + BM25 fusion / re-ranking knobs. Raise topK if the right page often misses the top-N.', [
    intField({ path: 'retrieval.topK', label: 'topK', value: c.retrieval.topK, min: 1 }),
    intField({ path: 'retrieval.rrfK', label: 'RRF k', value: c.retrieval.rrfK, min: 1 }),
    floatField({ path: 'retrieval.rerankSameSubtreeBoost', label: 'Re-rank same-subtree boost', value: c.retrieval.rerankSameSubtreeBoost }),
    floatField({ path: 'retrieval.navOrderBoost', label: 'Nav-order boost', value: c.retrieval.navOrderBoost }),
    intField({ path: 'retrieval.maxChunksHardCap', label: 'Max chunks (hard cap)', value: c.retrieval.maxChunksHardCap, min: 1 }),
  ]);
}

function clarifySection(c: ResolvedConfig): Html {
  return fieldGroup('Clarify', 'Thresholds that decide when to ask a clarifying sub-tree question vs. answering directly.', [
    floatField({ path: 'clarify.dominantThreshold', label: 'Dominant threshold', value: c.clarify.dominantThreshold }),
    floatField({ path: 'clarify.ambiguousGap', label: 'Ambiguous gap', value: c.clarify.ambiguousGap }),
  ]);
}

function feedbackSection(c: ResolvedConfig): Html {
  return fieldGroup('Feedback', 'v1.5 feedback loop (PRD §11). Disabled by default; enable to start collecting β / γ signals.', [
    checkboxField({ path: 'feedback.enabled', label: 'Enable feedback collection', checked: c.feedback.enabled, span: 2 }),
    selectField({ path: 'feedback.implicitSignals', label: 'Implicit signals (γ)', value: c.feedback.implicitSignals, options: ['off', 'session-only', 'full'] }),
    floatField({ path: 'feedback.rerankerWeight', label: 'Reranker weight (0.3 future)', value: c.feedback.rerankerWeight }),
  ]);
}

function indexingSection(c: ResolvedConfig): Html {
  return fieldGroup('Indexing', 'Chunk size + watch debounce for the local index.', [
    intField({ path: 'indexing.chunkMaxTokens', label: 'Chunk max tokens', value: c.indexing.chunkMaxTokens, min: 1 }),
    intField({ path: 'indexing.chunkHardCap', label: 'Chunk hard cap (tokens)', value: c.indexing.chunkHardCap, min: 1 }),
    intField({ path: 'indexing.debounceMs', label: 'Watch debounce (ms)', value: c.indexing.debounceMs, min: 0 }),
  ]);
}

function runsSection(c: ResolvedConfig): Html {
  return fieldGroup('Runs', 'runs.jsonl ledger — rotated weekly. Truncate caps prevent huge prompts / answers from bloating the file.', [
    checkboxField({ path: 'runs.enabled', label: 'Enable runs.jsonl', checked: c.runs.enabled, span: 2 }),
    selectField({ path: 'runs.rotation', label: 'Rotation', value: c.runs.rotation, options: ['weekly'] }),
    intField({ path: 'runs.truncateQueryChars', label: 'Truncate query (chars)', value: c.runs.truncateQueryChars, nullable: true, min: 1 }),
    intField({ path: 'runs.truncateAnswerChars', label: 'Truncate answer (chars)', value: c.runs.truncateAnswerChars, nullable: true, min: 1 }),
  ]);
}

function analyzeSection(c: ResolvedConfig): Html {
  return fieldGroup('Analyze', 'Default knobs for the `analyze` CLI command.', [
    intField({ path: 'analyze.lookbackDays', label: 'Lookback days', value: c.analyze.lookbackDays, min: 1 }),
    intField({ path: 'analyze.latencyP95Threshold', label: 'Latency P95 threshold (ms)', value: c.analyze.latencyP95Threshold, min: 1 }),
    floatField({ path: 'analyze.confidenceFloor', label: 'Confidence floor', value: c.analyze.confidenceFloor }),
  ]);
}

function serverSection(c: ResolvedConfig): Html {
  return fieldGroup('Server', 'HTTP server for /v1/ask. Edit cautiously — these affect how Reader clients reach the service.', [
    textField({ path: 'server.host', label: 'Host', value: c.server.host }),
    intField({ path: 'server.port', label: 'Port', value: c.server.port, min: 1 }),
    textareaField({ path: 'server.cors.allowedOrigins', label: 'CORS allowed origins (one per line)', value: c.server.cors.allowedOrigins, rows: 3, span: 2 }),
  ]);
}

// ---- Control helpers ---------------------------------------------------

function fieldWrap(label: string, hint: string | undefined, span: number | undefined, control: Html): Html {
  const styleAttr = span === 2 ? ' style="grid-column: 1 / -1;"' : '';
  return html`
    <label${raw(styleAttr)} style="${span === 2 ? 'grid-column: 1 / -1; ' : ''}display: grid; gap: var(--s-1);">
      <span style="font-size: var(--t-12); color: var(--fg-soft); font-weight: 600;">${label}</span>
      ${control}
      ${hint ? html`<span class="muted" style="font-size: 11.5px;">${hint}</span>` : ''}
    </label>
  `;
}

function textField(args: { path: string; label: string; value: string | null; nullable?: boolean; placeholder?: string; hint?: string; span?: number }): Html {
  const type = args.nullable ? 'stringOrNull' : 'string';
  return fieldWrap(
    args.label,
    args.hint,
    args.span,
    html`<input class="input" type="text" data-cfg-path="${args.path}" data-cfg-type="${type}" value="${args.value ?? ''}" placeholder="${args.placeholder ?? ''}" />`,
  );
}

function intField(args: { path: string; label: string; value: number | null; nullable?: boolean; min?: number; hint?: string; span?: number }): Html {
  const type = args.nullable ? 'intOrNull' : 'int';
  const minAttr = args.min !== undefined ? ` min="${args.min}"` : '';
  return fieldWrap(
    args.label,
    args.hint,
    args.span,
    html`<input class="input" type="number" step="1"${raw(minAttr)} data-cfg-path="${args.path}" data-cfg-type="${type}" value="${args.value ?? ''}" />`,
  );
}

function floatField(args: { path: string; label: string; value: number | null; nullable?: boolean; hint?: string; span?: number }): Html {
  const type = args.nullable ? 'floatOrNull' : 'float';
  return fieldWrap(
    args.label,
    args.hint,
    args.span,
    html`<input class="input" type="number" step="0.01" data-cfg-path="${args.path}" data-cfg-type="${type}" value="${args.value ?? ''}" />`,
  );
}

function checkboxField(args: { path: string; label: string; checked: boolean; span?: number }): Html {
  const styleAttr = args.span === 2 ? ' style="grid-column: 1 / -1;"' : '';
  return html`
    <label${raw(styleAttr)} class="check" style="${args.span === 2 ? 'grid-column: 1 / -1; ' : ''}display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2) 0;">
      <input type="checkbox" data-cfg-path="${args.path}" data-cfg-type="boolean" ${args.checked ? 'checked' : ''} />
      <span style="font-size: var(--t-13);">${args.label}</span>
    </label>
  `;
}

function selectField(args: { path: string; label: string; value: string; options: string[]; hint?: string; span?: number }): Html {
  return fieldWrap(
    args.label,
    args.hint,
    args.span,
    html`
      <select class="input" data-cfg-path="${args.path}" data-cfg-type="string">
        ${args.options.map((o) => html`<option value="${o}" ${o === args.value ? 'selected' : ''}>${o}</option>`)}
      </select>
    `,
  );
}

function textareaField(args: { path: string; label: string; value: string[]; rows: number; hint?: string; span?: number }): Html {
  return fieldWrap(
    args.label,
    args.hint,
    args.span,
    html`<textarea class="textarea" rows="${args.rows}" data-cfg-path="${args.path}" data-cfg-type="stringArray">${args.value.join('\n')}</textarea>`,
  );
}

function askCard(live: boolean): Html {
  if (!live) return askStartGate();
  return html`
    <section class="card primary">
      <div class="card-hd">
        <h2><svg style="width: 14px; height: 14px;"><use href="#i-chat"/></svg> Ask</h2>
        <label id="persist-toggle-wrap" class="check">
          <input type="checkbox" id="persist-toggle" />
          <span id="persist-toggle-label" class="muted">dry-run · don't write to runs</span>
        </label>
      </div>
      <div class="card-bd">
        <div id="persist-warning" class="banner err" hidden style="margin: 0 0 var(--s-3);">
          <span class="b-ico"><svg><use href="#i-err"/></svg></span>
          <div class="b-bd">
            <div class="b-ti">persist on — this question will write to runs jsonl</div>
            <div class="b-de">tagged <code class="inline">source=console</code>. analyze / golden generate exclude by default;
              use <code class="inline">--include-console</code> when you want to mix in dogfood traffic. Refreshing resets back to dry-run.</div>
          </div>
        </div>
        <textarea
          id="ask-q"
          class="textarea"
          rows="3"
          placeholder="Ask a question about your docs… e.g. how do I install hermes?"
          style="min-height: 96px;"
        ></textarea>
        <div style="display: flex; align-items: center; gap: var(--s-3); margin-top: var(--s-3);">
          <button id="btn-ask" class="btn primary">
            ask <span class="kbd">⌘↵</span>
          </button>
          <span id="ask-status" class="status">ready</span>
        </div>

        <div id="ask-result" hidden style="margin-top: var(--s-5); border-top: 1px solid var(--bd-soft); padding-top: var(--s-4);">
          <nav class="tabs inner" role="tablist" style="margin: 0 0 var(--s-3);">
            <button class="tab active" role="tab" data-tab="answer" aria-selected="true">answer</button>
            <button class="tab" role="tab" data-tab="citations" aria-selected="false">citations <span id="cit-count" class="cnt"></span></button>
            <button class="tab" role="tab" data-tab="meta" role="tab" aria-selected="false">meta</button>
          </nav>
          <div id="tab-answer" class="tab-panel" data-tab="answer">
            <div id="ask-clarify" class="banner warn" hidden style="margin: 0 0 var(--s-3);"></div>
            <div id="ask-answer-md" class="md"></div>
            <div id="ask-error" class="banner err" hidden style="margin: 0;"></div>
            <div id="ask-feedback" hidden style="margin-top: var(--s-4); padding-top: var(--s-3); border-top: 1px solid var(--bd-soft); display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap;">
              <span style="font-size: var(--t-12); color: var(--fg-soft);">这个回答怎么样？</span>
              <div style="display: flex; gap: var(--s-2);">
                <button id="ask-fb-up" class="btn sm" type="button" aria-label="答得好" title="答得好">👍 答得好</button>
                <button id="ask-fb-down" class="btn sm" type="button" aria-label="答得差" title="答得差">👎 答得差</button>
              </div>
              <span id="ask-fb-status" class="status" style="margin-left: auto;"></span>
            </div>
          </div>
          <div id="tab-citations" class="tab-panel" data-tab="citations" hidden>
            <div id="ask-cite-list" class="cite-list"></div>
            <p id="ask-cite-empty" class="empty" hidden style="padding: 24px 0;">No citations.</p>
          </div>
          <div id="tab-meta" class="tab-panel" data-tab="meta" hidden>
            <dl id="ask-meta" class="kv"></dl>
            <h3 style="margin-top: var(--s-4); font-size: var(--t-12); color: var(--fg-soft); letter-spacing: .04em; text-transform: uppercase;">raw response</h3>
            <pre id="ask-raw" class="block mono" style="max-height: 360px;"></pre>
            <p class="muted" style="font-size: 11.5px; margin-top: var(--s-2);">
              Full retrieval trace (fused top-5 / vec_rank / bm25_rank) lands with v1.5 <code class="inline">?debug=1</code> (ARCH §17.8).
            </p>
          </div>
        </div>
      </div>
    </section>
  `;
}

function askStartGate(): Html {
  return html`
    <section class="card" style="overflow: hidden;">
      <div class="card-bd" style="display: flex; flex-direction: column; align-items: center; text-align: center; padding: 56px 24px; gap: var(--s-3);">
        <div class="e-ico" style="width: 56px; height: 56px; background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent);">
          <svg style="width: 24px; height: 24px;"><use href="#i-play"/></svg>
        </div>
        <h3 style="font-size: var(--t-18); margin: 0;">Start this project to begin</h3>
        <p style="max-width: 48ch; color: var(--fg-soft); margin: 0;">
          Starting spins up a local /v1/ask endpoint. The first boot loads the embedder and indexes pages — usually 5–30s.
        </p>
        <div style="margin-top: var(--s-3); display: flex; gap: var(--s-2);">
          <button id="btn-start-ask-secondary" class="btn primary lg">
            <svg><use href="#i-play"/></svg> start project
          </button>
        </div>
        <p id="lifecycle-status-ask" class="status" style="margin-top: var(--s-2);"></p>
        <details style="margin-top: var(--s-3); text-align: left; width: 100%; max-width: 520px;">
          <summary style="font-size: var(--t-12); color: var(--fg-soft); cursor: pointer;">CLI equivalent</summary>
          <pre class="block" style="margin-top: var(--s-2);">anydocs-ask <span class="kw">serve</span> &lt;project&gt;</pre>
        </details>
      </div>
    </section>
  `;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

const BOOTSTRAP_SCRIPT = `
import { marked } from '/console/static/marked.esm.js';

marked.setOptions({ breaks: true, gfm: true });

const cfg = window.__CONSOLE__ || { name: '', valid: false, live: false, autostart: false };

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------
// warm state machine — surfaces child runtime.warm via /v1/health.
// ------------------------------------------------------------------
const warmState = {
  warm: false,
  polling: false,
  pollStartedAt: 0,
  pendingQuestion: null,
  abortPoll: false,
};
let warmTickTimer = null;

function setStatusPill(level, text) {
  const pill = $('status-pill');
  const txt = $('status-text');
  if (!pill || !txt) return;
  // Map level → pill class
  pill.className = 'pill' + (level === 'ok' ? ' ok' : level === 'warn' ? ' warn' : level === 'err' ? ' err' : level === 'run' ? ' run' : '');
  txt.textContent = text;
}

function elapsedSec() {
  if (!warmState.pollStartedAt) return 0;
  return Math.floor((Date.now() - warmState.pollStartedAt) / 1000);
}

function tickWarmingPill() {
  if (warmState.warm) return;
  setStatusPill('warn', 'warming · ' + elapsedSec() + 's');
}

async function pollHealth() {
  if (warmState.polling) return;
  warmState.polling = true;
  warmState.abortPoll = false;
  warmState.pollStartedAt = Date.now();
  setStatusPill('warn', 'warming · 0s');
  if (warmTickTimer) clearInterval(warmTickTimer);
  warmTickTimer = setInterval(tickWarmingPill, 500);
  while (!warmState.abortPoll) {
    let warm = false;
    let body = null;
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/health');
      if (res.status === 200) {
        body = await res.json();
        warm = body && body.warm === true;
      } else if (res.status === 502) {
        warmState.polling = false;
        warmState.abortPoll = true;
        if (warmTickTimer) { clearInterval(warmTickTimer); warmTickTimer = null; }
        setStatusPill('', 'idle');
        return;
      } else {
        try { body = await res.json(); } catch (_) {}
      }
    } catch (_) {}
    if (warm) {
      warmState.warm = true;
      warmState.polling = false;
      if (warmTickTimer) { clearInterval(warmTickTimer); warmTickTimer = null; }
      onWarmReady(body);
      return;
    }
    await sleep(1200);
  }
  warmState.polling = false;
  if (warmTickTimer) { clearInterval(warmTickTimer); warmTickTimer = null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function onWarmReady() {
  const txt = $('status-text');
  const existing = (txt && txt.textContent) || '';
  const portMatch = existing.match(/:[0-9]+/);
  const tail = portMatch ? ' · ' + portMatch[0] : '';
  setStatusPill('ok', 'ready' + tail);
  if (warmState.pendingQuestion) {
    const q = warmState.pendingQuestion;
    warmState.pendingQuestion = null;
    if (askStatus) { askStatus.textContent = 'warm-up done · re-submitting'; askStatus.className = 'status ok'; }
    if (askQ) askQ.value = q;
    submitAsk();
  } else if (askStatus) {
    askStatus.textContent = 'ready';
    askStatus.className = 'status ok';
    setTimeout(() => {
      if (askStatus && askStatus.textContent === 'ready') askStatus.textContent = '';
    }, 1500);
  }
}

function lifecycleClick(action, btnId, statusId) {
  return async () => {
    const btn = $(btnId || ('btn-' + action));
    const status = $(statusId || 'lifecycle-status-ask');
    if (!btn) return;
    btn.disabled = true;
    if (status) { status.textContent = action + '...'; status.className = 'status'; }
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/' + action, { method: 'POST' });
      const body = await res.json();
      if (!res.ok || body.ok === false) {
        if (status) { status.textContent = body.error || res.statusText; status.className = 'status err'; }
        btn.disabled = false;
        return;
      }
      if (status) { status.textContent = action + ' ok'; status.className = 'status ok'; }
      setTimeout(() => location.reload(), 350);
    } catch (e) {
      if (status) { status.textContent = 'network error: ' + (e && e.message ? e.message : e); status.className = 'status err'; }
      btn.disabled = false;
    }
  };
}

if ($('btn-start')) $('btn-start').addEventListener('click', lifecycleClick('start', 'btn-start'));
if ($('btn-stop')) $('btn-stop').addEventListener('click', lifecycleClick('stop', 'btn-stop'));
if ($('btn-start-ask')) $('btn-start-ask').addEventListener('click', lifecycleClick('start', 'btn-start-ask'));
if ($('btn-start-ask-secondary')) $('btn-start-ask-secondary').addEventListener('click', lifecycleClick('start', 'btn-start-ask-secondary'));

// Traffic tab analyze
(function bindTrafficAnalyze() {
  const btn = $('btn-traffic-analyze');
  const status = $('traffic-analyze-status');
  const includeConsole = $('analyze-include-console');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (status) { status.textContent = 'running... (10–60s)'; status.className = 'status'; }
    const t0 = Date.now();
    try {
      const payload = includeConsole && includeConsole.checked ? { include_console: true } : {};
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      const dt = Date.now() - t0;
      if (!res.ok || body.ok === false) {
        if (status) { status.textContent = 'failed (' + dt + 'ms): ' + (body.error || res.statusText); status.className = 'status err'; }
      } else {
        if (status) { status.textContent = 'done (' + dt + 'ms)'; status.className = 'status ok'; }
        setTimeout(() => location.reload(), 500);
      }
    } catch (e) {
      if (status) { status.textContent = 'network error: ' + (e && e.message ? e.message : e); status.className = 'status err'; }
    } finally {
      btn.disabled = false;
    }
  });
})();
// Golden Workshop generators — stream NDJSON from /golden/generate/stream
// so the log box ticks with real progress (project load → template gen →
// per-batch LLM rewrite → write). LLM rewrite can be 30-60s on a large
// project, so a static spinner is misleading; line-by-line logs let the
// author see exactly which batch they're on.
(function bindGwGenerators() {
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  function bind(id, source) {
    const btn = $(id);
    const status = $('gw-gen-status');
    const logEl = $('gw-gen-log');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      // Reset UI: clear log, disable both gen buttons (avoid parallel runs).
      const structureBtn = $('btn-gen-structure');
      const runsBtn = $('btn-gen-runs');
      if (structureBtn) structureBtn.disabled = true;
      if (runsBtn) runsBtn.disabled = true;
      if (logEl) {
        logEl.hidden = false;
        logEl.textContent = '';
        logEl.scrollTop = 0;
      }
      const t0 = Date.now();
      let spinnerIdx = 0;
      const tick = () => {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        if (status) {
          status.textContent = SPINNER[spinnerIdx % SPINNER.length] + ' ' + source + ' running... ' + dt + 's';
          status.className = 'status muted';
        }
        spinnerIdx++;
      };
      tick();
      const spinnerTimer = setInterval(tick, 120);
      const appendLine = (line, cls) => {
        if (!logEl) return;
        const span = document.createElement('span');
        if (cls) span.className = cls;
        span.textContent = line + '\\n';
        logEl.appendChild(span);
        // Stay pinned at bottom unless the user has manually scrolled up.
        const atBottom = logEl.scrollHeight - logEl.clientHeight - logEl.scrollTop < 30;
        if (atBottom) logEl.scrollTop = logEl.scrollHeight;
      };
      let lastResult = null;
      try {
        const limitInput = $('gw-gen-limit');
        let limitParam = '';
        if (limitInput && source === 'structure') {
          const v = parseInt(limitInput.value, 10);
          if (Number.isFinite(v) && v > 0) limitParam = '&limit=' + v;
        }
        const url = '/api/projects/' + encodeURIComponent(cfg.name) + '/golden/generate/stream?from=' + source + limitParam;
        const res = await fetch(url, { method: 'POST' });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          appendLine('HTTP ' + res.status + ': ' + (text || res.statusText), 'err');
          lastResult = { ok: false, error: 'HTTP ' + res.status };
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\\n')) !== -1) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let ev;
              try { ev = JSON.parse(line); } catch { appendLine(line, 'dim'); continue; }
              if (ev.type === 'log') {
                appendLine(ev.line, /(^|\s)ok in /.test(ev.line) ? 'ok' : (/FAIL|fail|error/i.test(ev.line) ? 'err' : null));
              } else if (ev.type === 'result') {
                lastResult = ev;
              }
            }
          }
          if (buf.trim()) {
            try { const ev = JSON.parse(buf); if (ev.type === 'result') lastResult = ev; } catch { appendLine(buf, 'dim'); }
          }
        }
      } catch (e) {
        appendLine('network error: ' + (e && e.message ? e.message : e), 'err');
        lastResult = { ok: false, error: (e && e.message) || String(e) };
      } finally {
        clearInterval(spinnerTimer);
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (lastResult && lastResult.ok) {
        appendLine('✓ done in ' + dt + 's', 'ok');
        if (status) { status.textContent = 'done in ' + dt + 's'; status.className = 'status ok'; }
        // Brief pause so the user sees the final state before reload swaps the DOM.
        setTimeout(() => location.reload(), 800);
      } else {
        const err = (lastResult && lastResult.error) || 'unknown error';
        appendLine('✗ failed (' + dt + 's): ' + err, 'err');
        if (status) { status.textContent = 'failed (' + dt + 's)'; status.className = 'status err'; }
        if (structureBtn) structureBtn.disabled = false;
        if (runsBtn) runsBtn.disabled = false;
      }
    });
  }
  bind('btn-gen-structure', 'structure');
  bind('btn-gen-runs', 'runs');
})();

// Golden Workshop approve / reject + flush
(function bindGwDecide() {
  document.querySelectorAll('.gw-candidate, .cand-row').forEach((row) => {
    const id = row.dataset.id;
    if (!id) return;
    row.querySelectorAll('button[data-decide]').forEach((b) => {
      b.addEventListener('click', async () => {
        const decision = b.dataset.decide;
        b.disabled = true;
        try {
          const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/golden/decide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, decision }),
          });
          const body = await res.json();
          if (!res.ok || body.ok === false) {
            alert((body && body.error) || res.statusText);
            b.disabled = false;
            return;
          }
          row.style.opacity = '0.4';
          row.style.transition = 'opacity .15s';
          setTimeout(() => location.reload(), 250);
        } catch (e) {
          alert('network error: ' + (e && e.message ? e.message : e));
          b.disabled = false;
        }
      });
    });
  });
  const flush = $('btn-gw-flush');
  if (flush) {
    flush.addEventListener('click', async () => {
      if (!confirm('flush approved candidates → cases.jsonl?')) return;
      flush.disabled = true;
      try {
        const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/golden/flush', { method: 'POST' });
        const body = await res.json();
        if (!res.ok || body.ok === false) {
          alert((body && body.error) || res.statusText);
          flush.disabled = false;
          return;
        }
        location.reload();
      } catch (e) {
        alert('network error: ' + (e && e.message ? e.message : e));
        flush.disabled = false;
      }
    });
  }
})();

// Golden Workshop: client-side pagination over the rendered pending rows.
// Server emits all rows (data-idx=0..N-1); JS shows pageSize at a time so a
// 530-candidate batch isn't a 530-row wall. Page persists in location.hash
// fragment (#eval / #eval-p3) so approve/reject reload doesn't lose place.
(function bindGwPager() {
  const listEl = $('gw-pending-list');
  if (!listEl) return;
  const rows = Array.from(listEl.querySelectorAll('.gw-candidate'));
  if (rows.length === 0) return;
  const pageSize = Math.max(1, parseInt(listEl.dataset.pageSize, 10) || 20);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const prev = $('gw-pager-prev');
  const next = $('gw-pager-next');
  const info = $('gw-pager-info');

  function readPage() {
    try {
      const m = (location.hash || '').match(/[?&]gp=(\\d+)/);
      if (m) {
        const p = parseInt(m[1], 10);
        if (Number.isFinite(p)) return Math.min(Math.max(1, p), totalPages);
      }
    } catch (_) {}
    return 1;
  }
  function writePage(p) {
    // Keep the existing tab fragment (e.g. "#eval") and replace any prior gp=.
    let h = location.hash || '';
    h = h.replace(/[?&]gp=\\d+/g, '');
    if (h && !h.includes('?')) h = h + '?gp=' + p;
    else if (h) h = h + '&gp=' + p;
    else h = '#eval?gp=' + p;
    history.replaceState({}, '', location.pathname + h);
  }

  let page = readPage();
  function render() {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    rows.forEach((r, i) => { r.style.display = (i >= start && i < end) ? '' : 'none'; });
    if (info) info.textContent = page + ' / ' + totalPages + ' · ' + rows.length + ' rows';
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= totalPages;
  }
  if (prev) prev.addEventListener('click', () => { if (page > 1) { page--; writePage(page); render(); } });
  if (next) next.addEventListener('click', () => { if (page < totalPages) { page++; writePage(page); render(); } });
  render();
})();

// Golden Workshop: edit modal — POST /golden/candidate/update with a patch
// of the editable fields. Read-only fields (template_id, created_by,
// reviewed_at, reviewer, decision) display in the modal header but are not
// part of the patch.
(function bindGwEdit() {
  const backdrop = $('gw-edit-backdrop');
  if (!backdrop) return;
  const pending = Array.isArray(window.__GW_PENDING__) ? window.__GW_PENDING__ : [];
  const byId = new Map(pending.map((c) => [c.id, c]));

  const elId = $('gw-edit-id');
  const elTemplate = $('gw-edit-template');
  const elCreatedBy = $('gw-edit-created-by');
  const elQuery = $('gw-edit-query');
  const elLang = $('gw-edit-lang');
  const elContext = $('gw-edit-context');
  const elAudience = $('gw-edit-audience');
  const elVersion = $('gw-edit-version');
  const elTags = $('gw-edit-tags');
  const elMustCite = $('gw-edit-mustcite');
  const elMustContain = $('gw-edit-mustcontain');
  const elForbid = $('gw-edit-forbid');
  const elNote = $('gw-edit-note');
  const elStatus = $('gw-edit-status');
  const btnSave = $('gw-edit-save');
  const btnCancel = $('gw-edit-cancel');
  const btnClose = $('gw-edit-close');

  let currentId = null;

  function open(id) {
    const c = byId.get(id);
    if (!c) { alert('candidate not found in client cache: ' + id); return; }
    currentId = id;
    if (elId) elId.textContent = c.id;
    if (elTemplate) elTemplate.textContent = c.template_id || '—';
    if (elCreatedBy) elCreatedBy.textContent = c.created_by || '—';
    if (elQuery) elQuery.value = c.query || '';
    if (elLang) elLang.value = c.lang || 'en';
    if (elContext) elContext.value = c.context_pageId || '';
    const f = c.filters || {};
    if (elAudience) elAudience.value = f.audience || '';
    if (elVersion) elVersion.value = f.version || '';
    if (elTags) elTags.value = Array.isArray(c.tags) ? c.tags.join(', ') : '';
    const exp = c.expected || {};
    if (elMustCite) elMustCite.value = (exp.must_cite_pages || []).join(', ');
    if (elMustContain) elMustContain.value = (exp.must_contain || []).join(', ');
    if (elForbid) elForbid.value = (exp.forbid_contain || []).join(', ');
    if (elNote) elNote.value = c.note || '';
    if (elStatus) { elStatus.textContent = ''; elStatus.className = 'status'; }
    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');
    if (elQuery) elQuery.focus();
  }
  function close() {
    currentId = null;
    backdrop.classList.remove('show');
    backdrop.setAttribute('aria-hidden', 'true');
  }
  function csvToArr(s) {
    return String(s || '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  }

  document.querySelectorAll('.gw-candidate button[data-edit]').forEach((b) => {
    b.addEventListener('click', (ev) => {
      const row = ev.currentTarget.closest('.gw-candidate');
      if (row && row.dataset.id) open(row.dataset.id);
    });
  });

  if (btnCancel) btnCancel.addEventListener('click', close);
  if (btnClose) btnClose.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('show')) close();
  });

  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      if (!currentId) return;
      const patch = {
        query: elQuery ? elQuery.value : undefined,
        lang: elLang ? elLang.value : undefined,
        context_pageId: elContext ? elContext.value : undefined,
        filters: {
          audience: elAudience ? elAudience.value : undefined,
          version: elVersion ? elVersion.value : undefined,
        },
        tags: elTags ? csvToArr(elTags.value) : undefined,
        expected: {
          must_cite_pages: elMustCite ? csvToArr(elMustCite.value) : undefined,
          must_contain: elMustContain ? csvToArr(elMustContain.value) : undefined,
          forbid_contain: elForbid ? csvToArr(elForbid.value) : undefined,
        },
        note: elNote ? elNote.value : undefined,
      };
      btnSave.disabled = true;
      if (elStatus) { elStatus.textContent = 'saving...'; elStatus.className = 'status muted'; }
      try {
        const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/golden/candidate/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: currentId, patch }),
        });
        const body = await res.json();
        if (!res.ok || body.ok === false) {
          if (elStatus) { elStatus.textContent = (body && body.error) || res.statusText; elStatus.className = 'status err'; }
          btnSave.disabled = false;
          return;
        }
        if (elStatus) { elStatus.textContent = 'saved · reloading'; elStatus.className = 'status ok'; }
        setTimeout(() => location.reload(), 300);
      } catch (e) {
        if (elStatus) { elStatus.textContent = 'network error: ' + (e && e.message ? e.message : e); elStatus.className = 'status err'; }
        btnSave.disabled = false;
      }
    });
  }
})();

// ------------------------------------------------------------------
// Top tabs (Ask / Index / Eval / Traffic)
// ------------------------------------------------------------------
function setProjectTab(name) {
  document.querySelectorAll('[data-project-tab]').forEach((el) => {
    if (el.getAttribute('role') === 'tab') {
      el.setAttribute('aria-selected', el.dataset.projectTab === name ? 'true' : 'false');
    } else {
      el.hidden = el.dataset.projectTab !== name;
    }
  });
  if (location.hash !== '#' + name) {
    history.replaceState({}, '', location.pathname + '#' + name);
  }
}
document.querySelectorAll('[role=tab][data-project-tab]').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.preventDefault();
    setProjectTab(b.dataset.projectTab);
  });
});
const initialTab = (location.hash || '').replace('#', '');
if (['ask', 'index', 'eval', 'traffic'].includes(initialTab)) {
  setProjectTab(initialTab);
}
window.addEventListener('hashchange', () => {
  const t = (location.hash || '').replace('#', '');
  if (['ask', 'index', 'eval', 'traffic'].includes(t)) {
    setProjectTab(t);
  }
});

// ------------------------------------------------------------------
// Index tab: reindex button
// ------------------------------------------------------------------
function bindReindex() {
  const btn = $('btn-reindex');
  const status = $('reindex-status');
  if (!btn || !status) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'reindexing...';
    status.className = 'status';
    const t0 = Date.now();
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/reindex', { method: 'POST' });
      const body = await res.json();
      const dt = Date.now() - t0;
      if (!res.ok || body.ok === false) {
        status.textContent = 'failed (' + dt + 'ms): ' + (body.error || body.message || res.statusText);
        status.className = 'status err';
      } else {
        const stats = body.stats || {};
        const pages = stats.pages || {};
        const chunks = stats.chunks || {};
        status.textContent = 'done (' + dt + 'ms) — ' +
          ((pages.inserted || 0) + (pages.updated || 0)) + ' pages, ' +
          (chunks.totalChunks || 0) + ' chunks';
        status.className = 'status ok';
        setTimeout(() => location.reload(), 800);
      }
    } catch (e) {
      status.textContent = 'network error: ' + (e && e.message ? e.message : e);
      status.className = 'status err';
    } finally {
      btn.disabled = false;
    }
  });
}
bindReindex();

// ------------------------------------------------------------------
// Eval tab: Run + pin/unpin baseline
// ------------------------------------------------------------------
function bindEvalRun() {
  const btn = $('btn-run-eval');
  const sel = $('eval-baseline-select');
  const status = $('eval-run-status');
  const progEl = $('eval-progress');
  const progI = $('eval-prog-i');
  const progTotal = $('eval-prog-total');
  const progSlug = $('eval-prog-slug');
  const progEta = $('eval-prog-eta');
  const progBar = $('eval-prog-bar');
  if (!btn || !status) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'warming up the runtime…';
    status.className = 'status';
    if (progEl) {
      progEl.hidden = false;
      if (progI) progI.textContent = '0';
      if (progTotal) progTotal.textContent = '—';
      if (progSlug) progSlug.textContent = '';
      if (progEta) progEta.textContent = '';
      if (progBar) progBar.style.width = '0%';
    }
    const t0 = Date.now();
    const baseline = sel ? (sel.value || null) : null;
    // Per-case running average for the ETA.
    let total = 0;
    let doneCount = 0;
    let sumMs = 0;
    let lastResult = null;
    function applyEvent(ev) {
      if (ev.type === 'boot') {
        total = ev.totalCases;
        if (progTotal) progTotal.textContent = String(total);
        status.textContent = total + ' cases loaded · waiting for runtime warm…';
      } else if (ev.type === 'warm') {
        status.textContent = 'warm in ' + ev.bootMs + 'ms · running cases';
      } else if (ev.type === 'case-start') {
        if (progI) progI.textContent = String(ev.i + 1);
        if (progSlug) progSlug.textContent = ev.lang + ' · ' + ev.caseId;
      } else if (ev.type === 'case-done') {
        doneCount = ev.i + 1;
        sumMs += ev.latencyMs;
        const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
        if (progBar) progBar.style.width = pct + '%';
        const avg = sumMs / Math.max(1, doneCount);
        const remaining = Math.max(0, total - doneCount);
        if (progEta && remaining > 0) {
          const etaMs = remaining * avg;
          progEta.textContent = etaMs > 1500
            ? '~' + Math.round(etaMs / 1000) + 's remaining'
            : '<1s remaining';
        } else if (progEta) {
          progEta.textContent = 'finishing…';
        }
      } else if (ev.type === 'done') {
        status.textContent = 'wrote ' + ev.reportPath.split('/').pop() + ' · reloading';
        status.className = 'status ok';
      } else if (ev.type === 'result') {
        lastResult = ev;
      }
    }
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/eval/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseline ? { baseline_path: baseline } : {}),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        status.textContent = 'failed: HTTP ' + res.status + ' ' + (text || res.statusText);
        status.className = 'status err';
        if (progEl) progEl.hidden = true;
        btn.disabled = false;
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { applyEvent(JSON.parse(line)); } catch (_) {}
        }
      }
      if (buf.trim()) {
        try { applyEvent(JSON.parse(buf)); } catch (_) {}
      }
      const dt = Date.now() - t0;
      if (lastResult && lastResult.ok) {
        if (progBar) progBar.style.width = '100%';
        status.textContent = (status.textContent || ('done in ' + (dt / 1000).toFixed(1) + 's')) + ' — reloading';
        status.className = 'status ok';
        setTimeout(() => location.reload(), 600);
      } else {
        const err = (lastResult && lastResult.error) || 'unknown error';
        status.textContent = 'failed (' + (dt / 1000).toFixed(1) + 's): ' + err;
        status.className = 'status err';
        if (progEl) progEl.hidden = true;
      }
    } catch (e) {
      status.textContent = 'network error: ' + (e && e.message ? e.message : e);
      status.className = 'status err';
      if (progEl) progEl.hidden = true;
    } finally {
      btn.disabled = false;
    }
  });
}
bindEvalRun();

function bindBaselineActions() {
  document.querySelectorAll('[data-pin-filename]').forEach((b) => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/eval/pin-baseline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: b.dataset.pinFilename }),
        });
        const body = await res.json();
        if (!res.ok || body.ok === false) {
          alert((body && body.error) || res.statusText);
          b.disabled = false;
          return;
        }
        location.reload();
      } catch (e) {
        alert('network error: ' + (e && e.message ? e.message : e));
        b.disabled = false;
      }
    });
  });
  const unpin = $('btn-unpin-baseline');
  if (unpin) {
    unpin.addEventListener('click', async () => {
      unpin.disabled = true;
      try {
        const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/eval/pin-baseline', { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          alert((body && body.error) || res.statusText);
          unpin.disabled = false;
          return;
        }
        location.reload();
      } catch (e) {
        alert('network error: ' + (e && e.message ? e.message : e));
        unpin.disabled = false;
      }
    });
  }
}
bindBaselineActions();

// ------------------------------------------------------------------
// Ask sub-tabs (answer / citations / meta) — scoped to #ask-result so
// they don't collide with project-level tabs.
// ------------------------------------------------------------------
const askResultEl = $('ask-result');
function setActiveAskTab(name) {
  if (!askResultEl) return;
  askResultEl.querySelectorAll('[role=tab]').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
    if (b.dataset.tab === name) b.classList.add('active'); else b.classList.remove('active');
  });
  askResultEl.querySelectorAll('.tab-panel').forEach((p) => {
    p.hidden = p.dataset.tab !== name;
  });
}
if (askResultEl) {
  askResultEl.querySelectorAll('[role=tab]').forEach((b) => {
    b.addEventListener('click', () => setActiveAskTab(b.dataset.tab));
  });
}

// persist toggle — defaults OFF every page load.
function setPersistUI(on) {
  const label = $('persist-toggle-label');
  const warn = $('persist-warning');
  const btn = $('btn-ask');
  if (on) {
    if (label) { label.textContent = '⚠ persist · writes to runs (source=console)'; label.className = ''; label.style.color = 'var(--err)'; label.style.fontWeight = '600'; }
    if (warn) warn.hidden = false;
    if (btn) btn.classList.add('danger');
  } else {
    if (label) { label.textContent = 'dry-run · don\\u2019t write to runs'; label.className = 'muted'; label.style.color = ''; label.style.fontWeight = ''; }
    if (warn) warn.hidden = true;
    if (btn) btn.classList.remove('danger');
  }
}
const persistToggle = $('persist-toggle');
if (persistToggle) {
  persistToggle.checked = false;
  persistToggle.addEventListener('change', () => setPersistUI(persistToggle.checked));
  setPersistUI(false);
}
function isPersist() { return !!(persistToggle && persistToggle.checked); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAnswer(body) {
  const result = $('ask-result');
  const ansEl = $('ask-answer-md');
  const clarEl = $('ask-clarify');
  const errEl = $('ask-error');
  if (!result || !ansEl || !clarEl || !errEl) return;
  ansEl.innerHTML = '';
  clarEl.hidden = true; clarEl.innerHTML = '';
  errEl.hidden = true; errEl.innerHTML = '';
  result.hidden = false;

  if (body && body.type === 'answer') {
    let md = body.answer_md || '';
    if (body.translation_notice) {
      md = '> _translation notice:_ ' + body.translation_notice + '\\n\\n' + md;
    }
    ansEl.innerHTML = marked.parse(md);
  } else if (body && body.type === 'clarify') {
    clarEl.hidden = false;
    let h = '<span class="b-ico"><svg><use href="#i-alert"/></svg></span>';
    h += '<div class="b-bd">';
    h += '<div class="b-ti">' + (body.message ? escapeHtml(body.message) : 'The question is ambiguous — pick a scope to continue') + '</div>';
    if (Array.isArray(body.options) && body.options.length) {
      h += '<div class="b-de" style="margin-top: 6px;">Pick one to re-ask under that scope, or refine the question above.</div>';
      h += '<div style="display: flex; flex-direction: column; gap: 6px; margin-top: var(--s-3);">';
      body.options.forEach((o) => {
        const label = escapeHtml(o.label || o.scope_id || '');
        const crumb = Array.isArray(o.breadcrumb) && o.breadcrumb.length
          ? o.breadcrumb.map((b) => escapeHtml((b && b.title) || '')).filter(Boolean).join(' / ')
          : '';
        h += '<button type="button" class="btn" data-scope-id="' + escapeHtml(o.scope_id || '') + '" data-scope-label="' + label + '" style="justify-content: flex-start; height: auto; padding: 10px 12px; text-align: left;">';
        h += '<svg style="width: 12px; height: 12px; opacity: .6; flex-shrink: 0;"><use href="#i-arr-r"/></svg>';
        h += '<span style="display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; flex: 1;">';
        h += '<span>Continue under <b>' + label + '</b></span>';
        if (crumb) h += '<span style="color: var(--fg-mute); font-size: 11px; font-family: var(--font-mono);">' + crumb + '</span>';
        h += '</span>';
        h += '</button>';
      });
      h += '</div>';
    }
    h += '</div>';
    clarEl.innerHTML = h;
    // Wire each suggestion: re-ask the same textarea question with
    // context.scope_id set so the child's /v1/ask constrains retrieval.
    clarEl.querySelectorAll('button[data-scope-id]').forEach((btn) => {
      btn.addEventListener('click', () => submitAsk({
        scopeId: btn.dataset.scopeId,
        scopeLabel: btn.dataset.scopeLabel,
      }));
    });
  } else if (body && body.type === 'error') {
    errEl.hidden = false;
    let h = '<span class="b-ico"><svg><use href="#i-err"/></svg></span>';
    h += '<div class="b-bd">';
    h += '<div class="b-ti">' + escapeHtml(body.code || 'error') + '</div>';
    h += '<div class="b-de">' + escapeHtml(body.message || '') + '</div>';
    h += '</div>';
    errEl.innerHTML = h;
  } else {
    errEl.hidden = false;
    errEl.innerHTML = '<span class="b-ico"><svg><use href="#i-err"/></svg></span><div class="b-bd"><div class="b-ti">unexpected response shape</div></div>';
  }

  // Only an answer with an answer_id can be rated. clarify/error responses
  // have no answer_id; dry_run answers do (the child mints one even when it
  // doesn't write to the answers table — POST /v1/ask/feedback is permissive
  // about missing FK, just loses the retrieved snapshot).
  setFeedbackBar(body && body.type === 'answer' && typeof body.answer_id === 'string' ? body.answer_id : null);
}

// ---------------------------------------------------------------------
// Ask feedback bar — 👍 / 👎 buttons under the answer.
// ---------------------------------------------------------------------
let lastAnswerId = null;

function setFeedbackBar(answerId) {
  const bar = $('ask-feedback');
  const up = $('ask-fb-up');
  const down = $('ask-fb-down');
  const status = $('ask-fb-status');
  if (!bar || !up || !down || !status) return;
  lastAnswerId = answerId;
  if (!answerId) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  up.disabled = false;
  down.disabled = false;
  up.classList.remove('primary');
  down.classList.remove('danger');
  status.textContent = '';
  status.className = 'status';
}

async function sendFeedback(rating, btn) {
  if (!lastAnswerId) return;
  const up = $('ask-fb-up');
  const down = $('ask-fb-down');
  const status = $('ask-fb-status');
  if (!up || !down || !status) return;
  up.disabled = true;
  down.disabled = true;
  status.textContent = '提交中…';
  status.className = 'status';
  try {
    const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer_id: lastAnswerId, rating }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || (body && body.ok === false)) {
      throw new Error((body && body.error) || ('http ' + res.status));
    }
    if (rating > 0) btn.classList.add('primary');
    else btn.classList.add('danger');
    status.textContent = '已提交 · 感谢反馈';
    status.className = 'status ok';
  } catch (err) {
    up.disabled = false;
    down.disabled = false;
    status.textContent = '提交失败：' + (err && err.message ? err.message : err);
    status.className = 'status err';
  }
}

// in_page_path is "<headingId>/p[N]" (section chunk) or "p[N]" (page-top
// chunk). Pull the heading part so two citations from the same page render
// with distinct section labels next to the title — otherwise two chunks of
// one page look like a duplicate citation (dogfood 2026-05-14 F4). Bare
// "p[N]" has no useful disambiguator, so return ''. lastIndexOf avoids a
// regex (backslashes would need double-escaping inside BOOTSTRAP_SCRIPT).
function citeSectionLabel(inPath) {
  if (!inPath) return '';
  const i = inPath.lastIndexOf('/p[');
  return i > 0 ? inPath.slice(0, i) : '';
}

function renderCitations(body) {
  const list = $('ask-cite-list');
  const empty = $('ask-cite-empty');
  const cnt = $('cit-count');
  if (!list || !empty) return;
  list.innerHTML = '';
  if (!body || body.type !== 'answer' || !Array.isArray(body.citations) || body.citations.length === 0) {
    empty.hidden = false;
    if (cnt) cnt.textContent = '';
    return;
  }
  empty.hidden = true;
  if (cnt) cnt.textContent = String(body.citations.length);
  for (const c of body.citations) {
    const div = document.createElement('div');
    div.className = 'cite-item';
    const crumb = Array.isArray(c.breadcrumb) ? c.breadcrumb.map((b) => b.title).join(' › ') : '';
    const inPath = c.in_page_path || '';
    const section = citeSectionLabel(inPath);
    const langTag = c.source_lang && c.source_lang !== c.lang ? '<span class="tag warn">cross-lang ' + escapeHtml(c.source_lang) + '→' + escapeHtml(c.lang) + '</span>' : '';
    const titleSuffix = section ? ' <span style="font-weight:400; color:var(--fg-mute);">· ' + escapeHtml(section) + '</span>' : '';
    div.innerHTML =
      '<span class="cite">' + escapeHtml(c.citation_id || '·') + '</span>' +
      '<div>' +
      '  <div class="meta">' + escapeHtml(c.page_id || '') + (inPath ? ' · ' + escapeHtml(inPath) : '') + ' ' + langTag + '</div>' +
      '  <div style="font-weight:600; margin-bottom:4px;">' + escapeHtml(c.title || '') + titleSuffix + '</div>' +
      (crumb ? '<div class="muted" style="font-size:11.5px; margin-bottom:6px;">' + escapeHtml(crumb) + '</div>' : '') +
      '  <div class="snippet">' + escapeHtml(c.snippet || '') + '</div>' +
      '</div>';
    list.appendChild(div);
  }
}

function renderMeta(body, latencyMs, httpStatus) {
  const meta = $('ask-meta');
  const raw = $('ask-raw');
  if (!meta || !raw) return;
  meta.innerHTML = '';
  function row(k, v) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.className = 'mono';
    dd.textContent = v == null ? '—' : String(v);
    meta.appendChild(dt);
    meta.appendChild(dd);
  }
  row('http', httpStatus);
  row('round-trip', latencyMs + ' ms');
  if (body && body.type) row('type', body.type);
  if (body && body.type === 'answer') {
    row('latency_ms', body.latency_ms);
    row('used_chunks', body.used_chunks);
    row('answer_lang', body.answer_lang);
    row('model', body.model);
    if (body.translation_notice) row('translation', body.translation_notice);
  }
  row('dry_run', body && body._dry_run ? 'true' : 'false');
  if (body && body._persisted) {
    row('persisted', 'true');
    row('source', body._source || 'console');
  }
  raw.textContent = JSON.stringify(body, null, 2);
}

const askBtn = $('btn-ask');
const askQ = $('ask-q');
const askStatus = $('ask-status');

// ---------------------------------------------------------------------
// Settings tab — structured form over anydocs.ask.json.
// Each control carries data-cfg-path (dot path) + data-cfg-type
// ('string' | 'stringOrNull' | 'int' | 'intOrNull' | 'float' |
//  'floatOrNull' | 'boolean' | 'stringArray'); collectSettingsPayload
// reads them all and rebuilds the nested JSON object, then POSTs to
// /api/projects/:name/ask-config (which re-validates with the same
// schema as loadConfig).
// ---------------------------------------------------------------------
function setPath(root, path, value) {
  const parts = path.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function readControlValue(el) {
  const type = el.dataset.cfgType;
  if (type === 'boolean') return !!el.checked;
  if (type === 'stringArray') {
    return el.value
      .split('\\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  const raw = (el.value || '').trim();
  if (type === 'stringOrNull') return raw.length === 0 ? null : raw;
  if (type === 'string') return raw;
  if (type === 'int' || type === 'intOrNull') {
    if (raw.length === 0) {
      if (type === 'intOrNull') return null;
      // empty required int → reject; surface as NaN, save handler shows error
      return NaN;
    }
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : NaN;
  }
  if (type === 'float' || type === 'floatOrNull') {
    if (raw.length === 0) {
      if (type === 'floatOrNull') return null;
      return NaN;
    }
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : NaN;
  }
  return raw; // fallback
}

function collectSettingsPayload(form) {
  const payload = {};
  const errors = [];
  const controls = form.querySelectorAll('[data-cfg-path]');
  controls.forEach((el) => {
    const path = el.dataset.cfgPath;
    const v = readControlValue(el);
    if (typeof v === 'number' && Number.isNaN(v)) {
      errors.push(path + ' must be a valid number');
      return;
    }
    setPath(payload, path, v);
  });
  return { payload, errors };
}

(function wireSettingsTab() {
  const form = $('settings-form');
  if (!form) return;
  const saveBtn = $('settings-save');
  const resetBtn = $('settings-reset');
  const status = $('settings-status');
  const warningsBox = $('settings-warnings');

  function renderSettingsWarnings(list) {
    if (!warningsBox) return;
    if (!Array.isArray(list) || list.length === 0) {
      warningsBox.hidden = true;
      warningsBox.innerHTML = '';
      return;
    }
    warningsBox.hidden = false;
    let h = '<span class="b-ico"><svg><use href="#i-alert"/></svg></span><div class="b-bd">';
    h += '<div class="b-ti">' + list.length + ' validation warning' + (list.length > 1 ? 's' : '') + '</div>';
    h += '<ul style="margin: 4px 0 0; padding-left: 20px;">';
    list.forEach((w) => { h += '<li style="font-size: var(--t-12);">' + escapeHtml(String(w)) + '</li>'; });
    h += '</ul></div>';
    warningsBox.innerHTML = h;
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      // Reload to get fresh SSR values (avoids per-field reset logic).
      location.reload();
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!cfg.name) return;
    const { payload, errors } = collectSettingsPayload(form);
    if (errors.length > 0) {
      if (status) {
        status.textContent = errors[0] + (errors.length > 1 ? ' (+' + (errors.length - 1) + ' more)' : '');
        status.className = 'status err';
      }
      return;
    }
    if (saveBtn) saveBtn.disabled = true;
    if (status) { status.textContent = '保存中…'; status.className = 'status'; }
    try {
      const rawText = JSON.stringify(payload, null, 2);
      const expectedMtimeISO = form.dataset.mtime || '';
      const body = expectedMtimeISO ? { rawText, expectedMtimeISO } : { rawText };
      const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/ask-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const respBody = await res.json().catch(() => ({}));
      if (!res.ok || (respBody && respBody.ok === false)) {
        const msg = (respBody && respBody.error) || ('http ' + res.status);
        if (status) {
          if (res.status === 409 && respBody && respBody.currentMtimeISO) {
            form.dataset.mtime = respBody.currentMtimeISO;
            status.textContent = '文件已被其它进程修改：' + msg + '（请刷新后重试）';
          } else {
            status.textContent = '保存失败：' + msg;
          }
          status.className = 'status err';
        }
        return;
      }
      if (respBody && respBody.mtimeISO) form.dataset.mtime = respBody.mtimeISO;
      renderSettingsWarnings(respBody && respBody.warnings);
      const wCount = Array.isArray(respBody && respBody.warnings) ? respBody.warnings.length : 0;
      const okText = wCount > 0 ? '已保存（' + wCount + ' 条警告）' : '已保存';
      if (status) {
        status.textContent = cfg.live ? okText + ' · 重启项目生效' : okText + ' · 下次启动生效';
        status.className = 'status ok';
      }
    } catch (err) {
      if (status) {
        status.textContent = '网络错误：' + (err && err.message ? err.message : err);
        status.className = 'status err';
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });
})();

async function submitAsk(opts) {
  opts = opts || {};
  if (!askQ || !askBtn) return;
  const question = askQ.value.trim();
  if (!question) {
    askStatus.textContent = 'enter a question';
    askStatus.className = 'status err';
    return;
  }
  if (!warmState.warm) {
    warmState.pendingQuestion = question;
    askStatus.textContent = 'queued · waiting for warm-up...';
    askStatus.className = 'status';
    pollHealth();
    return;
  }
  askBtn.disabled = true;
  askQ.disabled = true;
  askStatus.textContent = opts.scopeId
    ? 'thinking… (scoped to ' + (opts.scopeLabel || opts.scopeId) + ')'
    : 'thinking… typically 1–3s';
  askStatus.className = 'status';
  const t0 = Date.now();
  const persist = isPersist();
  try {
    const payload = persist ? { question, persist: true } : { question };
    // Clarify-suggestion buttons re-submit the SAME question with a scope_id
    // so the child's /v1/ask constrains retrieval to that subtree (ARCH §11).
    if (opts.scopeId) {
      payload.context = { scope_id: opts.scopeId };
    }
    const res = await fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { type: 'error', code: 'invalid_response', message: text }; }
    const dt = Date.now() - t0;
    if (res.status === 503 && body && body.code === 'warming') {
      warmState.warm = false;
      warmState.pendingQuestion = question;
      askStatus.textContent = 'child still warming · re-queued';
      askStatus.className = 'status';
      pollHealth();
      return;
    }
    const confTail = body && body.type === 'answer' && body.confidence != null ? ' · confidence ' + body.confidence.toFixed(2) : '';
    const persistedTail = body && body._persisted ? ' · wrote runs' : '';
    const kindLabel = body && body.type === 'clarify' ? 'clarify · ' + (dt / 1000).toFixed(1) + 's' :
                       body && body.type === 'error' ? 'http ' + res.status + ' · ' + dt + 'ms' :
                       'answered · ' + (dt / 1000).toFixed(1) + 's' + confTail + persistedTail;
    askStatus.textContent = kindLabel;
    askStatus.className = body && body.type === 'answer' ? 'status ok' :
                          body && body.type === 'clarify' ? 'status' :
                          'status err';
    renderAnswer(body);
    renderCitations(body);
    renderMeta(body, dt, res.status);
    setActiveAskTab('answer');
  } catch (e) {
    askStatus.textContent = 'network error: ' + (e && e.message ? e.message : e);
    askStatus.className = 'status err';
  } finally {
    askBtn.disabled = false;
    askQ.disabled = false;
  }
}
if (askBtn) askBtn.addEventListener('click', () => submitAsk());
if (askQ) {
  askQ.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitAsk();
    }
  });
}

const fbUp = $('ask-fb-up');
const fbDown = $('ask-fb-down');
if (fbUp) fbUp.addEventListener('click', () => sendFeedback(1, fbUp));
if (fbDown) fbDown.addEventListener('click', () => sendFeedback(-1, fbDown));

// Re-ask handler — Traffic tab fills #ask-q and switches to Ask tab.
window.addEventListener('console:reask', (e) => {
  if (askQ && e.detail && e.detail.query) askQ.value = e.detail.query;
  setProjectTab('ask');
});

// Autostart
if (cfg.valid && cfg.autostart && !cfg.live) {
  const status = $('lifecycle-status-ask');
  if (status) { status.textContent = 'auto-starting...'; status.className = 'status'; }
  fetch('/api/projects/' + encodeURIComponent(cfg.name) + '/start', { method: 'POST' })
    .then((r) => r.json())
    .then((body) => {
      if (body && body.ok) {
        if (status) { status.textContent = 'started · :' + body.port + ' · warming...'; status.className = 'status'; }
        setStatusPill('warn', 'warming · 0s');
        pollHealth();
        history.replaceState({}, '', location.pathname);
      } else if (status) {
        status.textContent = (body && body.error) || 'autostart failed';
        status.className = 'status err';
      }
    })
    .catch((e) => {
      if (status) { status.textContent = 'autostart err: ' + e.message; status.className = 'status err'; }
    });
} else if (cfg.valid && cfg.live) {
  pollHealth();
}
`;
