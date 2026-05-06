/**
 * Stage 3 structure-layer tests.
 *
 * Two flavors:
 *   1. End-to-end through fixtures/starter-docs to make sure we read the
 *      real anydocs JSON shape correctly.
 *   2. In-memory `projectStructure` calls covering every branch in
 *      ARCH §2.2.1 / §2.2.2: section/folder/page/link nodes, depth-1
 *      subtree_root, link participation in nav_index, orphan pages,
 *      cross-lang isolation, status filtering, etc.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProject } from '../src/anydocs/loader.ts';
import { projectStructure, stableNavId } from '../src/structure/project.ts';
import { upsertPages } from '../src/structure/upsert.ts';
import { openDatabase } from '../src/db/index.ts';
import type { BreadcrumbNode } from '../src/db/schema.ts';
import type {
  DocsLang,
  NavigationDoc,
  PageDoc,
} from '../src/anydocs/types.ts';

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/starter-docs/', import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(id: string, lang: DocsLang, overrides: Partial<PageDoc> = {}): PageDoc {
  return {
    id,
    lang,
    slug: id,
    title: `Title ${id}/${lang}`,
    status: 'published',
    content: { version: 1, blocks: [] },
    ...overrides,
  };
}

function input(
  navs: Array<[DocsLang, NavigationDoc]>,
  pages: Array<[DocsLang, PageDoc[]]>,
) {
  return {
    navigationsByLang: new Map(navs),
    pagesByLangAndId: new Map(
      pages.map(([lang, list]) => [lang, new Map(list.map((p) => [p.id, p]))]),
    ),
  };
}

// ---------------------------------------------------------------------------
// loadProject — real fixtures
// ---------------------------------------------------------------------------

test('loadProject reads the starter-docs fixture (zh + en)', async () => {
  const proj = await loadProject(FIXTURES_ROOT);

  assert.equal(proj.warnings.length, 0, `unexpected warnings: ${proj.warnings.join('\n')}`);
  assert.deepEqual([...proj.navigationsByLang.keys()].sort(), ['en', 'zh']);
  assert.deepEqual([...proj.pagesByLangAndId.keys()].sort(), ['en', 'zh']);

  const zhWelcome = proj.pagesByLangAndId.get('zh')!.get('welcome');
  assert.ok(zhWelcome, 'zh welcome page should be loaded');
  assert.equal(zhWelcome!.lang, 'zh');
  assert.equal(zhWelcome!.status, 'published');
});

test('loadProject throws if navigation/ is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anydocs-ask-test-'));
  try {
    await assert.rejects(
      () => loadProject(dir),
      /navigation\/ directory missing/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProject warns on unknown lang in navigation/', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anydocs-ask-test-'));
  try {
    mkdirSync(join(dir, 'navigation'));
    writeFileSync(
      join(dir, 'navigation', 'fr.json'),
      JSON.stringify({ version: 1, items: [] }),
    );
    const proj = await loadProject(dir);
    assert.equal(proj.navigationsByLang.size, 0);
    assert.ok(
      proj.warnings.some((w) => w.includes('unrecognized lang')),
      `expected unrecognized-lang warning; got: ${proj.warnings.join('\n')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProject warns when PageDoc.lang disagrees with path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anydocs-ask-test-'));
  try {
    mkdirSync(join(dir, 'navigation'));
    mkdirSync(join(dir, 'pages', 'zh'), { recursive: true });
    writeFileSync(
      join(dir, 'navigation', 'zh.json'),
      JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'p' }] }),
    );
    writeFileSync(
      join(dir, 'pages', 'zh', 'p.json'),
      JSON.stringify({
        id: 'p',
        lang: 'en',     // mismatch with path
        slug: 'p',
        title: 'P',
        status: 'published',
        content: { version: 1, blocks: [] },
      }),
    );
    const proj = await loadProject(dir);
    const zhP = proj.pagesByLangAndId.get('zh')!.get('p');
    assert.equal(zhP!.lang, 'zh', 'path-derived lang should win');
    assert.ok(
      proj.warnings.some((w) => w.includes('does not match path lang')),
      `expected mismatch warning; got: ${proj.warnings.join('\n')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// stableNavId — direct unit
// ---------------------------------------------------------------------------

test('stableNavId: page node uses pageId', () => {
  const id = stableNavId(
    { type: 'page', pageId: 'welcome' },
    'zh',
    [0, 1],
  );
  assert.equal(id, 'welcome');
});

test('stableNavId: section/folder uses author-provided id when present', () => {
  const id = stableNavId(
    { type: 'section', id: 'getting-started', title: '开始', children: [] },
    'zh',
    [0],
  );
  assert.equal(id, 'getting-started');
});

test('stableNavId: section/folder falls back to dfs path', () => {
  const id = stableNavId(
    { type: 'section', title: '开始', children: [] },
    'zh',
    [0, 2, 1],
  );
  assert.equal(id, 'nav:zh.json:0/2/1');
});

// ---------------------------------------------------------------------------
// projectStructure — projection logic
// ---------------------------------------------------------------------------

test('projectStructure: starter-docs round-trip', async () => {
  const proj = await loadProject(FIXTURES_ROOT);
  const result = projectStructure({
    navigationsByLang: proj.navigationsByLang,
    pagesByLangAndId: proj.pagesByLangAndId,
  });
  assert.equal(result.warnings.length, 0, `unexpected: ${result.warnings.join('\n')}`);
  assert.equal(result.rows.length, 2, 'one row per (page_id, lang)');

  const zh = result.rows.find((r) => r.lang === 'zh')!;
  const en = result.rows.find((r) => r.lang === 'en')!;
  assert.equal(zh.page_id, 'welcome');
  assert.equal(en.page_id, 'welcome');

  // Both pages sit under a single section node with no explicit id ->
  // subtree_root should be the dfs-derived id of that section.
  assert.equal(zh.subtree_root, 'nav:zh.json:0');
  assert.equal(en.subtree_root, 'nav:en.json:0');

  // Section is at navIndex 0; the page is the first child -> 1.
  assert.equal(zh.nav_index, 1);
  assert.equal(en.nav_index, 1);

  const zhBreadcrumb = JSON.parse(zh.breadcrumb) as BreadcrumbNode[];
  assert.equal(zhBreadcrumb.length, 2);
  assert.equal(zhBreadcrumb[0]?.type, 'section');
  assert.equal(zhBreadcrumb[1]?.type, 'page');
  assert.equal(zhBreadcrumb[1]?.id, 'welcome');
});

test('projectStructure: link nodes do not enter pages but bump nav_index', () => {
  const result = projectStructure(
    input(
      [
        [
          'zh',
          {
            version: 1,
            items: [
              {
                type: 'section',
                title: '入门',
                children: [
                  { type: 'link', title: '官网', href: 'https://x' },
                  { type: 'page', pageId: 'p1' },
                ],
              },
            ],
          },
        ],
      ],
      [['zh', [makePage('p1', 'zh')]]],
    ),
  );

  assert.equal(result.rows.length, 1);
  // nav_index counter: section=0, link=1, page=2.
  assert.equal(result.rows[0]!.nav_index, 2);
});

test('projectStructure: folder nests under section, subtree_root stays at depth 1', () => {
  const result = projectStructure(
    input(
      [
        [
          'zh',
          {
            version: 1,
            items: [
              {
                type: 'section',
                id: 'frontend',
                title: '前端 SDK',
                children: [
                  {
                    type: 'folder',
                    title: '鉴权',
                    children: [{ type: 'page', pageId: 'auth' }],
                  },
                ],
              },
            ],
          },
        ],
      ],
      [['zh', [makePage('auth', 'zh')]]],
    ),
  );

  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.subtree_root, 'frontend', 'depth-1 ancestor wins, not the folder');
  const breadcrumb = JSON.parse(row.breadcrumb) as BreadcrumbNode[];
  assert.deepEqual(
    breadcrumb.map((b) => b.type),
    ['section', 'folder', 'page'],
  );
});

test('projectStructure: depth-1 with explicit id is preferred over dfs path', () => {
  const result = projectStructure(
    input(
      [
        [
          'zh',
          {
            version: 1,
            items: [
              {
                type: 'section',
                id: 'getting-started',
                title: '入门',
                children: [{ type: 'page', pageId: 'welcome' }],
              },
            ],
          },
        ],
      ],
      [['zh', [makePage('welcome', 'zh')]]],
    ),
  );
  assert.equal(result.rows[0]!.subtree_root, 'getting-started');
});

test('projectStructure: draft / in_review pages are filtered out', () => {
  const result = projectStructure(
    input(
      [
        [
          'zh',
          {
            version: 1,
            items: [
              { type: 'page', pageId: 'p_pub' },
              { type: 'page', pageId: 'p_draft' },
              { type: 'page', pageId: 'p_review' },
            ],
          },
        ],
      ],
      [
        [
          'zh',
          [
            makePage('p_pub', 'zh'),
            makePage('p_draft', 'zh', { status: 'draft' }),
            makePage('p_review', 'zh', { status: 'in_review' }),
          ],
        ],
      ],
    ),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.page_id, 'p_pub');
});

test('projectStructure: same page_id under zh and en produce two independent rows', () => {
  const nav = (lang: DocsLang): NavigationDoc => ({
    version: 1,
    items: [
      {
        type: 'section',
        id: `s-${lang}`,
        title: `Section ${lang}`,
        children: [{ type: 'page', pageId: 'shared' }],
      },
    ],
  });
  const result = projectStructure(
    input(
      [
        ['zh', nav('zh')],
        ['en', nav('en')],
      ],
      [
        ['zh', [makePage('shared', 'zh')]],
        ['en', [makePage('shared', 'en')]],
      ],
    ),
  );
  assert.equal(result.rows.length, 2);
  const langs = result.rows.map((r) => r.lang).sort();
  assert.deepEqual(langs, ['en', 'zh']);
  // subtree_root differs by lang (different nav files, different ids).
  const zh = result.rows.find((r) => r.lang === 'zh')!;
  const en = result.rows.find((r) => r.lang === 'en')!;
  assert.equal(zh.subtree_root, 's-zh');
  assert.equal(en.subtree_root, 's-en');
});

test('projectStructure: orphan page (no nav reference) gets degenerate values + warning', () => {
  const result = projectStructure(
    input(
      [['zh', { version: 1, items: [{ type: 'page', pageId: 'p1' }] }]],
      [['zh', [makePage('p1', 'zh'), makePage('p2', 'zh')]]],
    ),
  );
  assert.equal(result.rows.length, 2);
  const orphan = result.rows.find((r) => r.page_id === 'p2')!;
  assert.equal(orphan.subtree_root, null);
  assert.equal(orphan.nav_index, Number.MAX_SAFE_INTEGER);
  assert.ok(result.warnings.some((w) => w.includes('orphan')));
});

test('projectStructure: navigation references unknown pageId emits warning + skips row', () => {
  const result = projectStructure(
    input(
      [['zh', { version: 1, items: [{ type: 'page', pageId: 'ghost' }] }]],
      [['zh', []]],
    ),
  );
  assert.equal(result.rows.length, 0);
  assert.ok(
    result.warnings.some((w) => w.includes('unknown pageId')),
    `expected unknown-pageId warning; got: ${result.warnings.join('\n')}`,
  );
});

test('projectStructure: duplicate page reference in nav keeps first, warns', () => {
  const result = projectStructure(
    input(
      [
        [
          'zh',
          {
            version: 1,
            items: [
              { type: 'section', id: 'a', title: 'A', children: [{ type: 'page', pageId: 'p' }] },
              { type: 'section', id: 'b', title: 'B', children: [{ type: 'page', pageId: 'p' }] },
            ],
          },
        ],
      ],
      [['zh', [makePage('p', 'zh')]]],
    ),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.subtree_root, 'a');
  assert.ok(result.warnings.some((w) => w.includes('referenced more than once')));
});

// ---------------------------------------------------------------------------
// upsertPages — DB integration
// ---------------------------------------------------------------------------

test('upsertPages: insert -> update -> delete cycle', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const proj = await loadProject(FIXTURES_ROOT);
    const first = projectStructure(proj);
    const r1 = upsertPages(db, first.rows);
    assert.equal(r1.inserted, 2, 'first round inserts both langs');
    assert.equal(r1.updated, 0);
    assert.equal(r1.deleted, 0);

    const r2 = upsertPages(db, first.rows);
    assert.equal(r2.inserted, 0);
    assert.equal(r2.updated, 2, 'second round with same rows is all updates');
    assert.equal(r2.deleted, 0);

    // Drop en from the projection (simulate deleting navigation/en.json).
    const zhOnly = first.rows.filter((r) => r.lang === 'zh');
    const r3 = upsertPages(db, zhOnly);
    assert.equal(r3.inserted, 0);
    assert.equal(r3.updated, 1);
    assert.equal(r3.deleted, 1);

    const remaining = db
      .prepare('SELECT page_id, lang FROM pages ORDER BY lang')
      .all() as Array<{ page_id: string; lang: string }>;
    assert.deepEqual(remaining, [{ page_id: 'welcome', lang: 'zh' }]);
  } finally {
    db.close();
  }
});

test('upsertPages: cascading delete removes chunks for that (page_id, lang) only', async () => {
  const db = openDatabase({ dbPath: ':memory:' });
  try {
    const proj = await loadProject(FIXTURES_ROOT);
    const first = projectStructure(proj);
    upsertPages(db, first.rows);

    // Pretend stage-4 has run: insert one chunk per lang for 'welcome'.
    const insertChunk = db.prepare(
      `INSERT INTO chunks (page_id, lang, text, content_hash, token_count, created_at)
       VALUES (?, ?, 'hello', 'h', 1, 1)`,
    );
    insertChunk.run('welcome', 'zh');
    insertChunk.run('welcome', 'en');

    // Drop en. Only the en chunk should disappear.
    upsertPages(db, first.rows.filter((r) => r.lang === 'zh'));
    const langs = db
      .prepare('SELECT lang FROM chunks ORDER BY lang')
      .all() as Array<{ lang: string }>;
    assert.deepEqual(langs, [{ lang: 'zh' }]);
  } finally {
    db.close();
  }
});
