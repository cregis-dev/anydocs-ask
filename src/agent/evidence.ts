import { createHash } from 'node:crypto';
import type { DocsLang } from '../anydocs/types.ts';
import type { RerankerConfig } from '../config.ts';
import { extractIndexedIdentifiers } from '../content/identifiers.ts';
import type { BreadcrumbNode } from '../db/schema.ts';
import type { DbHandle } from '../db/index.ts';
import { observeLangfuse } from '../observability/langfuse.ts';
import { search, type AskDeps } from '../query/answer.ts';
import { fallbackRoute, type IntentRouter } from '../query/intent-router.ts';
import type { SearchHit } from '../query/types.ts';
import type { Reranker } from '../reranker/types.ts';

export const AGENT_SEARCH_LIMIT = 20;
const AGENT_SEARCH_OVERFETCH_MULTIPLIER = 5;
const AGENT_SEARCH_OVERFETCH_CAP = 100;
export const AGENT_CATALOG_LIMIT = 50;
export const AGENT_READ_TOKEN_LIMIT = 3300;
export const AGENT_READ_TOKEN_HARD_CAP = 8000;
const DEFAULT_AGENT_PAGE_RERANK_TOP_K = 8;
const DEFAULT_AGENT_PAGE_RERANK_WEIGHT = 0.6;

const EVIDENCE_SEARCH_ROUTER: IntentRouter = {
  async route({ question }) {
    return { ...fallbackRoute(question), reason: 'agent_evidence_search_no_router' };
  },
};

export type EvidenceReadMode = 'page' | 'section' | 'field';

export type SearchDocsInput = {
  query: string;
  scopeId?: string | null;
  currentPageId?: string | null;
  limit?: number;
};

export type SearchDocsOutput = {
  type: 'candidates';
  candidates: SearchHit[];
};

export type ExactMatch = {
  identifier: string;
  kind: string;
  chunkId: number;
  pageId: string;
  lang: DocsLang;
  title: string;
  url: string | null;
  breadcrumb: BreadcrumbNode[];
  inPagePath: string;
  objectPath: string | null;
  snippet: string;
};

export type CatalogEntry = {
  pageId: string;
  lang: DocsLang;
  title: string;
  url: string | null;
  breadcrumb: BreadcrumbNode[];
  subtreeRoot: string | null;
  navIndex: number | null;
};

export type EvidenceRecord = {
  evidenceId: string;
  pageId: string;
  lang: DocsLang;
  title: string;
  url: string | null;
  breadcrumb: BreadcrumbNode[];
  mode: EvidenceReadMode;
  selector: string | null;
  inPagePath: string;
  body: string;
  tokenCount: number;
  truncated: boolean;
  availableLangs: DocsLang[];
  chunkIds: number[];
  contentHash: string;
};

export type EvidenceServiceDeps = {
  db: DbHandle;
  searchDeps: AskDeps;
};

type PageRow = {
  page_id: string;
  lang: DocsLang;
  title: string;
  url: string | null;
  breadcrumb: string;
  subtree_root: string | null;
  nav_index: number | null;
};

type ReadUnitRow = {
  chunk_id: number;
  parent_id: number | null;
  in_page_path: string | null;
  object_path: string | null;
  chunk_text: string;
  chunk_hash: string;
  chunk_tokens: number;
  parent_path: string | null;
  heading_id: string | null;
  heading_path: string | null;
  parent_text: string | null;
  parent_hash: string | null;
  parent_tokens: number | null;
};

type ReadUnit = {
  key: string;
  firstChunkId: number;
  chunkIds: number[];
  paths: string[];
  text: string;
  contentHash: string;
  tokenCount: number;
};

export class EvidenceService {
  private readonly deps: EvidenceServiceDeps;

  constructor(deps: EvidenceServiceDeps) {
    this.deps = deps;
  }

