import type { IndexBootstrap } from './types';
import type { RuntimeBuildMetadata } from '../runtime-build';

export type ProjectListing = {
  name: string;
  path: string;
  valid: boolean;
  missing: string[];
  projectId: string | null;
  indexed: boolean;
  title: string | null;
  description: string | null;
};

export type ProcessInfo = {
  name: string;
  pid: number;
  port: number;
  startedAt: number;
  lastUsedAt: number;
  exited: boolean;
};

export type Navigation = {
  projects: ProjectListing[];
  running: string[];
  consolePort: number;
  idleTimeoutMin?: number;
  authEnabled: boolean;
  publicRootPath: string;
  build: RuntimeBuildMetadata;
};

export type ProjectStats = {
  cases: number;
  lastEvalDate: string | null;
  runs7d: number;
  lastActivity: string | null;
};

export type WorkspaceSummary = {
  projectsTotal: number;
  projectsValid: number;
  projectsIndexed: number;
  projectsRunning: number;
  totalCases: number;
  totalRuns7d: number;
  mostRecentProject: string | null;
};

export type HomeBootstrap = {
  kind: 'home';
  consolePort: number;
  idleTimeoutMin: number;
  projects: ProjectListing[];
  running: Record<string, ProcessInfo>;
  projectStats: Record<string, ProjectStats>;
  workspaceSummary: WorkspaceSummary;
  authEnabled: boolean;
  publicRootPath: string;
  build: RuntimeBuildMetadata;
};

export type ReportListing = {
  filename: string;
  kind: 'eval' | 'analyze' | 'baseline';
  date: string;
  path: string;
  sizeBytes: number;
};

export type RunRecord = {
  input_snapshot?: import('../runs/input-snapshot-types').RunInputSnapshot;
  input_snapshot_status?: 'captured' | 'not_generated' | 'omitted_by_policy';
  ts: string;
  request_id: string;
  session_id: string | null;
  query: string;
  filters: Record<string, unknown>;
  context_pageId: string | null;
  source?: 'reader' | 'console' | 'mcp';
  langfuse_trace_id?: string;
  runtime_build?: RuntimeBuildMetadata;
  retrieval: {
    fused: Array<{
      chunk_id: number;
      page: string;
      content_hash?: string;
      lang?: string;
      page_title?: string;
      page_url?: string | null;
      in_page_path?: string;
      text_preview?: string;
      token_count?: number;
      parent_id?: number | null;
      chunk_kind?: string;
      object_path?: string | null;
      identifiers?: string[];
      rrf_score: number;
      final_score: number;
      vec_rank: number | null;
      bm25_rank: number | null;
      exact_rank?: number | null;
      nav_index: number | null;
    }>;
    selected_context?: Array<{
      chunk_id: number;
      page: string;
      content_hash?: string;
      lang: string;
      page_title: string;
      page_url: string | null;
      in_page_path: string;
      text_preview: string;
      token_count?: number;
      parent_id?: number | null;
      chunk_kind?: string;
      object_path?: string | null;
      identifiers?: string[];
      rrf_score: number;
      final_score: number;
      vec_rank: number | null;
      bm25_rank: number | null;
      exact_rank?: number | null;
      nav_index: number | null;
      context_rank: number;
      context_token_count: number;
      expanded_parent: {
        parent_id: number;
        content_hash: string;
        parent_path: string;
        heading_path: string[];
        token_count: number;
        child_count: number;
      } | null;
    }>;
    subtree_ask_triggered: boolean;
    router_strategy?: 'fast_path' | 'cache' | 'llm' | 'fallback' | 'disabled';
    timings?: {
      router_ms: number;
      embedding_ms: number;
      retrieval_ms: number;
      rerank_ms: number;
      generation_ms: number;
    };
  };
  answer: {
    kind: 'answer' | 'clarify' | 'error';
    answer_id: string | null;
    md: string | null;
    citations: Array<{
      chunk_id: number | null;
      page: string;
      quote: string;
      citation_id?: string;
      semantic_check?: {
        verdict: 'supports' | 'partially' | 'not_supports';
        reason: string;
        model: string;
        checked_at: string;
        latency_ms: number;
      };
    }>;
    latency_ms: number;
    tokens_in: number | null;
    tokens_out: number | null;
    model: string | null;
    error_code: string | null;
    history_window?: number;
  };
};

