import React, { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Check, Copy, LoaderCircle, MessageSquareText, RefreshCw } from 'lucide-react';
import { apiJson, projectApi } from './api';
import type { RunRecord } from './app-types';
import { conversationKey, matchesConversationRun } from '../runs/conversations';
import { renderTranscriptMarkdown } from './transcript-markdown';
import { RunContext } from './run-context';
import './traffic-conversations.css';

type Turn = Pick<RunRecord, 'request_id' | 'ts' | 'query' | 'context_pageId' | 'answer'>;
type ConversationPage = {
  sessionId: string | null; source: string; title: string; total: number;
  offset: number; nextOffset: number | null; turns: Turn[];
};
const timestamp = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const duration = (value: number) => value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;

export function TrafficConversations({ projectName, groups, returnTo, filters, pagination }: {
  projectName: string; groups: RunRecord[][]; returnTo: string;
  filters: { query: string; source: string; kind: string }; pagination: React.ReactNode;
}) {
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('traffic_session'));
  const [copied, setCopied] = useState(false);
  const href = (requestId: string | null) => {
    const url = new URL(returnTo, window.location.origin);
    if (requestId) url.searchParams.set('traffic_session', requestId);
    return `${url.pathname}${url.search}${url.hash}`;
  };
  useEffect(() => {
    window.history.replaceState(null, '', href(selected));
  }, [returnTo, selected]);
  useEffect(() => {
    const pop = () => setSelected(new URLSearchParams(window.location.search).get('traffic_session'));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const conversation = useInfiniteQuery({
    queryKey: ['traffic-conversation', projectName, selected],
    enabled: Boolean(selected),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => apiJson<ConversationPage>(projectApi(projectName,
      `/conversation?${new URLSearchParams({ request_id: selected!, offset: String(pageParam) })}`), { signal }),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const first = conversation.data?.pages[0];
  const turns = conversation.data?.pages.flatMap((part) => part.turns) ?? [];
  const selectedKey = first ? conversationKey({ request_id: selected!, session_id: first.sessionId, source: first.source, ts: '', query: '', answer: { md: null, kind: '', latency_ms: 0 } }) : null;
  const choose = (id: string | null) => { setSelected(id); setCopied(false); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(first?.sessionId ?? selected ?? ''); setCopied(true); }
    catch { setCopied(false); }
  };
  return <div className="tc-browser" data-selected={Boolean(selected)}>
    <aside className="tc-list" aria-label="Conversations">
      <div className="tc-list-heading"><h2>Conversations</h2><span>Latest activity</span></div>
      <div className="tc-items">
        {groups.length === 0 && <div className="tc-empty"><MessageSquareText size={24} /><h3>No matching conversations</h3></div>}
        {groups.map((runs) => {
          const start = runs[0]!; const latest = runs[runs.length - 1]!;
          const active = selectedKey === conversationKey(start) || runs.some((run) => run.request_id === selected);
          const errors = runs.filter((run) => run.answer.kind === 'error').length;
          const match = runs.find((run) => matchesConversationRun(run, filters));
          return <button className="tc-item" key={conversationKey(start)} aria-pressed={active} onClick={() => choose(latest.request_id)}>
            <span className="tc-item-meta"><span>{start.source ?? 'reader'}</span><time dateTime={latest.ts}>{timestamp(latest.ts)}</time></span>
            <strong>{start.query || 'Untitled conversation'}</strong>
            <span className="tc-preview">{filters.query && match ? match.query : runs.length > 1 ? latest.query : latest.answer.md ?? latest.answer.error_code ?? 'No saved answer'}</span>
            <span className="tc-item-footer"><span><MessageSquareText size={13} />{runs.length} {runs.length === 1 ? 'run' : 'runs'} in range</span>{errors > 0 ? <span className="tc-errors">{errors} {errors === 1 ? 'error' : 'errors'}</span> : <span>{latest.answer.kind}</span>}{!start.session_id?.trim() && <span>No session ID</span>}</span>
          </button>;
        })}
      </div>
      {pagination}
    </aside>
    <section className="tc-conversation" aria-label="Conversation history" aria-busy={Boolean(selected) && conversation.isPending}>
      {!selected ? <div className="tc-empty tc-empty-selection"><MessageSquareText size={32} /><h2>Select a conversation</h2></div> : <>
        <header className="tc-detail-head">
          <button className="ca-icon-button" aria-label="Back to conversations" title="Back to conversations" onClick={() => choose(null)}><ArrowLeft size={17} /></button>
          <div><h2>{first?.title ?? 'Conversation'}</h2><div className="tc-session-meta"><span>{first?.source ?? ''}</span><code>{first?.sessionId ?? 'No session ID'}</code></div></div>
          <button className="ca-icon-button" aria-label={copied ? 'Copied session ID' : 'Copy session ID'} title={copied ? 'Copied' : 'Copy session ID'} disabled={!first} onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
        </header>
        {first && <div className="tc-history-summary"><span>{first.total} saved {first.total === 1 ? 'run' : 'runs'} · All dates</span><span>{turns.length} loaded</span></div>}
        {conversation.isPending && <div className="tc-empty" role="status"><LoaderCircle size={20} className="ca-spin" />Loading conversation...</div>}
        {conversation.isError && <div className="tc-empty" role="alert"><p>{conversation.error.message}</p><button className="ca-button" onClick={() => conversation.refetch()}><RefreshCw size={14} />Retry</button></div>}
        <div className="tc-transcript" key={selected}>
          {turns.map((turn, index) => <article className="tc-turn" id={`turn-${turn.request_id}`} key={turn.request_id}>
            <div className="tc-turn-head"><span>Turn {index + 1}</span><time dateTime={turn.ts}>{timestamp(turn.ts)}</time><a href={`/p/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(turn.request_id)}?return=${encodeURIComponent(href(selected))}`} aria-label={`Run detail for turn ${index + 1}`}>Run detail<ArrowUpRight size={14} /></a></div>
            <div className="tc-user"><span className="tc-role">User</span><p>{turn.query}</p></div>
            <div className="tc-assistant" data-outcome={turn.answer.kind}><div className="tc-assistant-label"><span className="tc-role">Assistant</span><span className="tc-outcome">{turn.answer.kind}</span><span>{duration(turn.answer.latency_ms)}</span></div>
              {turn.answer.md ? <TranscriptMarkdown body={turn.answer.md} /> : <p className="tc-missing">{turn.answer.error_code ?? 'Answer text was not saved for this run.'}</p>}
              <div className="tc-turn-meta">{turn.answer.model && <span>{turn.answer.model}</span>}<span>{turn.answer.citations.length} citations</span>{turn.answer.history_window !== undefined && <span>{turn.answer.history_window} prior turns used</span>}{turn.context_pageId && <span title={turn.context_pageId}>Page: {turn.context_pageId}</span>}</div>
              <RunContext projectName={projectName} requestId={turn.request_id} />
            </div>
          </article>)}
          {conversation.hasNextPage && <button className="ca-button tc-load-more" disabled={conversation.isFetchingNextPage} onClick={() => conversation.fetchNextPage()}>{conversation.isFetchingNextPage && <LoaderCircle className="ca-spin" size={14} />}Load more turns</button>}
        </div>
      </>}
    </section>
  </div>;
}

function TranscriptMarkdown({ body }: { body: string }) {
  const html = useMemo(() => renderTranscriptMarkdown(body), [body]);
  return <div className="ca-markdown tc-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
