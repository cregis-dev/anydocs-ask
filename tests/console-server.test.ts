/**
 * Console Hono app smoke tests — GET / and GET /api/projects.
 * Uses scanProjects against a tmp workspace + a minimal fake registry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleApp, type ProjectStatusJSON } from '../src/console/server.ts';
import { openDatabase } from '../src/db/index.ts';
import { ensureStateRoot } from '../src/workspace.ts';
import {
  ProcessRegistry,
  type RegistryConfig,
  type Spawnable,
} from '../src/console/registry.ts';
import { addToProjectRegistry } from '../src/workspace.ts';

async function withTmpDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await fs.mkdtemp(join(tmpdir(), 'anydocs-console-srv-'));
  return { path, cleanup: () => fs.rm(path, { recursive: true, force: true }) };
}

async function makeWorkspaceWithProjects(ws: string, names: string[]): Promise<void> {
  await fs.mkdir(join(ws, 'state'), { recursive: true });
  for (const name of names) {
    const p = join(ws, 'projects', name);
    await fs.mkdir(join(p, 'pages'), { recursive: true });
    await fs.mkdir(join(p, 'navigation'), { recursive: true });
    await fs.writeFile(
      join(p, 'anydocs.config.json'),
      JSON.stringify({ version: 1, projectId: name }),
    );
    addToProjectRegistry(ws, p, name);
  }
}

class FakeChild implements Spawnable {
  pid = 1234;
  kill(): boolean {
    return true;
  }
  onExit(): void {
    /* never fires in these tests */
  }
}

function makeRegistry(): ProcessRegistry {
  const config: RegistryConfig = {
    childPortRangeStart: 4101,
    childPortRangeEnd: 4199,
    idleTimeoutMin: 15,
    healthTimeoutMs: 10,
  };
  return new ProcessRegistry({
    spawner: () => new FakeChild(),
    healthProbe: async () => true,
    config,
    workspacePath: '/tmp/fake',
  });
}

test('GET /: empty workspace shows guidance, not crash', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /projects/);
    assert.match(body, /还没有注册任何项目|workspace add/);
  } finally {
    await cleanup();
  }
});

test('GET /: lists valid + invalid projects with status tags', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // Add an invalid one (missing navigation/) — must also register it
    const brokenPath = join(ws, 'projects', 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /docs-zh/);
    assert.match(body, /broken/);
    // valid card vs invalid card distinguishable
    assert.match(body, /class="card proj-card"[\s\S]*docs-zh/);
    assert.match(body, /class="card proj-card invalid"[\s\S]*broken/);
    assert.match(body, /missing:[^<]*navigation/);
    // idle pill on stopped project
    assert.match(body, /pill[^>]*>[\s\S]*?idle/);
    // open link only for valid project (autostart variant or live variant)
    assert.match(body, /href="\/p\/docs-zh(\?autostart=1)?"/);
    assert.equal(body.includes('href="/p/broken"'), false);
    assert.equal(body.includes('href="/p/broken?autostart=1"'), false);
  } finally {
    await cleanup();
  }
});

