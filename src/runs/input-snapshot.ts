import { redactSensitiveText } from '../query/diagnostic-input.ts';

import type { RunInputSnapshot } from './input-snapshot-types.ts';
export type { RunInputSnapshot } from './input-snapshot-types.ts';

type SnapshotInput = Pick<RunInputSnapshot, 'question' | 'prompt_question' | 'search_question' | 'retrieve_question' | 'current_page' | 'history' | 'documents'>;

/** Capture the generation adapter inputs, never a reconstruction from later logs. */
export function createInputCapture(input: SnapshotInput, maxChars = 180_000) {
  let remaining = maxChars;
  const redacted_fields: string[] = [];
  const truncated_fields: string[] = [];
  const capture = (value: string, field: string, limit = 60_000) => {
    const safe = redactSensitiveText(value);
    if (safe !== value) redacted_fields.push(field);
    const length = Math.max(0, Math.min(limit, remaining));
    if (safe.length > length) truncated_fields.push(field);
    const text = safe.slice(0, length);
    remaining -= text.length;
    return text;
  };
  const snapshot: RunInputSnapshot = {
    version: 1, captured_at: new Date().toISOString(), redaction: 'sensitive-key-patterns-v1', redacted_fields, truncated_fields,
    question: capture(input.question, 'question', 20_000),
    prompt_question: capture(input.prompt_question, 'prompt_question', 20_000),
    search_question: capture(input.search_question, 'search_question', 20_000),
    retrieve_question: capture(input.retrieve_question, 'retrieve_question', 20_000),
    current_page: input.current_page === null ? null : capture(input.current_page, 'current_page', 2000),
    history: input.history.map((turn, i) => ({
      question: capture(turn.question, `history.${i}.question`, 20_000),
      answer_summary: capture(turn.answer_summary, `history.${i}.answer_summary`, 20_000),
    })),
    documents: input.documents.map((doc, i) => ({
      ...doc,
      title: capture(doc.title, `documents.${i}.title`, 2000),
      page_id: capture(doc.page_id, `documents.${i}.page_id`, 2000),
      url: doc.url === null ? null : capture(doc.url, `documents.${i}.url`, 4000),
      path: capture(doc.path, `documents.${i}.path`, 2000),
      text: capture(doc.text, `documents.${i}.text`, 32_000),
      expanded_parent: doc.expanded_parent ? {
        parent_id: doc.expanded_parent.parent_id,
        content_hash: doc.expanded_parent.content_hash,
        parent_path: capture(doc.expanded_parent.parent_path, `documents.${i}.expanded_parent.parent_path`, 2000),
      } : null,
    })),
    attempts: [],
  };
  return {
    snapshot,
    addAttempt(request: { systemPrompt: string; userPrompt: string }) {
      const i = snapshot.attempts.length;
      const attempt: RunInputSnapshot['attempts'][number] = {
        system_prompt: capture(request.systemPrompt, `attempts.${i}.system_prompt`),
        user_prompt: capture(request.userPrompt, `attempts.${i}.user_prompt`),
        outcome: 'pending', accepted: false,
      };
      snapshot.attempts.push(attempt);
      return attempt;
    },
  };
}