  async searchDocs(input: SearchDocsInput): Promise<SearchDocsOutput> {
    const requestedLimit = clampInteger(input.limit, AGENT_SEARCH_LIMIT, 1, AGENT_SEARCH_LIMIT);
    const configuredRetrieval = this.deps.searchDeps.retrievalConfig ?? {
      topK: AGENT_SEARCH_LIMIT,
      rrfK: 60,
      maxChunksHardCap: AGENT_SEARCH_LIMIT,
    };
    const overfetchLimit = Math.min(
      AGENT_SEARCH_OVERFETCH_CAP,
      Math.max(configuredRetrieval.topK, requestedLimit * AGENT_SEARCH_OVERFETCH_MULTIPLIER),
    );
    const result = await search(
      {
        ...this.deps.searchDeps,
        // The Agent reasons over pages, not child chunks. Keep the public
        // search()/legacy Ask child reranker unchanged, but disable it for
        // this discovery call so one page cannot consume the cross-encoder
        // window with several sibling children before page collapse.
        reranker: null,
        // The legacy hard cap counts child chunks. Agent discovery counts
        // unique pages, so fetch a wider navigation window before collapsing
        // siblings. This does not change the public MCP search contract.
        retrievalConfig: {
          ...configuredRetrieval,
          topK: overfetchLimit,
          maxChunksHardCap: overfetchLimit,
        },
        // Discovery is already planned by the Agent. Never hide another model
        // call inside the legacy retrieval pipeline, even for long questions.
        intentRouter: EVIDENCE_SEARCH_ROUTER,
      },
      {
        question: input.query,
        context: {
          scope_id: input.scopeId ?? null,
          current_page_id: input.currentPageId ?? null,
        },
      },
      overfetchLimit,
    );
    if (result.type === 'error') {
      throw new EvidenceToolError(result.code, result.message);
    }
    // Agent discovery is page-oriented. Multiple top-ranked children from
    // one page should not crowd a dedicated operation page out of the tool
    // result; keep the best child as that page's navigation clue.
    const seenPages = new Set<string>();
    const pageCandidates = result.hits.filter((hit) => {
      const key = hit.page_id;
      if (seenPages.has(key)) return false;
      seenPages.add(key);
      return true;
    });
    const protectedPageIds = protectedCandidatePageIds(
      this.deps.db,
      input.query,
      input.scopeId ?? null,
      input.currentPageId ?? null,
      pageCandidates,
    );
    const ranked = this.deps.searchDeps.reranker
      ? await observeLangfuse(
          'rerank-page-candidates',
          'retriever',
          {
            input: {
              query: input.query,
              candidates: pageCandidates.length,
              protected_page_ids: [...protectedPageIds],
            },
          },
          async (observation) => {
            const output = await rerankPageCandidates(
              this.deps.searchDeps.reranker!,
              input.query,
              pageCandidates,
              this.deps.searchDeps.rerankerConfig,
              protectedPageIds,
              configuredRetrieval.rrfK,
            );
            observation?.update({
              output: output.map((candidate, index) => ({
                rank: index + 1,
                page_id: candidate.page_id,
                chunk_id: candidate.chunk_id,
                score: candidate.score,
                protected: protectedPageIds.has(candidate.page_id),
              })),
            });
            return output;
          },
        )
      : pageCandidates;
    const candidates = ranked.slice(0, requestedLimit);
    return { type: 'candidates' as const, candidates };
  }

