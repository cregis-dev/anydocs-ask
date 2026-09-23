import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RerankerConfig } from '../src/config.ts';
import { openDatabase, type DbHandle } from '../src/db/index.ts';
import {
  EvidenceService,
  EvidenceToolError,
  rerankPageCandidates,
} from '../src/agent/evidence.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { SearchHit } from '../src/query/types.ts';
import type { Reranker, RerankerInputDoc } from '../src/reranker/types.ts';

function insertPage(
  db: DbHandle,
  pageId: string,
  lang: 'en' | 'zh',
  scope = 'waas',
  navIndex = 1,
): void {
  db.prepare(
    `INSERT INTO pages
      (page_id, lang, status, title, url, subtree_root, nav_index, breadcrumb, updated_at)
     VALUES (?, ?, 'published', ?, ?, ?, ?, ?, 1)`,
  ).run(
    pageId,
    lang,
    `${pageId} ${lang}`,
    `/${lang}/${pageId}`,
    scope,
    navIndex,
    JSON.stringify([{ id: scope, title: scope, type: 'group' }, { id: pageId, title: pageId, type: 'page' }]),
  );
}

function insertParent(
  db: DbHandle,
  pageId: string,
  lang: 'en' | 'zh',
  path: string,
  text: string,
  tokenCount: number,
): number {
  return Number(db.prepare(
    `INSERT INTO chunk_parents
      (page_id, lang, parent_path, heading_id, heading_path, text, content_hash, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(pageId, lang, path, path, JSON.stringify([path]), text, `hash-${lang}-${path}`, tokenCount).lastInsertRowid);
}

function insertChild(
  db: DbHandle,
  pageId: string,
  lang: 'en' | 'zh',
  parentId: number,
  path: string,
  text: string,
  objectPath: string | null = null,
): number {
  return Number(db.prepare(
    `INSERT INTO chunks
      (page_id, lang, in_page_path, text, content_hash, token_count, parent_id, chunk_kind, object_path, created_at)
     VALUES (?, ?, ?, ?, ?, 8, ?, 'api-request-object', ?, 1)`,
  ).run(pageId, lang, path, text, `child-${lang}-${path}`, parentId, objectPath).lastInsertRowid);
}

function service(
  db: DbHandle,
  reranker: Reranker | null = null,
  rerankerConfig?: RerankerConfig,
): EvidenceService {
  return new EvidenceService({
    db,
    searchDeps: {
      db,
      embedder: new MockEmbedder(),
      llm: new MockLLM(),
      intentRouter: null,
      reranker,
      rerankerConfig,
    },
  });
}

function rerankerConfig(overrides: Partial<RerankerConfig> = {}): RerankerConfig {
  return {
    enabled: true,
    provider: 'mock',
    model: 'test/page-reranker',
    revision: null,
    preferQuantized: true,
    maxLength: 512,
    rerankTopK: 20,
    weight: 1,
    ...overrides,
  };
}

class ReverseCaptureReranker implements Reranker {
  readonly model = 'test/reverse-capture';
  readonly ready = true;
  calls: RerankerInputDoc[][] = [];

  async warmUp(): Promise<void> {}

  async rerank(_query: string, docs: RerankerInputDoc[]) {
    this.calls.push(docs);
    return docs.map((doc, index) => ({ chunk_id: doc.chunk_id, score: index }));
  }
}

function searchHit(pageId: string, rank: number): SearchHit {
  return {
    chunk_id: rank,
    page_id: pageId,
    lang: 'en',
    title: `Title ${pageId}`,
    breadcrumb: [{ id: pageId, title: `Crumb ${pageId}`, type: 'page' }],
    url: `/en/${pageId}`,
    snippet: `Snippet for ${pageId}`,
    in_page_path: `section-${pageId}/p[1]`,
    score: 1 / rank,
  };
}

test('lookupExact preserves API version, language, metadata, and scope', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'api-waas-api-post-api-v1-payout', 'en');
    insertPage(db, 'api-waas-api-post-api-v2-payout', 'en');
    const v1Parent = insertParent(db, 'api-waas-api-post-api-v1-payout', 'en', 'endpoint', 'POST /api/v1/payout', 6);
    const v2Parent = insertParent(db, 'api-waas-api-post-api-v2-payout', 'en', 'endpoint', 'POST /api/v2/payout', 6);
    const v1 = insertChild(db, 'api-waas-api-post-api-v1-payout', 'en', v1Parent, 'endpoint/p[1]', 'POST /api/v1/payout');
    const v2 = insertChild(db, 'api-waas-api-post-api-v2-payout', 'en', v2Parent, 'endpoint/p[1]', 'POST /api/v2/payout');
    const statement = db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, ?, ?, 'api_path')`,
    );
    statement.run(v1, '/api/v1/payout', '/api/v1/payout');
    statement.run(v2, '/api/v2/payout', '/api/v2/payout');

    const hits = service(db).lookupExact({ identifier: '/api/v1/payout', lang: 'en', scopeId: 'waas' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.pageId, 'api-waas-api-post-api-v1-payout');
    assert.equal(hits[0]?.identifier, '/api/v1/payout');
    assert.equal(hits[0]?.breadcrumb.at(-1)?.id, 'api-waas-api-post-api-v1-payout');
  } finally {
    db.close();
  }
});

