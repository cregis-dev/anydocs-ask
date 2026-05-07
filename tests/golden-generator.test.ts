/**
 * Structure-based golden generator + reviewer + LLM-rewrite parser tests.
 *
 * Builds tiny in-memory anydocs project shapes and asserts:
 *   - DFS walk visits sections recursively, page nodes only
 *   - Each published page yields up to 5 candidates (4 if no sibling)
 *   - compare_siblings template fires only when there's a sibling
 *   - draft / in_review pages are skipped
 *   - reviewCandidates moves approved -> cases.jsonl, drops rejected,
 *     leaves pending in candidate file
 *   - parseRewriteResponse tolerates ```json fences and rejects shape errors
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedProject } from '../src/anydocs/loader.ts';
import type { DocsLang, NavigationDoc, PageDoc } from '../src/anydocs/types.ts';
import { generateFromStructure } from '../src/golden/generator.ts';
import { parseRewriteResponse, rewriteCandidatesWithLLM } from '../src/golden/llm-rewrite.ts';
import { reviewCandidates } from '../src/golden/reviewer.ts';
import { goldenPaths, writeCandidates, readApproved, readCandidates } from '../src/golden/store.ts';
import type { GoldenCaseCandidate, TemplateId } from '../src/golden/types.ts';
import { MockLLM } from '../src/llm/mock.ts';

function page(id: string, lang: DocsLang, title: string, slug = id): PageDoc {
  return { id, lang, slug, title, status: 'published', content: { version: 1, blocks: [] } };
}

function buildProject(args: {
  navItemsZh?: NavigationDoc['items'];
  navItemsEn?: NavigationDoc['items'];
  pagesZh?: PageDoc[];
  pagesEn?: PageDoc[];
}): LoadedProject {
  const navigationsByLang = new Map<DocsLang, NavigationDoc>();
  if (args.navItemsZh) navigationsByLang.set('zh', { version: 1, items: args.navItemsZh });
  if (args.navItemsEn) navigationsByLang.set('en', { version: 1, items: args.navItemsEn });
  const pagesByLangAndId = new Map<DocsLang, Map<string, PageDoc>>();
  if (args.pagesZh) pagesByLangAndId.set('zh', new Map(args.pagesZh.map((p) => [p.id, p])));
  if (args.pagesEn) pagesByLangAndId.set('en', new Map(args.pagesEn.map((p) => [p.id, p])));
  return { projectRoot: '/fake', navigationsByLang, pagesByLangAndId, warnings: [] };
}

async function withTmpProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-golden-'));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test('generator: solo page emits 4 templates (no compare_siblings)', () => {
  const project = buildProject({
    navItemsZh: [{ type: 'page', pageId: 'auth' }],
    pagesZh: [page('auth', 'zh', '鉴权')],
  });
  const cands = generateFromStructure(project);
  assert.equal(cands.length, 4);
  const tmpls = cands.map((c) => c.template_id).sort();
  assert.deepEqual(tmpls, ['caveats', 'how_to_configure', 'how_to_use', 'what_is']);
  for (const c of cands) {
    assert.equal(c.lang, 'zh');
    assert.match(c.query, /鉴权/);
    assert.deepEqual(c.expected.must_cite_pages, ['auth']);
    assert.equal(c.decision, null);
    assert.equal(c.created_by, 'structure');
  }
});

test('generator: two siblings under a section emit 5 templates each', () => {
  const project = buildProject({
    navItemsZh: [
      {
        type: 'section',
        title: '安全',
        children: [
          { type: 'page', pageId: 'jwt' },
          { type: 'page', pageId: 'oauth' },
        ],
      },
    ],
    pagesZh: [page('jwt', 'zh', 'JWT'), page('oauth', 'zh', 'OAuth')],
  });
  const cands = generateFromStructure(project);
  // 2 pages × 5 templates = 10
  assert.equal(cands.length, 10);
  const compares = cands.filter((c) => c.template_id === 'compare_siblings');
  assert.equal(compares.length, 2);
  for (const c of compares) {
    assert.match(c.query, /安全/);
  }
  // Sibling pick is deterministic (alphabetical by slug)
  const jwtCompare = compares.find((c) => c.expected.must_cite_pages[0] === 'jwt')!;
  assert.match(jwtCompare.query, /JWT.*OAuth|OAuth.*JWT/);
});

test('generator: skips draft / in_review pages', () => {
  const draft: PageDoc = { ...page('secret', 'zh', '内部'), status: 'draft' };
  const project = buildProject({
    navItemsZh: [
      { type: 'page', pageId: 'auth' },
      { type: 'page', pageId: 'secret' },
    ],
    pagesZh: [page('auth', 'zh', '鉴权'), draft],
  });
  const cands = generateFromStructure(project);
  // 1 page × 4 (no sibling because the draft is filtered) = 4
  assert.equal(cands.length, 4);
  for (const c of cands) {
    assert.equal(c.expected.must_cite_pages[0], 'auth');
  }
});

test('generator: en pages get English templates', () => {
  const project = buildProject({
    navItemsEn: [{ type: 'page', pageId: 'auth' }],
    pagesEn: [page('auth', 'en', 'Authentication')],
  });
  const cands = generateFromStructure(project);
  assert.equal(cands.length, 4);
  for (const c of cands) {
    assert.match(c.query, /Authentication/);
    assert.equal(c.lang, 'en');
  }
});

test('generator: zh + en together emit per-lang candidates', () => {
  const project = buildProject({
    navItemsZh: [{ type: 'page', pageId: 'auth' }],
    pagesZh: [page('auth', 'zh', '鉴权')],
    navItemsEn: [{ type: 'page', pageId: 'auth' }],
    pagesEn: [page('auth', 'en', 'Authentication')],
  });
  const cands = generateFromStructure(project);
  assert.equal(cands.length, 8);
  const langs = cands.map((c) => c.lang);
  assert.equal(langs.filter((l) => l === 'zh').length, 4);
  assert.equal(langs.filter((l) => l === 'en').length, 4);
});

test('generator: --limit truncates after deterministic walk order', () => {
  const project = buildProject({
    navItemsZh: [
      { type: 'page', pageId: 'a' },
      { type: 'page', pageId: 'b' },
      { type: 'page', pageId: 'c' },
    ],
    pagesZh: [page('a', 'zh', 'A'), page('b', 'zh', 'B'), page('c', 'zh', 'C')],
  });
  const cands = generateFromStructure(project, { limit: 6 });
  assert.equal(cands.length, 6);
});

test('generator: link nodes are ignored', () => {
  const project = buildProject({
    navItemsZh: [
      { type: 'page', pageId: 'auth' },
      { type: 'link', title: 'External', href: 'https://example.com' },
    ],
    pagesZh: [page('auth', 'zh', '鉴权')],
  });
  const cands = generateFromStructure(project);
  assert.equal(cands.length, 4);
});

test('generator: ids are stable and unique per (template, slug)', () => {
  const project = buildProject({
    navItemsZh: [{ type: 'page', pageId: 'auth' }],
    pagesZh: [page('auth', 'zh', '鉴权', 'security/auth')],
  });
  const ids = generateFromStructure(project).map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    ids.sort(),
    ['caveats:security/auth', 'how_to_configure:security/auth', 'how_to_use:security/auth', 'what_is:security/auth'],
  );
});

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

function fakeCand(overrides: Partial<GoldenCaseCandidate> = {}): GoldenCaseCandidate {
  return {
    id: 'what_is:auth',
    query: '什么是鉴权？',
    filters: { audience: null, version: null },
    context_pageId: null,
    expected: { must_cite_pages: ['auth'], must_contain: [], forbid_contain: [] },
    tags: [],
    created_by: 'structure',
    reviewed_at: null,
    reviewer: null,
    lang: 'zh',
    decision: null,
    template_id: 'what_is' as TemplateId,
    ...overrides,
  };
}

test('reviewer: approved candidates move to cases.jsonl, rejected drop, pending stay', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const cands: GoldenCaseCandidate[] = [
      fakeCand({ id: 'a', decision: 'approved' }),
      fakeCand({ id: 'b', decision: 'rejected' }),
      fakeCand({ id: 'c', decision: null }),
    ];
    writeCandidates(root, cands);

    const summary = reviewCandidates(root, {
      now: () => new Date('2026-05-08T00:00:00Z'),
      reviewer: 'shawn',
    });
    assert.deepEqual(summary, { approved: 1, rejected: 1, pending: 1, malformed: 0 });

    const approved = readApproved(root);
    assert.equal(approved.rows.length, 1);
    assert.equal(approved.rows[0]!.id, 'a');
    assert.equal(approved.rows[0]!.reviewed_at, '2026-05-08');
    assert.equal(approved.rows[0]!.reviewer, 'shawn');
    // approved row no longer carries decision/template_id
    assert.equal((approved.rows[0] as unknown as Record<string, unknown>).decision, undefined);
    assert.equal((approved.rows[0] as unknown as Record<string, unknown>).template_id, undefined);

    const candAfter = readCandidates(root);
    assert.equal(candAfter.rows.length, 1);
    assert.equal(candAfter.rows[0]!.id, 'c');
  } finally {
    await cleanup();
  }
});

test('reviewer: idempotent — second run on cleaned candidates does nothing', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    writeCandidates(root, [fakeCand({ id: 'a', decision: 'approved' })]);
    reviewCandidates(root);
    const second = reviewCandidates(root);
    assert.deepEqual(second, { approved: 0, rejected: 0, pending: 0, malformed: 0 });
    const approved = readApproved(root);
    assert.equal(approved.rows.length, 1);
  } finally {
    await cleanup();
  }
});

test('reviewer: appending to existing cases.jsonl preserves prior rows', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    // Round 1: approve 'a'
    writeCandidates(root, [fakeCand({ id: 'a', decision: 'approved' })]);
    reviewCandidates(root);
    // Round 2: approve 'b'
    writeCandidates(root, [fakeCand({ id: 'b', decision: 'approved' })]);
    reviewCandidates(root);
    const approved = readApproved(root);
    assert.deepEqual(approved.rows.map((r) => r.id), ['a', 'b']);
  } finally {
    await cleanup();
  }
});

test('reviewer: malformed lines counted but do not crash', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const paths = goldenPaths(root);
    await fs.mkdir(paths.dir, { recursive: true });
    await fs.writeFile(
      paths.candidates,
      `garbage line\n${JSON.stringify(fakeCand({ id: 'a', decision: 'approved' }))}\n`,
    );
    const summary = reviewCandidates(root);
    assert.equal(summary.approved, 1);
    assert.equal(summary.malformed, 1);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// LLM rewrite — parser
// ---------------------------------------------------------------------------

test('parseRewriteResponse: plain JSON array', () => {
  const r = parseRewriteResponse('["a", "b", "c"]', 3);
  assert.deepEqual(r, ['a', 'b', 'c']);
});

test('parseRewriteResponse: tolerates ```json fences', () => {
  const r = parseRewriteResponse('```json\n["x", "y"]\n```', 2);
  assert.deepEqual(r, ['x', 'y']);
});

test('parseRewriteResponse: rejects non-array', () => {
  assert.throws(() => parseRewriteResponse('"hello"', 1), /expected an array/);
});

test('parseRewriteResponse: rejects wrong length', () => {
  assert.throws(() => parseRewriteResponse('["a"]', 2), /returned 1 items, expected 2/);
});

test('parseRewriteResponse: rejects non-string item', () => {
  assert.throws(() => parseRewriteResponse('["ok", 42]', 2), /not a non-empty string/);
});

test('parseRewriteResponse: rejects empty string item', () => {
  assert.throws(() => parseRewriteResponse('["", "ok"]', 2), /not a non-empty string/);
});

// ---------------------------------------------------------------------------
// LLM rewrite — end-to-end with MockLLM
// ---------------------------------------------------------------------------

test('rewriteCandidatesWithLLM: replaces query and stamps created_by', async () => {
  const cands = [fakeCand({ id: 'a', query: '什么是鉴权？' })];
  const llm = new MockLLM({
    responder: () => JSON.stringify(['鉴权是怎么做的？']),
  });
  const out = await rewriteCandidatesWithLLM(cands, { llm });
  assert.equal(out[0]!.query, '鉴权是怎么做的？');
  assert.equal(out[0]!.created_by, 'structure+llm');
  assert.equal(out[0]!.id, 'a');
});

test('rewriteCandidatesWithLLM: empty input -> empty output, no LLM call', async () => {
  const llm = new MockLLM({
    responder: () => {
      throw new Error('should not be called');
    },
  });
  const out = await rewriteCandidatesWithLLM([], { llm });
  assert.equal(out.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('rewriteCandidatesWithLLM: batches respect batchSize', async () => {
  const cands = [
    fakeCand({ id: 'a' }),
    fakeCand({ id: 'b' }),
    fakeCand({ id: 'c' }),
  ];
  const llm = new MockLLM({
    responder: (input) => {
      // Each call should see exactly batchSize items in the user prompt
      const items = JSON.parse(input.userPrompt.split('\n').slice(2).join('\n')) as Array<{ raw: string }>;
      return JSON.stringify(items.map((it) => `rewritten:${it.raw}`));
    },
  });
  const out = await rewriteCandidatesWithLLM(cands, { llm, batchSize: 2 });
  assert.equal(llm.calls.length, 2); // 2 + 1
  assert.equal(out.length, 3);
  assert.match(out[0]!.query, /^rewritten:/);
});

// ---------------------------------------------------------------------------
// Store: writes round-trip
// ---------------------------------------------------------------------------

test('store: writeCandidates round-trips via readCandidates', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const cands = [fakeCand({ id: 'a' }), fakeCand({ id: 'b' })];
    const path = writeCandidates(root, cands);
    assert.ok(existsSync(path));
    const back = readCandidates(root);
    assert.equal(back.malformed, 0);
    assert.equal(back.rows.length, 2);
    assert.equal(back.rows[0]!.id, 'a');
  } finally {
    await cleanup();
  }
});

test('store: writeCandidates with empty array writes empty file', async () => {
  const { root, cleanup } = await withTmpProject();
  try {
    const path = writeCandidates(root, []);
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, 'utf8'), '');
  } finally {
    await cleanup();
  }
});
