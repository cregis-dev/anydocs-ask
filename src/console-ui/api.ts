import type { IndexedPageChunks } from './types';

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(body.error ?? body.message ?? response.statusText);
  }
  return body;
}

export async function fetchPageChunks(
  projectName: string,
  pageId: string,
  lang: string,
): Promise<IndexedPageChunks> {
  const query = new URLSearchParams({ page_id: pageId, lang });
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectName)}/index/chunks?${query}`,
    { headers: { Accept: 'application/json' } },
  );
  return readJson<IndexedPageChunks>(response);
}

export async function rebuildIndex(projectName: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectName)}/reindex`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  await readJson<{ ok: boolean }>(response);
}