test('lookupExact counts unique pages instead of repeated chunks as candidates', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'quickstart', 'en', 'waas', 1);
    insertPage(db, 'authentication', 'en', 'waas', 2);
    const statement = db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, '/api/v1/payout', '/api/v1/payout', 'api_path')`,
    );
    for (const [pageId, path] of [
      ['quickstart', 'curl'],
      ['quickstart', 'node'],
      ['quickstart', 'python'],
      ['authentication', 'signature-example'],
    ] as const) {
      const parent = insertParent(db, pageId, 'en', path, `POST /api/v1/payout in ${path}`, 8);
      statement.run(insertChild(db, pageId, 'en', parent, `${path}/p[1]`, 'POST /api/v1/payout'));
    }

    const hits = service(db).lookupExact({
      identifier: '/api/v1/payout',
      lang: 'en',
      scopeId: 'waas',
      limit: 2,
    });
    assert.deepEqual(hits.map((hit) => hit.pageId), ['quickstart', 'authentication']);
  } finally {
    db.close();
  }
});

test('searchDocs over-fetches child hits to fill the requested unique-page candidates', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    for (const [index, pageId] of ['repeated', 'dedicated-operation', 'reference'].entries()) {
      insertPage(db, pageId, 'en', 'waas', index + 1);
      const childCount = pageId === 'repeated' ? 4 : 1;
      for (let child = 0; child < childCount; child++) {
        const path = `section-${child}`;
        const parent = insertParent(db, pageId, 'en', path, `withdraw address ${pageId} ${child}`, 8);
        insertChild(db, pageId, 'en', parent, `${path}/p[1]`, `withdraw address ${pageId} ${child}`);
      }
    }

    const result = await service(db).searchDocs({ query: 'withdraw address', limit: 3 });
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(
      new Set(result.candidates.map((candidate) => candidate.page_id)),
      new Set(['repeated', 'dedicated-operation', 'reference']),
    );
  } finally {
    db.close();
  }
});

test('searchDocs reranks one representative per page after child collapse', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const reranker = new ReverseCaptureReranker();
  try {
    for (const [index, pageId] of ['repeated', 'dedicated-operation', 'reference'].entries()) {
      insertPage(db, pageId, 'en', 'waas', index + 1);
      const childCount = pageId === 'repeated' ? 4 : 1;
      for (let child = 0; child < childCount; child++) {
        const path = `section-${child}`;
        const parent = insertParent(db, pageId, 'en', path, `withdraw address ${pageId} ${child}`, 8);
        insertChild(db, pageId, 'en', parent, `${path}/p[1]`, `withdraw address ${pageId} ${child}`);
      }
    }

    const result = await service(db, reranker, rerankerConfig()).searchDocs({
      query: 'withdraw address',
      limit: 3,
    });

    assert.equal(reranker.calls.length, 1);
    assert.equal(reranker.calls[0]?.length, 3);
    assert.match(reranker.calls[0]?.[0]?.text ?? '', /^Title:/);
    assert.match(reranker.calls[0]?.[0]?.text ?? '', /Section:/);
    const submittedPageIds = reranker.calls[0]!.map((doc) =>
      doc.text.match(/^Title: (\S+) en$/m)?.[1]);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.page_id),
      submittedPageIds.reverse(),
    );
  } finally {
    db.close();
  }
});

test('page reranker keeps protected candidates in their original slots', async () => {
  const reranker = new ReverseCaptureReranker();
  const candidates = [searchHit('first', 1), searchHit('protected', 2), searchHit('third', 3)];

  const output = await rerankPageCandidates(
    reranker,
    'query',
    candidates,
    rerankerConfig({ rerankTopK: 3 }),
    new Set(['protected']),
  );

  assert.deepEqual(output.map((candidate) => candidate.page_id), ['third', 'protected', 'first']);
  assert.ok(output.every((candidate, index) => index === 0 || output[index - 1]!.score >= candidate.score));
});

test('page reranker leaves candidates outside its top-k window unchanged', async () => {
  const reranker = new ReverseCaptureReranker();
  const candidates = [
    searchHit('first', 1),
    searchHit('second', 2),
    searchHit('tail-one', 3),
    searchHit('tail-two', 4),
  ];

  const output = await rerankPageCandidates(
    reranker,
    'query',
    candidates,
    rerankerConfig({ rerankTopK: 2 }),
  );

  assert.deepEqual(output.map((candidate) => candidate.page_id), [
    'second',
    'first',
    'tail-one',
    'tail-two',
  ]);
  assert.equal(reranker.calls[0]?.length, 2);
});

test('searchDocs protects pages matched by an exact identifier', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  const reranker = new ReverseCaptureReranker();
  try {
    for (const [index, pageId] of ['error-codes', 'generic-one', 'generic-two'].entries()) {
      insertPage(db, pageId, 'en', 'waas', index + 1);
      const parent = insertParent(db, pageId, 'en', 'response', `B0001 response ${pageId}`, 8);
      const child = insertChild(db, pageId, 'en', parent, 'response/p[1]', `B0001 response ${pageId}`);
      if (pageId === 'error-codes') {
        db.prepare(
          `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
           VALUES (?, 'B0001', 'b0001', 'error-code')`,
        ).run(child);
      }
    }

    const result = await service(db, reranker, rerankerConfig()).searchDocs({
      query: 'What does B0001 mean?',
      scopeId: 'waas',
      limit: 3,
    });

    assert.equal(result.candidates[0]?.page_id, 'error-codes');
  } finally {
    db.close();
  }
});

test('readDoc collapses sibling children into one structural parent', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'auth', 'en');
    const parent = insertParent(
      db,
      'auth',
      'en',
      'signature',
      'Exclude sign and empty values. Sort names, concatenate key and value, prepend API Key, then calculate lowercase MD5.',
      24,
    );
    const first = insertChild(db, 'auth', 'en', parent, 'signature/p[1]', 'Exclude sign and empty values.');
    const second = insertChild(db, 'auth', 'en', parent, 'signature/p[2]', 'Sort and calculate MD5.');
    db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, 'sign', 'sign', 'field')`,
    ).run(first);

    const evidence = service(db).readDoc({ pageId: 'auth', lang: 'en', mode: 'field', selector: 'sign' });
    assert.match(evidence.body, /prepend API Key/);
    assert.equal(evidence.body.match(/Exclude sign/g)?.length, 1);
    assert.deepEqual(evidence.chunkIds, [first, second]);
    assert.equal(evidence.truncated, false);
    assert.match(evidence.evidenceId, /^ev_[a-f0-9]{20}$/);
  } finally {
    db.close();
  }
});

