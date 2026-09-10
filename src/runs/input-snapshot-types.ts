export type RunInputSnapshot = {
  version: 1;
  captured_at: string;
  redaction: 'sensitive-key-patterns-v1';
  redacted_fields: string[];
  truncated_fields: string[];
  question: string;
  prompt_question: string;
  search_question: string;
  retrieve_question: string;
  current_page: string | null;
  history: Array<{ question: string; answer_summary: string }>;
  documents: Array<{
    citation_id: string; chunk_id: number; page_id: string; title: string;
    lang: string; url: string | null; path: string; text: string;
    content_hash?: string; parent_id: number | null;
    expanded_parent?: { parent_id: number; content_hash: string; parent_path: string } | null;
  }>;
  attempts: Array<{
    system_prompt: string; user_prompt: string;
    outcome: 'pending' | 'returned' | 'error'; accepted: boolean; model?: string;
  }>;
};
