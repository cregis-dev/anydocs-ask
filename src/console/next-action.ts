/**
 * Next-action推断 — ARCH §17.3.7.
 *
 * Looks at index / eval / traffic snapshots and returns the single most
 * useful next step the author should take, plus a tab to jump to. Used
 * by the project page banner above the tab strip.
 *
 * Ordered top-down by funnel position: first-time setup, then first
 * eval, then ongoing iteration. Returns null when nothing actionable
 * stands out (project is in steady state).
 */

import type { EvalTabSnapshot } from './eval-state.ts';
import type { IndexSnapshot } from './index-state.ts';
import type { TrafficWindow } from './traffic-state.ts';

function countUnpublished(idx: IndexSnapshot): number {
  let n = 0;
  for (const l of idx.langs) {
    for (const p of l.pages) {
      if (p.missingFile) continue; // can't have a status; counted separately
      if (p.status !== 'published') n++;
    }
    for (const p of l.orphans) {
      if (p.status !== 'published') n++;
    }
  }
  return n;
}

export type NextAction = {
  /** Severity / urgency: 'info' (suggestion), 'warn' (you should), 'err' (broken). */
  level: 'info' | 'warn' | 'err';
  /** Short headline shown bold. */
  title: string;
  /** Optional secondary explanation. */
  detail?: string;
  /** Hash target tab to jump to (e.g. "#index"). */
  cta: { label: string; targetTab: 'ask' | 'index' | 'eval' | 'traffic' };
};

export type NextActionInputs = {
  indexSnapshot: IndexSnapshot | undefined;
  evalSnapshot: EvalTabSnapshot | undefined;
  trafficWindow: TrafficWindow | undefined;
  childLive: boolean;
  projectValid: boolean;
};

export function computeNextAction(inputs: NextActionInputs): NextAction | null {
  if (!inputs.projectValid) {
    return {
      level: 'err',
      title: 'Project files invalid',
      detail: 'Fix the missing pages/ and navigation/ entries, then reload.',
      cta: { label: 'Open Index', targetTab: 'index' },
    };
  }

  const idx = inputs.indexSnapshot;
  if (idx && idx.totalPages === 0) {
    return {
      level: 'warn',
      title: 'No docs yet',
      detail: 'Drop anydocs page files into projects/<name>/pages/<lang>/ and click reindex.',
      cta: { label: 'Open Index', targetTab: 'index' },
    };
  }

  // Index broken validations: missing files referenced by nav, or
  // mismatched on-disk vs DB counts (significant drift).
  if (idx) {
    const missingFile = idx.langs.some((l) => l.pages.some((p) => p.missingFile));
    if (missingFile) {
      return {
        level: 'err',
        title: 'Navigation points at missing page files',
        detail: 'See the validation card on Index for the list, add the JSON, then reindex.',
        cta: { label: 'Open Index', targetTab: 'index' },
      };
    }
    if (idx.dbStatus) {
      // The indexer writes every published page on disk (orphans included —
      // nav-membership is a soft rerank signal per PRD §4.5, not a hard
      // filter). The hard filter is `status === 'published'`. So:
      //     expected in DB = totalPages - unpublishedCount
      // Orphans alone don't explain drift; only unpublished pages do.
      const unpublishedCount = countUnpublished(idx);
      const expectedInDb = idx.totalPages - unpublishedCount;
      if (Math.abs(idx.dbStatus.page_count - expectedInDb) >= 1) {
        return {
          level: 'warn',
          title: `Disk and DB page counts disagree (expected ${expectedInDb}, got ${idx.dbStatus.page_count})`,
          detail: 'Click reindex to resync the SQLite index.',
          cta: { label: 'Open Index', targetTab: 'index' },
        };
      }
      // Differences absorbed by unpublished / orphan are not "next actions"
      // — Index tab validation card surfaces them in red already, banner
      // staying silent avoids noise.
    }
  }

  // No child running but project is valid + indexed — point to Ask to start.
  if (!inputs.childLive && idx && idx.totalPages > 0) {
    return {
      level: 'info',
      title: 'Project is not running',
      detail: 'Start the child runtime to ask questions in Ask, or run eval in Eval.',
      cta: { label: 'Start project', targetTab: 'ask' },
    };
  }

  const ev = inputs.evalSnapshot;
  if (ev && ev.goldenStats.totalCases === 0) {
    return {
      level: 'info',
      title: 'No golden cases yet',
      detail:
        'Go to Eval → Golden cases → Pending review, click "+ from structure" to seed candidates, then approve them.',
      cta: { label: 'Open Eval', targetTab: 'eval' },
    };
  }

  if (ev && ev.goldenStats.totalCases > 0 && ev.history.length === 0) {
    return {
      level: 'info',
      title: 'Cases ready — run your first eval',
      detail: 'Click ▶ run on the Eval tab to produce a baseline report.',
      cta: { label: 'Run eval', targetTab: 'eval' },
    };
  }

  if (ev && ev.history.length >= 2 && !ev.pinned) {
    return {
      level: 'info',
      title: 'Consider pinning a baseline',
      detail: 'Pin a known-good eval report so later runs do not drift against "previous". Click pin in the history table.',
      cta: { label: 'Open Eval', targetTab: 'eval' },
    };
  }

  // Traffic-driven hints.
  const tr = inputs.trafficWindow;
  if (tr && tr.totals.countReader >= 50 && tr.totals.errorRate > 0.05) {
    return {
      level: 'err',
      title: `Last ${tr.days}d error rate ${(tr.totals.errorRate * 100).toFixed(1)}%`,
      detail: 'Filter kind=error on Traffic to see the failing requests.',
      cta: { label: 'Open Traffic', targetTab: 'traffic' },
    };
  }

  if (tr && tr.totals.countReader >= 20 && tr.totals.meanConfidence !== null && tr.totals.meanConfidence < 0.5) {
    return {
      level: 'warn',
      title: `Last ${tr.days}d mean confidence ${tr.totals.meanConfidence.toFixed(2)}`,
      detail: 'Retrieval quality looks low — review low-confidence requests on Traffic and run Analyze.',
      cta: { label: 'Open Traffic', targetTab: 'traffic' },
    };
  }

  return null;
}
