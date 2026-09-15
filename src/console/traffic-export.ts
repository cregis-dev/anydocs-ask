import { redactSensitiveText } from '../query/diagnostic-input.ts';
import { groupConversations, matchesConversationRun } from '../runs/conversations.ts';
import { isRunRecord, runSource, type RunRecord } from '../runs/types.ts';
import { iterateRunsSince } from '../runs/writer.ts';
import type { TrafficRange, TrafficViewOptions } from './traffic-state.ts';

export const TRAFFIC_EXPORT_SCHEMA_VERSION = 1;

const INLINE_SECRET_RE = /(\b(?:api[_-]?key|secret[_-]?key|access[_-]?key|access[_-]?secret|x-api-key|token|password|authorization|cookie)\b\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^,;\s]+)/gi;

export type TrafficExportFormat = 'csv' | 'jsonl';
export type TrafficExportGroup = 'run' | 'session';

export type TrafficExportOptions = Pick<TrafficViewOptions, 'range' | 'query' | 'source' | 'kind'> & {
  format: TrafficExportFormat;
  groupBy: TrafficExportGroup;
  includeContent: boolean;
};

export type TrafficExportParseResult =
  | { ok: true; value: TrafficExportOptions }
  | { ok: false; error: string };

const DAY_MS = 86_400_000;

export function parseTrafficExportOptions(input: {
  range?: string;
  query?: string;
  source?: string;
  kind?: string;
  format?: string;
  groupBy?: string;
  includeContent?: string;
}): TrafficExportParseResult {
  if (input.range !== undefined && !['7', '30', '90', 'all'].includes(input.range)) {
    return { ok: false, error: 'range must be 7, 30, 90, or all' };
  }
  if (input.source !== undefined && !['', 'reader', 'console', 'mcp'].includes(input.source)) {
    return { ok: false, error: 'source must be reader, console, or mcp' };
  }
  if (input.kind !== undefined && !['', 'answer', 'clarify', 'error'].includes(input.kind)) {
    return { ok: false, error: 'kind must be answer, clarify, or error' };
  }
  if (input.format !== undefined && input.format !== 'csv' && input.format !== 'jsonl') {
    return { ok: false, error: 'format must be csv or jsonl' };
  }
  if (input.groupBy !== undefined && input.groupBy !== 'run' && input.groupBy !== 'session') {
    return { ok: false, error: 'group_by must be run or session' };
  }
  if (input.includeContent !== undefined && !['0', '1', 'false', 'true'].includes(input.includeContent)) {
    return { ok: false, error: 'include_content must be true or false' };
  }

  return {
    ok: true,
    value: {
      range: parseRange(input.range),
      query: (input.query ?? '').trim().slice(0, 200),
      source: (input.source ?? '') as TrafficExportOptions['source'],
      kind: (input.kind ?? '') as TrafficExportOptions['kind'],
      format: (input.format ?? 'csv') as TrafficExportFormat,
      groupBy: (input.groupBy ?? 'run') as TrafficExportGroup,
      includeContent: input.includeContent === '1' || input.includeContent === 'true',
    },
  };
}

export function trafficExportFilename(
  projectName: string,
  options: TrafficExportOptions,
  exportedAt: string,
): string {
  const project = projectName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const stamp = exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const range = options.range === 'all' ? 'all' : `${options.range}d`;
  return `${project}-traffic-${range}-${options.groupBy}-${stamp}.${options.format}`;
}