  lookupExact(input: {
    identifier: string;
    scopeId?: string | null;
    lang?: DocsLang | null;
    limit?: number;
  }): ExactMatch[] {
    const identifier = input.identifier.trim();
    if (!identifier) throw new EvidenceToolError('invalid_identifier', 'identifier must not be empty');
    assertScope(this.deps.db, input.scopeId ?? null);
    const requestedLimit = clampInteger(input.limit, 10, 1, AGENT_SEARCH_LIMIT);

    const rows = this.deps.db.prepare(
      `SELECT ci.identifier, ci.kind, c.chunk_id, c.page_id, c.lang,
              COALESCE(c.in_page_path, '') AS in_page_path,
              c.object_path, c.text, p.title, p.url, p.breadcrumb
         FROM chunk_identifiers ci
         JOIN chunks c ON c.chunk_id = ci.chunk_id
         JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
        WHERE ci.normalized = ?
          AND p.status = 'published'
          AND (? IS NULL OR p.subtree_root = ?)
          AND (? IS NULL OR c.lang = ?)
        ORDER BY CASE WHEN c.lang = ? THEN 0 ELSE 1 END,
                 p.nav_index ASC, c.chunk_id ASC
        LIMIT ?`,
    ).all(
      identifier.toLowerCase(),
      input.scopeId ?? null,
      input.scopeId ?? null,
      input.lang ?? null,
      input.lang ?? null,
      input.lang ?? '',
      Math.min(200, requestedLimit * 20),
    ) as Array<{
      identifier: string;
      kind: string;
      chunk_id: number;
      page_id: string;
      lang: DocsLang;
      in_page_path: string;
      object_path: string | null;
      text: string;
      title: string;
      url: string | null;
      breadcrumb: string;
    }>;

    // One document is one navigation candidate. API paths commonly appear in
    // several code samples on the same page; letting those rows consume the
    // entire limit hides authentication or troubleshooting pages that the
    // Agent may need next.
    const seenPages = new Set<string>();
    const matches: ExactMatch[] = [];
    for (const row of rows) {
      const pageKey = `${row.page_id}\0${row.lang}`;
      if (seenPages.has(pageKey)) continue;
      seenPages.add(pageKey);
      matches.push({
        identifier: row.identifier,
        kind: row.kind,
        chunkId: row.chunk_id,
        pageId: row.page_id,
        lang: row.lang,
        title: row.title,
        url: row.url,
        breadcrumb: parseBreadcrumb(row.breadcrumb),
        inPagePath: row.in_page_path,
        objectPath: row.object_path,
        snippet: row.text,
      });
      if (matches.length >= requestedLimit) break;
    }
    return matches;
  }

  browseCatalog(input: {
    scopeId?: string | null;
    lang?: DocsLang | null;
    query?: string | null;
    limit?: number;
  } = {}): CatalogEntry[] {
    assertScope(this.deps.db, input.scopeId ?? null);
    const query = input.query?.trim().toLowerCase() || null;
    const rows = this.deps.db.prepare(
      `SELECT page_id, lang, title, url, breadcrumb, subtree_root, nav_index
         FROM pages
        WHERE status = 'published'
          AND (? IS NULL OR subtree_root = ?)
          AND (? IS NULL OR lang = ?)
          AND (? IS NULL OR lower(title) LIKE ? OR lower(page_id) LIKE ?)
        ORDER BY lang ASC, nav_index ASC, page_id ASC
        LIMIT ?`,
    ).all(
      input.scopeId ?? null,
      input.scopeId ?? null,
      input.lang ?? null,
      input.lang ?? null,
      query,
      query ? `%${query}%` : null,
      query ? `%${query}%` : null,
      clampInteger(input.limit, 20, 1, AGENT_CATALOG_LIMIT),
    ) as PageRow[];

    return rows.map(catalogEntryFromRow);
  }

