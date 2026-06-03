/**
 * /v1/ask × session_id end-to-end. Boots a real Runtime + Hono app and
 * checks the wire-level contract from RFC 0001 §4.1:
 *
 *   - every successful response carries `session_id`
 *   - echoing the same session_id back keeps the session alive
 *   - sending an unknown id mints a fresh one (no resurrection)
 *
 * Unit-level γ behaviour (re-ask detection, threshold, window) lives in
 * feedback-gamma.test.ts; this file only certifies the HTTP plumbing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { Runtime } from '../src/server/runtime.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';

async function buildProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-session-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.writeFile(
    join(root, 'navigation', 'zh.json'),
    JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'auth' }] }),
  );
  await fs.writeFile(
    join(root, 'pages', 'zh', 'auth.json'),
    JSON.stringify({
      id: 'auth',
      lang: 'zh',
      slug: 'auth',
      title: '鉴权',
      status: 'published',
      content: {
        version: 1,
        blocks: [
          { type: 'heading', id: 'h1', level: 1, children: [{ type: 'text', text: '鉴权' }] },
          {
            type: 'paragraph',
            id: 'p1',
            children: [{ type: 'text', text: '使用 JWT bearer token 完成鉴权。' }],
          },
        ],
      },
    }),
  );
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function setup(opts: { feedbackEnabled?: boolean } = {}): Promise<{
  runtime: Runtime;
  cleanup: () => Promise<void>;
}> {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-session-state-'));
  const { config } = await loadConfig(root);
  config.feedback.enabled = opts.feedbackEnabled ?? false;
  const db = openDatabase({ dbPath: ':memory:' });
  const runtime = new Runtime({
    projectRoot: root,
    stateRoot,
    config,
    db,
    embedder: new MockEmbedder(),
    llm: new MockLLM({ model: 'mock-llm' }),
    skipWatcher: true,
  });
  await runtime.start();
  return {
    runtime,
    cleanup: async () => {
      await runtime.stop();
      await rmTmp();
      await fs.rm(stateRoot, { recursive: true, force: true });
    },
  };
}

test('/v1/ask includes session_id in response body (even with feedback.enabled=false)', async () => {
  // Issuing a session id has to be unconditional so clients can keep one in
  // localStorage from day 1 even before the operator flips the switch.
  const s = await setup({ feedbackEnabled: false });
  try {
    const app = createApp({ runtime: s.runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { session_id?: string };
    assert.ok(body.session_id);
    assert.match(body.session_id, /^s_[a-f0-9]+$/);
  } finally {
    await s.cleanup();
  }
});

test('/v1/ask: echoing same session_id keeps the session alive', async () => {
  const s = await setup({ feedbackEnabled: true });
  try {
    const app = createApp({ runtime: s.runtime });
    const first = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    const firstBody = (await first.json()) as { session_id: string };

    const second = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '另一个不同的问题', session_id: firstBody.session_id }),
    });
    const secondBody = (await second.json()) as { session_id: string };
    assert.equal(secondBody.session_id, firstBody.session_id);
  } finally {
    await s.cleanup();
  }
});

test('/v1/ask: unknown session_id mints a fresh one (no resurrection)', async () => {
  const s = await setup({ feedbackEnabled: true });
  try {
    const app = createApp({ runtime: s.runtime });
    const res = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？', session_id: 's_does_not_exist' }),
    });
    const body = (await res.json()) as { session_id: string };
    assert.notEqual(body.session_id, 's_does_not_exist');
    assert.match(body.session_id, /^s_[a-f0-9]+$/);
  } finally {
    await s.cleanup();
  }
});

test('/v1/ask: identical question twice in same session writes an implicit-negative feedback row', async () => {
  // MockEmbedder is deterministic in the question's bytes → identical
  // questions → cosine similarity 1.0 → re-ask threshold triggers. This
  // makes the test exercise the whole gamma path end-to-end, not just the
  // session-id plumbing.
  const s = await setup({ feedbackEnabled: true });
  try {
    const app = createApp({ runtime: s.runtime });
    const first = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    const firstBody = (await first.json()) as { session_id: string };

    await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？', session_id: firstBody.session_id }),
    });

    const row = s.runtime.db
      .prepare(
        `SELECT signal_source, session_id FROM feedback
            WHERE signal_source = 'implicit' LIMIT 1`,
      )
      .get() as { signal_source: string; session_id: string } | undefined;
    assert.ok(row, 'expected at least one implicit feedback row from the re-ask');
    assert.equal(row?.session_id, firstBody.session_id);
  } finally {
    await s.cleanup();
  }
});

test("/v1/ask: feedback.enabled=false writes no implicit rows even on identical re-ask", async () => {
  const s = await setup({ feedbackEnabled: false });
  try {
    const app = createApp({ runtime: s.runtime });
    const first = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    const firstBody = (await first.json()) as { session_id: string };
    await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？', session_id: firstBody.session_id }),
    });
    const n = (s.runtime.db.prepare(`SELECT COUNT(*) AS n FROM feedback`).get() as { n: number }).n;
    assert.equal(n, 0, 'disabled → strict v1 equivalence (no implicit rows)');
  } finally {
    await s.cleanup();
  }
});

test('/v1/ask: feedback.enabled=false still injects multi-turn history on the second call', async () => {
  const s = await setup({ feedbackEnabled: false });
  try {
    const app = createApp({ runtime: s.runtime });
    const first = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    const firstBody = (await first.json()) as { session_id: string };

    const second = await app.request('/v1/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '它怎么用？', session_id: firstBody.session_id }),
    });
    const secondBody = (await second.json()) as { session_id: string; history_window?: number };
    assert.equal(second.status, 200);
    assert.equal(secondBody.session_id, firstBody.session_id);
    assert.equal(secondBody.history_window, 1);
  } finally {
    await s.cleanup();
  }
});

test('/v1/ask?dry_run=1 issues a session_id but writes no implicit rows on re-ask', async () => {
  const s = await setup({ feedbackEnabled: true });
  try {
    const app = createApp({ runtime: s.runtime });
    const first = await app.request('/v1/ask?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    const firstBody = (await first.json()) as { session_id: string; _dry_run?: boolean };
    assert.equal(firstBody._dry_run, true);
    assert.match(firstBody.session_id, /^s_/);

    await app.request('/v1/ask?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？', session_id: firstBody.session_id }),
    });

    const n = (s.runtime.db.prepare(`SELECT COUNT(*) AS n FROM feedback`).get() as { n: number }).n;
    assert.equal(n, 0, 'dry_run must not leave γ breadcrumbs in the DB');
  } finally {
    await s.cleanup();
  }
});