export function* iterateTrafficExportChunks(args: {
  stateRoot: string;
  projectName: string;
  options: TrafficExportOptions;
  nowMs?: number;
  exportedAt?: string;
}): Generator<string> {
  const nowMs = args.nowMs ?? Date.now();
  const exportedAt = args.exportedAt ?? new Date(nowMs).toISOString();
  const sinceMs = args.options.range === 'all' ? 0 : nowMs - args.options.range * DAY_MS;

  if (args.options.format === 'jsonl') {
    yield `${JSON.stringify({
      type: 'manifest',
      schema_version: TRAFFIC_EXPORT_SCHEMA_VERSION,
      exported_at: exportedAt,
      project: args.projectName,
      filters: {
        range: args.options.range,
        query: args.options.query,
        source: args.options.source,
        kind: args.options.kind,
        group_by: args.options.groupBy,
        include_content: args.options.includeContent,
      },
    })}\n`;
  }

  if (args.options.groupBy === 'session') {
    const runs = [...iterateMatchingRuns(args.stateRoot, sinceMs, {
      ...args.options,
      query: '',
      source: '',
      kind: '',
    })];
    const groups = groupConversations(runs).filter((group) =>
      group.some((run) => matchesConversationRun(run, args.options)),
    );
    if (args.options.format === 'csv') {
      yield `\uFEFF${sessionCsvHeader(args.options.includeContent)}\n`;
      for (const group of groups) yield `${sessionCsvRow(group, args.options.includeContent)}\n`;
      return;
    }
    for (const group of groups) {
      yield `${JSON.stringify(sessionJsonRecord(group, args.projectName, exportedAt, args.options.includeContent))}\n`;
    }
    return;
  }

  if (args.options.format === 'csv') {
    yield `\uFEFF${runCsvHeader(args.options.includeContent)}\n`;
  }
  for (const run of iterateMatchingRuns(args.stateRoot, sinceMs, args.options)) {
    if (args.options.format === 'csv') {
      yield `${runCsvRow(run, args.options.includeContent)}\n`;
    } else {
      yield `${JSON.stringify({
        type: 'run',
        schema_version: TRAFFIC_EXPORT_SCHEMA_VERSION,
        exported_at: exportedAt,
        project: args.projectName,
        run: projectRun(run, args.options.includeContent),
      })}\n`;
    }
  }
}

function* iterateMatchingRuns(
  stateRoot: string,
  sinceMs: number,
  filters: Pick<TrafficExportOptions, 'query' | 'source' | 'kind'>,
): Generator<RunRecord> {
  const seen = new Set<string>();
  for (const line of iterateRunsSince({ stateRoot, sinceMs })) {
    if (!isRunRecord(line) || seen.has(line.request_id)) continue;
    seen.add(line.request_id);
    if (matchesConversationRun(line, filters)) yield line;
  }
}

function projectRun(run: RunRecord, includeContent: boolean): Record<string, unknown> {
  const { md: _md, citations, ...answer } = run.answer;
  const retrieval = {
    ...run.retrieval,
    fused: run.retrieval.fused.map((chunk) => projectChunk(chunk, includeContent)),
    ...(run.retrieval.selected_context
      ? { selected_context: run.retrieval.selected_context.map((chunk) => projectChunk(chunk, includeContent)) }
      : {}),
  };
  return {
    ts: run.ts,
    request_id: run.request_id,
    session_id: run.session_id,
    source: runSource(run),
    context_pageId: run.context_pageId,
    langfuse_trace_id: run.langfuse_trace_id ?? null,
    runtime_build: run.runtime_build ?? null,
    query_chars: run.query.length,
    answer_chars: run.answer.md?.length ?? 0,
    ...(includeContent ? { query: redactExportText(run.query), filters: redactValue(run.filters) } : {}),
    retrieval,
    answer: {
      ...answer,
      ...(includeContent && run.answer.md ? { md: redactExportText(run.answer.md) } : {}),
      citations: citations.map(({ quote: _quote, ...citation }) => ({
        ...citation,
        ...(includeContent ? { quote: redactExportText(_quote) } : {}),
      })),
    },
    feedback: run.feedback,
    input_snapshot_status: run.input_snapshot_status ?? (run.input_snapshot ? 'captured' : 'legacy'),
    ...(includeContent && run.input_snapshot ? { input_snapshot: redactValue(run.input_snapshot) } : {}),
  };
}

function projectChunk<T extends { text_preview?: string }>(chunk: T, includeContent: boolean): Record<string, unknown> {
  const { text_preview: textPreview, ...metadata } = chunk;
  return {
    ...metadata,
    ...(includeContent && textPreview ? { text_preview: redactExportText(textPreview) } : {}),
  };
}

function sessionJsonRecord(
  runs: RunRecord[],
  projectName: string,
  exportedAt: string,
  includeContent: boolean,
): Record<string, unknown> {
  const summary = summarizeSession(runs);
  return {
    type: 'session',
    schema_version: TRAFFIC_EXPORT_SCHEMA_VERSION,
    exported_at: exportedAt,
    project: projectName,
    ...summary,
    runs: runs.map((run) => projectRun(run, includeContent)),
  };
}

