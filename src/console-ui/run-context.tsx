import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Layers3, LoaderCircle, RefreshCw } from 'lucide-react';
import { apiJson, projectApi } from './api';
import type { RunRecord } from './app-types';
import type { RunInputSnapshot } from '../runs/input-snapshot-types';
import './run-context.css';

type ContextData = {
  snapshot: RunInputSnapshot | null;
  status: 'captured' | 'not_generated' | 'omitted_by_policy' | 'legacy';
  currentPage: string | null;
  historyWindow: number | null;
  selectedContext: NonNullable<RunRecord['retrieval']['selected_context']>;
};

export function RunContext({ projectName, requestId, run, full = false }: {
  projectName: string; requestId: string; run?: RunRecord; full?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const context = useQuery({
    queryKey: ['run-input-context', projectName, requestId],
    enabled: open && !run,
    queryFn: ({ signal }) => apiJson<ContextData>(projectApi(projectName, `/runs/${encodeURIComponent(requestId)}/context`), { signal }),
  });
  const data: ContextData | undefined = run ? {
    snapshot: run.input_snapshot ?? null, status: run.input_snapshot_status ?? 'legacy',
    currentPage: run.context_pageId, historyWindow: run.answer.history_window ?? null,
    selectedContext: run.retrieval.selected_context ?? [],
  } : context.data;
  const snapshot = data?.snapshot;
  return <details className="rc-context" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><Layers3 size={14} /><strong>{full ? 'Generation input snapshot' : 'Run context'}</strong>{snapshot && <span>{snapshot.history.length} history · {snapshot.documents.length} documents</span>}<ChevronDown size={14} className="rc-chevron" /></summary>
    {open && <div className="rc-body">
      {!data && context.isPending && <div role="status" className="rc-status"><LoaderCircle className="ca-spin" size={14} />Loading saved context...</div>}
      {context.isError && <div role="alert" className="rc-status">{context.error.message}<button className="ca-button" onClick={() => context.refetch()}><RefreshCw size={13} />Retry</button></div>}
      {data && <>
        <div className="rc-meta"><span>Request page</span><code>{data.currentPage ?? 'Not provided'}</code></div>
        {!snapshot ? <>
          <p className="rc-status">{data.status === 'not_generated' ? 'No answer-generation request was made for this run.' : data.status === 'omitted_by_policy' ? 'Input snapshot omitted by the configured text-retention policy.' : 'Input snapshot was not saved for this run.'}</p>
          {data.historyWindow !== null && <p className="rc-status">Reported history: {data.historyWindow} prior turns. Message text is not available.</p>}
          {data.selectedContext.map((doc) => <details className="rc-document" key={`${doc.chunk_id}:${doc.context_rank}`}><summary>{doc.page_title || doc.page}<span>Saved preview only</span></summary><pre>{doc.text_preview || 'Preview not saved'}</pre></details>)}
        </> : <>
          <div className="rc-snapshot-state"><span>Sensitive-key redaction applied</span><time dateTime={snapshot.captured_at}>{new Date(snapshot.captured_at).toLocaleString()}</time></div>
          {snapshot.truncated_fields.length > 0 && <p className="rc-warning" role="status">Snapshot storage limit reached. Truncated fields: {snapshot.truncated_fields.join(', ')}</p>}
          <section className="rc-section"><h3>Queries</h3><ContextText label="Original question" text={snapshot.question} /><ContextText label="Generation question" text={snapshot.prompt_question} /><ContextText label="Search query" text={snapshot.search_question} /><ContextText label="Retrieval query" text={snapshot.retrieve_question} /></section>
          <section className="rc-section"><h3>History sent to generation <span>{snapshot.history.length}</span></h3>
            {snapshot.history.length === 0 ? <p className="rc-status">No prior turns were included.</p> : snapshot.history.map((turn, index) => <div className="rc-history-turn" key={index}><ContextText label={`Prior turn ${index + 1} · Question`} text={turn.question} /><ContextText label="Answer summary" text={turn.answer_summary} /></div>)}
          </section>
          <section className="rc-section"><h3>Documents sent to generation <span>{snapshot.documents.length}</span></h3>
            {snapshot.documents.length === 0 && <p className="rc-status">No document context was included.</p>}
            {snapshot.documents.map((doc) => <details className="rc-document" key={doc.citation_id}>
              <summary><code>{doc.citation_id}</code><strong>{doc.title || doc.page_id}</strong><ChevronDown size={13} /></summary>
              <div className="rc-document-meta">
                <code>{doc.page_id}</code><span>{doc.lang}</span><span>Child {doc.chunk_id}</span>
                {doc.expanded_parent ? <><span>Expanded parent {doc.expanded_parent.parent_id}</span><code>{doc.expanded_parent.parent_path}</code><code>Parent hash: {doc.expanded_parent.content_hash}</code></> : <span>Child text</span>}
                <code>{doc.path}</code>{doc.content_hash && <code>Child hash: {doc.content_hash}</code>}{doc.url && <span>Source: {doc.url}</span>}
              </div><pre>{doc.text}</pre>
            </details>)}
          </section>
          {full ? <section className="rc-section"><h3>Generation requests <span>{snapshot.attempts.length}</span></h3>
            {snapshot.attempts.map((attempt, index) => <details className="rc-document" key={index}><summary><strong>Attempt {index + 1}</strong><span>{attempt.outcome}{attempt.accepted ? ' · Used for answer' : ''}</span><ChevronDown size={13} /></summary>{attempt.model && <p className="rc-status">{attempt.model}</p>}<ContextText label="System prompt" text={attempt.system_prompt} /><ContextText label="User prompt" text={attempt.user_prompt} /></details>)}
          </section> : <p className="rc-status">{snapshot.attempts.length} generation {snapshot.attempts.length === 1 ? 'request' : 'requests'} · Full prompts in Run detail</p>}
        </>}
      </>}
    </div>}
  </details>;
}

function ContextText({ label, text }: { label: string; text: string }) {
  return <div className="rc-text"><h4>{label}</h4><pre>{text || '(empty)'}</pre></div>;
}