test('readDoc section includes one adjacent structural unit on each side', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'checkout', 'en', 'payment-engine');
    for (const [path, text] of [
      ['before', 'request overview'],
      ['valid-time', 'valid_time accepts 10 to 1440 minutes'],
      ['after', 'response fields'],
      ['unrelated', 'far away section'],
    ] as const) {
      const parent = insertParent(db, 'checkout', 'en', path, text, 8);
      insertChild(db, 'checkout', 'en', parent, `${path}/p[1]`, text, path === 'valid-time' ? 'valid_time' : null);
    }

    const evidence = service(db).readDoc({
      pageId: 'checkout',
      lang: 'en',
      mode: 'section',
      selector: 'valid-time',
    });
    assert.match(evidence.body, /request overview/);
    assert.match(evidence.body, /10 to 1440/);
    assert.match(evidence.body, /response fields/);
    assert.doesNotMatch(evidence.body, /far away/);
  } finally {
    db.close();
  }
});

test('readDoc falls back to child windows when a parent exceeds the token budget', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'long-auth', 'en');
    const parent = insertParent(
      db,
      'long-auth',
      'en',
      'authentication',
      'OVERSIZED PARENT CONTENT THAT MUST NOT BE INJECTED WHOLE',
      4_000,
    );
    const before = insertChild(db, 'long-auth', 'en', parent, 'authentication/p[1]', 'authentication overview');
    const target = insertChild(db, 'long-auth', 'en', parent, 'authentication/p[2]', 'sort fields then calculate MD5', 'sign');
    const after = insertChild(db, 'long-auth', 'en', parent, 'authentication/p[3]', 'submit the request');
    db.prepare(
      `INSERT INTO chunk_identifiers (chunk_id, identifier, normalized, kind)
       VALUES (?, 'sign', 'sign', 'field')`,
    ).run(target);

    const evidence = service(db).readDoc({
      pageId: 'long-auth',
      lang: 'en',
      mode: 'field',
      selector: 'sign',
      maxTokens: 100,
    });
    assert.equal(evidence.body, 'sort fields then calculate MD5');
    assert.deepEqual(evidence.chunkIds, [target]);
    assert.equal(evidence.tokenCount, 8);
    assert.doesNotMatch(evidence.body, /OVERSIZED PARENT/);
    assert.notDeepEqual(evidence.chunkIds, [before, target, after]);
  } finally {
    db.close();
  }
});