test('GET /: running registry entry surfaces port + run tag', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh'); // 4101
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
    });
    const res = await app.request('/');
    const body = await res.text();
    assert.match(body, /running · :4101/);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects: empty workspace returns []', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects');
    assert.equal(res.status, 200);
    const body = (await res.json()) as ProjectStatusJSON[];
    assert.deepEqual(body, []);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects: returns ProjectStatusJSON with running/port/pid', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['a', 'b']);
    const registry = makeRegistry();
    await registry.start('a'); // running
    // b not started
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
    });
    const res = await app.request('/api/projects');
    const body = (await res.json()) as ProjectStatusJSON[];
    assert.equal(body.length, 2);
    const a = body.find((p) => p.name === 'a')!;
    const b = body.find((p) => p.name === 'b')!;
    assert.equal(a.running, true);
    assert.equal(a.port, 4101);
    assert.equal(typeof a.pid, 'number');
    assert.equal(a.valid, true);
    assert.equal(a.projectId, 'a');
    assert.equal(b.running, false);
    assert.equal(b.port, null);
    assert.equal(b.pid, null);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: 404 on unknown project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/nope');
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: stopped project shows start button enabled, stop disabled', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Redesign 2026-05-15: the page-head breadcrumb is gone — project name
    // is conveyed by the document <title> + the header project switcher.
    // The Status card holds the start/stop buttons + the "stopped" tag.
    assert.match(body, /<title>docs-zh /);
    assert.match(body, /id="btn-start"(?![^>]*disabled)/);
    assert.match(body, /id="btn-stop"[^>]*disabled/);
    assert.match(body, /tag[^>]*>stopped/);
    // Stopped-state Ask gate heading must be English to match the English
    // body + button copy in the same card (dogfood 2026-05-14 F5 — the IA
    // cleanup left "项目未启动" next to English copy). The console redesign
    // reworded the gate heading; it stays English.
    assert.match(body, />Start this project to begin</);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: running project disables start, enables stop, shows pid+port', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
    });
    const res = await app.request('/p/docs-zh');
    const body = await res.text();
    assert.match(body, /id="btn-start"[^>]*disabled/);
    assert.match(body, /id="btn-stop"(?![^>]*disabled)/);
    // pagehead pill carries the live status text
    assert.match(body, /pill[^>]*>[\s\S]*?running · :4101/);
    // status card shows port + pid
    assert.match(body, /tag run[^>]*>:4101</);
    assert.match(body, /pid [0-9]/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: project tabs (Ask/Index/Eval/Traffic) + scoped JS handler so they do not collide with Ask sub-tabs', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    const body = await res.text();
    // four project tabs present
    assert.match(body, /data-project-tab="ask"/);
    assert.match(body, /data-project-tab="index"/);
    assert.match(body, /data-project-tab="eval"/);
    assert.match(body, /data-project-tab="traffic"/);
    // Ask sub-tab handler MUST be scoped to #ask-result so it can't
    // accidentally hide outer project panels when user clicks them.
    // (Regression: previous build used unscoped `document.querySelectorAll
    // ('[role=tab]')` which collided with the outer tabs.)
    assert.match(body, /askResultEl\.querySelectorAll/);
    assert.equal(
      /document\.querySelectorAll\('\[role=tab\]'\)/.test(body),
      false,
      'unscoped [role=tab] selector would re-introduce the cross-talk bug',
    );
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: every nav tab is in the hashchange whitelist (URL-anchor jumps stay in sync)', async () => {
  // Regression: T1-a added a Feedback tab CTA pointing at `#settings`, which
  // exposed an existing gap — 'settings' was never in the hashchange
  // whitelist, so the URL changed but the panel didn't. Lock down the rule:
  // every `data-project-tab=...` value emitted in the nav strip must also
  // appear in both the initial-load and the hashchange whitelists in the
  // inline bootstrap script. Asserting the SSR string keeps the test simple
  // (DOM execution is overkill here).
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    const body = await res.text();
    const tabs = Array.from(body.matchAll(/<a class="tab"[^>]*data-project-tab="([^"]+)"/g))
      .map((m) => m[1]!);
    assert.ok(tabs.length > 0, 'expected at least one tab in nav');
    // Find every `['ask', 'index', ...]` whitelist literal in the inline script.
    const whitelists = Array.from(body.matchAll(/\[((?:'[a-z]+'(?:,\s*)?)+)\]\.includes/g))
      .map((m) => m[1]!.split(',').map((s) => s.trim().replace(/'/g, '')));
    assert.ok(whitelists.length >= 2, 'expected ≥2 hash whitelists in bootstrap script');
    for (const wl of whitelists) {
      for (const tab of tabs) {
        assert.ok(wl.includes(tab), `tab '${tab}' missing from whitelist [${wl.join(', ')}]`);
      }
    }
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: setProjectTab preserves ?query suffix (jump-to-doc dogfood regression)', async () => {
  // Live dogfood on hermes-docs caught this: the Feedback drawer's
  // jump-to-doc chip sets `location.hash = '#index?focus=<id>'`, which
  // fires hashchange. The hashchange listener called setProjectTab('index'),
  // and the pre-fix setProjectTab did:
  //
  //   if (location.hash !== '#' + name) {
  //     history.replaceState({}, '', location.pathname + '#' + name);
  //   }
  //
  // That strict-equality check force-stripped any `?query=string`, so the
  // hash flipped to `#index` and the Index-tab focus receiver never saw
  // the page id. Static-source assertion that the fixed shape is emitted.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // The fixed check uses `startsWith(expected + '?')` to keep the suffix.
    assert.match(body, /const expected = '#' \+ name;/);
    assert.match(body, /current\.startsWith\(expected \+ '\?'\)/);
    // And the pre-fix shape MUST be gone — guard against re-introduction.
    assert.equal(
      /if \(location\.hash !== '#' \+ name\)/.test(body),
      false,
      'pre-fix strict equality check would silently strip ?query suffix',
    );
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab — disabled state when feedback.enabled is false (RFC 0002 T1-a)', async () => {
  // PRD §11.4 #6 makes feedback.enabled=false the default. The tab must
  // still register (so URL/anchor jumps work), but render the disabled
  // empty state pointing at Settings.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // No anydocs.ask.json written → feedback.enabled = default false.
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Tab is registered in the nav strip + panel container.
    assert.match(body, /data-project-tab="feedback"/);
    assert.match(body, /id="ptab-feedback"/);
    // Disabled state rendered (state 1 from console-redesign-brief §7.5.1).
    assert.match(body, /data-feedback-state="disabled"/);
    assert.match(body, /Feedback loop is off/);
    // CTA points at Settings where feedback.enabled lives.
    assert.match(body, /href="#settings"[^>]*>\s*<svg><use href="#i-gear"\/><\/svg>\s*open Settings/);
    // Empty/enabled state must NOT also be rendered.
    assert.equal(body.includes('data-feedback-state="empty"'), false);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab — empty state when feedback.enabled is true but no rows (RFC 0002 T1-a)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(
      join(projectRoot, 'anydocs.ask.json'),
      JSON.stringify({ feedback: { enabled: true } }, null, 2),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Empty/enabled state rendered (state 2 from console-redesign-brief §7.5.1).
    assert.match(body, /data-feedback-state="empty"/);
    assert.match(body, /data-feedback-total="0"/);
    assert.match(body, /No feedback yet/);
    // KPI rail is in place even with no data — every tile shows the em-dash placeholder.
    assert.match(body, /feedback · 7d/);
    assert.match(body, /A\+ candidates/);
    // Disabled card must NOT also render.
    assert.equal(body.includes('data-feedback-state="disabled"'), false);
    // No "signals collected" banner when totalCount is 0.
    assert.equal(body.includes('data-feedback-banner="collected"'), false);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// T1-b helpers
// ---------------------------------------------------------------------------

async function seedFeedbackProject(ws: string, name: string): Promise<{
  stateRoot: string;
  db: ReturnType<typeof openDatabase>;
}> {
  await makeWorkspaceWithProjects(ws, [name]);
  const projectRoot = join(ws, 'projects', name);
  await fs.writeFile(
    join(projectRoot, 'anydocs.ask.json'),
    JSON.stringify({ feedback: { enabled: true } }, null, 2),
  );
  const stateRoot = ensureStateRoot(ws, name);
  const db = openDatabase({ stateRoot });
  return { stateRoot, db };
}

function insertFeedback(
  db: ReturnType<typeof openDatabase>,
  args: {
    answer_id: string;
    question?: string;
    rating?: number | null;
    signal_source?: 'explicit' | 'implicit' | 'curated';
    current_page_id?: string | null;
    created_at?: number;
    /** RFC 0003 M6 — populated by γ + curated inserts; β path persists null
     *  today (see app.ts:308). Tests use this to seed multi-turn dialogues. */
    session_id?: string | null;
    /** F8 — pre-JSON-encoded retrieved snapshot. Either Citation[] shape
     *  (page_id/snippet) — what β handler writes — or RunCitation[]
     *  (page/quote) — what runs.jsonl uses. Parser must accept both. */
    retrieved?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO feedback
       (answer_id, question, generated, retrieved, rating, signal_source, current_page_id, created_at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.answer_id,
    args.question ?? 'q',
    'gen',
    args.retrieved ?? null,
    args.rating ?? null,
    args.signal_source ?? 'explicit',
    args.current_page_id ?? null,
    args.created_at ?? Date.now(),
    args.session_id ?? null,
  );
}

test('GET /p/:name: Feedback tab — KPI tiles + list render when feedback table populated (RFC 0002 T1-b)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    // 3 explicit (2👍 + 1👎) + 1 implicit — gives every chip a non-zero count
    // and verifies the signal_source split + KPI bucketing.
    insertFeedback(db, { answer_id: 'ans_1', rating: 1 });
    insertFeedback(db, { answer_id: 'ans_2', rating: 1 });
    insertFeedback(db, { answer_id: 'ans_3', rating: -1 });
    insertFeedback(db, { answer_id: 'ans_4', signal_source: 'implicit', rating: null });
    db.close();

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();

    // State transitioned from empty to list.
    assert.match(body, /data-feedback-state="list"/);
    assert.match(body, /data-feedback-total="4"/);

    // KPI tiles carry the real numbers — feedback·7d count and the β/γ split.
    assert.match(body, /β\s*3\s*·\s*γ\s*1/);
    // explicit share = 3 / (3 + 1) = 75%
    assert.match(body, /explicit %[\s\S]*?75%/);
    // A+ candidates tile still placeholder.
    assert.match(body, /A\+ candidates[\s\S]*?—[\s\S]*?unlocks at 50/);

    // Chip bar with the four T1-b filters + per-chip badge counts.
    assert.match(body, /data-feedback-chip="all"/);
    assert.match(body, /data-feedback-chip="thumbs_up"/);
    assert.match(body, /data-feedback-chip="thumbs_down"/);
    assert.match(body, /data-feedback-chip="implicit"/);

    // List has rows — one rendered <li> per seeded row. Match the unique
    // `data-feedback-row="<id>"` attribute to avoid counting the inline JS
    // template's literal `class="feedback-row"` string.
    const rowMatches = body.match(/data-feedback-row="\d+"/g) ?? [];
    assert.equal(rowMatches.length, 4, 'expected 4 SSR feedback rows');
    // Rating badges: 2 👍 + 1 👎 + 1 γ ⏱
    assert.match(body, /<span class="tag ok">👍<\/span>/);
    assert.match(body, /<span class="tag err">👎<\/span>/);
    assert.match(body, /γ ⏱/);

    // The disabled / no-data branches must NOT render alongside.
    assert.equal(body.includes('data-feedback-state="disabled"'), false);
    assert.equal(body.includes('No feedback yet'), false);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab — onboarding banner only when 0 < totalCount < 10 (RFC 0002 T1-b)', async () => {
  // The "X signals collected" banner is an onboarding aid for the
  // pre-PRD §10.3 ≥50 phase. It MUST hide on the 0 row case (covered by
  // its own test) and SHOULD also hide once we cross 10 rows so the
  // healthy state stays uncluttered.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    for (let i = 0; i < 12; i++) {
      insertFeedback(db, { answer_id: 'a_' + i, rating: i % 2 === 0 ? 1 : -1 });
    }
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    assert.match(body, /data-feedback-state="list"/);
    assert.match(body, /data-feedback-total="12"/);
    assert.equal(
      body.includes('data-feedback-banner="collected"'),
      false,
      'banner should not render once totalCount ≥ 10',
    );
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: returns rows + filterCounts; respects ?filter (RFC 0002 T1-b)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1, question: 'q-up' });
    insertFeedback(db, { answer_id: 'a2', rating: 1, question: 'q-up-2' });
    insertFeedback(db, { answer_id: 'a3', rating: -1, question: 'q-down' });
    insertFeedback(db, { answer_id: 'a4', signal_source: 'implicit', question: 'q-implicit' });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });

    // default (filter=all) — all 4 rows.
    const allRes = await app.request('/api/projects/docs-zh/feedback');
    assert.equal(allRes.status, 200);
    const allBody = (await allRes.json()) as {
      ok: boolean;
      rows: Array<{ answerId: string; question: string }>;
      filterCounts: Record<string, number>;
    };
    assert.equal(allBody.ok, true);
    assert.equal(allBody.rows.length, 4);
    assert.deepEqual(allBody.filterCounts, { all: 4, thumbs_up: 2, thumbs_down: 1, implicit: 1, no_citations: 0, semantic_check_failed: 0, aplus_candidates: 0 });

    // filter=thumbs_up — 2 rows.
    const upRes = await app.request('/api/projects/docs-zh/feedback?filter=thumbs_up');
    const upBody = (await upRes.json()) as {
      rows: Array<{ answerId: string; question: string }>;
    };
    assert.equal(upBody.rows.length, 2);
    assert.ok(upBody.rows.every((r) => r.question.startsWith('q-up')));

    // filter=implicit — 1 row.
    const impRes = await app.request('/api/projects/docs-zh/feedback?filter=implicit');
    const impBody = (await impRes.json()) as {
      rows: Array<{ answerId: string }>;
    };
    assert.equal(impBody.rows.length, 1);
    assert.equal(impBody.rows[0]!.answerId, 'a4');

    // Unknown filter falls back to 'all' (parseFeedbackFilter contract).
    const fallbackRes = await app.request('/api/projects/docs-zh/feedback?filter=garbage');
    const fallbackBody = (await fallbackRes.json()) as { filter: string; rows: unknown[] };
    assert.equal(fallbackBody.filter, 'all');
    assert.equal(fallbackBody.rows.length, 4);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: curated rows excluded from all chip + KPI count (Codex P2 regression)', async () => {
  // Codex review on PR #47 caught: filterCounts.all was a raw row count
  // including signal_source='curated', but the SQL filter for 'all'
  // restricts to explicit/implicit. Result: chip badge said "all 5" while
  // the list only rendered 4. KPI feedback·7d also footnoted "β + γ
  // combined" but counted curated. Both must now exclude curated.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1 });
    insertFeedback(db, { answer_id: 'a2', rating: -1 });
    insertFeedback(db, { answer_id: 'a3', signal_source: 'implicit' });
    insertFeedback(db, { answer_id: 'a4', signal_source: 'curated', rating: 1 });
    insertFeedback(db, { answer_id: 'a5', signal_source: 'curated', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });

    // Endpoint contract: filterCounts.all = 3 (1👍 + 1👎 + 1γ), NOT 5.
    const body = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      rows: Array<{ signal_source: string }>;
      filterCounts: Record<string, number>;
    };
    assert.deepEqual(body.filterCounts, { all: 3, thumbs_up: 1, thumbs_down: 1, implicit: 1, no_citations: 0, semantic_check_failed: 0, aplus_candidates: 0 });
    // List rows when filter='all' must also stay at 3 (curated suppressed
    // by the SQL filter; counts and list must agree).
    assert.equal(body.rows.length, 3);
    assert.ok(body.rows.every((r) => r.signal_source !== 'curated'));

    // SSR KPI: feedback·7d count tile reads explicit+implicit only.
    const ssr = await (await app.request('/p/docs-zh')).text();
    assert.match(ssr, /feedback · 7d[\s\S]*?>3</);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: question backfill placeholder kicks in for empty-string rows', async () => {
  // Pre-0.2.0-alpha.2 rows have `question = ''` (the spawned "Backfill
  // question" task fixes the writer; until that lands, the list UI must
  // not show an empty cell — the loader rewrites the field to a stable
  // sentinel and the test pins that contract.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', question: '', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      rows: Array<{ question: string }>;
    };
    assert.equal(body.rows.length, 1);
    assert.match(body.rows[0]!.question, /pre-0\.2\.0-alpha\.2/);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: disabled project returns enabled=false, empty rows', async () => {
  // The route still answers 200 with structured data; the client uses
  // `enabled` to decide whether to render the list at all. The SSR /p/:name
  // path renders the disabled card; this exercises the JSON branch.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // No anydocs.ask.json → feedback.enabled defaults to false.
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      ok: boolean;
      enabled: boolean;
      rows: unknown[];
      filterCounts: Record<string, number>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.enabled, false);
    assert.equal(body.rows.length, 0);
    assert.deepEqual(body.filterCounts, { all: 0, thumbs_up: 0, thumbs_down: 0, implicit: 0, no_citations: 0, semantic_check_failed: 0, aplus_candidates: 0 });
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: 404 on unknown project, 400 on invalid project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // Add an invalid project (missing navigation/).
    const brokenPath = join(ws, 'projects', 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const unknown = await app.request('/api/projects/does-not-exist/feedback');
    assert.equal(unknown.status, 404);
    const invalid = await app.request('/api/projects/broken/feedback');
    assert.equal(invalid.status, 400);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// T1-c helpers
// ---------------------------------------------------------------------------

function seedPage(
  db: ReturnType<typeof openDatabase>,
  args: {
    page_id: string;
    breadcrumb: Array<{ id: string; title: string; type: 'section' | 'folder' | 'page' }>;
    lang?: string;
    title?: string;
  },
): void {
  db.prepare(
    `INSERT INTO pages
       (page_id, lang, status, title, slug, breadcrumb, nav_index, parent_id, subtree_root, url, updated_at)
     VALUES (?, ?, 'published', ?, NULL, ?, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    args.page_id,
    args.lang ?? 'zh',
    args.title ?? args.breadcrumb[args.breadcrumb.length - 1]?.title ?? args.page_id,
    JSON.stringify(args.breadcrumb),
    Date.now(),
  );
}

async function seedRunsFile(stateRoot: string, lines: Array<Record<string, unknown>>): Promise<void> {
  const runsDir = join(stateRoot, 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  const now = new Date();
  const year = now.getUTCFullYear();
  const week = String(Math.floor(((now.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7) + 1).padStart(2, '0');
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await fs.writeFile(join(runsDir, `${year}-W${week}.jsonl`), content);
}

function makeRunRecord(args: {
  answer_id: string;
  ts?: string;
  kind?: 'answer' | 'clarify' | 'error';
  confidence?: number;
  citations?: Array<{
    chunk_id: number | null;
    page: string;
    quote: string;
    /** RFC 0005 V4 — present on alpha.2+ runs. Drives the V5 verdict
     *  join in the drawer. */
    citation_id?: string;
  }>;
  /** RFC 0003 — populated by the multi-turn pipeline (alpha.0+). M6 tests
   *  use this to exercise the runs.jsonl fallback for β rows whose
   *  feedback.session_id column is null. */
  session_id?: string | null;
  history_window?: number;
  /** RFC 0005 V5 — request_id override. Defaults to `req_<answer_id>` so
   *  test fixtures can build a matching citation-check-update tail
   *  without bookkeeping. */
  request_id?: string;
}): Record<string, unknown> {
  const answerCore: Record<string, unknown> = {
    kind: args.kind ?? 'answer',
    answer_id: args.answer_id,
    md: 'a',
    citations: args.citations ?? [{ chunk_id: 1, page: 'p', quote: 'q' }],
    confidence: args.confidence ?? 0.7,
    latency_ms: 100,
    tokens_in: null,
    tokens_out: null,
    model: 'mock',
    error_code: null,
  };
  if (typeof args.history_window === 'number') {
    answerCore.history_window = args.history_window;
  }
  return {
    ts: args.ts ?? new Date().toISOString(),
    request_id: args.request_id ?? 'req_' + args.answer_id,
    session_id: args.session_id ?? null,
    query: 'q',
    filters: {},
    context_pageId: null,
    source: 'reader',
    retrieval: { fused: [], subtree_ask_triggered: false },
    answer: answerCore,
    feedback: { beta: null, gamma: null },
  };
}

/** RFC 0005 V5 — build a citation-check-update tail keyed to a RunRecord's
 *  request_id. Each verdict joins to its citation by `citation_id`. */
function makeCitationCheckUpdate(args: {
  request_id: string;
  ts?: string;
  verdicts: Array<{
    citation_id: string;
    verdict: 'supports' | 'partially' | 'not_supports';
    reason?: string;
  }>;
}): Record<string, unknown> {
  return {
    type: 'citation-check-update',
    ts: args.ts ?? new Date().toISOString(),
    request_id: args.request_id,
    citations: args.verdicts.map((v) => ({
      citation_id: v.citation_id,
      semantic_check: {
        verdict: v.verdict,
        reason: v.reason ?? 'reason placeholder',
        model: 'mock-validator',
        checked_at: args.ts ?? new Date().toISOString(),
        latency_ms: 1234,
      },
    })),
  };
}

test('GET /p/:name: Feedback tab — breadcrumb chain rendered when pages row exists (RFC 0002 T1-c)', async () => {
  // T1-c replaces the raw current_page_id cell with the title chain
  // resolved via the pages.breadcrumb JOIN. Missing page rows
  // (unpublished / deleted) fall back to the raw page_id, dimmed.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    seedPage(db, {
      page_id: 'auth-jwt',
      breadcrumb: [
        { id: 'sec-quickstart', title: 'Quickstart', type: 'section' },
        { id: 'fld-auth', title: 'Auth', type: 'folder' },
        { id: 'page-jwt', title: 'JWT', type: 'page' },
      ],
    });
    insertFeedback(db, { answer_id: 'a1', rating: 1, current_page_id: 'auth-jwt' });
    insertFeedback(db, { answer_id: 'a2', rating: -1, current_page_id: 'missing-page' });
    db.close();

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();

    // Breadcrumb chain rendered with the › separator.
    assert.match(body, /Quickstart › Auth › JWT/);
    // Missing-page row still shows the raw page id (dimmed branch).
    assert.match(body, />missing-page</);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: breadcrumb field populated per row (RFC 0002 T1-c)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    seedPage(db, {
      page_id: 'auth-jwt',
      breadcrumb: [
        { id: 'fld-auth', title: 'Auth', type: 'folder' },
        { id: 'page-jwt', title: 'JWT', type: 'page' },
      ],
    });
    insertFeedback(db, { answer_id: 'a1', rating: 1, current_page_id: 'auth-jwt' });
    insertFeedback(db, { answer_id: 'a2', rating: 1, current_page_id: 'missing-page' });
    insertFeedback(db, { answer_id: 'a3', rating: 1, current_page_id: null });
    db.close();

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      rows: Array<{ answerId: string; currentPageId: string | null; breadcrumb: unknown }>;
    };
    const byAid = new Map(body.rows.map((r) => [r.answerId, r]));
    assert.deepEqual(byAid.get('a1')?.breadcrumb, [
      { id: 'fld-auth', title: 'Auth', type: 'folder' },
      { id: 'page-jwt', title: 'JWT', type: 'page' },
    ]);
    // Missing pages row: page_id retained, breadcrumb is null.
    assert.equal(byAid.get('a2')?.currentPageId, 'missing-page');
    assert.equal(byAid.get('a2')?.breadcrumb, null);
    // page_id absent entirely.
    assert.equal(byAid.get('a3')?.currentPageId, null);
    assert.equal(byAid.get('a3')?.breadcrumb, null);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback?filter=no_citations: returns only rows with empty-citation runs (RFC 0002 T1-c)', async () => {
  // The no_citations chip is data-driven from runs.jsonl, not the
  // feedback table itself. Seed: 3 feedback rows linked to 3 runs —
  // two with citations, one without. Filter must pick only the empty-
  // citation one; chip badge must match.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'ans_ok1', rating: 1 });
    insertFeedback(db, { answer_id: 'ans_ok2', rating: -1 });
    insertFeedback(db, { answer_id: 'ans_empty', rating: 1 });
    db.close();
    await seedRunsFile(stateRoot, [
      makeRunRecord({ answer_id: 'ans_ok1' }),
      makeRunRecord({ answer_id: 'ans_ok2' }),
      makeRunRecord({ answer_id: 'ans_empty', citations: [] }),
    ]);

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });

    // Chip badge: filterCounts.no_citations = 1.
    const allBody = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      filterCounts: { no_citations: number };
    };
    assert.equal(allBody.filterCounts.no_citations, 1);

    // filter=no_citations returns only the empty-citation row.
    const filtBody = (await (
      await app.request('/api/projects/docs-zh/feedback?filter=no_citations')
    ).json()) as {
      filter: string;
      rows: Array<{ answerId: string; hadNoCitations: boolean | null }>;
    };
    assert.equal(filtBody.filter, 'no_citations');
    assert.equal(filtBody.rows.length, 1);
    assert.equal(filtBody.rows[0]!.answerId, 'ans_empty');
    assert.equal(filtBody.rows[0]!.hadNoCitations, true);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab — no_citations chip is in the SSR chip bar (RFC 0002 T1-c)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    assert.match(body, /data-feedback-chip="no_citations"/);
    // Label is emitted as plain text followed by the count <span>, so we
    // match the label segment without anchoring to the closing tag.
    assert.match(body, /no citations\s*<span class="cnt"/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// T1-d — per-row detail drawer + endpoint
// ---------------------------------------------------------------------------

test('GET /p/:name: Feedback tab — drawer SSR shell appears when rows exist (RFC 0002 T1-d)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // Drawer skeleton + close-button container present.
    assert.match(body, /id="fb-drawer-mask"/);
    assert.match(body, /id="fb-drawer"[\s\S]*?aria-label="Feedback detail"/);
    assert.match(body, /id="fb-drawer-bd"/);
    // Rows are click-affordant.
    assert.match(body, /class="feedback-row"[\s\S]*?cursor:\s*pointer/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab — drawer shell hidden when zero rows', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(
      join(projectRoot, 'anydocs.ask.json'),
      JSON.stringify({ feedback: { enabled: true } }, null, 2),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // Empty state should NOT carry the drawer skeleton — nothing to open.
    assert.equal(body.includes('id="fb-drawer-mask"'), false);
    assert.equal(body.includes('id="fb-drawer"'), false);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback drawer inline JS guards against stale async responses (Codex P2 regression)', async () => {
  // Two rapid row clicks must not let the slower fetch overwrite the
  // faster one. Codex flagged this on PR #50 — the drawer code now
  // tracks a request token bumped on each openDrawer() and on closeDrawer
  // and bails on token mismatch after the await.
  //
  // Static-source assertion keeps the test simple (no headless browser
  // dependency); we just verify the guard pattern is emitted.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // Token is declared, bumped on open, and checked after the await.
    assert.match(body, /let drawerReqToken = 0;/);
    assert.match(body, /const myToken = \+\+drawerReqToken;/);
    assert.match(body, /if \(myToken !== drawerReqToken\) return;/);
    // closeDrawer also bumps it so a pending fetch can't reopen the drawer.
    assert.match(body, /function closeDrawer\(\)\s*\{[\s\S]*?drawerReqToken\+\+;/);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: returns row + run JOIN (RFC 0002 T1-d)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    seedPage(db, {
      page_id: 'auth-jwt',
      breadcrumb: [
        { id: 'fld-auth', title: 'Auth', type: 'folder' },
        { id: 'page-jwt', title: 'JWT', type: 'page' },
      ],
    });
    // Stable insert id: 1.
    insertFeedback(db, {
      answer_id: 'ans_x',
      rating: 1,
      question: 'how do I get a JWT?',
      current_page_id: 'auth-jwt',
    });
    db.close();
    await seedRunsFile(stateRoot, [
      makeRunRecord({
        answer_id: 'ans_x',
        confidence: 0.82,
        citations: [{ chunk_id: 7, page: 'auth-jwt', quote: 'use bearer token' }],
      }),
    ]);

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/feedback/1');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      detail: {
        feedback_id: number;
        question: string;
        rating: number | null;
        breadcrumb: Array<{ title: string }>;
        confidence: number | null;
        hadNoCitations: boolean | null;
        run: { kind: string; fused: unknown[]; latencyMs: number; model: string | null } | null;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.detail.feedback_id, 1);
    assert.equal(body.detail.question, 'how do I get a JWT?');
    assert.equal(body.detail.rating, 1);
    assert.equal(body.detail.confidence, 0.82);
    assert.equal(body.detail.hadNoCitations, false);
    assert.deepEqual(
      body.detail.breadcrumb,
      [
        { id: 'fld-auth', title: 'Auth', type: 'folder' },
        { id: 'page-jwt', title: 'JWT', type: 'page' },
      ],
    );
    assert.ok(body.detail.run);
    assert.equal(body.detail.run!.kind, 'answer');
    assert.equal(body.detail.run!.model, 'mock');
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: returns 404 on unknown id, 400 on non-numeric, 404 on missing project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    // Unknown numeric id → 404.
    const missing = await app.request('/api/projects/docs-zh/feedback/9999');
    assert.equal(missing.status, 404);
    // Non-numeric id → 400 (not a routing match; we explicitly validate).
    const bad = await app.request('/api/projects/docs-zh/feedback/abc');
    assert.equal(bad.status, 400);
    // Unknown project → 404.
    const noProj = await app.request('/api/projects/does-not-exist/feedback/1');
    assert.equal(noProj.status, 404);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: row with no linked run → run=null, breadcrumb=null', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'orphan', rating: -1 }); // no runs.jsonl seeded
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = (await (await app.request('/api/projects/docs-zh/feedback/1')).json()) as {
      detail: { run: unknown; confidence: number | null; breadcrumb: unknown };
    };
    assert.equal(body.detail.run, null);
    assert.equal(body.detail.confidence, null);
    assert.equal(body.detail.breadcrumb, null);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// RFC 0003 M6 — Feedback tab session grouping
// ---------------------------------------------------------------------------

test('GET /p/:name: Feedback tab — contiguous same-session rows fold into one block (RFC 0003 M6)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    const t0 = Date.now() - 60_000;
    // 3-turn dialogue (session_id sess-a) interleaved on the timeline with
    // a standalone row (no session). The SSR list is newest-first; the
    // session block should still render in chronological order inside.
    insertFeedback(db, {
      answer_id: 'a-turn-1', question: 'Q1', rating: 1,
      session_id: 'sess-a', created_at: t0,
    });
    insertFeedback(db, {
      answer_id: 'standalone', question: 'standalone q', rating: -1,
      session_id: null, created_at: t0 + 1_000,
    });
    insertFeedback(db, {
      answer_id: 'a-turn-2', question: 'Q2', signal_source: 'implicit', rating: null,
      session_id: 'sess-a', created_at: t0 + 2_000,
    });
    insertFeedback(db, {
      answer_id: 'a-turn-3', question: 'Q3', rating: 1,
      session_id: 'sess-a', created_at: t0 + 3_000,
    });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();

    // Session header carries the dialogue count + truncated session_id.
    // Match on data-session-id="sess-a" — the literal value only appears
    // in SSR output, not in the inline JS template (the JS escapes from
    // a variable, leaving `data-session-id="` as a partial literal).
    assert.match(body, /data-session-id="sess-a"/);
    assert.match(body, /3-turn dialogue/);
    // The 3-turn session emits exactly one SSR header — count unique
    // session id attrs to avoid hitting the inline JS template's literal
    // `class="feedback-session-hd"` substring.
    const headerMatches = body.match(/data-session-id="sess-a"/g) ?? [];
    assert.equal(headerMatches.length, 1, 'expected 1 session header for 3-turn dialogue');
    // Each turn row has the grouped variant. Grouped rows also carry a
    // matching data-feedback-session-id attribute on each <li>; count
    // those to avoid the JS template noise.
    const groupedSessionRows = body.match(/data-feedback-session-id="sess-a"/g) ?? [];
    assert.equal(groupedSessionRows.length, 3, 'expected 3 turn rows for sess-a');
    assert.match(body, /T1\/3/);
    assert.match(body, /T2\/3/);
    assert.match(body, /T3\/3/);

    // Standalone row stays ungrouped + carries an empty session id attr.
    assert.match(body, /data-feedback-session-id=""/);

    // Inside the rendered HTML, the order of turns Q1 → Q2 → Q3 (chronological)
    // must hold even though the global list is newest-first. The questions
    // appear once each in the SSR (drawer is lazy-loaded, JS template noise
    // doesn't contain these literal strings).
    const q1 = body.indexOf('Q1');
    const q2 = body.indexOf('Q2');
    const q3 = body.indexOf('Q3');
    assert.ok(q1 > 0, 'Q1 must appear in SSR body');
    assert.ok(q2 > q1, 'Q2 must follow Q1 (chronological order inside group)');
    assert.ok(q3 > q2, 'Q3 must follow Q2 (chronological order inside group)');
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab — single-turn session does not render a session header (RFC 0003 M6)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'lone-1', rating: 1, session_id: 'sess-x' });
    insertFeedback(db, { answer_id: 'lone-2', rating: -1, session_id: 'sess-y' });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // No SSR session header — sessionTurnCount=1 for each row. We match on
    // data-session-id="sess-x"/"sess-y" because the inline JS template
    // contains the literal `class="feedback-session-hd"` substring.
    assert.equal(body.includes('data-session-id="sess-x"'), false);
    assert.equal(body.includes('data-session-id="sess-y"'), false);
    // Standalone rows carry their session id on the row li (for replay /
    // future linking) but never the `grouped` modifier class.
    assert.match(body, /data-feedback-session-id="sess-x"/);
    assert.match(body, /data-feedback-session-id="sess-y"/);
    // The grouped marker only ever lands in SSR if a header was emitted;
    // count distinct `data-feedback-session-id="sess-x"` to ensure no
    // duplicate / grouped row was rendered.
    const sessXRows = body.match(/data-feedback-session-id="sess-x"/g) ?? [];
    assert.equal(sessXRows.length, 1, 'expected exactly one ungrouped sess-x row');
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: rows carry sessionId / turnIndex / sessionTurnCount / historyWindow (RFC 0003 M6)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    const t0 = Date.now() - 60_000;
    // β explicit rows leave session_id NULL in the column (see app.ts:308);
    // the runs.jsonl fallback must backfill them for the M6 grouping to
    // work on real β data.
    insertFeedback(db, {
      answer_id: 'b1', rating: 1, session_id: null, created_at: t0,
    });
    insertFeedback(db, {
      answer_id: 'b2', rating: -1, session_id: null, created_at: t0 + 1_000,
    });
    db.close();
    await seedRunsFile(stateRoot, [
      makeRunRecord({ answer_id: 'b1', session_id: 'sess-beta', history_window: 0 }),
      makeRunRecord({ answer_id: 'b2', session_id: 'sess-beta', history_window: 1 }),
    ]);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const json = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      rows: Array<{
        sessionId: string | null;
        turnIndex: number;
        sessionTurnCount: number;
        historyWindow: number | null;
      }>;
    };
    assert.equal(json.rows.length, 2);
    // Newest-first ordering — b2 is row 0.
    const [row0, row1] = json.rows;
    assert.equal(row0.sessionId, 'sess-beta');
    assert.equal(row1.sessionId, 'sess-beta');
    assert.equal(row0.sessionTurnCount, 2);
    assert.equal(row1.sessionTurnCount, 2);
    assert.equal(row0.turnIndex, 2);
    assert.equal(row1.turnIndex, 1);
    assert.equal(row0.historyWindow, 1);
    assert.equal(row1.historyWindow, 0);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: drawer detail carries peer sessionTurns (RFC 0003 M6)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    const t0 = Date.now() - 60_000;
    insertFeedback(db, { answer_id: 't1', question: 'first',  rating: 1, session_id: 'sess-d', created_at: t0 });
    insertFeedback(db, { answer_id: 't2', question: 'second', rating: -1, session_id: 'sess-d', created_at: t0 + 1_000 });
    insertFeedback(db, { answer_id: 't3', question: 'third', signal_source: 'implicit', session_id: 'sess-d', created_at: t0 + 2_000 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    // The middle row is feedback_id=2 (autoincrement; matches insert order).
    const json = (await (await app.request('/api/projects/docs-zh/feedback/2')).json()) as {
      detail: {
        sessionId: string | null;
        turnIndex: number;
        sessionTurnCount: number;
        sessionTurns: Array<{ feedback_id: number; turnIndex: number; question: string }>;
      };
    };
    assert.equal(json.detail.sessionId, 'sess-d');
    assert.equal(json.detail.sessionTurnCount, 3);
    assert.equal(json.detail.turnIndex, 2);
    // sessionTurns excludes the current row, ordered by turnIndex ASC.
    assert.equal(json.detail.sessionTurns.length, 2);
    assert.deepEqual(
      json.detail.sessionTurns.map((t) => [t.turnIndex, t.question]),
      [
        [1, 'first'],
        [3, 'third'],
      ],
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// F8 — drawer parser accepts both Citation and RunCitation field names
// ---------------------------------------------------------------------------

test('GET /api/projects/:name/feedback/:id: parseRunCitations decodes Citation[] shape from β handler (F8)', async () => {
  // Dogfood 2026-05-23 F8 root cause: β /v1/ask/feedback handler writes
  // Citation[] (page_id + snippet) into feedback.retrieved, but the
  // drawer parser only knew RunCitation[] (page + quote). All items got
  // filtered out → drawer falsely showed "no citations on this answer"
  // even though the column had a 960+-byte populated JSON snapshot.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    const retrieved = JSON.stringify([
      {
        citation_id: 'cit_1',
        chunk_id: 26111,
        page_id: 'ai-providers',
        lang: 'en',
        source_lang: 'en',
        title: 'AI Providers',
        breadcrumb: [],
        url: null,
        snippet: 'Hermes supports Anthropic / OpenAI / OpenRouter.',
        in_page_path: 'provider-selection/p[1]',
      },
      {
        citation_id: 'cit_2',
        chunk_id: 25771,
        page_id: 'quickstart',
        lang: 'en',
        source_lang: 'en',
        title: 'Quickstart',
        breadcrumb: [],
        url: null,
        snippet: 'Run `hermes model` to choose your LLM provider.',
        in_page_path: '2-set-up-a-provider/p[1]',
      },
    ]);
    insertFeedback(db, { answer_id: 'beta-1', rating: -1, retrieved });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const json = (await (await app.request('/api/projects/docs-zh/feedback/1')).json()) as {
      detail: { citations: Array<{ page: string; quote: string; chunkId: number | null }> };
    };
    assert.equal(json.detail.citations.length, 2, 'Citation[] shape must decode to 2 items');
    assert.equal(json.detail.citations[0]!.page, 'ai-providers', 'page_id maps to page');
    assert.match(json.detail.citations[0]!.quote, /Anthropic/, 'snippet maps to quote');
    assert.equal(json.detail.citations[0]!.chunkId, 26111);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: parseRunCitations still decodes RunCitation[] shape (F8 backward-compat)', async () => {
  // Pin the pre-F8 RunCitation path so the dual-shape fix doesn't regress
  // existing rows. Any analyze / golden code that round-trips RunCitation
  // through this column keeps working.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    const retrieved = JSON.stringify([
      { chunk_id: 42, page: 'auth', quote: 'JWT bearer tokens' },
      { chunk_id: 43, page: 'auth-jwt', quote: 'Refresh tokens expire after 30 days' },
    ]);
    insertFeedback(db, { answer_id: 'run-style', rating: 1, retrieved });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const json = (await (await app.request('/api/projects/docs-zh/feedback/1')).json()) as {
      detail: { citations: Array<{ page: string; quote: string; chunkId: number | null }> };
    };
    assert.equal(json.detail.citations.length, 2);
    assert.equal(json.detail.citations[0]!.page, 'auth');
    assert.equal(json.detail.citations[0]!.quote, 'JWT bearer tokens');
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: parseRunCitations prefers RunCitation page/quote over Citation page_id/snippet when both present (F8 precedence)', async () => {
  // Belt-and-suspenders for the rare case where a writer started emitting
  // both field families (e.g. a future RunCitation+Citation merge). Pin
  // the canonical-trace-source-wins rule.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    const retrieved = JSON.stringify([
      { chunk_id: 99, page: 'canonical-page', page_id: 'legacy-page',
        quote: 'canonical quote', snippet: 'legacy snippet' },
    ]);
    insertFeedback(db, { answer_id: 'mixed', rating: 1, retrieved });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const json = (await (await app.request('/api/projects/docs-zh/feedback/1')).json()) as {
      detail: { citations: Array<{ page: string; quote: string }> };
    };
    assert.equal(json.detail.citations[0]!.page, 'canonical-page');
    assert.equal(json.detail.citations[0]!.quote, 'canonical quote');
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: parseRunCitations skips items missing both page identifiers (F8 sanity)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    const retrieved = JSON.stringify([
      { chunk_id: 1 }, // no page / page_id → skip
      { chunk_id: 2, page: 'valid', quote: 'ok' },
      null,
      'not an object',
    ]);
    insertFeedback(db, { answer_id: 'partial', rating: 1, retrieved });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const json = (await (await app.request('/api/projects/docs-zh/feedback/1')).json()) as {
      detail: { citations: Array<{ page: string }> };
    };
    assert.equal(json.detail.citations.length, 1);
    assert.equal(json.detail.citations[0]!.page, 'valid');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// T1-d follow-up — drawer cross-journey chips