export type TrafficWindow = {
  sinceISO: string;
  days: number;
  range: 7 | 30 | 90 | 'all';
  records: RunRecord[];
  totals: {
    count: number;
    countReader: number;
    countConsole: number;
    countMcp: number;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    errorRate: number;
    clarifyRate: number;
  };
  perDay: Array<{ date: string; count: number; p95LatencyMs: number | null }>;
};

export type TrafficViewState = {
  range: 7 | 30 | 90 | 'all';
  query: string;
  source: '' | 'reader' | 'console' | 'mcp';
  kind: '' | 'answer' | 'clarify' | 'error';
  page: number;
  pageSize: 25 | 50 | 100;
};

export type FeedbackRow = {
  feedback_id: number;
  ts: string;
  rating: number | null;
  signal_source: 'explicit' | 'implicit' | 'curated';
  question: string;
  answerId: string;
  currentPageId: string | null;
  hadNoCitations: boolean | null;
  sessionId: string | null;
  historyWindow: number | null;
  turnIndex: number;
  sessionTurnCount: number;
  semanticCheckFailed: boolean | null;
  aplusCluster: { clusterId: string; shadow: boolean } | null;
};

export type FeedbackSnapshot = {
  enabled: boolean;
  totalCount: number;
  sinceISO: string;
  days: number;
  kpi: {
    count: number;
    explicitCount: number;
    implicitCount: number;
    explicitShare: number | null;
    nonAnswerRate: number;
    aplusCandidates: { total: number; mode: 'enabled' | 'shadow' } | null;
    semanticCheckFailed: number | null;
  };
  filterCounts: Record<string, number>;
  filter: string;
  rows: FeedbackRow[];
  hasMore: boolean;
};

export type EvalReport = {
  filename: string;
  date: string;
  mrr: number | null;
  hit_at_5: number | null;
  context_precision_at_5: number | null;
  retrieval_content_pass: number | null;
  citation_anchor_pass: number | null;
  kind_pass: number | null;
  api_rule_pass: number | null;
  cases: number | null;
  sizeBytes: number;
};

export type EvalSnapshot = {
  goldenStats: {
    totalCases: number;
    byLang: Record<string, number>;
    byTag: Record<string, number>;
    byCreatedBy: Record<string, number>;
    lastEditISO: string | null;
    malformed: number;
  };
  history: EvalReport[];
  latest: EvalReport | null;
  pinned: { filename: string; pinnedAt: string } | null;
  pinnedSummary: EvalReport | null;
};

export type GoldenCandidate = {
  id: string;
  query: string;
  lang: string;
  context_pageId?: string | null;
  tags?: string[];
  expected?: {
    must_cite_pages?: string[];
    must_contain?: string[];
    forbid_contain?: string[];
  };
  note?: string;
  decision?: string | null;
};

export type CandidateSnapshot = {
  total: number;
  pending: GoldenCandidate[];
  approved: number;
  rejected: number;
  malformed: number;
};

export type AskConfigView = {
  path: string;
  exists: boolean;
  mtimeISO: string | null;
  raw: Record<string, unknown> | null;
  defaults: Record<string, unknown>;
  rawText: string | null;
  warnings: string[];
  parseError: string | null;
};

export type ProjectBootstrap = {
  kind: 'project';
  project: ProjectListing;
  running: ProcessInfo | null;
  reports: ReportListing[];
  autostart: boolean;
  navigation: Navigation;
  evalSnapshot?: EvalSnapshot;
  latestEvalReportBody: string | null;
  indexSnapshot: IndexBootstrap | null;
  trafficWindow?: TrafficWindow;
  trafficView?: TrafficViewState;
  feedbackSnapshot?: FeedbackSnapshot;
  candidates?: CandidateSnapshot;
  analyzeHistory: Array<{ filename: string; date: string; sizeBytes: number }>;
  latestAnalyzeBody: string | null;
  askConfig?: AskConfigView;
};

export type RunsBootstrap = {
  kind: 'runs';
  projectName: string;
  lines: RunRecord[];
  limit: number;
  navigation: Navigation;
};

export type RunDetailBootstrap = {
  kind: 'run-detail';
  projectName: string;
  run: RunRecord;
  childLive: boolean;
  returnTo: string;
  navigation: Navigation;
};

export type ReportBootstrap = {
  kind: 'report';
  projectName: string;
  filename: string;
  body: string;
  navigation: Navigation;
};

export type ConsoleBootstrap = HomeBootstrap | ProjectBootstrap | RunsBootstrap | RunDetailBootstrap | ReportBootstrap;