  readDoc(input: {
    pageId: string;
    lang?: DocsLang | null;
    scopeId?: string | null;
    mode?: EvidenceReadMode;
    selector?: string | null;
    maxTokens?: number;
  }): EvidenceRecord {
    const pageId = input.pageId.trim();
    if (!pageId) throw new EvidenceToolError('invalid_page_id', 'pageId must not be empty');
    assertScope(this.deps.db, input.scopeId ?? null);

    const pages = this.deps.db.prepare(
      `SELECT page_id, lang, title, url, breadcrumb, subtree_root, nav_index
         FROM pages
        WHERE page_id = ? AND status = 'published'
          AND (? IS NULL OR subtree_root = ?)
        ORDER BY lang ASC`,
    ).all(pageId, input.scopeId ?? null, input.scopeId ?? null) as PageRow[];
    if (pages.length === 0) {
      throw new EvidenceToolError('not_found', `no published page with page_id '${pageId}'`);
    }

    const chosen = chooseLanguage(pages, input.lang ?? null);
    const mode = input.mode ?? 'page';
    const selector = input.selector?.trim() || null;
    if (mode !== 'page' && !selector) {
      throw new EvidenceToolError('invalid_selector', `${mode} mode requires selector`);
    }

    const rows = this.deps.db.prepare(
      `SELECT c.chunk_id, c.parent_id, c.in_page_path, c.object_path,
              c.text AS chunk_text, c.content_hash AS chunk_hash,
              c.token_count AS chunk_tokens,
              cp.parent_path, cp.heading_id, cp.heading_path,
              cp.text AS parent_text, cp.content_hash AS parent_hash,
              cp.token_count AS parent_tokens
         FROM chunks c
         LEFT JOIN chunk_parents cp ON cp.parent_id = c.parent_id
        WHERE c.page_id = ? AND c.lang = ?
        ORDER BY c.chunk_id ASC`,
    ).all(pageId, chosen.lang) as ReadUnitRow[];

    const maxTokens = clampInteger(
      input.maxTokens,
      AGENT_READ_TOKEN_LIMIT,
      1,
      AGENT_READ_TOKEN_HARD_CAP,
    );
    const units = collapseReadUnits(rows, maxTokens);
    const selected = selectReadUnits(this.deps.db, units, rows, pageId, chosen.lang, mode, selector);
    if (selected.length === 0) {
      throw new EvidenceToolError(
        'selector_not_found',
        `no ${mode} content matching '${selector ?? ''}' in page '${pageId}'`,
      );
    }
    const bounded = takeWithinTokenBudget(selected, maxTokens);
    const body = bounded.units.map((unit) => unit.text).join('\n\n');
    const contentHash = createHash('sha256')
      .update(bounded.units.map((unit) => unit.contentHash).join(':'))
      .digest('hex');
    const path = commonPath(bounded.units.flatMap((unit) => unit.paths));
    const evidenceId = `ev_${createHash('sha256')
      // Evidence identity follows the authoritative content range, not how
      // the Agent happened to access it. A page and a section read that
      // resolve to byte-equivalent content must map to one citation.
      .update([pageId, chosen.lang, contentHash].join('\0'))
      .digest('hex')
      .slice(0, 20)}`;

    return {
      evidenceId,
      pageId,
      lang: chosen.lang,
      title: chosen.title,
      url: chosen.url,
      breadcrumb: parseBreadcrumb(chosen.breadcrumb),
      mode,
      selector,
      inPagePath: path,
      body,
      tokenCount: bounded.units.reduce((sum, unit) => sum + unit.tokenCount, 0),
      truncated: bounded.truncated,
      availableLangs: pages.map((page) => page.lang),
      chunkIds: bounded.units.flatMap((unit) => unit.chunkIds),
      contentHash,
    };
  }
}

/**
 * Reorder unique page candidates with one representative document per page.
 * Exact/current-page candidates keep their original slots; the reranker only
 * competes for the remaining slots. Score slots are reassigned after sorting
 * so callers retain a monotonic, retrieval-scale score sequence.
 */