// ---------------------------------------------------------------------------

test('GET /p/:name: drawer JS emits add-to-golden + jump-to-doc chip handlers (RFC 0002 T1-d follow-up)', async () => {
  // Static-source assertion that the wiring exists, mirroring the same
  // pattern as the stale-response regression. The two chips dispatch via
  // (a) console:add-golden CustomEvent (reuses BOOTSTRAP_SCRIPT receiver
  // shipped with PR #44) and (b) location.hash = #index?focus=<id> (the
  // Index tab listens for the focus query string).
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1, current_page_id: 'some-page' });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // The drawer template now renders both buttons.
    assert.match(body, /data-add-golden-payload=/);
    assert.match(body, /data-jump-page-id=/);
    // Handlers are bound in bindDrawerControls.
    assert.match(body, /querySelector\('\[data-add-golden-payload\]'\)/);
    assert.match(body, /querySelector\('\[data-jump-page-id\]'\)/);
    // add-to-golden reuses the existing CustomEvent contract.
    assert.match(body, /new CustomEvent\('console:add-golden'/);
    // jump uses location.hash with #index?focus= prefix.
    assert.match(body, /location\.hash\s*=\s*'#index\?focus='/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: drawer jump-to-doc chip disabled when current_page_id is null', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    // No current_page_id → can't anchor a jump.
    insertFeedback(db, { answer_id: 'a1', rating: 1, current_page_id: null });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    // Detail endpoint should report no breadcrumb / no page_id.
    const body = (await (await app.request('/api/projects/docs-zh/feedback/1')).json()) as {
      detail: { currentPageId: string | null };
    };
    assert.equal(body.detail.currentPageId, null);
    // The drawer template renders the disabled tag instead of the button when
    // the row has no page id. We assert by checking the rendered detail
    // body via the inline JS string — the renderer function always emits
    // the conditional branch text into the bundled script.
    const ssr = await (await app.request('/p/docs-zh')).text();
    assert.match(ssr, /jump to doc section — n\/a/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Index tab JS reads ?focus=<id> from hash and scrolls/flashes the row (RFC 0002 T1-d follow-up)', async () => {
  // Static-source assertion of the focus receiver. The receiver lives in
  // langSwitchScript so it ships when the explorer renders at all.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(
      join(projectRoot, 'navigation', 'zh.json'),
      JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'auth' }] }),
    );
    await fs.mkdir(join(projectRoot, 'pages', 'zh'), { recursive: true });
    await fs.writeFile(
      join(projectRoot, 'pages', 'zh', 'auth.json'),
      JSON.stringify({
        id: 'auth',
        lang: 'zh',
        slug: 'auth',
        title: 'Auth',
        status: 'published',
        content: { version: 1, blocks: [] },
      }),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // Receiver hooks into hashchange + initial.
    assert.match(body, /\[?focus=/);
    assert.match(body, /window\.addEventListener\('hashchange', applyFocus\)/);
    assert.match(body, /applyFocus\(\);/);
    // Flash highlight uses the accent outline style — sanity-check the
    // exact style string so a future refactor doesn't silently drop it.
    assert.match(body, /outline = '2px solid var\(--accent\)'/);
    // Row carries data-page-id for the focus query.
    assert.match(body, /data-page-id="auth"/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// T4 — Index tab reverse marks (per-page + per-section)
// ---------------------------------------------------------------------------

test('GET /p/:name: Index tab — per-page ask-usage badge renders when ≥3 hits (RFC 0002 T4)', async () => {
  // Set up: a project with nav→page=auth-jwt, 4 fresh runs all hitting
  // that page with high confidence. The badge should render with the
  // neutral (◷) glyph and a count of 4.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    // Wire navigation so the page actually surfaces in the content
    // explorer; the loader needs both files.
    await fs.writeFile(
      join(projectRoot, 'navigation', 'zh.json'),
      JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'auth-jwt' }] }),
    );
    await fs.mkdir(join(projectRoot, 'pages', 'zh'), { recursive: true });
    await fs.writeFile(
      join(projectRoot, 'pages', 'zh', 'auth-jwt.json'),
      JSON.stringify({
        id: 'auth-jwt',
        lang: 'zh',
        slug: 'auth-jwt',
        title: 'JWT auth',
        status: 'published',
        content: { version: 1, blocks: [] },
      }),
    );
    const stateRoot = ensureStateRoot(ws, 'docs-zh');
    await seedRunsFile(stateRoot, [
      makeRunRecord({ answer_id: 'a1', confidence: 0.8 }),
      makeRunRecord({ answer_id: 'a2', confidence: 0.8 }),
      makeRunRecord({ answer_id: 'a3', confidence: 0.8 }),
      makeRunRecord({ answer_id: 'a4', confidence: 0.8 }),
    ].map((r, i) => ({
      ...r,
      retrieval: { fused: [{ chunk_id: i + 1, page: 'auth-jwt', rrf_score: 0.5, final_score: 0.5, vec_rank: 1, bm25_rank: 1, nav_index: null, nav_index_boost: 0 }], subtree_ask_triggered: false },
    })));

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // Badge present with neutral glyph + count + ask-count attribute.
    assert.match(body, /data-page-id="auth-jwt"[\s\S]*?data-ask-mark="ok"/);
    assert.match(body, /data-ask-count="4"/);
    assert.match(body, /◷\s*4 asks/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Index tab — warn tint when median confidence < 0.5 (RFC 0002 T4)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(
      join(projectRoot, 'navigation', 'zh.json'),
      JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'shaky-page' }] }),
    );
    await fs.mkdir(join(projectRoot, 'pages', 'zh'), { recursive: true });
    await fs.writeFile(
      join(projectRoot, 'pages', 'zh', 'shaky-page.json'),
      JSON.stringify({
        id: 'shaky-page',
        lang: 'zh',
        slug: 'shaky-page',
        title: 'Shaky',
        status: 'published',
        content: { version: 1, blocks: [] },
      }),
    );
    const stateRoot = ensureStateRoot(ws, 'docs-zh');
    await seedRunsFile(stateRoot, [
      makeRunRecord({ answer_id: 'a1', confidence: 0.2 }),
      makeRunRecord({ answer_id: 'a2', confidence: 0.3 }),
      makeRunRecord({ answer_id: 'a3', confidence: 0.4 }),
    ].map((r, i) => ({
      ...r,
      retrieval: { fused: [{ chunk_id: i + 1, page: 'shaky-page', rrf_score: 0.5, final_score: 0.5, vec_rank: 1, bm25_rank: 1, nav_index: null, nav_index_boost: 0 }], subtree_ask_triggered: false },
    })));

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    assert.match(body, /data-page-id="shaky-page"[\s\S]*?data-ask-mark="warn"/);
    assert.match(body, /⚠\s*3 asks/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Index tab — no badge when hit count < 3 (RFC 0002 T4 noise floor)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(
      join(projectRoot, 'navigation', 'zh.json'),
      JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'quiet-page' }] }),
    );
    await fs.mkdir(join(projectRoot, 'pages', 'zh'), { recursive: true });
    await fs.writeFile(
      join(projectRoot, 'pages', 'zh', 'quiet-page.json'),
      JSON.stringify({
        id: 'quiet-page',
        lang: 'zh',
        slug: 'quiet-page',
        title: 'Quiet',
        status: 'published',
        content: { version: 1, blocks: [] },
      }),
    );
    const stateRoot = ensureStateRoot(ws, 'docs-zh');
    await seedRunsFile(stateRoot, [
      makeRunRecord({ answer_id: 'a1', confidence: 0.9 }),
      makeRunRecord({ answer_id: 'a2', confidence: 0.9 }),
    ].map((r, i) => ({
      ...r,
      retrieval: { fused: [{ chunk_id: i + 1, page: 'quiet-page', rrf_score: 0.5, final_score: 0.5, vec_rank: 1, bm25_rank: 1, nav_index: null, nav_index_boost: 0 }], subtree_ask_triggered: false },
    })));

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = await (await app.request('/p/docs-zh')).text();
    // Row exists, but no badge attribute should appear for it.
    assert.match(body, /data-page-id="quiet-page"/);
    // Tighter assertion: the badge data-attrs don't co-occur with this page.
    assert.equal(/data-page-id="quiet-page"[^>]*>[^<]*<[^<]*data-ask-mark/.test(body), false);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: renders Settings tab with prompt + LLM + retrieval + feedback fields', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(
      join(projectRoot, 'anydocs.ask.json'),
      JSON.stringify(
        {
          llm: { model: 'claude-opus-4-7' },
          prompt: { assistantName: 'Cregis AI', systemInstructions: ['hi'] },
          feedback: { enabled: true },
        },
        null,
        2,
      ),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Settings tab exists in nav + panel
    assert.match(body, /data-project-tab="settings"/);
    assert.match(body, /id="settings-form"/);
    assert.match(body, /id="settings-save"/);
    // Field paths surfaced via data-cfg-path on the SSR controls
    assert.match(body, /data-cfg-path="prompt\.assistantName"/);
    assert.match(body, /data-cfg-path="prompt\.systemInstructions"/);
    assert.match(body, /data-cfg-path="llm\.model"/);
    assert.match(body, /data-cfg-path="retrieval\.topK"/);
    assert.match(body, /data-cfg-path="feedback\.enabled"/);
    assert.match(body, /data-cfg-path="server\.cors\.allowedOrigins"/);
    // Prefill: existing values must render in the controls
    assert.match(body, /value="Cregis AI"/);
    assert.match(body, /value="claude-opus-4-7"/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Settings tab does NOT prefill fields absent from anydocs.ask.json', async () => {
  // Regression: prefilling DEFAULTS made unset fields look like real values;
  // a Save would then pin them into the file and shadow env overrides
  // (e.g. ANTHROPIC_MODEL). Verify unset fields render with empty value
  // attribute + the default as placeholder.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    // File explicitly sets ONLY llm.model. Everything else absent.
    await fs.writeFile(
      join(projectRoot, 'anydocs.ask.json'),
      JSON.stringify({ llm: { model: 'claude-opus-4-7' } }, null, 2),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();

    // Present field → prefilled as value
    assert.match(body, /data-cfg-path="llm\.model"[^>]*value="claude-opus-4-7"/);
    // Absent field (llm.apiKeyEnv) → empty value but placeholder shows default
    assert.match(
      body,
      /data-cfg-path="llm\.apiKeyEnv"[^>]*value=""[^>]*placeholder="ANTHROPIC_API_KEY"/,
    );
    // Absent retrieval.topK → empty value with placeholder "20"
    assert.match(body, /data-cfg-path="retrieval\.topK"[^>]*value=""[^>]*placeholder="20"/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Settings tab surfaces validation warnings inline', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(
      join(projectRoot, 'anydocs.ask.json'),
      JSON.stringify({ prompt: { systemInstructions: ['valid', 123] } }, null, 2),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });

    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="settings-warnings"/);
    assert.match(body, /prompt\.systemInstructions ignored 1/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// anydocs.ask.json full-file read/write (Config drawer editable mode)
// ---------------------------------------------------------------------------

test('GET /api/projects/:name/ask-config: returns rawText + mtimeISO when file exists', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    const original = JSON.stringify({ llm: { model: 'claude-opus-4-7' } }, null, 2);
    await fs.writeFile(join(projectRoot, 'anydocs.ask.json'), original);

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/ask-config');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      exists: boolean;
      rawText: string | null;
      mtimeISO: string | null;
      warnings: string[];
      parseError: string | null;
    };
    assert.equal(body.ok, true);
    assert.equal(body.exists, true);
    assert.equal(body.rawText, original);
    assert.equal(typeof body.mtimeISO, 'string');
    assert.equal(body.parseError, null);
    assert.deepEqual(body.warnings, []);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/ask-config: exists=false when file missing', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/ask-config');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { exists: boolean; rawText: string | null };
    assert.equal(body.exists, false);
    assert.equal(body.rawText, null);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask-config: writes file + preserves trailing newline', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const rawText = JSON.stringify(
      { llm: { provider: 'anthropic', model: 'claude-opus-4-7' }, retrieval: { topK: 12 } },
      null,
      2,
    );
    const res = await app.request('/api/projects/docs-zh/ask-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; warnings: string[]; mtimeISO: string };
    assert.equal(body.ok, true);
    assert.deepEqual(body.warnings, []);
    const onDisk = await fs.readFile(join(projectRoot, 'anydocs.ask.json'), 'utf8');
    assert.equal(onDisk, rawText + '\n', 'file ends with a single newline');
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask-config: 400 on malformed JSON', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/ask-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText: '{ "llm": ' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /malformed JSON/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask-config: 409 when expectedMtimeISO is stale', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const projectRoot = join(ws, 'projects', 'docs-zh');
    await fs.writeFile(join(projectRoot, 'anydocs.ask.json'), '{}\n');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/ask-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawText: '{}',
        expectedMtimeISO: '1999-01-01T00:00:00.000Z',
      }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { ok: boolean; error: string; currentMtimeISO: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /changed on disk/);
    assert.equal(typeof body.currentMtimeISO, 'string');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ask feedback proxy (β button → /v1/ask/feedback)
// ---------------------------------------------------------------------------

test('POST /api/projects/:name/feedback: 502 when child not running', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer_id: 'ans_x', rating: 1 }),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /not running/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/feedback: forwards body verbatim to child /v1/ask/feedback', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({ status: 200, body: { ok: true } }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    const payload = JSON.stringify({ answer_id: 'ans_x', rating: -1, tags: ['thumbs-down'] });
    const res = await app.request('/api/projects/docs-zh/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask/feedback');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.body, payload);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/feedback: 404 unknown project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/nope/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: live project renders Ask feedback bar (👍/👎)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="ask-feedback"/);
    assert.match(body, /id="ask-fb-up"/);
    assert.match(body, /id="ask-fb-down"/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: bootstrap <script type=module> parses + carries citeSectionLabel helper', async () => {
  // The project page emits BOOTSTRAP_SCRIPT inside a TS template literal.
  // PR #16 shipped a syntax error there (a stray real newline from an
  // unescaped \n) that killed every button. This guards the whole script
  // parses, and that the F4 same-page-citation disambiguator is wired in.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    const body = await res.text();

    // The page emits more than one <script type="module"> (traffic tab has
    // its own). Validate every one parses, then pin the F4 helper to the
    // bootstrap script (the one with window.__CONSOLE__).
    const blocks = [...body.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(
      (mm) => mm[1]!,
    );
    assert.ok(blocks.length > 0, 'expected at least one <script type="module"> block');
    for (const script of blocks) {
      // strip ESM import/export lines — new Function() can't parse module
      // syntax, but the rest of the body must still be syntactically valid.
      const stripped = script
        .split('\n')
        .filter((l) => !/^\s*(import|export)\s/.test(l))
        .join('\n');
      assert.doesNotThrow(
        () => new Function(stripped),
        'every module <script> body must be syntactically valid JS',
      );
    }
    const bootstrap = blocks.find((s) => s.includes('window.__CONSOLE__'));
    assert.ok(bootstrap, 'expected the bootstrap script (window.__CONSOLE__)');
    assert.match(bootstrap!, /function citeSectionLabel/);
    assert.match(bootstrap!, /lastIndexOf\('\/p\['\)/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: invalid project hides action buttons', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const brokenPath = join(ws, 'projects', 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/broken');
    const body = await res.text();
    assert.equal(body.includes('id="btn-start"'), false);
    assert.match(body, /missing.*navigation/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: spawns child + returns port', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; port: number; reused: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.port, 4101);
    assert.equal(body.reused, false);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: second call returns reused=true with same port', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    const r2 = await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    const body = (await r2.json()) as { ok: boolean; port: number; reused: boolean };
    assert.equal(body.reused, true);
    assert.equal(body.port, 4101);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: 404 on unknown project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/nope/start', { method: 'POST' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown project/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/start: 400 on invalid project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const brokenPath = join(ws, 'projects', 'broken');
    await fs.mkdir(join(brokenPath, 'pages'), { recursive: true });
    addToProjectRegistry(ws, brokenPath, 'broken');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/broken/start', { method: 'POST' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.match(body.error, /invalid.*navigation/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/stop: stops running child', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    await app.request('/api/projects/docs-zh/start', { method: 'POST' });
    const res = await app.request('/api/projects/docs-zh/stop', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; stopped: boolean };
    assert.deepEqual(body, { ok: true, stopped: true });
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/stop: returns stopped=false when not running', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/stop', { method: 'POST' });
    const body = (await res.json()) as { ok: boolean; stopped: boolean };
    assert.deepEqual(body, { ok: true, stopped: false });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:name — project removal (ARCH §17.3.x)
// ---------------------------------------------------------------------------

test('DELETE /api/projects/:name: removes registry entry, default purges state dir', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // Pre-seed the per-project state dir so we can assert it gets purged.
    const stateDir = join(ws, 'state', 'docs-zh');
    await fs.mkdir(join(stateDir, 'reports'), { recursive: true });
    await fs.writeFile(join(stateDir, 'index.db'), 'fake-sqlite');

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      registryRemoved: boolean;
      stateRemoved: boolean;
      stoppedFirst: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.registryRemoved, true);
    assert.equal(body.stateRemoved, true);
    assert.equal(body.stoppedFirst, false);

    // Registry entry gone
    const list = await app.request('/api/projects');
    const projects = (await list.json()) as ProjectStatusJSON[];
    assert.equal(projects.find((p) => p.name === 'docs-zh'), undefined);
    // State dir gone
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(stateDir), false);
  } finally {
    await cleanup();
  }
});

