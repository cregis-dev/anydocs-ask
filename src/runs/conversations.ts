/** Shared by Console and its API. Never infer a session from similar questions. */
export type ConversationRun = {
  request_id: string;
  session_id: string | null;
  source?: string;
  ts: string;
  query: string;
  answer: { kind: string; md: string | null; latency_ms: number };
};

export function conversationKey(run: ConversationRun): string {
  return JSON.stringify([run.source ?? 'reader', run.session_id?.trim() ? 'session' : 'run',
    run.session_id?.trim() ? run.session_id : run.request_id]);
}

export function groupConversations<T extends ConversationRun>(records: T[]): T[][] {
  const groups = new Map<string, T[]>();
  const seen = new Set<string>();
  for (const run of records) {
    if (seen.has(run.request_id)) continue;
    seen.add(run.request_id);
    const key = conversationKey(run);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].map((runs) => runs.sort((a, b) => a.ts.localeCompare(b.ts) || a.request_id.localeCompare(b.request_id)));
  return ordered.sort((a, b) => b[b.length - 1]!.ts.localeCompare(a[a.length - 1]!.ts) || conversationKey(a[0]!).localeCompare(conversationKey(b[0]!)));
}

export function matchesConversationRun(run: ConversationRun, filters: { query: string; source: string; kind: string }): boolean {
  const query = filters.query.trim().toLowerCase();
  return (!filters.source || (run.source ?? 'reader') === filters.source)
    && (!filters.kind || run.answer.kind === filters.kind)
    && (!query || [run.query, run.answer.md ?? '', run.session_id ?? ''].some((value) => value.toLowerCase().includes(query)));
}
