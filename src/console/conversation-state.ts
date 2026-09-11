import { iterateRunsSince } from '../runs/writer.ts';
import { isRunRecord, type RunRecord } from '../runs/types.ts';
import { conversationKey } from '../runs/conversations.ts';

export function loadConversation(stateRoot: string, requestId: string, offset = 0) {
  // Read across the entire retained log, independent of the Traffic date filter.
  let anchor: RunRecord | undefined;
  for (const line of iterateRunsSince({ stateRoot, sinceMs: 0 })) {
    if (isRunRecord(line) && line.request_id === requestId) { anchor = line; break; }
  }
  if (!anchor) return null;
  const key = conversationKey(anchor);
  const records = new Map<string, RunRecord>();
  for (const line of iterateRunsSince({ stateRoot, sinceMs: 0 })) {
    if (isRunRecord(line) && conversationKey(line) === key) records.set(line.request_id, line);
  }
  const turns = [...records.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.request_id.localeCompare(b.request_id));
  const page = turns.slice(offset, offset + 50);
  return {
    sessionId: anchor.session_id,
    source: anchor.source ?? 'reader',
    title: turns[0]!.query,
    total: turns.length,
    offset,
    nextOffset: offset + page.length < turns.length ? offset + page.length : null,
    // Retrieval snapshots stay on Run detail; don't send them for every turn.
    turns: page.map((run) => ({
      request_id: run.request_id, ts: run.ts, query: run.query,
      context_pageId: run.context_pageId, answer: run.answer,
    })),
  };
}
