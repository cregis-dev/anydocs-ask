import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  Database,
  FileJson2,
  FileText,
  Hash,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { fetchPageChunks, rebuildIndex } from './api';
import type {
  IndexBootstrap,
  IndexedChunk,
  IndexedPageChunks,
  IndexLanguage,
  IndexPage,
} from './types';

type Props = { initial: IndexBootstrap };

export function IndexExplorer({ initial }: Props) {
  const firstLang = initial.langs[0]?.lang ?? '';
  const [language, setLanguage] = useState(firstLang);
  const [pageFilter, setPageFilter] = useState('');
  const [chunkFilter, setChunkFilter] = useState('');
  const [selectedPageKey, setSelectedPageKey] = useState(() => {
    const focusPageId = initial.focusPageId ?? focusFromHash();
    const preferred = initial.langs
      .flatMap((entry) => [...entry.pages, ...entry.orphans])
      .find((page) => page.id === focusPageId && !page.missingFile);
    return preferred ? pageKey(preferred) : firstSelectableKey(initial.langs[0]);
  });
  const [selectedChunkId, setSelectedChunkId] = useState<number | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const langData = initial.langs.find((entry) => entry.lang === language) ?? initial.langs[0];
  const allPages = useMemo(() => langData ? [...langData.pages, ...langData.orphans] : [], [langData]);
  const selectablePages = useMemo(() => allPages.filter((page) => !page.missingFile), [allPages]);
  const selectedPage = selectablePages.find((page) => pageKey(page) === selectedPageKey)
    ?? selectablePages[0]
    ?? null;

  useEffect(() => {
    if (selectedPage && selectedPage.lang !== language) setLanguage(selectedPage.lang);
  }, [language, selectedPage]);

  useEffect(() => {
    if (!selectedPage && selectablePages[0]) setSelectedPageKey(pageKey(selectablePages[0]));
  }, [selectablePages, selectedPage]);

  useEffect(() => {
    const applyFocus = () => {
      const pageId = focusFromHash();
      if (!pageId) return;
      const target = initial.langs
        .flatMap((entry) => [...entry.pages, ...entry.orphans])
        .find((page) => page.id === pageId && !page.missingFile);
      if (!target) return;
      setLanguage(target.lang);
      setSelectedPageKey(pageKey(target));
      window.setTimeout(() => {
        document.querySelector(`[data-page-id="${CSS.escape(pageId)}"]`)?.scrollIntoView({
          block: 'center',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      }, 0);
    };
    window.addEventListener('hashchange', applyFocus);
    return () => window.removeEventListener('hashchange', applyFocus);
  }, [initial.langs]);

  const chunksQuery = useQuery({
    queryKey: ['index-chunks', initial.projectName, selectedPage?.lang, selectedPage?.id],
    queryFn: () => fetchPageChunks(initial.projectName, selectedPage!.id, selectedPage!.lang),
    enabled: Boolean(initial.childLive && selectedPage),
  });

  const chunks = chunksQuery.data?.chunks ?? [];
  useEffect(() => {
    if (chunks.length === 0) {
      setSelectedChunkId(null);
      return;
    }
    if (!chunks.some((chunk) => chunk.chunk_id === selectedChunkId)) {
      setSelectedChunkId(chunks[0]!.chunk_id);
    }
  }, [chunks, selectedChunkId]);

  const visibleChunks = useMemo(() => {
    const query = chunkFilter.trim().toLowerCase();
    if (!query) return chunks;
    return chunks.filter((chunk) =>
      `${chunk.in_page_path ?? ''} ${chunk.text} ${chunk.content_hash}`.toLowerCase().includes(query),
    );
  }, [chunkFilter, chunks]);
  const selectedChunk = chunks.find((chunk) => chunk.chunk_id === selectedChunkId) ?? null;

  const reindex = useMutation({
    mutationFn: () => rebuildIndex(initial.projectName),
    onSuccess: () => window.location.reload(),
  });

  const db = initial.dbStatus;
  const avgChunks = db && initial.totalPages > 0
    ? (db.chunk_count / initial.totalPages).toFixed(1)
    : '—';

  return (
    <Tooltip.Provider delayDuration={350}>
      <section className="ix-shell" aria-label="Index workspace">
        <header className="ix-head">
          <div>
            <div className="ix-eyebrow"><Database size={13} /> Knowledge index</div>
            <h1>Content inventory</h1>
          </div>
          <div className="ix-head-actions">
            <span className={`ix-sync ${initial.childLive ? 'is-live' : ''}`}>
              <span />{initial.childLive ? 'Index online' : 'Service idle'}
            </span>
            <button
              className="ix-button ix-button-primary"
              type="button"
              disabled={!initial.childLive || reindex.isPending}
              onClick={() => reindex.mutate()}
            >
              {reindex.isPending ? <LoaderCircle className="ix-spin" size={15} /> : <RefreshCw size={15} />}
              {reindex.isPending ? 'Reindexing' : 'Reindex'}
            </button>
          </div>
        </header>

        {reindex.isError && <InlineNotice tone="error">{reindex.error.message}</InlineNotice>}
        {initial.warnings.length > 0 && (
          <InlineNotice tone="warning">{initial.warnings[0]}</InlineNotice>
        )}

        <div className="ix-metrics" aria-label="Index metrics">
          <Metric icon={<FileText />} label="On disk" value={initial.totalPages} suffix="pages" />
          <Metric icon={<Database />} label="In database" value={db?.page_count ?? '—'} suffix="pages" />
          <Metric icon={<Layers3 />} label="Chunks" value={db?.chunk_count ?? '—'} suffix={`avg ${avgChunks} / page`} />
          <Metric icon={<Sparkles />} label="Embedding cache" value={db?.embedding_cache_size ?? '—'} suffix={db?.embedding_model ?? 'offline'} />
          <Metric icon={<Clock3 />} label="Last indexed" value={formatTime(db?.last_indexed_at)} suffix={db?.llm_model ?? '—'} compact />
        </div>

        <div className="ix-workspace">
          <PageRail
            languages={initial.langs}
            language={language}
            setLanguage={(next) => {
              setLanguage(next);
              const nextLang = initial.langs.find((entry) => entry.lang === next);
              setSelectedPageKey(firstSelectableKey(nextLang));
              setPageFilter('');
            }}
            pages={allPages}
            filter={pageFilter}
            setFilter={setPageFilter}
            selectedPageKey={selectedPage ? pageKey(selectedPage) : ''}
            onSelect={(page) => {
              setSelectedPageKey(pageKey(page));
              setChunkFilter('');
              setSelectedChunkId(null);
            }}
          />

          <ChunkList
            page={selectedPage}
            data={chunksQuery.data}
            loading={chunksQuery.isLoading}
            error={chunksQuery.error}
            serviceLive={initial.childLive}
            chunks={visibleChunks}
            filter={chunkFilter}
            setFilter={setChunkFilter}
            selectedChunkId={selectedChunkId}
            onSelect={(chunk) => {
              setSelectedChunkId(chunk.chunk_id);
              if (window.matchMedia('(max-width: 1180px)').matches) setMobileDetailOpen(true);
            }}
          />

          <aside className="ix-inspector" aria-label="Chunk metadata">
            <ChunkInspector data={chunksQuery.data} chunk={selectedChunk} />
          </aside>
        </div>
      </section>

      <Dialog.Root open={mobileDetailOpen} onOpenChange={setMobileDetailOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="ix-dialog-overlay" />
          <Dialog.Content className="ix-dialog-content" aria-describedby={undefined}>
            <Dialog.Title className="ix-dialog-title">Chunk detail</Dialog.Title>
            <Dialog.Close className="ix-icon-button" aria-label="Close chunk detail"><X size={18} /></Dialog.Close>
            <ChunkInspector data={chunksQuery.data} chunk={selectedChunk} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Tooltip.Provider>
  );
}

function PageRail(props: {
  languages: IndexLanguage[];
  language: string;
  setLanguage: (language: string) => void;
  pages: IndexPage[];
  filter: string;
  setFilter: (value: string) => void;
  selectedPageKey: string;
  onSelect: (page: IndexPage) => void;
}) {
  const query = props.filter.trim().toLowerCase();
  const visible = props.pages.filter((page) =>
    `${page.title} ${page.id} ${page.breadcrumb.join(' ')}`.toLowerCase().includes(query),
  );
  const groups = groupPages(visible);

  return (
    <aside className="ix-page-rail" aria-label="Indexed pages">
      <div className="ix-pane-head">
        <div><span className="ix-pane-kicker">Documents</span><strong>{props.pages.length} pages</strong></div>
        <div className="ix-segmented" role="tablist" aria-label="Language">
          {props.languages.map((entry) => (
            <button
              type="button"
              role="tab"
              aria-selected={entry.lang === props.language}
              key={entry.lang}
              onClick={() => props.setLanguage(entry.lang)}
            >
              {entry.lang}<span>{entry.pages.length + entry.orphans.length}</span>
            </button>
          ))}
        </div>
      </div>
      <SearchField value={props.filter} onChange={props.setFilter} placeholder="Filter documents" />
      <div className="ix-page-scroll">
        {groups.map(([group, pages]) => (
          <section className="ix-page-group" key={group}>
            <h2>{group}<span>{pages.length}</span></h2>
            {pages.map((page) => {
              const missing = Boolean(page.missingFile);
              return (
                <button
                  type="button"
                  className="ix-page-row"
                  data-selected={pageKey(page) === props.selectedPageKey}
                  data-page-id={page.id}
                  data-ask-mark={page.askStats
                    ? (page.askStats.medianConfidence !== null && page.askStats.medianConfidence < .5 ? 'warn' : 'ok')
                    : undefined}
                  data-ask-count={page.askStats?.count}
                  disabled={missing}
                  key={pageKey(page)}
                  onClick={() => props.onSelect(page)}
                >
                  <FileJson2 size={15} />
                  <span className="ix-page-copy"><strong>{page.title}</strong><small>{page.id}</small></span>
                  <span className="ix-page-tail">
                    {page.askStats && (
                      <span className="ix-ask-mark" data-warn={page.askStats.medianConfidence !== null && page.askStats.medianConfidence < .5}>
                        {page.askStats.count}
                      </span>
                    )}
                    {missing ? <CircleAlert size={14} /> : <ChevronRight size={14} />}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
        {visible.length === 0 && <PaneEmpty>No matching documents</PaneEmpty>}
      </div>
    </aside>
  );
}

function ChunkList(props: {
  page: IndexPage | null;
  data?: IndexedPageChunks;
  loading: boolean;
  error: Error | null;
  serviceLive: boolean;
  chunks: IndexedChunk[];
  filter: string;
  setFilter: (value: string) => void;
  selectedChunkId: number | null;
  onSelect: (chunk: IndexedChunk) => void;
}) {
  if (!props.page) return <main className="ix-chunk-pane"><PaneEmpty>No indexed pages</PaneEmpty></main>;

  return (
    <main className="ix-chunk-pane">
      <div className="ix-pane-head ix-chunk-head">
        <div className="ix-page-title">
          <span className="ix-pane-kicker">{props.page.breadcrumb.join(' / ') || 'Indexed page'}</span>
          <strong>{props.page.title}</strong>
          <code>{props.page.id}</code>
        </div>
        <span className="ix-count">{props.data?.chunks.length ?? '—'} chunks</span>
      </div>
      <SearchField value={props.filter} onChange={props.setFilter} placeholder="Filter chunks" />
      <div className="ix-chunk-scroll">
        {!props.serviceLive && <PaneEmpty>Start the project to inspect its index</PaneEmpty>}
        {props.loading && <LoadingRows />}
        {props.error && <PaneEmpty tone="error">{props.error.message}</PaneEmpty>}
        {!props.loading && !props.error && props.serviceLive && props.chunks.map((chunk) => (
          <button
            type="button"
            className="ix-chunk-row"
            data-selected={chunk.chunk_id === props.selectedChunkId}
            key={chunk.chunk_id}
            onClick={() => props.onSelect(chunk)}
          >
            <span className="ix-chunk-no">{String(chunk.ordinal).padStart(2, '0')}</span>
            <span className="ix-chunk-body">
              <span className="ix-chunk-path">
                {chunk.is_code ? <Code2 size={13} /> : <Braces size={13} />}
                {chunk.in_page_path ?? 'page body'}
              </span>
              <span className="ix-chunk-preview">{preview(chunk.text)}</span>
              <span className="ix-chunk-meta">
                <span>{chunk.token_count} tokens</span>
                <span>{chunk.text.length} chars</span>
                <span className={chunk.embedded ? 'is-ok' : 'is-warn'}>
                  {chunk.embedded ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
                  {chunk.embedded ? 'embedded' : 'missing vector'}
                </span>
              </span>
            </span>
            <ChevronRight className="ix-row-arrow" size={15} />
          </button>
        ))}
        {!props.loading && !props.error && props.serviceLive && props.data && props.chunks.length === 0 && (
          <PaneEmpty>No matching chunks</PaneEmpty>
        )}
      </div>
    </main>
  );
}

function ChunkInspector({ data, chunk }: { data?: IndexedPageChunks; chunk: IndexedChunk | null }) {
  const [copied, setCopied] = useState(false);
  if (!data || !chunk) return <PaneEmpty>Select a chunk</PaneEmpty>;
  const page = data.page;

  const copy = async () => {
    await navigator.clipboard.writeText(chunk.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="ix-detail">
      <div className="ix-detail-head">
        <div>
          <span className="ix-pane-kicker">Chunk {String(chunk.ordinal).padStart(2, '0')}</span>
          <strong>{chunk.in_page_path ?? 'Page body'}</strong>
        </div>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button className="ix-icon-button" type="button" onClick={copy} aria-label="Copy chunk text">
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Content className="ix-tooltip" sideOffset={6}>{copied ? 'Copied' : 'Copy text'}</Tooltip.Content></Tooltip.Portal>
        </Tooltip.Root>
      </div>

      <div className="ix-detail-text"><pre>{chunk.text}</pre></div>

      <section className="ix-meta-section">
        <h3>Chunk metadata</h3>
        <dl className="ix-meta-grid">
          <Meta label="Chunk ID" value={String(chunk.chunk_id)} mono />
          <Meta label="Tokens" value={String(chunk.token_count)} />
          <Meta label="Characters" value={String(chunk.text.length)} />
          <Meta label="Content" value={chunk.is_code ? 'Code / structured' : 'Text / structured'} />
          <Meta label="Vector" value={chunk.embedded ? 'Ready' : 'Missing'} good={chunk.embedded} />
          <Meta label="Cache" value={chunk.embedding_cached ? 'Hit' : 'Missing'} good={chunk.embedding_cached} />
        </dl>
      </section>

      <section className="ix-meta-section">
        <h3>Source metadata</h3>
        <dl className="ix-source-list">
          <Meta label="Page" value={page.page_id} mono />
          <Meta label="Language" value={page.lang} />
          <Meta label="Subtree" value={page.subtree_root ?? '—'} mono />
          <Meta label="Parent" value={page.parent_id ?? '—'} mono />
          <Meta label="Hash" value={chunk.content_hash} mono />
          <Meta label="Indexed" value={formatDate(chunk.created_at)} />
        </dl>
      </section>
    </div>
  );
}

function Metric(props: { icon: React.ReactNode; label: string; value: string | number; suffix: string; compact?: boolean }) {
  return (
    <div className="ix-metric">
      <span className="ix-metric-icon">{props.icon}</span>
      <span className="ix-metric-label">{props.label}</span>
      <strong className={props.compact ? 'is-compact' : ''}>{props.value}</strong>
      <small>{props.suffix}</small>
    </div>
  );
}

function SearchField(props: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="ix-search">
      <Search size={14} />
      <span className="sr-only">{props.placeholder}</span>
      <input
        type="search"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
      />
      {props.value && (
        <button type="button" onClick={() => props.onChange('')} aria-label={`Clear ${props.placeholder.toLowerCase()}`}><X size={13} /></button>
      )}
    </label>
  );
}

function Meta(props: { label: string; value: string; mono?: boolean; good?: boolean }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd className={props.mono ? 'is-mono' : ''} data-good={props.good || undefined}>{props.value}</dd>
    </div>
  );
}

function InlineNotice({ children, tone }: { children: React.ReactNode; tone: 'warning' | 'error' }) {
  return <div className="ix-notice" data-tone={tone}><CircleAlert size={15} />{children}</div>;
}

function PaneEmpty({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return <div className="ix-pane-empty" data-tone={tone}><FileText size={19} />{children}</div>;
}

function LoadingRows() {
  return <div className="ix-loading" aria-label="Loading chunks">{[0, 1, 2, 3].map((i) => <span key={i} />)}</div>;
}

function groupPages(pages: IndexPage[]): Array<[string, IndexPage[]]> {
  const groups = new Map<string, IndexPage[]>();
  for (const page of pages) {
    const group = page.breadcrumb.length > 1
      ? page.breadcrumb.join(' › ')
      : (page.breadcrumb[0] ?? (page.id.startsWith('reference/') ? 'API Reference' : 'Unsorted'));
    const list = groups.get(group) ?? [];
    list.push(page);
    groups.set(group, list);
  }
  return [...groups.entries()];
}

function firstSelectableKey(language?: IndexLanguage): string {
  const page = [...(language?.pages ?? []), ...(language?.orphans ?? [])].find((item) => !item.missingFile);
  return page ? pageKey(page) : '';
}

function pageKey(page: IndexPage): string {
  return `${page.lang}:${page.id}`;
}

function focusFromHash(): string | null {
  const query = window.location.hash.split('?', 2)[1];
  return query ? new URLSearchParams(query).get('focus') : null;
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 190);
}

function formatTime(value?: number | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}