test('DELETE /api/projects/:name?purge_state=false: leaves state dir on disk', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const stateDir = join(ws, 'state', 'docs-zh');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(join(stateDir, 'index.db'), 'fake-sqlite');

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh?purge_state=false', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; stateRemoved: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.stateRemoved, false);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(stateDir), true);
  } finally {
    await cleanup();
  }
});

test('DELETE /api/projects/:name: 409 + running:true when child is live and no force_stop', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    await app.request('/api/projects/docs-zh/start', { method: 'POST' });

    const res = await app.request('/api/projects/docs-zh', { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { ok: boolean; running: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.running, true);
    assert.match(body.error, /force_stop=true/);
  } finally {
    await cleanup();
  }
});

test('DELETE /api/projects/:name?force_stop=true: stops live child, then removes', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    await app.request('/api/projects/docs-zh/start', { method: 'POST' });

    const res = await app.request('/api/projects/docs-zh?force_stop=true', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; stoppedFirst: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.stoppedFirst, true);
  } finally {
    await cleanup();
  }
});

test('DELETE /api/projects/:name: 404 when name not in registry', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/ghost', { method: 'DELETE' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /not found in registry/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ask 体验台 reverse proxy (ARCH §17.3.2 / §17.3.3)
// ---------------------------------------------------------------------------

type ProxyCall = { url: string; method: string; body: string };

function makeStubFetch(
  capture: ProxyCall[],
  respond: (call: ProxyCall) => { status: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: ProxyCall = {
      url: typeof input === 'string' ? input : (input as URL).toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    };
    capture.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

test('GET /api/projects/:name/health: 502 when not running', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/health');
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /not running/);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/health: mirrors child 503 warming response', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 503,
      body: { status: 'warming', warm: false },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/health');
    assert.equal(res.status, 503);
    const body = (await res.json()) as { warm: boolean };
    assert.equal(body.warm, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/health');
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/health: mirrors child 200 warm response', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    const fetchFn = makeStubFetch([], () => ({
      status: 200,
      body: { status: 'ok', warm: true, booted_at: 0 },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/health');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { warm: boolean };
    assert.equal(body.warm, true);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: lazy-spawns + proxies with dry_run=1', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', answer_md: 'A.', citations: [], _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'JWT 续期' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; _dry_run: boolean };
    assert.equal(body.type, 'answer');
    assert.equal(body._dry_run, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?dry_run=1');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.body, JSON.stringify({ question: 'JWT 续期' }));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: persist:true forwards to ?source=console (no dry_run)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', answer_md: 'A.', citations: [] },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'real Q', persist: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { type: string; _persisted?: boolean; _source?: string };
    assert.equal(body.type, 'answer');
    assert.equal(body._persisted, true);
    assert.equal(body._source, 'console');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?source=console');
    // persist field is stripped from the forwarded body so child's AskRequest
    // schema isn't extended.
    const fwd = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    assert.equal(fwd.question, 'real Q');
    assert.equal(fwd.persist, undefined);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: persist:false (or missing) keeps dry_run default', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q', persist: false }),
    });
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?dry_run=1');
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: reuses already-running child without re-spawn', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh'); // already running on 4101
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 200,
      body: { type: 'answer', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q' }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:4101/v1/ask?dry_run=1');
    // still only one running entry; no extra spawn
    assert.equal(registry.list().length, 1);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: 404 unknown project', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await fs.mkdir(join(ws, 'projects'), { recursive: true });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn: makeStubFetch([], () => ({ status: 200, body: {} })),
    });
    const res = await app.request('/api/projects/nope/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: mirrors child error status (400) + body', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const calls: ProxyCall[] = [];
    const fetchFn = makeStubFetch(calls, () => ({
      status: 400,
      body: { type: 'error', code: 'invalid_scope', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Q' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; _dry_run: boolean };
    assert.equal(body.code, 'invalid_scope');
    assert.equal(body._dry_run, true);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: 502 when proxy fetch throws', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const fetchFn = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      fetchFn,
    });
    const res = await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /proxy failed/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Eval / Analyze / Golden + reports + runs (ARCH §17.3.1 / §17.3.2 / §17.5)
// ---------------------------------------------------------------------------

import type { ConsoleOps, OpResult } from '../src/console/ops.ts';
import type { RunRecord } from '../src/runs/types.ts';

function makeStubOps(overrides: Partial<ConsoleOps> = {}): {
  ops: ConsoleOps;
  calls: { eval: number; analyzeRuns: number; goldenGenerate: number };
} {
  const calls = { eval: 0, analyzeRuns: 0, goldenGenerate: 0 };
  const ok: OpResult = { ok: true, message: 'stub' };
  const ops: ConsoleOps = {
    eval: overrides.eval ??
      (async () => {
        calls.eval += 1;
        return ok;
      }),
    analyzeRuns: overrides.analyzeRuns ??
      (async () => {
        calls.analyzeRuns += 1;
        return ok;
      }),
    goldenGenerate: overrides.goldenGenerate ??
      (async () => {
        calls.goldenGenerate += 1;
        return ok;
      }),
    goldenGenerateStream: overrides.goldenGenerateStream ??
      (async (_opts, onEvent) => {
        calls.goldenGenerate += 1;
        onEvent({ type: 'log', line: 'stub log' });
        onEvent({ type: 'result', ok: true, message: 'stub' });
      }),
    evalStream: overrides.evalStream ??
      (async (_opts, onEvent) => {
        calls.eval += 1;
        onEvent({ type: 'boot', totalCases: 2 });
        onEvent({ type: 'warm', bootMs: 100, chunks: 50 });
        onEvent({ type: 'case-start', i: 0, total: 2, caseId: 'c1', query: 'q1', lang: 'en' });
        onEvent({
          type: 'case-done',
          i: 0, total: 2, caseId: 'c1', latencyMs: 200,
          kind: 'answer', r_at_5: true, citation_pass: true, answer_rule_pass: true,
        });
        onEvent({ type: 'case-start', i: 1, total: 2, caseId: 'c2', query: 'q2', lang: 'zh' });
        onEvent({
          type: 'case-done',
          i: 1, total: 2, caseId: 'c2', latencyMs: 300,
          kind: 'answer', r_at_5: false, citation_pass: true, answer_rule_pass: false,
        });
        onEvent({
          type: 'done',
          reportPath: '/tmp/fake/reports/2026-05-15-eval.md',
          totalMs: 500,
          summary: { n: 2, r_at_5: 0.5, citation_pass: 1, answer_rule_pass: 0.5 },
        });
        onEvent({ type: 'result', ok: true, reportPath: '/tmp/fake/reports/2026-05-15-eval.md' });
      }),
  };
  return { ops, calls };
}

test('POST /api/projects/:name/eval: invokes ops.eval with state path', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawStateRoot: string | null = null;
    const { ops } = makeStubOps({
      eval: async (opts) => {
        sawStateRoot = opts.stateRoot;
        return { ok: true, reportPath: '/tmp/fake/reports/2026-05-10-eval.md' };
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/eval', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; reportPath: string };
    assert.equal(body.ok, true);
    assert.match(body.reportPath, /2026-05-10-eval\.md$/);
    assert.equal(sawStateRoot, join(ws, 'state', 'docs-zh'));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: body.baseline_path resolved to absolute report path', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    // Write a baseline report so the pointer can resolve.
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# baseline\n');
    let receivedBaseline: string | undefined;
    const fakeOps = {
      eval: async (opts: { projectRoot: string; stateRoot: string; baselinePath?: string }) => {
        receivedBaseline = opts.baselinePath;
        return { ok: true as const, message: 'ok' };
      },
      analyzeRuns: async () => ({ ok: true as const, message: 'ok' }),
      goldenGenerate: async () => ({ ok: true as const, message: 'ok' }),
    };
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops: fakeOps,
    });
    const res = await app.request('/api/projects/docs-zh/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseline_path: '2026-05-08-eval.md' }),
    });
    assert.equal(res.status, 200);
    assert.ok(receivedBaseline);
    assert.ok(receivedBaseline.endsWith('state/docs-zh/reports/2026-05-08-eval.md'));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: invalid baseline filename rejected', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseline_path: '../../etc/passwd' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /invalid baseline/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: pinned baseline used when body omits baseline_path', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const stateRoot = join(ws, 'state', 'docs-zh');
    const reportsDir = join(stateRoot, 'reports');
    const goldenDir = join(stateRoot, 'golden');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.mkdir(goldenDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# pinned baseline\n');
    await fs.writeFile(
      join(goldenDir, 'eval-baseline.json'),
      JSON.stringify({ filename: '2026-05-08-eval.md', pinnedAt: '2026-05-09T00:00:00.000Z' }),
    );
    let receivedBaseline: string | undefined;
    const fakeOps = {
      eval: async (opts: { projectRoot: string; stateRoot: string; baselinePath?: string }) => {
        receivedBaseline = opts.baselinePath;
        return { ok: true as const, message: 'ok' };
      },
      analyzeRuns: async () => ({ ok: true as const, message: 'ok' }),
      goldenGenerate: async () => ({ ok: true as const, message: 'ok' }),
    };
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops: fakeOps,
    });
    const res = await app.request('/api/projects/docs-zh/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.ok(receivedBaseline?.endsWith('reports/2026-05-08-eval.md'));
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval/stream: emits boot → warm → case-* → done → result as NDJSON', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops: fakeOps } = makeStubOps();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops: fakeOps,
    });
    const res = await app.request('/api/projects/docs-zh/eval/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /x-ndjson/);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    // exact sequence the stub emits — proves the server is forwarding events
    // verbatim through stream() in NDJSON form.
    assert.deepEqual(
      events.map((e) => e.type),
      ['boot', 'warm', 'case-start', 'case-done', 'case-start', 'case-done', 'done', 'result'],
    );
    const last = events[events.length - 1] as { type: 'result'; ok: boolean };
    assert.equal(last.ok, true);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval/stream: invalid baseline filename → 400', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops: fakeOps } = makeStubOps();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops: fakeOps,
    });
    const res = await app.request('/api/projects/docs-zh/eval/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseline_path: '../escape.md' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /invalid baseline filename/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval/pin-baseline: writes pointer to state/golden/eval-baseline.json', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# r\n');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval/pin-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '2026-05-08-eval.md' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; pinned: { filename: string } };
    assert.equal(body.ok, true);
    assert.equal(body.pinned.filename, '2026-05-08-eval.md');
    // file actually exists
    const pinFile = join(ws, 'state', 'docs-zh', 'golden', 'eval-baseline.json');
    const content = JSON.parse(await fs.readFile(pinFile, 'utf8')) as { filename: string };
    assert.equal(content.filename, '2026-05-08-eval.md');
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval/pin-baseline: missing report → 400', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval/pin-baseline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '2099-12-31-eval.md' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /report not found/);
  } finally {
    await cleanup();
  }
});

