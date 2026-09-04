export type AskStats = {
  count: number;
  medianConfidence: number | null;
};

export type IndexPage = {
  id: string;
  title: string;
  slug: string | null;
  status: string;
  lang: string;
  breadcrumb: string[];
  missingFile?: true;
  askStats?: AskStats;
};

export type IndexLanguage = {
  lang: string;
  pages: IndexPage[];
  orphans: IndexPage[];
};

export type IndexStatus = {
  page_count: number;
  chunk_count: number;
  embedding_cache_size: number;
  embedding_model: string;
  llm_model: string;
  warm: boolean;
  last_indexed_at: number | null;
};

export type IndexBootstrap = {
  projectName: string;
  childLive: boolean;
  totalPages: number;
  langs: IndexLanguage[];
  warnings: string[];
  dbStatus: IndexStatus | null;
  focusPageId?: string | null;
};

export type BreadcrumbNode = {
  id: string;
  title: string;
  type: 'section' | 'folder' | 'page';
};

export type IndexedPageMeta = {
  page_id: string;
  lang: string;
  status: string;
  title: string;
  slug: string | null;
  breadcrumb: BreadcrumbNode[];
  nav_index: number | null;
  parent_id: string | null;
  subtree_root: string | null;
  url: string | null;
  updated_at: number;
};

export type IndexedChunk = {
  chunk_id: number;
  ordinal: number;
  in_page_path: string | null;
  text: string;
  content_hash: string;
  token_count: number;
  is_code: boolean;
  parent_id: number | null;
  parent_path: string | null;
  parent_heading_path: string[];
  parent_token_count: number | null;
  chunk_kind: string;
  object_path: string | null;
  identifiers: Array<{ value: string; kind: string }>;
  created_at: number;
  embedded: boolean;
  embedding_cached: boolean;
};

export type IndexedParent = {
  parent_id: number;
  parent_path: string;
  heading_id: string | null;
  heading_path: string[];
  text: string;
  content_hash: string;
  token_count: number;
  child_count: number;
  created_at: number;
};

export type IndexedPageChunks = {
  page: IndexedPageMeta;
  parents: IndexedParent[];
  chunks: IndexedChunk[];
};

declare global {
  interface Window {
    __INDEX_EXPLORER__?: IndexBootstrap;
    __CONSOLE_APP__?: import('./app-types').ConsoleBootstrap;
  }
}
