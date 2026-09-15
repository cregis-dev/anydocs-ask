import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { marked } from 'marked';
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Fingerprint,
  GitBranch,
  Hash,
  Layers3,
  ListFilter,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { apiJson, projectApi, resolveRunChunks } from './api';
import type { RunDetailBootstrap, RunRecord } from './app-types';
import type { ResolvedIndexedChunk } from './types';
import { RunContext } from './run-context';

type RetrievalMode = 'context' | 'candidates' | 'citations';
type FusedHit = RunRecord['retrieval']['fused'][number];
type ContextHit = NonNullable<RunRecord['retrieval']['selected_context']>[number];
type Citation = RunRecord['answer']['citations'][number];

export function RunDetailScreen({
  data,
  header,
}: {
  data: RunDetailBootstrap;
  header: React.ReactNode;
}) {
  const { run } = data;
  const refs = useMemo(() => uniqueChunkRefs(run), [run]);
  const resolvedQuery = useQuery({
    queryKey: ['run-chunks', data.projectName, run.request_id, refs],
    queryFn: () => resolveRunChunks(data.projectName, refs),
    enabled: data.childLive && refs.length > 0,
  });
  const resolved = useMemo(
    () => new Map((resolvedQuery.data ?? []).map((item) => [item.requested_chunk_id, item])),
    [resolvedQuery.data],
  );
  const [copied, setCopied] = useState(false);
  const [addingGolden, setAddingGolden] = useState(false);

  const copyRequestId = async () => {
    await navigator.clipboard.writeText(run.request_id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  const addGolden = async () => {
    setAddingGolden(true);
    try {
      const result = await apiJson<{ isNew: boolean }>(
        projectApi(data.projectName, '/golden/candidate/create-from-run'),
        {
          method: 'POST',
          body: JSON.stringify({
            query: run.query,
            context_pageId: run.context_pageId,
            answer: run.answer.md,
            request_id: run.request_id,
          }),
        },
      );
      window.alert(result.isNew ? 'Added to Golden review queue.' : 'This question is already in the queue.');
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingGolden(false);
    }
  };

  return (
    <div className="ca-app">
      {header}
      <main className="rd-page" id="console-main">
        <nav className="rd-breadcrumb" aria-label="Breadcrumb">
          <a href={data.returnTo}><ArrowLeft size={15} />Traffic</a>
          <span>/</span>
          <span>{shortId(run.request_id)}</span>
        </nav>

        <header className="rd-head">
          <div>
            <div className="rd-eyebrow"><Activity size={13} />RAG run diagnostics</div>
            <h1>Run detail</h1>
            <div className="rd-run-meta">
              <OutcomeBadge kind={run.answer.kind} />
              <span>{run.source ?? 'reader'}</span>
              <time dateTime={run.ts}>{formatTimestamp(run.ts, true)}</time>
            </div>
          </div>
          <div className="rd-head-actions">
            <button className="ca-button" type="button" onClick={copyRequestId}>
              {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy run ID'}
            </button>
            <button className="ca-button ca-primary" type="button" disabled={addingGolden} onClick={addGolden}>
              {addingGolden ? <LoaderCircle className="ca-spin" size={15} /> : <Plus size={15} />}Golden case
            </button>
          </div>
        </header>

        <section className="rd-summary" aria-label="Run summary">
          <SummaryMetric icon={<Clock3 />} label="Total latency" value={formatDuration(run.answer.latency_ms)} />
          <SummaryMetric icon={<Search />} label="Candidates" value={run.retrieval.fused.length} />
          <SummaryMetric icon={<Layers3 />} label="Generation context" value={run.retrieval.selected_context?.length ?? 'legacy'} />
          <SummaryMetric icon={<FileText />} label="Citations" value={run.answer.citations.length} />
        </section>

        <div className="rd-overview-grid">
          <div className="rd-main-column">
            <RunSection eyebrow="Input" title="Question">
              <p className="rd-question">{run.query}</p>
            </RunSection>
            <RunSection eyebrow="Output" title={run.answer.kind === 'error' ? 'Error' : 'Answer'}>
              {run.answer.md
                ? <Markdown body={run.answer.md} />
                : <p className="rd-empty-copy">No generated answer was persisted for this run.</p>}
              {run.answer.error_code && <div className="rd-error-code"><CircleAlert size={15} />{run.answer.error_code}</div>}
            </RunSection>
          </div>
          <aside className="rd-side-column">
            <PipelineTiming run={run} />
            <RunConfiguration run={run} />
          </aside>
        </div>

        <RunContext projectName={data.projectName} requestId={run.request_id} run={run} full />
        <RetrievalInspector
          projectName={data.projectName}
          run={run}
          resolved={resolved}
          loading={resolvedQuery.isLoading}
          error={resolvedQuery.error}
          childLive={data.childLive}
        />
      </main>
    </div>
  );
}

function RetrievalInspector(props: {
  projectName: string;
  run: RunRecord;
  resolved: Map<number, ResolvedIndexedChunk>;
  loading: boolean;
  error: Error | null;
  childLive: boolean;
}) {
  const hasContext = Boolean(props.run.retrieval.selected_context?.length);
  const [mode, setMode] = useState<RetrievalMode>(hasContext ? 'context' : 'candidates');
  const context = props.run.retrieval.selected_context ?? [];
  const candidates = props.run.retrieval.fused;
  const citations = props.run.answer.citations;
  const contextIds = new Set(context.map((item) => item.chunk_id));
  const citationsByChunk = new Map<number, Citation[]>();
  for (const citation of citations) {
    if (typeof citation.chunk_id !== 'number') continue;
    const list = citationsByChunk.get(citation.chunk_id) ?? [];
    list.push(citation);
    citationsByChunk.set(citation.chunk_id, list);
  }

  return (
    <section className="rd-retrieval" aria-labelledby="retrieval-heading">
      <header className="rd-section-head">
        <div>
          <div className="rd-eyebrow"><Database size={13} />Retrieval trace</div>
          <h2 id="retrieval-heading">Inspect what reached generation</h2>
          <p>Compare fused child candidates with parent-expanded prompt context and final citations.</p>
        </div>
        {props.loading && <span className="rd-resolve-state"><LoaderCircle className="ca-spin" size={14} />Resolving index metadata</span>}
      </header>

      {!props.childLive && <InlineState tone="warning">The project service is offline. Showing metadata captured in the run only.</InlineState>}
      {props.error && <InlineState tone="warning">Current index metadata could not be loaded: {props.error.message}</InlineState>}

      <div className="rd-retrieval-tabs" role="tablist" aria-label="Retrieval trace view">
        <RetrievalTab active={mode === 'context'} onClick={() => setMode('context')} icon={<Layers3 />} label="Generation context" count={context.length} disabled={!hasContext} />
        <RetrievalTab active={mode === 'candidates'} onClick={() => setMode('candidates')} icon={<ListFilter />} label="Candidates" count={candidates.length} />
        <RetrievalTab active={mode === 'citations'} onClick={() => setMode('citations')} icon={<FileText />} label="Citations" count={citations.length} />
      </div>

      <div className="rd-chunk-list" role="tabpanel">
        {mode === 'context' && context.map((hit) => (
          <ChunkRow
            key={`context-${hit.context_rank}-${hit.chunk_id}`}
            projectName={props.projectName}
            rank={hit.context_rank}
            hit={hit}
            resolved={props.resolved.get(hit.chunk_id)}
            context={hit}
            citations={citationsByChunk.get(hit.chunk_id) ?? []}
            usedForGeneration
            defaultOpen
          />
        ))}
        {mode === 'candidates' && candidates.map((hit, index) => (
          <ChunkRow
            key={`candidate-${hit.chunk_id}`}
            projectName={props.projectName}
            rank={index + 1}
            hit={hit}
            resolved={props.resolved.get(hit.chunk_id)}
            context={context.find((item) => item.chunk_id === hit.chunk_id)}
            citations={citationsByChunk.get(hit.chunk_id) ?? []}
            usedForGeneration={contextIds.has(hit.chunk_id)}
          />
        ))}
        {mode === 'citations' && citations.map((citation, index) => {
          const hit = typeof citation.chunk_id !== 'number'
            ? undefined
            : candidates.find((item) => item.chunk_id === citation.chunk_id)
              ?? context.find((item) => item.chunk_id === citation.chunk_id);
          return (
            <ChunkRow
              key={`${citation.citation_id ?? index}-${citation.chunk_id ?? citation.page}`}
              projectName={props.projectName}
              rank={index + 1}
              hit={hit ?? citationFallback(citation)}
              resolved={typeof citation.chunk_id !== 'number' ? undefined : props.resolved.get(citation.chunk_id)}
              context={typeof citation.chunk_id !== 'number' ? undefined : context.find((item) => item.chunk_id === citation.chunk_id)}
              citations={[citation]}
              usedForGeneration={typeof citation.chunk_id === 'number' && contextIds.has(citation.chunk_id)}
              defaultOpen
            />
          );
        })}
        {mode === 'context' && context.length === 0 && <EmptyTrace title="Generation context was not captured" detail="This is a legacy run. Candidate and citation data remain available." />}
        {mode === 'candidates' && candidates.length === 0 && <EmptyTrace title="No retrieval candidates" detail="The request ended before retrieval or no indexed content matched." />}
        {mode === 'citations' && citations.length === 0 && <EmptyTrace title="No citations" detail="The answer did not retain a valid citation marker." />}
      </div>
    </section>
  );
}

function ChunkRow(props: {
  projectName: string;
  rank: number;
  hit: FusedHit | ContextHit;
  resolved?: ResolvedIndexedChunk;
  context?: ContextHit;
  citations: Citation[];
  usedForGeneration: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(props.defaultOpen));
  const chunk = props.resolved?.chunk;
  const page = props.resolved?.page;
  const parent = props.resolved?.parent;
  const title = page?.title ?? props.hit.page_title ?? props.hit.page;
  const path = chunk?.in_page_path ?? props.hit.in_page_path ?? 'Page body';
  const childText = chunk?.text ?? props.hit.text_preview ?? props.citations[0]?.quote ?? '';
  const expanded = props.context?.expanded_parent ?? null;
  const parentText = expanded && parent?.content_hash === expanded.content_hash ? parent.text : null;
  const citedLabels = props.citations.map((item) => item.citation_id).filter(Boolean).join(', ');

  return (
    <details className="rd-chunk" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="rd-rank">{String(props.rank).padStart(2, '0')}</span>
        <span className="rd-chunk-title">
          <strong>{title}</strong>
          <small>{path}</small>
        </span>
        <span className="rd-hit-flags">
          {props.hit.exact_rank != null && <TraceBadge tone="exact">Exact #{props.hit.exact_rank}</TraceBadge>}
          {props.hit.bm25_rank != null && <TraceBadge>BM25 #{props.hit.bm25_rank}</TraceBadge>}
          {props.hit.vec_rank != null && <TraceBadge>Vector #{props.hit.vec_rank}</TraceBadge>}
          {props.usedForGeneration && <TraceBadge tone="context">Context</TraceBadge>}
          {props.citations.length > 0 && <TraceBadge tone="cited">{citedLabels || 'Cited'}</TraceBadge>}
          {props.resolved?.stale_id && <TraceBadge tone="warning">ID changed</TraceBadge>}
        </span>
        <span className="rd-score"><small>final</small>{formatScore(props.hit.final_score)}</span>
        <ChevronDown className="rd-chevron" size={17} />
      </summary>

      <div className="rd-chunk-body">
        {expanded && (
          <section className="rd-context-unit">
            <div className="rd-context-unit-head">
              <span><Layers3 size={14} />Expanded parent used for generation</span>
              <code>parent #{expanded.parent_id} · {expanded.token_count} tok</code>
            </div>
            <pre>{parentText ?? props.context?.text_preview ?? 'Parent text is unavailable in the current index.'}</pre>
            <small>{expanded.heading_path.join(' › ') || expanded.parent_path} · {expanded.child_count} children</small>
          </section>
        )}

        <section className="rd-child-content">
          <div className="rd-subhead">
            <span>{expanded ? 'Matched child' : 'Indexed chunk'}</span>
            <code>#{chunk?.chunk_id ?? props.hit.chunk_id}</code>
          </div>
          <pre>{childText || 'Chunk text is unavailable for this legacy run.'}</pre>
        </section>

        <div className="rd-chunk-meta">
          <Meta label="RRF score" value={formatScore(props.hit.rrf_score)} />
          <Meta label="Final score" value={formatScore(props.hit.final_score)} />
          <Meta label="Vector rank" value={rankValue(props.hit.vec_rank)} />
          <Meta label="BM25 rank" value={rankValue(props.hit.bm25_rank)} />
          <Meta label="Exact rank" value={rankValue(props.hit.exact_rank)} />
          <Meta label="Tokens" value={String(chunk?.token_count ?? props.hit.token_count ?? '—')} />
          <Meta label="Kind" value={chunk?.chunk_kind ?? props.hit.chunk_kind ?? '—'} mono />
          <Meta label="Object" value={chunk?.object_path ?? props.hit.object_path ?? '—'} mono />
          <Meta label="Identifiers" value={chunk?.identifiers.map((item) => item.value).join(', ') || '—'} mono wide />
          <Meta label="Content hash" value={chunk?.content_hash ?? props.hit.content_hash ?? '—'} mono wide />
        </div>

        {props.citations.map((citation) => (
          <div className="rd-citation-evidence" key={citation.citation_id ?? citation.quote}>
            <div><FileText size={14} /><strong>{citation.citation_id ?? 'Citation'}</strong></div>
            <p>{citation.quote}</p>
            {citation.semantic_check && <small data-verdict={citation.semantic_check.verdict}>{citation.semantic_check.verdict}: {citation.semantic_check.reason}</small>}
          </div>
        ))}

        <div className="rd-chunk-actions">
          <a className="ca-button" href={`/p/${encodeURIComponent(props.projectName)}#index?focus=${encodeURIComponent(props.hit.page)}`}><Database size={14} />Open in Index</a>
          {(page?.url ?? props.hit.page_url) && <a className="ca-button" href={page?.url ?? props.hit.page_url ?? '#'} target="_blank" rel="noreferrer"><BookOpen size={14} />Open document<ExternalLink size={12} /></a>}
          {props.resolved?.match === 'content_hash' && <span className="rd-resolution-note"><Fingerprint size={13} />Resolved by content hash</span>}
        </div>
      </div>
    </details>
  );
}

function PipelineTiming({ run }: { run: RunRecord }) {
  const timings = run.retrieval.timings;
  const stages = timings ? [
    { label: 'Router', value: timings.router_ms, icon: <GitBranch /> },
    { label: 'Embedding', value: timings.embedding_ms, icon: <Layers3 /> },
    { label: 'Retrieval', value: timings.retrieval_ms, icon: <Search /> },
    { label: 'Rerank', value: timings.rerank_ms, icon: <ListFilter /> },
    { label: 'Generation', value: timings.generation_ms, icon: <Sparkles /> },
  ] : [];
  const max = Math.max(1, ...stages.map((stage) => stage.value));
  return (
    <RunSection eyebrow="Latency" title="Pipeline timing">
      {stages.length > 0 ? <div className="rd-timing-list">{stages.map((stage) => <div key={stage.label}><span>{stage.icon}{stage.label}</span><div><i style={{ width: `${Math.max(2, (stage.value / max) * 100)}%` }} /></div><strong>{formatDuration(stage.value)}</strong></div>)}</div> : <p className="rd-empty-copy">Stage timing was not captured for this legacy run.</p>}
    </RunSection>
  );
}

function RunConfiguration({ run }: { run: RunRecord }) {
  return (
    <RunSection eyebrow="Runtime" title="Configuration">
      <dl className="rd-config">
        <div><dt>Request</dt><dd><code>{run.request_id}</code></dd></div>
        {run.langfuse_trace_id && <div><dt>Langfuse trace</dt><dd><code>{run.langfuse_trace_id}</code></dd></div>}
        <div><dt>Session</dt><dd><code>{run.session_id ?? '—'}</code></dd></div>
        <div><dt>Model</dt><dd>{run.answer.model ?? '—'}</dd></div>
        <div><dt>Router</dt><dd>{run.retrieval.router_strategy ?? 'legacy'}</dd></div>
        <div><dt>Current page</dt><dd><code>{run.context_pageId ?? '—'}</code></dd></div>
        <div><dt>History turns</dt><dd>{run.answer.history_window ?? 0}</dd></div>
      </dl>
      {Object.keys(run.filters).length > 0 && <pre className="rd-filter-json"><Braces size={13} />{JSON.stringify(run.filters, null, 2)}</pre>}
    </RunSection>
  );
}

function RunSection({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return <section className="rd-panel"><header><span>{eyebrow}</span><h2>{title}</h2></header><div className="rd-panel-body">{children}</div></section>;
}

function SummaryMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return <div><span>{icon}</span><small>{label}</small><strong>{value}</strong></div>;
}

function RetrievalTab(props: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number; disabled?: boolean }) {
  return <button type="button" role="tab" aria-selected={props.active} disabled={props.disabled} onClick={props.onClick}>{props.icon}<span>{props.label}</span><small>{props.count}</small></button>;
}

function TraceBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'exact' | 'context' | 'cited' | 'warning' }) {
  return <span className="rd-trace-badge" data-tone={tone}>{children}</span>;
}

function Meta({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return <div className={wide ? 'is-wide' : undefined}><dt>{label}</dt><dd className={mono ? 'is-mono' : undefined}>{value}</dd></div>;
}

function InlineState({ tone, children }: { tone: 'warning'; children: React.ReactNode }) {
  return <div className="rd-inline-state" data-tone={tone}><CircleAlert size={15} /><span>{children}</span></div>;
}

function EmptyTrace({ title, detail }: { title: string; detail: string }) {
  return <div className="rd-empty-trace"><Hash size={20} /><strong>{title}</strong><p>{detail}</p></div>;
}

function OutcomeBadge({ kind }: { kind: RunRecord['answer']['kind'] }) {
  return <span className="rd-outcome" data-kind={kind}>{kind}</span>;
}

function Markdown({ body }: { body: string }) {
  const html = useMemo(() => marked.parse(body, { async: false, breaks: true, gfm: true }) as string, [body]);
  return <div className="ca-markdown rd-answer" dangerouslySetInnerHTML={{ __html: html }} />;
}

function uniqueChunkRefs(run: RunRecord): Array<{ chunk_id: number; content_hash?: string; page_id?: string }> {
  const refs = new Map<number, { chunk_id: number; content_hash?: string; page_id?: string }>();
  for (const item of [...run.retrieval.fused, ...(run.retrieval.selected_context ?? [])]) {
    refs.set(item.chunk_id, {
      chunk_id: item.chunk_id,
      ...(item.content_hash ? { content_hash: item.content_hash } : {}),
      ...(item.page ? { page_id: item.page } : {}),
    });
  }
  for (const citation of run.answer.citations) {
    if (typeof citation.chunk_id !== 'number' || refs.has(citation.chunk_id)) continue;
    refs.set(citation.chunk_id, { chunk_id: citation.chunk_id, page_id: citation.page });
  }
  return [...refs.values()];
}

function citationFallback(citation: Citation): FusedHit {
  return {
    chunk_id: citation.chunk_id ?? -1,
    page: citation.page,
    rrf_score: 0,
    final_score: 0,
    vec_rank: null,
    bm25_rank: null,
    exact_rank: null,
    nav_index: null,
    text_preview: citation.quote,
  };
}

function rankValue(value: number | null | undefined): string { return value == null ? '—' : `#${value}`; }
function formatScore(value: number | null | undefined): string { return value == null ? '—' : value.toFixed(3); }
function shortId(value: string): string { return value.length > 12 ? `${value.slice(0, 8)}…` : value; }
function formatDuration(value: number | null | undefined): string { if (value == null) return '—'; return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`; }
function formatTimestamp(value: string, long = false): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, long ? { dateStyle: 'medium', timeStyle: 'medium' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); }