test('DELETE /api/projects/:name/eval/pin-baseline: removes pointer file', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    await fs.mkdir(goldenDir, { recursive: true });
    await fs.writeFile(
      join(goldenDir, 'eval-baseline.json'),
      JSON.stringify({ filename: '2026-05-08-eval.md', pinnedAt: '2026-05-09' }),
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/eval/pin-baseline', {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.cleared, true);
    // file gone
    const stillExists = await fs
      .stat(join(goldenDir, 'eval-baseline.json'))
      .then(() => true)
      .catch(() => false);
    assert.equal(stillExists, false);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/decide: writes decision into candidate jsonl', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    await fs.mkdir(goldenDir, { recursive: true });
    const candidate = {
      id: 'cand-001',
      query: 'JWT 续期',
      filters: {},
      context_pageId: null,
      expected: { must_cite_pages: ['jwt'], must_contain: [], forbid_contain: [] },
      tags: [],
      created_by: 'structure',
      reviewed_at: null,
      reviewer: null,
      lang: 'zh',
      decision: null,
      template_id: 'definition',
    };
    await fs.writeFile(
      join(goldenDir, 'cases.candidate.jsonl'),
      JSON.stringify(candidate) + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/golden/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'cand-001', decision: 'approved' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; after: string };
    assert.equal(body.ok, true);
    assert.equal(body.after, 'approved');
    // file actually contains the update
    const content = await fs.readFile(join(goldenDir, 'cases.candidate.jsonl'), 'utf8');
    const parsed = JSON.parse(content.trim()) as { decision: string };
    assert.equal(parsed.decision, 'approved');
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/decide: unknown id → 404', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/golden/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'nope', decision: 'approved' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not found/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/flush: moves approved → cases.jsonl, leaves rejected behind', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    await fs.mkdir(goldenDir, { recursive: true });
    const make = (id: string, decision: string | null) => ({
      id,
      query: 'q-' + id,
      filters: {},
      context_pageId: null,
      expected: { must_cite_pages: ['p'], must_contain: [], forbid_contain: [] },
      tags: [],
      created_by: 'structure',
      reviewed_at: null,
      reviewer: null,
      lang: 'zh',
      decision,
      template_id: 'definition',
    });
    await fs.writeFile(
      join(goldenDir, 'cases.candidate.jsonl'),
      [make('a', 'approved'), make('b', 'rejected'), make('c', null)]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/golden/flush', {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      summary: { approved: number; rejected: number; pending: number };
    };
    assert.equal(body.summary.approved, 1);
    assert.equal(body.summary.rejected, 1);
    assert.equal(body.summary.pending, 1);
    // cases.jsonl contains the approved row only
    const cases = (await fs.readFile(join(goldenDir, 'cases.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(cases.length, 1);
    const approved = JSON.parse(cases[0]!) as { id: string; reviewer: string };
    assert.equal(approved.id, 'a');
    assert.equal(approved.reviewer, 'console');
    // candidate file keeps only the pending row
    const remaining = (await fs.readFile(join(goldenDir, 'cases.candidate.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(remaining.length, 1);
    assert.equal((JSON.parse(remaining[0]!) as { id: string }).id, 'c');
  } finally {
    await cleanup();
  }
});

// RFC 0002 T2 — Traffic → Golden cross-journey jump endpoint.
// Writes one pending candidate (decision=null) so the existing approve/reject
// flow takes over from there; PRD §11.2 ③ ("审核走文件 + git") stays intact.
test('POST /api/projects/:name/golden/candidate/create-from-run: appends a pending candidate', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request(
      '/api/projects/docs-zh/golden/candidate/create-from-run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '怎么续期 JWT？',
          context_pageId: 'auth/jwt',
          citation_pages: ['auth/jwt', 'auth/refresh'],
        }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      isNew: boolean;
      created: {
        id: string;
        query: string;
        lang: string;
        decision: null | string;
        template_id: string;
        created_by: string;
        expected: { must_cite_pages: string[] };
        context_pageId: string | null;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.isNew, true);
    assert.match(body.created.id, /^runs:[0-9a-f]{8}$/);
    assert.equal(body.created.query, '怎么续期 JWT？');
    assert.equal(body.created.lang, 'zh');
    assert.equal(body.created.decision, null);
    assert.equal(body.created.template_id, 'from_runs');
    assert.equal(body.created.created_by, 'runs');
    assert.equal(body.created.context_pageId, 'auth/jwt');
    assert.deepEqual(body.created.expected.must_cite_pages, ['auth/jwt', 'auth/refresh']);
    // The JSONL file actually contains the new row.
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    const content = await fs.readFile(join(goldenDir, 'cases.candidate.jsonl'), 'utf8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]!) as { id: string }).id, body.created.id);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/candidate/create-from-run: idempotent on same query', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const reqBody = JSON.stringify({
      query: 'how to refresh tokens',
      citation_pages: ['auth'],
    });
    const first = await app.request(
      '/api/projects/docs-zh/golden/candidate/create-from-run',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reqBody },
    );
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { isNew: boolean; created: { id: string } };
    assert.equal(firstBody.isNew, true);

    const second = await app.request(
      '/api/projects/docs-zh/golden/candidate/create-from-run',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reqBody },
    );
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { isNew: boolean; created: { id: string } };
    assert.equal(secondBody.isNew, false);
    assert.equal(secondBody.created.id, firstBody.created.id);
    // Only one row on disk despite two POSTs.
    const goldenDir = join(ws, 'state', 'docs-zh', 'golden');
    const content = await fs.readFile(join(goldenDir, 'cases.candidate.jsonl'), 'utf8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/candidate/create-from-run: 400 on empty query', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request(
      '/api/projects/docs-zh/golden/candidate/create-from-run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '   ' }),
      },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /query/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/eval: 500 with op error on failure', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps({
      eval: async () => ({ ok: false, error: 'no golden cases' }),
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/eval', { method: 'POST' });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /no golden cases/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/analyze: forwards ?since to ops.analyzeRuns', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawSince: string | undefined;
    const { ops } = makeStubOps({
      analyzeRuns: async (opts) => {
        sawSince = opts.since;
        return { ok: true };
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    await app.request('/api/projects/docs-zh/analyze?since=14d', { method: 'POST' });
    assert.equal(sawSince, '14d');
    // Without query param, since should be undefined
    await app.request('/api/projects/docs-zh/analyze', { method: 'POST' });
    assert.equal(sawSince, undefined);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate: from=structure default, llmRewrite=true with auto-fallback', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawOpts: {
      from: string;
      llmRewrite: boolean;
      fallbackOnLlmError?: boolean;
      limit?: number;
    } | null = null;
    const { ops } = makeStubOps({
      goldenGenerate: async (opts) => {
        sawOpts = {
          from: opts.from,
          llmRewrite: opts.llmRewrite,
          ...(opts.fallbackOnLlmError !== undefined
            ? { fallbackOnLlmError: opts.fallbackOnLlmError }
            : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        };
        return { ok: true, message: 'wrote candidates' };
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    await app.request('/api/projects/docs-zh/golden/generate', { method: 'POST' });
    assert.equal(sawOpts!.from, 'structure');
    assert.equal(sawOpts!.llmRewrite, true);
    assert.equal(sawOpts!.fallbackOnLlmError, true);
    assert.equal(sawOpts!.limit, undefined);

    await app.request('/api/projects/docs-zh/golden/generate?from=runs&limit=20', {
      method: 'POST',
    });
    assert.equal(sawOpts!.from, 'runs');
    assert.equal(sawOpts!.limit, 20);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate/stream: multi-line reporter writes split into separate log events', async () => {
  // The reporter contract is "newline-terminated", but runGoldenGenerate
  // does emit multi-line blocks (e.g. the final wrote/next summary). The
  // streaming wrapper must split those into one log event per line, otherwise
  // the UI log box gets one giant blob.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps({
      goldenGenerateStream: async (_opts, onEvent) => {
        // Mirror what defaultOps.goldenGenerateStream does: callers may write
        // a single chunk containing multiple newlines, and each line should
        // become its own event.
        const chunk = 'line one\nline two\nline three\n';
        let pending = '';
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf('\n')) !== -1) {
          onEvent({ type: 'log', line: pending.slice(0, nl) });
          pending = pending.slice(nl + 1);
        }
        onEvent({ type: 'result', ok: true });
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate/stream', {
      method: 'POST',
    });
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; line?: string });
    const logLines = events.filter((e) => e.type === 'log').map((e) => e.line);
    assert.deepEqual(logLines, ['line one', 'line two', 'line three']);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate/stream: error from runner surfaces as log event before result', async () => {
  // Regression: when runGoldenGenerate fails on an actionable check (file
  // already exists, no runs, etc.), the streaming UI must see the helpful
  // message — not just "exited with code 1". The runner emits the message
  // through reporter (= log event), then returns non-zero (= result.ok=false).
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps({
      goldenGenerateStream: async (_opts, onEvent) => {
        onEvent({
          type: 'log',
          line: 'error: cases.candidate.jsonl already exists. Run golden review first.',
        });
        onEvent({ type: 'result', ok: false, error: 'golden generate exited with code 1' });
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate/stream', {
      method: 'POST',
    });
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; line?: string; ok?: boolean });
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'log');
    assert.match(events[0]!.line!, /already exists/);
    assert.equal(events[1]!.type, 'result');
    assert.equal(events[1]!.ok, false);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate/stream: NDJSON log + result events', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    let sawOpts: { from: string; llmRewrite: boolean; fallbackOnLlmError?: boolean } | null = null;
    const { ops } = makeStubOps({
      goldenGenerateStream: async (opts, onEvent) => {
        sawOpts = {
          from: opts.from,
          llmRewrite: opts.llmRewrite,
          ...(opts.fallbackOnLlmError !== undefined
            ? { fallbackOnLlmError: opts.fallbackOnLlmError }
            : {}),
        };
        onEvent({ type: 'log', line: 'loading project...' });
        onEvent({ type: 'log', line: '  rewrite batch 1/2 (50 items)...' });
        onEvent({ type: 'log', line: '    ok in 1234ms' });
        onEvent({ type: 'result', ok: true, message: 'wrote /tmp/cases.candidate.jsonl' });
      },
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate/stream', {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);
    const body = await res.text();
    const lines = body.split('\n').filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    assert.equal(events.length, 4);
    assert.equal(events[0]!.type, 'log');
    assert.equal(events[3]!.type, 'result');
    assert.equal((events[3] as { ok: boolean }).ok, true);
    assert.equal(sawOpts!.from, 'structure');
    assert.equal(sawOpts!.llmRewrite, true);
    assert.equal(sawOpts!.fallbackOnLlmError, true);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/golden/generate: rejects invalid from', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const { ops } = makeStubOps();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
      ops,
    });
    const res = await app.request('/api/projects/docs-zh/golden/generate?from=inbox', {
      method: 'POST',
    });
    assert.equal(res.status, 400);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/reports: returns the listing newest first', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-01-eval.md'), 'A');
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), 'B');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/reports');
    const body = (await res.json()) as Array<{ filename: string }>;
    assert.deepEqual(
      body.map((r) => r.filename),
      ['2026-05-08-eval.md', '2026-05-01-eval.md'],
    );
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/reports/:file: renders report inside <pre>', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const reportsDir = join(ws, 'state', 'docs-zh', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(join(reportsDir, '2026-05-08-eval.md'), '# Eval\n\nR@5=0.78');
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/reports/2026-05-08-eval.md');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<pre[^>]*>[^<]*# Eval/);
    assert.match(body, /R@5=0\.78/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/reports/:file: 400 on bad filename (path traversal)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    // Note: hono decodes %2e%2e, but our route's filename validator rejects
    // anything not matching the canonical pattern.
    const res = await app.request('/p/docs-zh/reports/etc-passwd.md');
    assert.equal(res.status, 400);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/reports/:file: 404 when filename valid but file missing', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/reports/2030-01-01-eval.md');
    assert.equal(res.status, 404);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/runs: returns recent jsonl entries', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const runsDir = join(ws, 'state', 'docs-zh', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const rec = (q: string): RunRecord => ({
      ts: '2026-05-10T03:14:15.123Z',
      request_id: '01HXX',
      session_id: null,
      query: q,
      filters: {},
      context_pageId: null,
      retrieval: { fused: [], subtree_ask_triggered: false },
      answer: {
        kind: 'answer',
        answer_id: 'ans',
        md: 'A.',
        citations: [],
        confidence: 0.8,
        latency_ms: 100,
        tokens_in: null,
        tokens_out: null,
        model: 'mock',
        error_code: null,
      },
      feedback: { beta: null, gamma: null },
    });
    await fs.writeFile(
      join(runsDir, '2026-W19.jsonl'),
      JSON.stringify(rec('Q1')) + '\n' + JSON.stringify(rec('Q2')) + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/api/projects/docs-zh/runs?limit=5');
    const body = (await res.json()) as RunRecord[];
    assert.equal(body.length, 2);
    assert.deepEqual(
      body.map((r) => r.query),
      ['Q1', 'Q2'],
    );
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/runs: renders runs table with newest first', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const runsDir = join(ws, 'state', 'docs-zh', 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(
      join(runsDir, '2026-W19.jsonl'),
      JSON.stringify({
        ts: '2026-05-10T03:14:15.123Z',
        request_id: '01HXY',
        session_id: null,
        query: 'JWT 续期',
        filters: {},
        context_pageId: null,
        retrieval: { fused: [], subtree_ask_triggered: false },
        answer: {
          kind: 'answer',
          answer_id: 'a1',
          md: 'use refresh token',
          citations: [{ chunk_id: 1, page: 'security/jwt', quote: '' }],
          confidence: 0.78,
          latency_ms: 1234,
          tokens_in: null,
          tokens_out: null,
          model: 'mock',
          error_code: null,
        },
        feedback: { beta: null, gamma: null },
      }) + '\n',
    );
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/runs');
    const body = await res.text();
    assert.match(body, /JWT 续期/);
    assert.match(body, /security\/jwt/);
    assert.match(body, /1234ms/);
    assert.match(body, /tag ok[^>]*>answer/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name/runs: empty state shows hint', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh/runs');
    const body = await res.text();
    assert.match(body, /No runs recorded this week/);
  } finally {
    await cleanup();
  }
});

