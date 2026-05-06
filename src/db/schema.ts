/**
 * TypeScript row shapes for the SQLite tables defined in
 * `migrations/001_initial.sql`.
 *
 * Hand-mirrored — when migrations change, update both. We deliberately do not
 * pull in a runtime validator (Zod / Valibot) for internal rows; the SQL
 * schema is the source of truth and TS types are an ergonomic mirror.
 *
 * JSON columns are typed as `string` here (the raw stored value). Helpers in
 * `db/json.ts` (stage 3+) will parse them into structured types.
 */

export type PageRow = {
  page_id: string;
  lang: string;
  status: string;
  title: string;
  slug: string | null;
  breadcrumb: string;       // JSON: BreadcrumbNode[]
  nav_index: number | null;
  parent_id: string | null;
  subtree_root: string | null;
  url: string | null;
  updated_at: number;
};

export type ChunkRow = {
  chunk_id: number;
  page_id: string;
  lang: string;
  in_page_path: string | null;
  text: string;
  content_hash: string;
  token_count: number;
  is_code: number;          // SQLite has no bool; 0 / 1
  created_at: number;
};

export type EmbeddingCacheRow = {
  content_hash: string;
  model: string;
  embedding: Buffer;        // raw float bytes
  created_at: number;
};

export type FeedbackRow = {
  feedback_id: number;
  answer_id: string;
  question: string;
  current_page_id: string | null;
  retrieved: string | null;       // JSON
  generated: string;
  rating: number | null;
  correction: string | null;
  bad_citation_ids: string | null; // JSON
  tags: string | null;             // JSON
  model_used: string | null;
  created_at: number;
};

export type AnswerRow = {
  answer_id: string;
  question: string;
  payload: string;          // JSON
  created_at: number;
};

/**
 * Structured shape of a `pages.breadcrumb` JSON entry. Mirrors ARCH §2.2.1.
 *
 * `id` is a stable nav id (NOT a page id) — see ARCH §2.2.2.
 */
export type BreadcrumbNode = {
  id: string;
  title: string;
  type: 'section' | 'folder' | 'page';
};
