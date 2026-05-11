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
      detail: '修复 pages/ 和 navigation/ 缺失项后再继续。',
      cta: { label: 'open Index', targetTab: 'index' },
    };
  }

  const idx = inputs.indexSnapshot;
  if (idx && idx.totalPages === 0) {
    return {
      level: 'warn',
      title: '还没放 docs',
      detail: '把 anydocs 格式的 page 文件放到 projects/<name>/pages/<lang>/ 后点 reindex。',
      cta: { label: 'open Index', targetTab: 'index' },
    };
  }

  // Index broken validations: missing files referenced by nav, or
  // mismatched on-disk vs DB counts (significant drift).
  if (idx) {
    const missingFile = idx.langs.some((l) => l.pages.some((p) => p.missingFile));
    if (missingFile) {
      return {
        level: 'err',
        title: 'Navigation 引用了缺失的 page 文件',
        detail: 'Index tab 验证卡列出了具体缺哪些；补齐 page JSON 后 reindex。',
        cta: { label: 'open Index', targetTab: 'index' },
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
          title: `disk 与 DB 页数不一致 (expected ${expectedInDb}, got ${idx.dbStatus.page_count})`,
          detail: '点 reindex 同步 SQLite 索引。',
          cta: { label: 'open Index', targetTab: 'index' },
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
      title: '项目尚未启动',
      detail: '点 start 后即可在 Ask tab dogfood / 在 Eval tab 跑评测。',
      cta: { label: 'open Ask', targetTab: 'ask' },
    };
  }

  const ev = inputs.evalSnapshot;
  if (ev && ev.goldenStats.totalCases === 0) {
    return {
      level: 'info',
      title: '还没 golden 题集',
      detail:
        '左侧 Golden / Analyze 卡里点 "golden ← structure" 生成候选；编辑器里把 decision 改 approved 后跑 anydocs-ask golden review 入库。',
      cta: { label: 'open Eval', targetTab: 'eval' },
    };
  }

  if (ev && ev.goldenStats.totalCases > 0 && ev.history.length === 0) {
    return {
      level: 'info',
      title: '题集已就位，先跑首次 eval',
      detail: 'Eval tab 里点 ▶ run 生成 baseline 报告。',
      cta: { label: 'open Eval', targetTab: 'eval' },
    };
  }

  if (ev && ev.history.length >= 2 && !ev.pinned) {
    return {
      level: 'info',
      title: '建议钉一个 baseline',
      detail: '钉住一份满意的 eval 报告，避免后续随"上一份"漂。Eval tab history 表点 pin。',
      cta: { label: 'open Eval', targetTab: 'eval' },
    };
  }

  // Traffic-driven hints.
  const tr = inputs.trafficWindow;
  if (tr && tr.totals.countReader >= 50 && tr.totals.errorRate > 0.05) {
    return {
      level: 'err',
      title: `近 ${tr.days} 天 error 率 ${(tr.totals.errorRate * 100).toFixed(1)}%`,
      detail: '去 Traffic tab 筛 kind=error 查具体请求。',
      cta: { label: 'open Traffic', targetTab: 'traffic' },
    };
  }

  if (tr && tr.totals.countReader >= 20 && tr.totals.meanConfidence !== null && tr.totals.meanConfidence < 0.5) {
    return {
      level: 'warn',
      title: `近 ${tr.days} 天 mean confidence ${tr.totals.meanConfidence.toFixed(2)}`,
      detail: '召回质量偏低；Traffic tab 看低置信度请求 + analyze runs 跑诊断。',
      cta: { label: 'open Traffic', targetTab: 'traffic' },
    };
  }

  return null;
}