test('POST /api/projects/:name/ask: touches lastUsedAt to defer reap', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    await makeWorkspaceWithProjects(ws, ['docs-zh']);
    const registry = makeRegistry();
    await registry.start('docs-zh');
    // simulate baseline lastUsedAt by reading list
    const before = registry.list()[0]!.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    const fetchFn = makeStubFetch([], () => ({
      status: 200,
      body: { type: 'answer', _dry_run: true },
    }));
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry,
      fetchFn,
    });
    await app.request('/api/projects/docs-zh/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const after = registry.list()[0]!.lastUsedAt;
    assert.ok(after > before, `expected lastUsedAt to advance: before=${before} after=${after}`);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// RFC 0005 V5 — Console Studio verdict display
// ---------------------------------------------------------------------------

test('GET /api/projects/:name/feedback: semantic_check_failed chip counts rows with ≥1 failing verdict', async () => {
  // V5 happy path: 3 feedback rows linked to 3 runs.
  //   ans_ok  — all supports → NOT counted
  //   ans_partial — one partially → counted
  //   ans_bad — one not_supports → counted
  // Chip badge: filterCounts.semantic_check_failed = 2.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'ans_ok', rating: 1 });
    insertFeedback(db, { answer_id: 'ans_partial', rating: 1 });
    insertFeedback(db, { answer_id: 'ans_bad', rating: -1 });
    db.close();
    await seedRunsFile(stateRoot, [
      makeRunRecord({
        answer_id: 'ans_ok',
        citations: [{ chunk_id: 1, page: 'p1', quote: 'q', citation_id: 'cit_1' }],
      }),
      makeCitationCheckUpdate({
        request_id: 'req_ans_ok',
        verdicts: [{ citation_id: 'cit_1', verdict: 'supports' }],
      }),
      makeRunRecord({
        answer_id: 'ans_partial',
        citations: [
          { chunk_id: 1, page: 'p1', quote: 'q', citation_id: 'cit_1' },
          { chunk_id: 2, page: 'p2', quote: 'q', citation_id: 'cit_2' },
        ],
      }),
      makeCitationCheckUpdate({
        request_id: 'req_ans_partial',
        verdicts: [
          { citation_id: 'cit_1', verdict: 'supports' },
          { citation_id: 'cit_2', verdict: 'partially' },
        ],
      }),
      makeRunRecord({
        answer_id: 'ans_bad',
        citations: [{ chunk_id: 1, page: 'p1', quote: 'q', citation_id: 'cit_1' }],
      }),
      makeCitationCheckUpdate({
        request_id: 'req_ans_bad',
        verdicts: [{ citation_id: 'cit_1', verdict: 'not_supports' }],
      }),
    ]);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const allBody = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      filterCounts: Record<string, number>;
      kpi: { semanticCheckFailed: number | null };
    };
    assert.equal(allBody.filterCounts.semantic_check_failed, 2);
    // KPI tile uses the same denominator.
    assert.equal(allBody.kpi.semanticCheckFailed, 2);

    // filter=semantic_check_failed narrows the SQL pull to those answer_ids.
    const filtBody = (await (
      await app.request('/api/projects/docs-zh/feedback?filter=semantic_check_failed')
    ).json()) as {
      filter: string;
      rows: Array<{ answerId: string; semanticCheckFailed: boolean | null }>;
    };
    assert.equal(filtBody.filter, 'semantic_check_failed');
    assert.equal(filtBody.rows.length, 2);
    const ids = filtBody.rows.map((r) => r.answerId).sort();
    assert.deepEqual(ids, ['ans_bad', 'ans_partial']);
    for (const r of filtBody.rows) {
      assert.equal(r.semanticCheckFailed, true);
    }
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: with NO citation-check tails KPI semanticCheckFailed = null (feature off vs no failures distinct)', async () => {
  // alpha.0 promise: `enabled=false` produces zero tails → KPI tile reads
  // "—" not "0". Tests the distinction at the snapshot layer.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'ans_1', rating: 1 });
    db.close();
    await seedRunsFile(stateRoot, [
      makeRunRecord({
        answer_id: 'ans_1',
        citations: [{ chunk_id: 1, page: 'p1', quote: 'q', citation_id: 'cit_1' }],
      }),
      // NO citation-check-update tail.
    ]);
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      filterCounts: Record<string, number>;
      kpi: { semanticCheckFailed: number | null };
    };
    assert.equal(body.filterCounts.semantic_check_failed, 0);
    assert.equal(body.kpi.semanticCheckFailed, null, 'null distinguishes "feature off" from "0 failures"');
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: drawer citations carry semanticCheck verdict + reason', async () => {
  // V5 drawer join: the citation snapshot in feedback.retrieved is
  // β-style ({page_id, snippet, citation_id}). The runs.jsonl tail joins
  // by citation_id and the drawer merges verdict + reason onto each cit.
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    // Write feedback.retrieved as β-shape JSON (Citation, not RunCitation).
    const retrievedJson = JSON.stringify([
      { citation_id: 'cit_1', page_id: 'p1', snippet: 'snippet1' },
      { citation_id: 'cit_2', page_id: 'p2', snippet: 'snippet2' },
    ]);
    insertFeedback(db, {
      answer_id: 'ans_x',
      rating: -1,
      retrieved: retrievedJson,
    });
    db.close();
    await seedRunsFile(stateRoot, [
      makeRunRecord({
        answer_id: 'ans_x',
        citations: [
          { chunk_id: 1, page: 'p1', quote: 'q1', citation_id: 'cit_1' },
          { chunk_id: 2, page: 'p2', quote: 'q2', citation_id: 'cit_2' },
        ],
      }),
      makeCitationCheckUpdate({
        request_id: 'req_ans_x',
        verdicts: [
          { citation_id: 'cit_1', verdict: 'supports', reason: '原文吻合' },
          { citation_id: 'cit_2', verdict: 'not_supports', reason: '片段在讲别的' },
        ],
      }),
    ]);

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    // Find the inserted feedback row's id (always 1 in a fresh schema).
    const detailRes = await app.request('/api/projects/docs-zh/feedback/1');
    assert.equal(detailRes.status, 200);
    const body = (await detailRes.json()) as {
      ok: boolean;
      detail: {
        citations: Array<{
          citationId: string | null;
          semanticCheck: { verdict: string; reason: string } | null;
        }>;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.detail.citations.length, 2);
    const byCit = new Map(body.detail.citations.map((c) => [c.citationId, c]));
    assert.equal(byCit.get('cit_1')?.semanticCheck?.verdict, 'supports');
    assert.equal(byCit.get('cit_1')?.semanticCheck?.reason, '原文吻合');
    assert.equal(byCit.get('cit_2')?.semanticCheck?.verdict, 'not_supports');
    assert.equal(byCit.get('cit_2')?.semanticCheck?.reason, '片段在讲别的');
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab SSR — semantic_check_failed chip is in the chip bar + cit-check KPI tile', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Chip in the chip bar.
    assert.match(body, /data-feedback-chip="semantic_check_failed"/);
    assert.match(body, /⚠ cit-check/);
    // KPI tile.
    assert.match(body, /cit-check failed/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// RFC 0006 A7 alpha.3 — A+ visibility in Studio Feedback tab
// ---------------------------------------------------------------------------

async function seedAplusCluster(
  stateRoot: string,
  args: {
    clusterId: string;
    members: number[];
    memberQuestions: string[];
    shadow?: boolean;
    size?: number;
    density?: number;
    markdown?: string;
  },
): Promise<{ tracePath: string; mdPath: string }> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = args.shadow
    ? join(stateRoot, 'feedback', 'suggestions', '.shadow')
    : join(stateRoot, 'feedback', 'suggestions');
  await mkdir(dir, { recursive: true });
  const tracePath = join(dir, `${args.clusterId}.json`);
  const mdPath = join(dir, `${args.clusterId}.md`);
  await writeFile(
    tracePath,
    JSON.stringify(
      {
        cluster_id: args.clusterId,
        size: args.size ?? args.members.length,
        density: args.density ?? 0.82,
        center_question: args.memberQuestions[0],
        center_feedback_id: args.members[0],
        members: args.members,
        member_questions: args.memberQuestions,
        suggestion: { model: 'mock', latency_ms: 100 },
      },
      null,
      2,
    ),
  );
  await writeFile(
    mdPath,
    args.markdown ??
      `# Suggested doc fix\n\nCluster ${args.clusterId} groups ${args.members.length} similar failed queries.\n`,
  );
  return { tracePath, mdPath };
}

test('GET /api/projects/:name/feedback: aplus_candidates filter narrows rows to cluster members (RFC 0006 A7)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: -1, question: 'how to retry refund?' });
    insertFeedback(db, { answer_id: 'a2', rating: -1, question: 'retry policy on refunds?' });
    insertFeedback(db, { answer_id: 'a3', rating: 1, question: 'how to check status?' });
    db.close();
    // Two rows (1, 2) are in the cluster; row 3 is not.
    await seedAplusCluster(stateRoot, {
      clusterId: 'c_aplus0000001',
      members: [1, 2],
      memberQuestions: ['how to retry refund?', 'retry policy on refunds?'],
    });

    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });

    // filterCounts.aplus_candidates = 2; all = 3.
    const all = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      filterCounts: Record<string, number>;
      kpi: { aplusCandidates: { total: number; mode: string } | null };
    };
    assert.equal(all.filterCounts.aplus_candidates, 2);
    assert.equal(all.filterCounts.all, 3);
    assert.deepEqual(all.kpi.aplusCandidates, { total: 1, mode: 'enabled' });

    // filter=aplus_candidates narrows to the 2 cluster members.
    const narrowed = (await (
      await app.request('/api/projects/docs-zh/feedback?filter=aplus_candidates')
    ).json()) as { rows: Array<{ feedback_id: number; aplusCluster: unknown }> };
    assert.equal(narrowed.rows.length, 2);
    assert.ok(narrowed.rows.every((r) => r.aplusCluster !== null));
    const fids = new Set(narrowed.rows.map((r) => r.feedback_id));
    assert.ok(fids.has(1));
    assert.ok(fids.has(2));
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: aplus KPI shows shadow mode when traces live under .shadow/', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: -1, question: 'q1' });
    insertFeedback(db, { answer_id: 'a2', rating: -1, question: 'q2' });
    db.close();
    await seedAplusCluster(stateRoot, {
      clusterId: 'c_shadow000001',
      members: [1, 2],
      memberQuestions: ['q1', 'q2'],
      shadow: true,
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      kpi: { aplusCandidates: { total: number; mode: string } | null };
      filterCounts: Record<string, number>;
    };
    assert.deepEqual(body.kpi.aplusCandidates, { total: 1, mode: 'shadow' });
    assert.equal(body.filterCounts.aplus_candidates, 2);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback: aplus KPI is null when no suggestions dir exists', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: -1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const body = (await (await app.request('/api/projects/docs-zh/feedback')).json()) as {
      kpi: { aplusCandidates: unknown };
      filterCounts: Record<string, number>;
    };
    assert.equal(body.kpi.aplusCandidates, null);
    assert.equal(body.filterCounts.aplus_candidates, 0);
  } finally {
    await cleanup();
  }
});