export async function rerankPageCandidates(
  reranker: Reranker,
  query: string,
  candidates: SearchHit[],
  config?: RerankerConfig,
  protectedPageIds: ReadonlySet<string> = new Set(),
  rrfK = 60,
): Promise<SearchHit[]> {
  if (candidates.length === 0) return candidates;
  const topK = Math.min(
    candidates.length,
    config?.rerankTopK ?? DEFAULT_AGENT_PAGE_RERANK_TOP_K,
  );
  const weight = config?.weight ?? DEFAULT_AGENT_PAGE_RERANK_WEIGHT;
  const window = candidates.slice(0, topK);
  const tail = candidates.slice(topK);
  const scores = await reranker.rerank(
    query,
    window.map((candidate) => ({
      chunk_id: candidate.chunk_id,
      text: pageCandidateText(candidate),
    })),
  );
  const rawScoreByChunk = new Map(scores.map((score) => [score.chunk_id, score.score]));
  const originalRank = new Map(window.map((candidate, index) => [candidate.chunk_id, index + 1]));
  const semanticRank = new Map(
    [...window]
      .filter((candidate) => !protectedPageIds.has(candidate.page_id))
      .sort((left, right) =>
        (rawScoreByChunk.get(right.chunk_id) ?? Number.NEGATIVE_INFINITY)
        - (rawScoreByChunk.get(left.chunk_id) ?? Number.NEGATIVE_INFINITY))
      .map((candidate, index) => [candidate.chunk_id, index + 1]),
  );
  const movable = window
    .filter((candidate) => !protectedPageIds.has(candidate.page_id))
    .map((candidate) => {
      const lexicalRank = originalRank.get(candidate.chunk_id)!;
      const rerankedPosition = semanticRank.get(candidate.chunk_id) ?? lexicalRank;
      return {
        candidate,
        score:
          weight / (rrfK + rerankedPosition)
          + (1 - weight) / (rrfK + lexicalRank),
      };
    })
    .sort((left, right) => right.score - left.score)
    .map((item) => item.candidate);

  let movableIndex = 0;
  const reordered = window.map((candidate) =>
    protectedPageIds.has(candidate.page_id)
      ? candidate
      : movable[movableIndex++]!);
  const scoreSlots = window.map((candidate) => candidate.score).sort((a, b) => b - a);
  return [
    ...reordered.map((candidate, index) => ({ ...candidate, score: scoreSlots[index]! })),
    ...tail,
  ];
}

function pageCandidateText(candidate: SearchHit): string {
  const breadcrumb = candidate.breadcrumb.map((item) => item.title).join(' > ');
  return [
    `Title: ${candidate.title}`,
    breadcrumb ? `Breadcrumb: ${breadcrumb}` : '',
    `Section: ${candidate.in_page_path}`,
    candidate.snippet,
  ].filter(Boolean).join('\n');
}