test('readDoc enforces scope and reports truncation without splitting a parent', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'long-page', 'en', 'waas');
    for (let i = 0; i < 3; i++) {
      const parent = insertParent(db, 'long-page', 'en', `section-${i}`, `section ${i}`, 100);
      insertChild(db, 'long-page', 'en', parent, `section-${i}/p[1]`, `section ${i}`);
    }
    const evidence = service(db).readDoc({ pageId: 'long-page', scopeId: 'waas', maxTokens: 150 });
    assert.equal(evidence.tokenCount, 100);
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.body, 'section 0');

    assert.throws(
      () => service(db).readDoc({ pageId: 'long-page', scopeId: 'payment-engine' }),
      (error) => error instanceof EvidenceToolError && error.code === 'invalid_scope',
    );
  } finally {
    db.close();
  }
});

test('browseCatalog returns published pages in navigation order', () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    insertPage(db, 'second', 'zh', 'waas', 2);
    insertPage(db, 'first', 'zh', 'waas', 1);
    insertPage(db, 'other', 'zh', 'payment-engine', 0);
    const pages = service(db).browseCatalog({ scopeId: 'waas', lang: 'zh' });
    assert.deepEqual(pages.map((page) => page.pageId), ['first', 'second']);
  } finally {
    db.close();
  }
});