test('GET /api/projects/:name/feedback/:id: drawer detail carries SUGGESTION block when row is in a cluster (RFC 0006 A7)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: -1, question: 'how to retry refund?' });
    insertFeedback(db, { answer_id: 'a2', rating: -1, question: 'retry policy on refunds?' });
    db.close();
    await seedAplusCluster(stateRoot, {
      clusterId: 'c_drawer000001',
      members: [1, 2],
      memberQuestions: ['how to retry refund?', 'retry policy on refunds?'],
      markdown: '# Suggested fix\n\nDocument the retry-after-refund flow under Refunds → Errors.\n',
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const detailRes = await app.request('/api/projects/docs-zh/feedback/1');
    assert.equal(detailRes.status, 200);
    const body = (await detailRes.json()) as {
      ok: boolean;
      detail: {
        aplusCluster: {
          clusterId: string;
          shadow: boolean;
          centerQuestion: string;
          peerQuestions: string[];
          size: number;
          density: number;
          suggestionMarkdown: string | null;
          suggestionTruncated: boolean;
          suggestionPath: string;
        } | null;
      };
    };
    assert.equal(body.ok, true);
    assert.ok(body.detail.aplusCluster, 'row 1 should carry an aplusCluster');
    const c = body.detail.aplusCluster!;
    assert.equal(c.clusterId, 'c_drawer000001');
    assert.equal(c.shadow, false);
    assert.equal(c.size, 2);
    // peerQuestions excludes this row's own question.
    assert.equal(c.peerQuestions.length, 1);
    assert.match(c.peerQuestions[0]!, /retry policy/);
    // suggestionMarkdown was loaded inline.
    assert.match(c.suggestionMarkdown ?? '', /Suggested fix/);
    assert.equal(c.suggestionTruncated, false);
    assert.match(c.suggestionPath, /c_drawer000001\.md$/);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab SSR — aplus_candidates chip + KPI render (RFC 0006 A7)', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { stateRoot, db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: -1, question: 'q1' });
    insertFeedback(db, { answer_id: 'a2', rating: -1, question: 'q2' });
    db.close();
    await seedAplusCluster(stateRoot, {
      clusterId: 'c_ssr00000001',
      members: [1, 2],
      memberQuestions: ['q1', 'q2'],
    });
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Chip is in the chip bar.
    assert.match(body, /data-feedback-chip="aplus_candidates"/);
    assert.match(body, /A\+ cluster/);
    // KPI tile shows real count + live mode (not placeholder).
    assert.match(body, /data-feedback-aplus-mode="enabled"/);
    assert.match(body, /A\+ candidates[\s\S]*?>1<[\s\S]*?live · operator flipped/);
    // Placeholder copy is NOT present.
    assert.equal(body.includes('unlocks at 50 (PRD §10.3)'), false);
  } finally {
    await cleanup();
  }
});

test('GET /p/:name: Feedback tab SSR — KPI placeholder when no suggestions dir', async () => {
  const { path: ws, cleanup } = await withTmpDir();
  try {
    const { db } = await seedFeedbackProject(ws, 'docs-zh');
    insertFeedback(db, { answer_id: 'a1', rating: 1 });
    db.close();
    const app = createConsoleApp({
      workspacePath: ws,
      consolePort: 4100,
      registry: makeRegistry(),
    });
    const res = await app.request('/p/docs-zh');
    assert.equal(res.status, 200);
    const body = await res.text();
    // Placeholder copy is back in place (no clusters yet).
    assert.match(body, /A\+ candidates[\s\S]*?>—<[\s\S]*?unlocks at 50/);
    assert.equal(body.includes('data-feedback-aplus-mode'), false);
  } finally {
    await cleanup();
  }
});
