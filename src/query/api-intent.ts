import type { RetrievedChunk } from './retrieval.ts';

export function isApiReferenceChunk(c: Pick<RetrievedChunk, 'page_id' | 'page_url' | 'text'>): boolean {
  if (c.page_id.startsWith('api-')) return true;
  if ((c.page_url ?? '').includes('/reference/')) return true;
  return /\bAPI reference:/i.test(c.text) || /\bHTTP Request\b/i.test(c.text);
}

export function apiReferenceChunkMatchesVersion(
  c: Pick<RetrievedChunk, 'page_id' | 'page_url' | 'page_title' | 'text'>,
  versions: string[] | undefined,
): boolean {
  if (!versions?.length) return true;
  const haystack = `${c.page_id} ${c.page_url ?? ''} ${c.page_title} ${c.text}`.toLowerCase();
  const match = haystack.match(/(?:\/api\/|api-)(v[0-9]+)\b/);
  if (!match) return true;
  return versions.includes(match[1]!);
}
