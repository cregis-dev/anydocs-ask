import React, { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { marked } from 'marked';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileChartColumn,
  FileText,
  FolderOpen,
  Gauge,
  Home,
  Layers3,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import { apiJson, projectApi } from './api';
import { IndexExplorer } from './index-explorer';
import type {
  AskConfigView,
  CandidateSnapshot,
  ConsoleBootstrap,
  EvalSnapshot,
  FeedbackRow,
  FeedbackSnapshot,
  GoldenCandidate,
  HomeBootstrap,
  Navigation,
  ProcessInfo,
  ProjectBootstrap,
  ReportBootstrap,
  RunRecord,
  RunsBootstrap,
  TrafficViewState,
  TrafficWindow,
} from './app-types';
import { RunDetailScreen } from './run-detail';
import { TrafficConversations } from './traffic-conversations';
import { groupConversations, matchesConversationRun } from '../runs/conversations';
import type { RuntimeBuildMetadata } from '../runtime-build';

const PROJECT_TABS = ['ask', 'index', 'eval', 'traffic', 'feedback', 'settings'] as const;
type ProjectTab = typeof PROJECT_TABS[number];

export function ConsoleApp({ bootstrap }: { bootstrap: ConsoleBootstrap }) {
  if (bootstrap.kind === 'home') return <HomeScreen data={bootstrap} />;
  if (bootstrap.kind === 'project') return <ProjectScreen data={bootstrap} />;
  if (bootstrap.kind === 'report') return <ReportScreen data={bootstrap} />;
  if (bootstrap.kind === 'run-detail') {
    return <RunDetailScreen data={bootstrap} header={<AppHeader navigation={bootstrap.navigation} current={bootstrap.projectName} />} />;
  }
  return <RunsScreen data={bootstrap} />;
}

function AppHeader({ navigation, current }: { navigation: Navigation; current?: string }) {
  return (
    <>
      <a className="ca-skip-link" href="#console-main">Skip to content</a>
      <header className="ca-header">
        <a className="ca-brand" href={navigation.publicRootPath || '/'} aria-label="anydocs-ask console home">
          <span className="ca-brand-mark" aria-hidden="true" />
          <strong>anydocs-ask</strong><span>/ console</span>
        </a>
        {navigation.projects.length > 0 && (
          <label className="ca-project-switch">
            <span className="ca-sr-only">Switch project</span>
            <select value={current ?? ''} onChange={(event) => {
              const next = event.target.value;
              if (next) window.location.href = `/p/${encodeURIComponent(next)}`;
            }}>
              {!current && <option value="">Open project</option>}
              {navigation.projects.filter((p) => p.valid).map((project) => (
                <option value={project.name} key={project.name}>
                  {navigation.running.includes(project.name) ? '●' : '○'} {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ca-header-spacer" />
        <span className="ca-environment"><span aria-hidden="true" />local console</span>
        <span className="ca-host">127.0.0.1:{navigation.consolePort}</span>
        {navigation.authEnabled && (
          <Tooltip.Provider delayDuration={300}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <a className="ca-icon-button ca-header-action" href="/logout" aria-label="Sign out"><LogOut size={17} /></a>
              </Tooltip.Trigger>
              <Tooltip.Portal><Tooltip.Content className="ca-tooltip">Sign out</Tooltip.Content></Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        )}
      </header>
    </>
  );
}

function HomeScreen({ data }: { data: HomeBootstrap }) {
  const navigation: Navigation = {
    projects: data.projects,
    running: Object.values(data.running).filter((entry) => !entry.exited).map((entry) => entry.name),
    consolePort: data.consolePort,
    idleTimeoutMin: data.idleTimeoutMin,
    authEnabled: data.authEnabled,
    publicRootPath: data.publicRootPath,
    build: data.build,
  };
  const [addOpen, setAddOpen] = useState(false);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const addProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiJson<{ name: string }>('/api/projects/add', {
        method: 'POST', body: JSON.stringify({ path, name: name || undefined }),
      });
      window.location.href = `/p/${encodeURIComponent(result.name)}?autostart=1`;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="ca-app">
      <AppHeader navigation={navigation} />
      <main className="ca-home" id="console-main">
        <div className="ca-page-title">
          <div><span className="ca-kicker">Workspace</span><h1>Documentation projects</h1></div>
          <button className="ca-button ca-primary" type="button" onClick={() => setAddOpen(true)}><Plus size={16} />Add project</button>
        </div>
        <div className="ca-metric-strip">
          <Metric label="Projects" value={`${data.workspaceSummary.projectsValid}/${data.workspaceSummary.projectsTotal}`} icon={<FolderOpen />} />
          <Metric label="Indexed" value={data.workspaceSummary.projectsIndexed} icon={<Database />} />
          <Metric label="Running" value={data.workspaceSummary.projectsRunning} icon={<Activity />} />
          <Metric label="Golden cases" value={data.workspaceSummary.totalCases} icon={<ClipboardCheck />} />
          <Metric label="Runs · 7d" value={data.workspaceSummary.totalRuns7d} icon={<BarChart3 />} />
        </div>
        {data.projects.length === 0 ? (
          <EmptyState icon={<FolderOpen />} title="No projects yet" detail="Register a documentation folder to begin indexing and evaluation.">
            <button className="ca-button ca-primary" type="button" onClick={() => setAddOpen(true)}><Plus size={16} />Add project</button>
          </EmptyState>
        ) : (
          <div className="ca-project-grid">
            {data.projects.map((project) => (
              <ProjectCard
                key={project.name}
                project={project}
                running={data.running[project.name] ?? null}
                stats={data.projectStats[project.name]}
              />
            ))}
          </div>
        )}
      </main>
      <Dialog.Root open={addOpen} onOpenChange={setAddOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="ca-dialog-overlay" />
          <Dialog.Content className="ca-dialog ca-dialog-sm">
            <Dialog.Title>Add project</Dialog.Title>
            <Dialog.Description>Register a local AnyDocs project folder.</Dialog.Description>
            <form onSubmit={addProject} className="ca-form-stack">
              <Field label="Project path"><input required autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder="~/workspace/docs" /></Field>
              <Field label="Display name" hint="Optional"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="cregis-docs" /></Field>
              {error && <Notice tone="error">{error}</Notice>}
              <div className="ca-dialog-actions"><Dialog.Close className="ca-button" type="button">Cancel</Dialog.Close><button className="ca-button ca-primary" disabled={busy} type="submit">{busy && <LoaderCircle className="ca-spin" size={15} />}Add project</button></div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function ProjectCard({ project, running, stats }: { project: HomeBootstrap['projects'][number]; running: ProcessInfo | null; stats?: HomeBootstrap['projectStats'][string] }) {
  const live = Boolean(running && !running.exited);
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    if (!window.confirm(`Remove ${project.name} from this workspace? Source files are not deleted.`)) return;
    setDeleting(true);
    try {
      await apiJson(projectApi(project.name, `?purge_state=true&force_stop=${live}`), { method: 'DELETE' });
      window.location.reload();
    } catch (err) {
      window.alert(errorMessage(err));
      setDeleting(false);
    }
  };
  return (
    <article className="ca-project-card" data-invalid={!project.valid || undefined}>
      <div className="ca-project-card-head">
        <span className="ca-project-icon"><BookOpen size={18} /></span>
        <div><h2>{project.name}</h2><p>{project.title ?? project.description ?? 'AnyDocs project'}</p></div>
        <StatusBadge tone={!project.valid ? 'error' : live ? 'live' : 'neutral'}>{!project.valid ? 'invalid' : live ? `:${running!.port}` : 'idle'}</StatusBadge>
      </div>
      <dl className="ca-project-stats">
        <div><dt>index</dt><dd>{project.indexed ? 'ready' : 'missing'}</dd></div>
        <div><dt>cases</dt><dd>{stats?.cases ?? 0}</dd></div>
        <div><dt>runs · 7d</dt><dd>{stats?.runs7d ?? 0}</dd></div>
      </dl>
      <code className="ca-path">{project.path}</code>
      {!project.valid && <Notice tone="error">Missing {project.missing.join(', ')}</Notice>}
      <div className="ca-project-card-actions">
        <a className="ca-button ca-primary" href={`/p/${encodeURIComponent(project.name)}`}>Open<ChevronRight size={15} /></a>
        <button className="ca-icon-button" disabled={deleting} type="button" onClick={remove} aria-label={`Remove ${project.name}`}><Trash2 size={16} /></button>
      </div>
    </article>
  );
}

function ProjectScreen({ data }: { data: ProjectBootstrap }) {
  const [tab, setTab] = useHashTab();
  const [running, setRunning] = useState(data.running);
  const [health, setHealth] = useState<'idle' | 'warming' | 'ready' | 'error'>(data.running ? 'warming' : 'idle');
  const [askBuild, setAskBuild] = useState<RuntimeBuildMetadata | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch(projectApi(data.project.name, '/health'), {
          headers: { Accept: 'application/json' },
        });
        const result = await response.json() as {
          runtime?: { warm?: boolean };
          warm?: boolean;
          build?: RuntimeBuildMetadata;
          error?: string;
        };
        if (!response.ok && response.status !== 503) {
          throw new Error(result.error ?? `Health check failed (${response.status})`);
        }
        if (!cancelled) {
          setHealth((result.runtime?.warm ?? result.warm) ? 'ready' : 'warming');
          setAskBuild(result.build ?? null);
        }
      } catch {
        if (!cancelled) setHealth('error');
      }
    };
    void check();
    const timer = window.setInterval(check, 8_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [data.project.name, running]);

  useEffect(() => {
    if (data.autostart && !running && data.project.valid) void lifecycle('start');
  }, []);

  const lifecycle = async (action: 'start' | 'stop') => {
    setLifecycleBusy(true);
    try {
      const result = await apiJson<{ port?: number }>(projectApi(data.project.name, `/${action}`), { method: 'POST' });
      if (action === 'start') {
        setRunning({ name: data.project.name, pid: 0, port: result.port ?? 0, startedAt: Date.now(), lastUsedAt: Date.now(), exited: false });
        setHealth('warming');
      } else {
        setRunning(null);
        setHealth('idle');
        setAskBuild(null);
      }
    } catch (err) {
      window.alert(errorMessage(err));
    } finally {
      setLifecycleBusy(false);
    }
  };

  return (
    <div className="ca-app">
      <AppHeader navigation={data.navigation} current={data.project.name} />
      <div className="ca-project-layout">
        <aside className={`ca-sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Project runtime">
          <div className="ca-sidebar-head"><span>Project</span><button className="ca-icon-button" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close project sidebar"><PanelLeftClose size={17} /></button></div>
          <section className="ca-status-panel">
            <div className="ca-status-title"><div><span className="ca-kicker">Runtime</span><h2>{data.project.name}</h2></div><StatusBadge tone={health === 'ready' ? 'live' : health === 'error' ? 'error' : 'neutral'}>{health}</StatusBadge></div>
            <dl className="ca-kv">
              <div><dt>path</dt><dd><code title={data.project.path}>{shortPath(data.project.path)}</code></dd></div>
              <div><dt>index</dt><dd>{data.project.indexed ? 'available' : 'not built'}</dd></div>
              <div><dt>process</dt><dd>{running ? `:${running.port}${running.pid ? ` · pid ${running.pid}` : ''}` : 'stopped'}</dd></div>
            </dl>
            <RuntimeBuildInfo consoleBuild={data.navigation.build} askBuild={askBuild} running={Boolean(running)} />
            <div className="ca-split-actions">
              <button className="ca-button ca-primary" disabled={Boolean(running) || lifecycleBusy || !data.project.valid} onClick={() => lifecycle('start')}><Play size={15} />Start</button>
              <button className="ca-button" disabled={!running || lifecycleBusy} onClick={() => lifecycle('stop')}><Square size={14} />Stop</button>
            </div>
          </section>
          {data.reports.length > 0 && <ReportsNav projectName={data.project.name} reports={data.reports} />}
        </aside>
        {sidebarOpen && <button className="ca-sidebar-scrim" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close project sidebar" />}
        <main className="ca-project-main" id="console-main">
          <div className="ca-tabs-bar">
            <button className="ca-icon-button ca-sidebar-toggle" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open project sidebar"><PanelLeftOpen size={17} /></button>
            <nav className="ca-tabs" aria-label="Project workspace">
              {PROJECT_TABS.map((name) => <TabButton key={name} name={name} active={tab === name} onClick={() => setTab(name)} />)}
            </nav>
          </div>
          {!data.project.valid ? <InvalidProject project={data.project} /> : (
            <div className="ca-tab-stage">
              {tab === 'ask' && <AskTab projectName={data.project.name} live={Boolean(running)} onStart={() => lifecycle('start')} />}
              {tab === 'index' && data.indexSnapshot && <IndexExplorer initial={{ ...data.indexSnapshot, childLive: Boolean(running) }} />}
              {tab === 'eval' && <EvalTab projectName={data.project.name} snapshot={data.evalSnapshot} candidates={data.candidates} />}
              {tab === 'traffic' && <TrafficTab projectName={data.project.name} window={data.trafficWindow} view={data.trafficView} />}
              {tab === 'feedback' && <FeedbackTab projectName={data.project.name} snapshot={data.feedbackSnapshot} />}
              {tab === 'settings' && <SettingsTab projectName={data.project.name} config={data.askConfig} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function RuntimeBuildInfo({
  consoleBuild,
  askBuild,
  running,
}: {
  consoleBuild: RuntimeBuildMetadata;
  askBuild: RuntimeBuildMetadata | null;
  running: boolean;
}) {
  const build = askBuild ?? consoleBuild;
  const mismatch = Boolean(
    askBuild?.release && consoleBuild.release && askBuild.release !== consoleBuild.release,
  );
  const askReleaseMissing = Boolean(running && askBuild && consoleBuild.release && !askBuild.release);
  if (!hasBuildMetadata(build) && !hasBuildMetadata(consoleBuild)) return null;

  return (
    <div className="ca-runtime-build">
      <dl className="ca-kv ca-build-kv">
        <div><dt>release</dt><dd><ReleaseValue build={build} /></dd></div>
        {build.engine_release && <div><dt>engine</dt><dd><code title={build.engine_release}>{shortRelease(build.engine_release)}</code></dd></div>}
        {build.built_at && <div><dt>built</dt><dd><time dateTime={build.built_at}>{formatBuildTime(build.built_at)}</time></dd></div>}
      </dl>
      {mismatch && <div className="ca-version-warning" role="alert"><CircleAlert size={14} /><span>Version mismatch: Console {shortRelease(consoleBuild.release!)} · Ask {shortRelease(askBuild!.release!)}</span></div>}
      {askReleaseMissing && <div className="ca-version-warning" role="alert"><CircleAlert size={14} /><span>Ask did not report a release.</span></div>}
    </div>
  );
}

function ReleaseValue({ build }: { build: RuntimeBuildMetadata }) {
  const [copied, setCopied] = useState(false);
  if (!build.release) return <span>unknown</span>;
  const copy = async () => {
    await navigator.clipboard.writeText(build.release!);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  const label = <code title={build.release}>{shortRelease(build.release)}</code>;
  return (
    <span className="ca-release-value">
      {build.release_url ? <a href={build.release_url} target="_blank" rel="noreferrer">{label}<ExternalLink size={11} /></a> : label}
      <button type="button" onClick={copy} aria-label={copied ? 'Release copied' : 'Copy release'} title={copied ? 'Copied' : 'Copy release'}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>
    </span>
  );
}

function ReportsNav({ projectName, reports }: { projectName: string; reports: ProjectBootstrap['reports'] }) {
  return <section className="ca-sidebar-section"><h3>Recent reports</h3><div className="ca-report-links">{reports.slice(0, 8).map((report) => <a href={`/p/${encodeURIComponent(projectName)}/reports/${encodeURIComponent(report.filename)}`} key={report.filename}><FileChartColumn size={14} /><span>{report.date}</span><small>{report.kind}</small></a>)}</div></section>;
}

function TabButton({ name, active, onClick }: { name: ProjectTab; active: boolean; onClick: () => void }) {
  const icons: Record<ProjectTab, React.ReactNode> = { ask: <MessageSquareText />, index: <Database />, eval: <ClipboardCheck />, traffic: <BarChart3 />, feedback: <ThumbsUp />, settings: <Settings /> };
  return <button type="button" data-tab={name} aria-label={capitalize(name)} aria-current={active ? 'page' : undefined} onClick={onClick}>{icons[name]}<span>{capitalize(name)}</span></button>;
}

type AskAnswer = {
  type: 'answer'; answer_id: string; answer_md: string; answer_lang: string; translation_notice?: string | null;
  citations: Array<{ citation_id: string; title: string; page_id: string; url: string | null; snippet: string; in_page_path: string }>;
  used_chunks: number; model: string; latency_ms: number; history_window?: number; _persisted?: boolean;
} | { type: 'clarify'; answer_id: string; message: string; options: Array<{ scope_id: string; label: string; breadcrumb: Array<{ title: string }> }> }
  | { type: 'error'; code: string; message: string; detail?: string | null };

type ChatTurn = { question: string; response: AskAnswer; at: number };

function AskTab({ projectName, live, onStart }: { projectName: string; live: boolean; onStart: () => void }) {
  const storageKey = `anydocs-console:${projectName}:conversation`;
  const [question, setQuestion] = useState('');
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>(() => readStoredTurns(storageKey));

  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(turns.slice(-20))); }, [storageKey, turns]);

  const ask = async (scopeId?: string, questionOverride?: string) => {
    const text = (questionOverride ?? question).trim();
    if (!text) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiJson<AskAnswer>(projectApi(projectName, '/ask'), {
        method: 'POST',
        body: JSON.stringify({
          question: text,
          persist,
          context: {
            ...(scopeId ? { scope_id: scopeId } : {}),
            history: turns.slice(-3).map((turn) => ({
              question: turn.question,
              answer_summary: turn.response.type === 'answer'
                ? turn.response.answer_md.replace(/\s+/g, ' ').slice(0, 200)
                : turn.response.type === 'clarify' ? turn.response.message.slice(0, 200) : '',
            })),
          },
        }),
      });
      setTurns((current) => [...current, { question: text, response, at: Date.now() }]);
      if (response.type !== 'clarify') setQuestion('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const rate = async (answerId: string, rating: 1 | -1) => {
    try {
      await apiJson(projectApi(projectName, '/feedback'), { method: 'POST', body: JSON.stringify({ answer_id: answerId, rating }) });
    } catch (err) { window.alert(errorMessage(err)); }
  };

  if (!live) return <WorkspaceEmpty icon={<Bot />} title="Ask service is stopped" detail="Start this project to warm the embedding model and query the documentation."><button className="ca-button ca-primary" onClick={onStart}><Play size={15} />Start service</button></WorkspaceEmpty>;

  return (
    <section className="ca-workspace ca-ask-workspace">
      <WorkspaceHeader eyebrow="Grounded assistant" title="Ask the documentation" description="Test retrieval and generation against the current project." actions={turns.length ? <button className="ca-button" onClick={() => setTurns([])}><Trash2 size={15} />Clear</button> : null} />
      <div className="ca-chat-log">
        {turns.length === 0 && <div className="ca-chat-welcome"><Sparkles size={22} /><h2>Start with a concrete integration question</h2><p>Answers include the source chunks used by retrieval.</p></div>}
        {turns.map((turn, index) => <ChatTurnView key={`${turn.at}-${index}`} turn={turn} onScope={(scope) => { setQuestion(turn.question); void ask(scope, turn.question); }} onRate={rate} />)}
        {busy && <div className="ca-answer ca-loading-answer"><LoaderCircle className="ca-spin" />Retrieving documentation and generating an answer…</div>}
      </div>
      <div className="ca-composer">
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void ask(); }} placeholder="Ask about an API, signature, callback, or error code…" />
        <div className="ca-composer-foot">
          <label className="ca-check"><input type="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} /><span>Save as console traffic</span></label>
          <button className="ca-button ca-primary ca-send-button" disabled={busy || !question.trim()} onClick={() => ask()}><Send size={16} />Ask</button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </section>
  );
}

function ChatTurnView({ turn, onScope, onRate }: { turn: ChatTurn; onScope: (scope: string) => void; onRate: (id: string, rating: 1 | -1) => void }) {
  const response = turn.response;
  return <div className="ca-chat-turn"><div className="ca-question">{turn.question}</div>{response.type === 'answer' ? <div className="ca-answer"><Markdown body={response.answer_md} /><div className="ca-answer-meta"><span>{response.citations.length} citations</span><span>{formatDuration(response.latency_ms)}</span><span>{response.model}</span>{response._persisted && <span>saved</span>}</div>{response.citations.length > 0 && <div className="ca-citations">{response.citations.map((citation) => <article key={citation.citation_id}><span>{citation.citation_id}</span><div><strong>{citation.title}</strong><code>{citation.page_id}{citation.in_page_path ? ` · ${citation.in_page_path}` : ''}</code><p>{citation.snippet}</p></div></article>)}</div>}<div className="ca-rating"><button className="ca-icon-button" onClick={() => onRate(response.answer_id, 1)} aria-label="Helpful"><ThumbsUp size={15} /></button><button className="ca-icon-button" onClick={() => onRate(response.answer_id, -1)} aria-label="Not helpful"><ThumbsDown size={15} /></button></div></div> : response.type === 'clarify' ? <div className="ca-answer"><Notice tone="warning">{response.message}</Notice><div className="ca-scope-list">{response.options.map((option) => <button className="ca-button" key={option.scope_id} onClick={() => onScope(option.scope_id)}><ChevronRight size={14} />{option.label}</button>)}</div></div> : <div className="ca-answer"><Notice tone="error"><strong>{response.code}</strong> {response.message}</Notice></div>}</div>;
}

function TrafficTab({ projectName, window: traffic, view }: { projectName: string; window?: TrafficWindow; view?: TrafficViewState }) {
  const [range, setRange] = useState<string>(String(view?.range ?? traffic?.range ?? 7));
  const [query, setQuery] = useState(view?.query ?? '');
  const [source, setSource] = useState(view?.source ?? '');
  const [kind, setKind] = useState(view?.kind ?? '');
  const [page, setPage] = useState(view?.page ?? 1);
  const [analyzing, setAnalyzing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const records = traffic?.records ?? [];
  const groups = useMemo(() => groupConversations(records), [records]);
  const filtered = useMemo(() => groups.filter((runs) => runs.some((record) =>
    matchesConversationRun(record, { query, source, kind }))), [groups, query, source, kind]);
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((Math.min(page, pages) - 1) * pageSize, Math.min(page, pages) * pageSize);
  const returnTo = trafficHref(projectName, { range, query, source, kind, page: Math.min(page, pages) });
  const totals = traffic?.totals;
  const matchingRuns = useMemo(
    () => records.filter((record) => matchesConversationRun(record, { query, source, kind })).length,
    [records, query, source, kind],
  );
  const analyze = async () => {
    setAnalyzing(true);
    try { await apiJson(projectApi(projectName, `/analyze?since=${range === 'all' ? '1970-01-01' : `${range}d`}`), { method: 'POST' }); window.location.reload(); }
    catch (err) { window.alert(errorMessage(err)); setAnalyzing(false); }
  };
  if (!traffic) return <WorkspaceEmpty icon={<BarChart3 />} title="No traffic data" detail="Persist Ask runs or connect the reader to populate operational metrics." />;
  return <section className="ca-workspace"><WorkspaceHeader eyebrow="Observability" title="Traffic" description="Inspect live questions, answer quality, and latency." actions={<div className="ca-inline-actions"><button className="ca-button" disabled={analyzing} onClick={analyze}>{analyzing ? <LoaderCircle className="ca-spin" size={15} /> : <Sparkles size={15} />}Analyze</button><button className="ca-button" onClick={() => setExportOpen(true)}><Download size={15} />Export</button></div>} />
    <div className="ca-metric-strip ca-four"><Metric label={`Conversations · ${range === 'all' ? 'all' : `${range}d`}`} value={groups.length} icon={<MessageSquareText />} /><Metric label={`Runs · ${totals?.count ?? 0} · Error rate`} value={formatPercent(totals?.errorRate)} icon={<CircleAlert />} /><Metric label="p50 run latency" value={formatDuration(totals?.p50LatencyMs)} icon={<Activity />} /><Metric label="p95 run latency" value={formatDuration(totals?.p95LatencyMs)} icon={<Activity />} /></div>
    <div className="ca-toolbar"><label className="ca-search"><Search size={15} /><input aria-label="Search conversations" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search questions, answers, session ID..." /></label><select aria-label="Traffic date range" value={range} onChange={(e) => { const next = e.target.value; setRange(next); window.location.href = trafficHref(projectName, { range: next, query, source, kind, page: 1 }); }}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="all">All time</option></select><select aria-label="Traffic source" value={source} onChange={(e) => { setSource(e.target.value as TrafficViewState['source']); setPage(1); }}><option value="">All sources</option><option>reader</option><option>console</option><option>mcp</option></select><select aria-label="Run outcome" value={kind} onChange={(e) => { setKind(e.target.value as TrafficViewState['kind']); setPage(1); }}><option value="">All outcomes</option><option>answer</option><option>clarify</option><option>error</option></select></div>
    <TrafficConversations projectName={projectName} groups={visible} returnTo={returnTo} filters={{ query, source, kind }} pagination={<Pagination page={Math.min(page, pages)} pages={pages} total={filtered.length} onChange={setPage} />} />
    <TrafficExportDialog
      open={exportOpen}
      onOpenChange={setExportOpen}
      projectName={projectName}
      filters={{ range, query, source, kind }}
      matchingRuns={matchingRuns}
      matchingSessions={filtered.length}
    />
  </section>;
}

function TrafficExportDialog({
  open,
  onOpenChange,
  projectName,
  filters,
  matchingRuns,
  matchingSessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  filters: { range: string; query: string; source: string; kind: string };
  matchingRuns: number;
  matchingSessions: number;
}) {
  const [format, setFormat] = useState<'csv' | 'jsonl'>('csv');
  const [groupBy, setGroupBy] = useState<'run' | 'session'>('run');
  const [includeContent, setIncludeContent] = useState(false);
  const params = new URLSearchParams({
    range: filters.range,
    format,
    group_by: groupBy,
    include_content: includeContent ? 'true' : 'false',
  });
  if (filters.query) params.set('query', filters.query);
  if (filters.source) params.set('source', filters.source);
  if (filters.kind) params.set('kind', filters.kind);
  const href = projectApi(projectName, `/traffic/export?${params.toString()}`);
  const exportCount = groupBy === 'session' ? matchingSessions : matchingRuns;

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="ca-dialog-overlay" />
      <Dialog.Content className="ca-dialog ca-dialog-sm ca-export-dialog">
        <div className="ca-dialog-heading">
          <div><Dialog.Title>Export traffic data</Dialog.Title><Dialog.Description>Download all results matching the current filters, not only this page.</Dialog.Description></div>
          <Dialog.Close className="ca-icon-button" aria-label="Close export dialog"><X size={18} /></Dialog.Close>
        </div>
        <div className="ca-export-grid">
          <fieldset className="ca-choice-field">
            <legend>Format</legend>
            <div className="ca-segmented" role="radiogroup" aria-label="Export format">
              <button type="button" role="radio" aria-checked={format === 'csv'} data-active={format === 'csv'} onClick={() => setFormat('csv')}>CSV</button>
              <button type="button" role="radio" aria-checked={format === 'jsonl'} data-active={format === 'jsonl'} onClick={() => setFormat('jsonl')}>JSONL</button>
            </div>
            <p>{format === 'csv' ? 'Flat metrics for spreadsheets and BI tools.' : 'Structured retrieval traces for scripts and evals.'}</p>
          </fieldset>
          <fieldset className="ca-choice-field">
            <legend>Group by</legend>
            <div className="ca-segmented" role="radiogroup" aria-label="Export grouping">
              <button type="button" role="radio" aria-checked={groupBy === 'run'} data-active={groupBy === 'run'} onClick={() => setGroupBy('run')}>Run</button>
              <button type="button" role="radio" aria-checked={groupBy === 'session'} data-active={groupBy === 'session'} onClick={() => setGroupBy('session')}>Session</button>
            </div>
            <p>{groupBy === 'run' ? 'One record per matching request.' : 'Keeps all in-range turns for each matching conversation.'}</p>
          </fieldset>
        </div>
        <label className="ca-export-content-toggle">
          <input type="checkbox" checked={includeContent} onChange={(event) => setIncludeContent(event.target.checked)} />
          <span><strong>Include question, answer, and context text</strong><small>Off by default. Credential patterns are redacted again during export.</small></span>
        </label>
        <div className="ca-export-summary" aria-live="polite">
          <span>{exportCount} matching {groupBy === 'session' ? (exportCount === 1 ? 'session' : 'sessions') : (exportCount === 1 ? 'run' : 'runs')}</span>
          <code>{filters.range === 'all' ? 'all time' : `${filters.range} days`} · {format.toUpperCase()}</code>
        </div>
        <div className="ca-dialog-actions">
          <Dialog.Close className="ca-button" type="button">Cancel</Dialog.Close>
          <a className="ca-button ca-primary" href={href} download onClick={() => onOpenChange(false)}><Download size={15} />Export data</a>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function FeedbackTab({ projectName, snapshot }: { projectName: string; snapshot?: FeedbackSnapshot }) {
  const [current, setCurrent] = useState(snapshot);
  const [filter, setFilter] = useState(snapshot?.filter ?? 'all');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<FeedbackRow | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const filters = ['all', 'thumbs_up', 'thumbs_down', 'implicit', 'no_citations', 'semantic_check_failed', 'aplus_candidates'];
  const load = async (next: string) => {
    setFilter(next); setLoading(true);
    try { setCurrent(await apiJson<FeedbackSnapshot & { ok: boolean }>(projectApi(projectName, `/feedback?filter=${encodeURIComponent(next)}&limit=100`))); }
    catch (err) { window.alert(errorMessage(err)); }
    finally { setLoading(false); }
  };
  const openDetail = async (row: FeedbackRow) => {
    setSelected(row); setDetail(null);
    try { const result = await apiJson<{ detail: Record<string, unknown> }>(projectApi(projectName, `/feedback/${row.feedback_id}`)); setDetail(result.detail); }
    catch (err) { setDetail({ error: errorMessage(err) }); }
  };
  if (!snapshot?.enabled) return <WorkspaceEmpty icon={<ThumbsUp />} title="Feedback collection is disabled" detail="Enable feedback.enabled in Settings to collect explicit and implicit signals." />;
  const kpi = current?.kpi;
  return <section className="ca-workspace"><WorkspaceHeader eyebrow="Quality signals" title="Feedback" description="Review explicit ratings, implicit signals, and citation quality." />
    <div className="ca-metric-strip ca-four"><Metric label="Signals · 7d" value={kpi?.count ?? 0} icon={<ThumbsUp />} /><Metric label="Explicit share" value={formatPercent(kpi?.explicitShare)} icon={<Gauge />} /><Metric label="Citation issues" value={kpi?.semanticCheckFailed ?? '—'} icon={<CircleAlert />} /><Metric label="Non-answer rate" value={formatPercent(kpi?.nonAnswerRate)} icon={<Activity />} /></div>
    <div className="ca-chip-row">{filters.map((item) => <button key={item} data-active={filter === item} onClick={() => load(item)}>{labelFilter(item)}<span>{current?.filterCounts[item] ?? 0}</span></button>)}</div>
    {loading ? <LoadingBlock /> : current && current.rows.length > 0 ? <div className="ca-feedback-list">{current.rows.map((row) => <button key={row.feedback_id} onClick={() => openDetail(row)}><span className="ca-feedback-signal">{row.rating === 1 ? <ThumbsUp size={15} /> : row.rating === -1 ? <ThumbsDown size={15} /> : <Activity size={15} />}</span><span><strong>{row.question}</strong><small>{formatTimestamp(row.ts)} · {row.signal_source}{row.sessionTurnCount > 1 ? ` · turn ${row.turnIndex}/${row.sessionTurnCount}` : ''}</small></span><span className="ca-feedback-tags">{row.semanticCheckFailed && <StatusBadge tone="warning">citation</StatusBadge>}{row.aplusCluster && <StatusBadge>A+</StatusBadge>}<ChevronRight size={15} /></span></button>)}</div> : <EmptyState icon={<ThumbsUp />} title="No signals in this filter" detail="New reader feedback will appear here." />}
    <Dialog.Root open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}><Dialog.Portal><Dialog.Overlay className="ca-dialog-overlay" /><Dialog.Content className="ca-drawer"><Dialog.Description className="ca-sr-only">Inspect the selected feedback signal and its linked run details.</Dialog.Description><div className="ca-drawer-head"><Dialog.Title>Feedback detail</Dialog.Title><Dialog.Close className="ca-icon-button" aria-label="Close feedback detail"><X size={18} /></Dialog.Close></div><div className="ca-drawer-body">{selected && <Section title="Question"><p>{selected.question}</p></Section>}{detail ? <pre className="ca-json-view">{JSON.stringify(detail, null, 2)}</pre> : <LoadingBlock />}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}

function EvalTab({ projectName, snapshot, candidates }: { projectName: string; snapshot?: EvalSnapshot; candidates?: CandidateSnapshot }) {
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const runStream = async (path: string) => {
    setBusy(true); setProgress('Starting…');
    try {
      await consumeNdjson(projectApi(projectName, path), (event) => setProgress(progressLabel(event)));
      window.location.reload();
    } catch (err) { setProgress(errorMessage(err)); setBusy(false); }
  };
  const decide = async (candidate: GoldenCandidate, decision: 'approved' | 'rejected') => {
    try { await apiJson(projectApi(projectName, '/golden/decide'), { method: 'POST', body: JSON.stringify({ id: candidate.id, decision }) }); window.location.reload(); }
    catch (err) { window.alert(errorMessage(err)); }
  };
  const flush = async () => {
    try { await apiJson(projectApi(projectName, '/golden/flush'), { method: 'POST' }); window.location.reload(); }
    catch (err) { window.alert(errorMessage(err)); }
  };
  const latest = snapshot?.latest;
  return <section className="ca-workspace"><WorkspaceHeader eyebrow="Evaluation" title="Quality lab" description="Build golden cases, run repeatable checks, and compare reports." actions={<button className="ca-button ca-primary" disabled={busy || !snapshot?.goldenStats.totalCases} onClick={() => runStream('/eval/stream')}><Play size={15} />Run evaluation</button>} />
    {progress && <Notice tone={progress.toLowerCase().includes('error') ? 'error' : 'info'}>{busy && <LoaderCircle className="ca-spin" size={15} />}{progress}</Notice>}
    <div className="ca-metric-strip ca-four"><Metric label="Golden cases" value={snapshot?.goldenStats.totalCases ?? 0} icon={<ClipboardCheck />} /><Metric label="Recall @ 5" value={formatPercent(latest?.r_at_5)} icon={<Layers3 />} /><Metric label="Citation pass" value={formatPercent(latest?.citation_pass)} icon={<CheckCircle2 />} /><Metric label="Answer rules" value={formatPercent(latest?.answer_rule_pass)} icon={<CheckCircle2 />} /></div>
    <div className="ca-eval-grid"><section className="ca-panel"><div className="ca-panel-head"><div><span className="ca-kicker">Golden workshop</span><h2>Pending review</h2></div><div className="ca-inline-actions"><button className="ca-button" disabled={busy} onClick={() => runStream('/golden/generate/stream?from=structure')}><Sparkles size={15} />From structure</button><button className="ca-button" disabled={busy} onClick={() => runStream('/golden/generate/stream?from=runs')}><Activity size={15} />From runs</button></div></div>{candidates?.pending.length ? <div className="ca-candidate-list">{candidates.pending.slice(0, 50).map((candidate) => <article key={candidate.id}><div><StatusBadge>{candidate.lang}</StatusBadge><strong>{candidate.query}</strong><code>{candidate.context_pageId ?? 'project scope'}</code></div><div><button className="ca-icon-button ca-good" aria-label="Approve" onClick={() => decide(candidate, 'approved')}><Check size={16} /></button><button className="ca-icon-button ca-danger" aria-label="Reject" onClick={() => decide(candidate, 'rejected')}><X size={16} /></button></div></article>)}</div> : <EmptyState icon={<ClipboardCheck />} title="Review queue is empty" detail="Generate candidates from document structure or production runs." />}{(candidates?.approved ?? 0) > 0 && <div className="ca-panel-footer"><span>{candidates!.approved} approved candidates ready</span><button className="ca-button ca-primary" onClick={flush}>Flush approved</button></div>}</section>
    <section className="ca-panel"><div className="ca-panel-head"><div><span className="ca-kicker">History</span><h2>Evaluation reports</h2></div></div>{snapshot?.history.length ? <div className="ca-report-table">{snapshot.history.map((report) => <a key={report.filename} href={`/p/${encodeURIComponent(projectName)}/reports/${encodeURIComponent(report.filename)}`}><span>{report.date}</span><strong>{formatPercent(report.r_at_5)}</strong><strong>{formatPercent(report.citation_pass)}</strong><small>{report.cases ?? '—'} cases</small><ChevronRight size={15} /></a>)}</div> : <EmptyState icon={<FileChartColumn />} title="No evaluation reports" detail="Run the first evaluation after approving golden cases." />}</section></div>
  </section>;
}

function SettingsTab({ projectName, config }: { projectName: string; config?: AskConfigView }) {
  const [text, setText] = useState(config?.rawText ?? JSON.stringify(config?.raw ?? config?.defaults ?? {}, null, 2));
  const [mtime, setMtime] = useState(config?.mtimeISO ?? null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      JSON.parse(text);
      const result = await apiJson<{ mtimeISO: string; warnings: string[] }>(projectApi(projectName, '/ask-config'), { method: 'POST', body: JSON.stringify({ rawText: text, expectedMtimeISO: mtime }) });
      setMtime(result.mtimeISO); setMessage(result.warnings.length ? result.warnings.join(' · ') : 'Configuration saved. Restart the service to apply runtime changes.');
    } catch (err) { setMessage(errorMessage(err)); }
    finally { setSaving(false); }
  };
  return <section className="ca-workspace"><WorkspaceHeader eyebrow="Project configuration" title="Settings" description="Edit the complete anydocs.ask.json with server-side validation." actions={<button className="ca-button ca-primary" disabled={saving} onClick={save}>{saving ? <LoaderCircle className="ca-spin" size={15} /> : <Save size={15} />}Save</button>} />
    {config?.parseError && <Notice tone="error">{config.parseError}</Notice>}{config?.warnings.map((warning) => <Notice tone="warning" key={warning}>{warning}</Notice>)}{message && <Notice tone={message.includes('saved') ? 'success' : 'warning'}>{message}</Notice>}
    <div className="ca-settings-grid"><section className="ca-panel ca-editor-panel"><div className="ca-panel-head"><div><span className="ca-kicker">JSON source</span><h2>{config?.path ?? 'anydocs.ask.json'}</h2></div><StatusBadge tone={config?.exists ? 'live' : 'warning'}>{config?.exists ? 'on disk' : 'new file'}</StatusBadge></div><textarea className="ca-code-editor" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} /></section><aside className="ca-settings-help"><Section title="Applies after restart"><p>Retrieval, feedback, multi-turn, generation, and model settings are read when the child service starts.</p></Section><Section title="Write protection"><p>The save request includes the last file modification time. A newer disk edit will not be overwritten.</p></Section></aside></div>
  </section>;
}

function ReportScreen({ data }: { data: ReportBootstrap }) {
  return <div className="ca-app"><AppHeader navigation={data.navigation} current={data.projectName} /><main className="ca-document-page" id="console-main"><div className="ca-page-title"><div><a className="ca-back" href={`/p/${encodeURIComponent(data.projectName)}#eval`}><ArrowLeft size={15} />{data.projectName}</a><h1>{data.filename}</h1></div><button className="ca-button" onClick={() => window.print()}><FileText size={15} />Print</button></div><article className="ca-markdown-document"><Markdown body={data.body} /></article></main></div>;
}

function RunsScreen({ data }: { data: RunsBootstrap }) {
  const records = data.lines.filter((line): line is RunRecord => Boolean(line && 'answer' in line));
  const traffic: TrafficWindow = { sinceISO: '', days: 0, range: 'all', records, totals: computeRunTotals(records), perDay: [] };
  return <div className="ca-app"><AppHeader navigation={data.navigation} current={data.projectName} /><main className="ca-document-page ca-runs-page" id="console-main"><a className="ca-back" href={`/p/${encodeURIComponent(data.projectName)}#traffic`}><ArrowLeft size={15} />Back to project</a><TrafficTab projectName={data.projectName} window={traffic} /></main></div>;
}

function WorkspaceHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <header className="ca-workspace-head"><div><span className="ca-kicker">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions && <div className="ca-inline-actions">{actions}</div>}</header>;
}

function Metric({ label, value, icon }: { label: string; value: React.ReactNode; icon: React.ReactNode }) { return <div className="ca-metric"><span>{icon}</span><small>{label}</small><strong>{value}</strong></div>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <label className="ca-field"><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>; }
function Notice({ tone, children }: { tone: 'error' | 'warning' | 'info' | 'success'; children: React.ReactNode }) { return <div className="ca-notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'} aria-live="polite">{tone === 'error' || tone === 'warning' ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}<span>{children}</span></div>; }
function StatusBadge({ tone = 'neutral', children }: { tone?: 'neutral' | 'live' | 'error' | 'warning'; children: React.ReactNode }) { return <span className="ca-badge" data-tone={tone}>{children}</span>; }
function EmptyState({ icon, title, detail, children }: { icon: React.ReactNode; title: string; detail: string; children?: React.ReactNode }) { return <div className="ca-empty"><span>{icon}</span><h2>{title}</h2><p>{detail}</p>{children}</div>; }
function WorkspaceEmpty(props: React.ComponentProps<typeof EmptyState>) { return <section className="ca-workspace ca-workspace-empty"><EmptyState {...props} /></section>; }
function LoadingBlock() { return <div className="ca-loading-block"><LoaderCircle className="ca-spin" size={18} />Loading…</div>; }
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="ca-detail-section"><h3>{title}</h3>{children}</section>; }
function Markdown({ body }: { body: string }) { const html = useMemo(() => marked.parse(body, { async: false, breaks: true, gfm: true }) as string, [body]); return <div className="ca-markdown" dangerouslySetInnerHTML={{ __html: html }} />; }

function Pagination({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (page: number) => void }) { return <div className="ca-pagination"><span>{total} results</span><div><button className="ca-icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {pages}</span><button className="ca-icon-button" aria-label="Next page" disabled={page >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={16} /></button></div></div>; }

function InvalidProject({ project }: { project: ProjectBootstrap['project'] }) { return <WorkspaceEmpty icon={<CircleAlert />} title="Project structure is invalid" detail={`Missing ${project.missing.join(', ')} in ${project.path}.`} />; }

function useHashTab(): [ProjectTab, (tab: ProjectTab) => void] {
  const read = (): ProjectTab => { const value = window.location.hash.slice(1).split('?', 1)[0]; return PROJECT_TABS.includes(value as ProjectTab) ? value as ProjectTab : 'ask'; };
  const [tab, setTabState] = useState<ProjectTab>(read);
  useEffect(() => { const change = () => setTabState(read()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  return [tab, (next) => { const currentQuery = next === 'index' && window.location.hash.startsWith('#index?') ? window.location.hash.split('?', 2)[1] : ''; window.location.hash = `${next}${currentQuery ? `?${currentQuery}` : ''}`; setTabState(next); }];
}

async function consumeNdjson(path: string, onEvent: (event: Record<string, unknown>) => void) {
  const response = await fetch(path, { method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok || !response.body) throw new Error((await response.json().catch(() => null))?.error ?? response.statusText);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as Record<string, unknown>); if (done) break; }
}

function progressLabel(event: Record<string, unknown>): string { return String(event.message ?? event.phase ?? event.type ?? 'Working…'); }
function readStoredTurns(key: string): ChatTurn[] { try { const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown; return Array.isArray(value) ? value.slice(-20) as ChatTurn[] : []; } catch { return []; } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function shortPath(path: string): string { const home = '/Users/'; return path.startsWith(home) ? `~/${path.split('/').slice(3).join('/')}` : path; }
function shortRelease(value: string): string { return value.length > 10 ? value.slice(0, 7) : value; }
function hasBuildMetadata(value: RuntimeBuildMetadata): boolean { return Boolean(value.release || value.engine_release || value.built_at); }
function formatBuildTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatDecimal(value: number | null | undefined): string { return value === null || value === undefined ? '—' : value.toFixed(2); }
function formatPercent(value: number | null | undefined): string { return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`; }
function formatDuration(value: number | null | undefined): string { if (value === null || value === undefined) return '—'; return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`; }
function formatTimestamp(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); }
function trafficHref(projectName: string, state: { range: string; query: string; source: string; kind: string; page: number }): string {
  const query = new URLSearchParams();
  query.set('traffic_range', state.range);
  if (state.query) query.set('traffic_q', state.query);
  if (state.source) query.set('traffic_source', state.source);
  if (state.kind) query.set('traffic_kind', state.kind);
  if (state.page > 1) query.set('traffic_page', String(state.page));
  return `/p/${encodeURIComponent(projectName)}?${query}#traffic`;
}
function labelFilter(value: string): string { return value.replaceAll('_', ' ').replace('thumbs up', 'positive').replace('thumbs down', 'negative'); }
function computeRunTotals(records: RunRecord[]): TrafficWindow['totals'] { const lat = records.map((r) => r.answer.latency_ms).sort((a, b) => a - b); const pick = (p: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]! : null; return { count: records.length, countReader: records.filter((r) => !r.source || r.source === 'reader').length, countConsole: records.filter((r) => r.source === 'console').length, countMcp: records.filter((r) => r.source === 'mcp').length, p50LatencyMs: pick(.5), p95LatencyMs: pick(.95), errorRate: records.length ? records.filter((r) => r.answer.kind === 'error').length / records.length : 0, clarifyRate: records.length ? records.filter((r) => r.answer.kind === 'clarify').length / records.length : 0 }; }
