import { iterateRunsSince } from '../runs/writer.ts';
import {
  isRunRecord,
  type RunCitationCheckUpdate,
  type RunFeedbackUpdate,
  type RunRecord,
  type RunsLine,
} from '../runs/types.ts';

/** Load one run and fold its append-only feedback/citation updates. */
export function loadRunDetail(stateRoot: string, requestId: string): RunRecord | null {
  let record: RunRecord | null = null;
  let feedbackUpdate: RunFeedbackUpdate['feedback'] = {};
  const citationChecks = new Map<
    string,
    RunCitationCheckUpdate['citations'][number]['semantic_check']
  >();

  for (const line of iterateRunsSince({ stateRoot, sinceMs: 0 }) as Iterable<RunsLine>) {
    if (line.request_id !== requestId) continue;
    if (isRunRecord(line)) {
      record = structuredClone(line);
      continue;
    }
    if (line.type === 'feedback-update') {
      feedbackUpdate = { ...feedbackUpdate, ...line.feedback };
      continue;
    }
    for (const citation of line.citations) {
      citationChecks.set(citation.citation_id, citation.semantic_check);
    }
  }

  if (!record) return null;
  record.feedback = { ...record.feedback, ...feedbackUpdate };
  record.answer.citations = record.answer.citations.map((citation) => {
    const check = citation.citation_id ? citationChecks.get(citation.citation_id) : undefined;
    return check ? { ...citation, semantic_check: check } : citation;
  });
  return record;
}
