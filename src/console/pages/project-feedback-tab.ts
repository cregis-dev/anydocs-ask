/**
 * Feedback tab — RFC 0002 T1-a (skeleton).
 *
 * Only the first two states from console-redesign-brief §7.5.1 are
 * implemented here:
 *
 *   1. disabled        — `feedback.enabled = false` (PRD §11.4 #6 default)
 *   2. enabled, empty  — switch on, feedback table has 0 rows
 *
 * KPI rail, middle list, and the right-side detail drawer (states 3-5)
 * land in T1-b / T1-d once the list endpoint exists. T1-a's job is to
 * make the tab visible so a design partner opening the console can see
 * where the loop is heading.
 */

import { html } from 'hono/html';
import type { Html } from './layout.ts';
import type { FeedbackTabSnapshot } from '../feedback-state.ts';

export type FeedbackTabViewModel = {
  projectName: string;
  snapshot: FeedbackTabSnapshot;
};

export function renderFeedbackTab(vm: FeedbackTabViewModel): Html {
  if (!vm.snapshot.enabled) return disabledCard();
  return emptyEnabledLayout(vm.snapshot.totalCount);
}

function disabledCard(): Html {
  // State 1 — feedback.enabled = false. PRD §11.4 #6 makes this the default,
  // so the tab is muted instead of showing fake KPIs. The CTA points to the
  // Settings tab where `feedback.enabled` lives.
  return html`
    <section class="card" data-feedback-state="disabled">
      <div class="card-bd">
        <div class="empty">
          <div class="e-ico"><svg><use href="#i-info"/></svg></div>
          <h3>Feedback loop is off</h3>
          <p>
            <code class="inline">feedback.enabled</code> is <code class="inline">false</code> in this
            project's <code class="inline">anydocs.ask.json</code>. With it off the query pipeline
            stays byte-equivalent to v1 (no β/γ rows written, no inbox populated). Turn it on to
            start collecting the signal that powers RFC 0001 + 0002.
          </p>
          <div class="e-cta">
            <a href="#settings" class="btn primary">
              <svg><use href="#i-gear"/></svg> open Settings · feedback
            </a>
          </div>
        </div>
      </div>
    </section>
  `;
}

function emptyEnabledLayout(totalCount: number): Html {
  // State 2 (and a placeholder for state 3 onwards). T1-a only ships the
  // empty-shaped layout; we keep rendering it regardless of `totalCount`
  // because KPI math, the list, and the drawer all land in T1-b.
  //
  // When rows already exist we still owe the author a visible signal that
  // the β/γ pipe is alive — otherwise design partners click 👍, see the
  // table grow in the DB, and find the UI unchanged. The thin "signals
  // collected" banner above the empty card bridges that gap without
  // pulling state 3+ into T1-a.
  const collected = totalCount > 0;
  return html`
    <div
      class="feedback-tab"
      data-feedback-state="empty"
      data-feedback-total="${totalCount}"
      style="display: flex; flex-direction: column; gap: var(--s-5);"
    >
      ${collected ? collectedBanner(totalCount) : ''}
      ${kpiPlaceholder()}
      ${emptyListCard()}
    </div>
  `;
}

function collectedBanner(totalCount: number): Html {
  const label = totalCount === 1 ? 'signal' : 'signals';
  return html`
    <div class="banner info" data-feedback-banner="collected">
      <span class="b-ico"><svg><use href="#i-info"/></svg></span>
      <div class="b-bd">
        <div class="b-ti">${totalCount} feedback ${label} collected</div>
        <div class="b-de">
          The β / γ pipe is writing rows. KPI numbers, the list view, and the per-row drawer
          ship in T1-b — this tab will fill in then.
        </div>
      </div>
    </div>
  `;
}

function kpiPlaceholder(): Html {
  // Five tiles match the §7.5.1 left rail (feedback count · explicit % ·
  // mean confidence · non-answer rate · A+ candidates). Every value is `—`
  // until we have rows; sparkline / refresh button arrive in T1-b.
  const labels = [
    { lab: 'feedback · 7d', foot: 'β + γ combined' },
    { lab: 'explicit %', foot: '👍 / 👎 share' },
    { lab: 'mean confidence', foot: 'across rated runs' },
    { lab: 'non-answer rate', foot: 'error + clarify' },
    { lab: 'A+ candidates', foot: 'unlocks at 50 (PRD §10.3)' },
  ];
  return html`
    <div class="kpis" style="grid-template-columns: repeat(5, 1fr);">
      ${labels.map(
        (k) => html`
          <div class="kpi">
            <div class="k-lab">${k.lab}</div>
            <div class="k-val">—</div>
            <div class="k-foot">${k.foot}</div>
          </div>
        `,
      )}
    </div>
  `;
}

function emptyListCard(): Html {
  return html`
    <section class="card">
      <div class="card-bd">
        <div class="empty">
          <div class="e-ico"><svg><use href="#i-chat"/></svg></div>
          <h3>No feedback yet</h3>
          <p>
            Once readers tap 👍 / 👎 (β channel) or the server detects a same-session re-ask within
            5 min (γ channel), rows will appear here. Until then the loop has nothing to chew on —
            try the Ask tab, or wait for real traffic.
          </p>
          <div class="e-cta">
            <a href="#ask" class="btn primary">
              <svg><use href="#i-chat"/></svg> dogfood from the Ask tab
            </a>
            <a href="#traffic" class="btn">
              <svg><use href="#i-chart"/></svg> check live traffic
            </a>
          </div>
        </div>
      </div>
    </section>
  `;
}
