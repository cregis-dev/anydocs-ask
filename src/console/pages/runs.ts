/**
 * Recent runs viewer — ARCH §17.3.1 GET /p/:name/runs.
 * Renders the latest tail of `<state>/runs/<YYYY-Www>.jsonl` as a table.
 */

import { html } from 'hono/html';
import type { RunsLine, RunRecord } from '../../runs/types.ts';
import { layout, type Html } from './layout.ts';

export function renderRuns(args: {
  projectName: string;
  lines: RunsLine[];
  limit: number;
}): Html {
  const records = args.lines.filter((l): l is RunRecord => 'answer' in l);
  return layout({
    title: `${args.projectName} · runs`,
    body: html`
      <p class="mono"><a href="/p/${args.projectName}">← ${args.projectName}</a></p>
      <h1>recent runs · ${records.length}/${args.limit}</h1>
      ${records.length === 0
        ? html`<p class="empty">尚无 runs（或本周文件不存在）。</p>`
        : runsTable(records)}
    `,
  });
}

function runsTable(records: RunRecord[]): Html {
  // Newest last in jsonl tail; reverse for display newest-first.
  const rows = [...records].reverse().map((r) => runRow(r));
  return html`
    <table>
      <thead>
        <tr>
          <th>ts</th>
          <th>kind</th>
          <th>conf</th>
          <th>latency</th>
          <th>query</th>
          <th>citations</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function runRow(r: RunRecord): Html {
  const kindTag =
    r.answer.kind === 'answer'
      ? html`<span class="tag ok">answer</span>`
      : r.answer.kind === 'clarify'
        ? html`<span class="tag warn">clarify</span>`
        : html`<span class="tag err">error</span>`;
  const conf = r.answer.confidence !== null ? r.answer.confidence.toFixed(2) : '—';
  const cits =
    r.answer.kind === 'answer' && r.answer.citations.length > 0
      ? r.answer.citations.map((c) => c.page).join(', ')
      : '—';
  return html`
    <tr>
      <td class="mono muted" style="font-size: 11px;">${r.ts.slice(11, 19)}</td>
      <td>${kindTag}</td>
      <td class="mono">${conf}</td>
      <td class="mono">${r.answer.latency_ms}ms</td>
      <td>${r.query}</td>
      <td class="mono muted" style="font-size: 12px;">${cits}</td>
    </tr>
  `;
}