function summarizeSession(runs: RunRecord[]) {
  const first = runs[0]!;
  const last = runs[runs.length - 1]!;
  const latencies = runs.map((run) => run.answer.latency_ms).sort((a, b) => a - b);
  const releaseValues = new Set(runs.map((run) => run.runtime_build?.release).filter((value): value is string => Boolean(value)));
  const models = new Set(runs.map((run) => run.answer.model).filter((value): value is string => Boolean(value)));
  return {
    session_key: first.session_id?.trim() ? `${runSource(first)}:${first.session_id}` : `${runSource(first)}:run:${first.request_id}`,
    session_id: first.session_id,
    source: runSource(first),
    started_at: first.ts,
    ended_at: last.ts,
    run_count: runs.length,
    answer_count: runs.filter((run) => run.answer.kind === 'answer').length,
    clarify_count: runs.filter((run) => run.answer.kind === 'clarify').length,
    error_count: runs.filter((run) => run.answer.kind === 'error').length,
    total_latency_ms: latencies.reduce((sum, value) => sum + value, 0),
    average_latency_ms: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    p95_latency_ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!,
    citation_count: runs.reduce((sum, run) => sum + run.answer.citations.length, 0),
    positive_feedback_count: runs.filter((run) => run.feedback.beta === 'positive').length,
    negative_feedback_count: runs.filter((run) => run.feedback.beta === 'negative').length,
    releases: [...releaseValues],
    models: [...models],
  };
}

function runCsvHeader(includeContent: boolean): string {
  return [
    'schema_version', 'ts', 'request_id', 'session_id', 'source', 'kind', 'latency_ms',
    'model', 'tokens_in', 'tokens_out', 'citation_count', 'context_page_id', 'router_strategy',
    'release', 'engine_release', 'feedback_beta', 'feedback_gamma', 'query_chars', 'answer_chars',
    ...(includeContent ? ['query', 'answer', 'context_json'] : []),
  ].join(',');
}

function runCsvRow(run: RunRecord, includeContent: boolean): string {
  return [
    TRAFFIC_EXPORT_SCHEMA_VERSION,
    run.ts,
    run.request_id,
    run.session_id,
    runSource(run),
    run.answer.kind,
    run.answer.latency_ms,
    run.answer.model,
    run.answer.tokens_in,
    run.answer.tokens_out,
    run.answer.citations.length,
    run.context_pageId,
    run.retrieval.router_strategy,
    run.runtime_build?.release,
    run.runtime_build?.engine_release,
    run.feedback.beta,
    run.feedback.gamma,
    run.query.length,
    run.answer.md?.length ?? 0,
    ...(includeContent
      ? [
          redactExportText(run.query),
          run.answer.md ? redactExportText(run.answer.md) : '',
          JSON.stringify({
            filters: redactValue(run.filters),
            retrieval: projectRun(run, true).retrieval,
            input_snapshot: run.input_snapshot ? redactValue(run.input_snapshot) : undefined,
          }),
        ]
      : []),
  ].map(csvCell).join(',');
}

function sessionCsvHeader(includeContent: boolean): string {
  return [
    'schema_version', 'session_key', 'session_id', 'source', 'started_at', 'ended_at',
    'run_count', 'answer_count', 'clarify_count', 'error_count', 'total_latency_ms',
    'average_latency_ms', 'p95_latency_ms', 'citation_count', 'positive_feedback_count',
    'negative_feedback_count', 'releases', 'models',
    ...(includeContent ? ['first_query', 'last_query', 'runs_json'] : []),
  ].join(',');
}

function sessionCsvRow(runs: RunRecord[], includeContent: boolean): string {
  const summary = summarizeSession(runs);
  return [
    TRAFFIC_EXPORT_SCHEMA_VERSION,
    summary.session_key,
    summary.session_id,
    summary.source,
    summary.started_at,
    summary.ended_at,
    summary.run_count,
    summary.answer_count,
    summary.clarify_count,
    summary.error_count,
    summary.total_latency_ms,
    summary.average_latency_ms,
    summary.p95_latency_ms,
    summary.citation_count,
    summary.positive_feedback_count,
    summary.negative_feedback_count,
    summary.releases.join('|'),
    summary.models.join('|'),
    ...(includeContent
      ? [
          redactExportText(runs[0]!.query),
          redactExportText(runs[runs.length - 1]!.query),
          JSON.stringify(runs.map((run) => projectRun(run, true))),
        ]
      : []),
  ].map(csvCell).join(',');
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactExportText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  }
  return value;
}

function redactExportText(value: string): string {
  return redactSensitiveText(value).replace(INLINE_SECRET_RE, '$1[REDACTED]');
}

function parseRange(value: string | undefined): TrafficRange {
  if (value === 'all') return 'all';
  if (value === '30' || value === '90') return Number(value) as 30 | 90;
  return 7;
}