function protectedCandidatePageIds(
  db: DbHandle,
  query: string,
  scopeId: string | null,
  currentPageId: string | null,
  candidates: SearchHit[],
): Set<string> {
  const candidatePageIds = new Set(candidates.map((candidate) => candidate.page_id));
  const protectedPageIds = new Set<string>();
  if (currentPageId && candidatePageIds.has(currentPageId)) {
    protectedPageIds.add(currentPageId);
  }

  const identifiers = [...new Set(
    extractIndexedIdentifiers(query).map((identifier) => identifier.normalized),
  )];
  if (identifiers.length === 0) return protectedPageIds;
  const placeholders = identifiers.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT c.page_id
       FROM chunk_identifiers ci
       JOIN chunks c ON c.chunk_id = ci.chunk_id
       JOIN pages p ON p.page_id = c.page_id AND p.lang = c.lang
      WHERE ci.normalized IN (${placeholders})
        AND p.status = 'published'
        AND (? IS NULL OR p.subtree_root = ?)`,
  ).all(...identifiers, scopeId, scopeId) as Array<{ page_id: string }>;
  for (const row of rows) {
    if (candidatePageIds.has(row.page_id)) protectedPageIds.add(row.page_id);
  }
  return protectedPageIds;
}

export class EvidenceToolError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceToolError';
    this.code = code;
  }
}

function assertScope(db: DbHandle, scopeId: string | null): void {
  if (!scopeId) return;
  const row = db.prepare(
    `SELECT 1 AS hit FROM pages WHERE subtree_root = ? AND status = 'published' LIMIT 1`,
  ).get(scopeId) as { hit: number } | undefined;
  if (!row) throw new EvidenceToolError('invalid_scope', `scope_id '${scopeId}' is not a published subtree`);
}

function chooseLanguage(rows: PageRow[], preferred: DocsLang | null): PageRow {
  return rows.find((row) => row.lang === preferred) ?? rows[0]!;
}

function collapseReadUnits(rows: ReadUnitRow[], maxTokens: number): ReadUnit[] {
  const units = new Map<string, ReadUnit>();
  for (const row of rows) {
    const useParent = row.parent_id !== null && (row.parent_tokens ?? 0) <= maxTokens;
    const key = useParent ? `parent:${row.parent_id}` : `chunk:${row.chunk_id}`;
    const existing = units.get(key);
    const pathValues = [row.in_page_path, row.object_path, row.parent_path, row.heading_id]
      .filter((value): value is string => !!value);
    if (existing) {
      existing.chunkIds.push(row.chunk_id);
      existing.paths.push(...pathValues);
      continue;
    }
    units.set(key, {
      key,
      firstChunkId: row.chunk_id,
      chunkIds: [row.chunk_id],
      paths: pathValues,
      text: useParent ? row.parent_text! : row.chunk_text,
      contentHash: useParent ? row.parent_hash! : row.chunk_hash,
      tokenCount: useParent ? row.parent_tokens! : row.chunk_tokens,
    });
  }
  return [...units.values()].sort((a, b) => a.firstChunkId - b.firstChunkId);
}

function selectReadUnits(
  db: DbHandle,
  units: ReadUnit[],
  rows: ReadUnitRow[],
  pageId: string,
  lang: DocsLang,
  mode: EvidenceReadMode,
  selector: string | null,
): ReadUnit[] {
  if (mode === 'page') return units;
  const normalized = selector!.toLowerCase();
  const matchingKeys = new Set<string>();

  for (const unit of units) {
    if (
      unit.paths.some((path) => path.toLowerCase().includes(normalized)) ||
      unit.text.toLowerCase().includes(normalized)
    ) {
      matchingKeys.add(unit.key);
    }
  }

  if (mode === 'field') {
    const chunkRows = db.prepare(
      `SELECT c.chunk_id, c.parent_id
         FROM chunk_identifiers ci
         JOIN chunks c ON c.chunk_id = ci.chunk_id
        WHERE c.page_id = ? AND c.lang = ? AND ci.normalized = ?`,
    ).all(pageId, lang, normalized) as Array<{ chunk_id: number; parent_id: number | null }>;
    for (const row of chunkRows) {
      const unit = units.find((candidate) => candidate.chunkIds.includes(row.chunk_id));
      if (unit) matchingKeys.add(unit.key);
    }
  }

  if (matchingKeys.size === 0) return [];
  if (mode === 'field') return units.filter((unit) => matchingKeys.has(unit.key));

  const indexes = units
    .map((unit, index) => (matchingKeys.has(unit.key) ? index : -1))
    .filter((index) => index >= 0);
  const expanded = new Set<number>();
  for (const index of indexes) {
    for (const candidate of [index - 1, index, index + 1]) {
      if (candidate >= 0 && candidate < units.length) expanded.add(candidate);
    }
  }
  return [...expanded].sort((a, b) => a - b).map((index) => units[index]!);
}

function takeWithinTokenBudget(
  units: ReadUnit[],
  maxTokens: number,
): { units: ReadUnit[]; truncated: boolean } {
  const taken: ReadUnit[] = [];
  let total = 0;
  for (const unit of units) {
    if (taken.length > 0 && total + unit.tokenCount > maxTokens) break;
    taken.push(unit);
    total += unit.tokenCount;
    if (total >= maxTokens) break;
  }
  return { units: taken, truncated: taken.length < units.length };
}

function catalogEntryFromRow(row: PageRow): CatalogEntry {
  return {
    pageId: row.page_id,
    lang: row.lang,
    title: row.title,
    url: row.url,
    breadcrumb: parseBreadcrumb(row.breadcrumb),
    subtreeRoot: row.subtree_root,
    navIndex: row.nav_index,
  };
}

function parseBreadcrumb(value: string): BreadcrumbNode[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as BreadcrumbNode[] : [];
  } catch {
    return [];
  }
}

function commonPath(paths: string[]): string {
  const values = [...new Set(paths.filter(Boolean))];
  return values.length === 1 ? values[0]! : values[0] ?? '';
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
