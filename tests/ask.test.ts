/**
 * End-to-end query pipeline tests — covers PRD §8 acceptance #11 / #12 / #13
 * (the multilingual-strategy gates) plus the input-validation surface.
 *
 * Approach:
 *   - Build a real project with the file-system fixture pattern from stage 5,
 *     run the indexer once to populate SQLite + sqlite-vec + FTS5.
 *   - Drive ask() with a MockEmbedder (deterministic vectors) and MockLLM.
 *   - Rely on the BM25 path for actual relevance signal (the mock embedder
 *     vectors are noise; sha1-hash-based, not semantic). FTS5 handles both
 *     CJK and ASCII tokens out of the box.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { Indexer } from '../src/index/indexer.ts';
import { ask, askWithTrace } from '../src/query/answer.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type PageBlueprint = {
  id: string;
  title: string;
  body: string;
};

async function writePage(
  root: string,
  lang: 'zh' | 'en',
  page: PageBlueprint,
): Promise<void> {
  await fs.writeFile(
    join(root, 'pages', lang, `${page.id}.json`),
    JSON.stringify(
      {
        id: page.id,
        lang,
        slug: page.id,
        title: page.title,
        status: 'published',
        content: {
          version: 1,
          blocks: [
            {
              type: 'heading',
              id: 'h1',
              level: 1,
              children: [{ type: 'text', text: page.title }],
            },
            {
              type: 'heading',
              id: 'h2',
              level: 2,
              children: [{ type: 'text', text: lang === 'zh' ? '说明' : 'Details' }],
            },
            {
              type: 'paragraph',
              id: 'p1',
              children: [{ type: 'text', text: page.body }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
}

async function writeNav(root: string, lang: 'zh' | 'en', json: object): Promise<void> {
  await fs.writeFile(
    join(root, 'navigation', `${lang}.json`),
    JSON.stringify(json, null, 2),
  );
}

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-q-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'en'), { recursive: true });
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function bootstrap(setup: (root: string) => Promise<void>): Promise<{
  db: ReturnType<typeof openDatabase>;
  embedder: MockEmbedder;
  llm: MockLLM;
  cleanup: () => Promise<void>;
}> {
  const { root, cleanup: rmTmp } = await makeRoot();
  await setup(root);
  const db = openDatabase({ dbPath: ':memory:' });
  const embedder = new MockEmbedder();
  const llm = new MockLLM();
  const indexer = new Indexer({ db, embedder, projectRoot: root });
  await indexer.fullReindex();
  return {
    db,
    embedder,
    llm,
    cleanup: async () => {
      db.close();
      await rmTmp();
    },
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('ask: empty question returns invalid_question error', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: 'A', body: '内容' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    const r = await ask(ctx, { question: '   ' });
    assert.equal(r.type, 'error');
    if (r.type === 'error') assert.equal(r.code, 'invalid_question');
  } finally {
    await ctx.cleanup();
  }
});

test('ask: question over 500 chars returns invalid_question error', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: 'A', body: '内容' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    const r = await ask(ctx, { question: 'x'.repeat(501) });
    assert.equal(r.type, 'error');
  } finally {
    await ctx.cleanup();
  }
});

test('ask: unknown scope_id returns invalid_scope error (no silent fallback)', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: 'A', body: '内容' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    const r = await ask(ctx, {
      question: '怎么用',
      context: { scope_id: 'nav:zh.json:bogus' },
    });
    assert.equal(r.type, 'error');
    if (r.type === 'error') assert.equal(r.code, 'invalid_scope');
  } finally {
    await ctx.cleanup();
  }
});

// Regression for codex eval round-2: `no_citations` used to surface the
// internal phrase "LLM response contained no valid citations" directly to
// users. The message is now user-friendly and lang-aware; the internal
// diagnostic moves to `detail` for operators / runs analysis.
test('ask: no_citations carries a localized user message; internal diagnostic is in detail', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: '配置', body: '系统配置说明文档内容。' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    // Force the LLM to emit text with no [cit_N] markers, so postprocess
    // strips every citation and the pipeline returns no_citations.
    ctx.llm.setResponder(() => 'I cannot find the answer in the docs.');
    const r = await ask(ctx, { question: '怎么配置' });
    assert.equal(r.type, 'error');
    if (r.type !== 'error') return;
    assert.equal(r.code, 'no_citations');
    // zh query → zh user message; must not contain internal phrasing.
    assert.match(r.message, /文档|没有|未找到/);
    assert.doesNotMatch(r.message, /LLM|citation|response/i);
    // Internal diagnostic remains accessible to operators.
    assert.equal(r.detail, 'LLM response contained no valid citations');
  } finally {
    await ctx.cleanup();
  }
});

test('ask: no_citations on an English question returns an English user message', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', { id: 'a', title: 'Config', body: 'System configuration docs.' });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    ctx.llm.setResponder(() => 'I cannot find the answer.');
    const r = await ask(ctx, { question: 'how to configure' });
    assert.equal(r.type, 'error');
    if (r.type !== 'error') return;
    assert.equal(r.code, 'no_citations');
    assert.match(r.message, /Couldn'?t find|documentation/i);
    assert.doesNotMatch(r.message, /LLM|citation|response/i);
  } finally {
    await ctx.cleanup();
  }
});

// Regression for codex round-8 zh-lang-aware: when the LLM picks up on
// Chinese phrasing in a query that detected as en (low CJK ratio) and replies
// in zh anyway, answer_lang should be corrected to match the actual answer
// text. This is the one-way en→zh correction; zh→en stays as cross-lang
// fallback (covered by PRD §8 #11).
test('ask: en queryLang with zh-replying LLM corrects answer_lang to zh', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', {
      id: 'auth',
      title: 'Authentication',
      body: 'Use a JWT bearer token in the Authorization header for every request.',
    });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'auth' }] });
  });
  try {
    // Stub the LLM to reply in zh regardless of the (en) prompt hint —
    // simulates real-LLM behaviour on mixed-language queries.
    ctx.llm.setResponder(() => '使用 JWT bearer token 即可 [cit_1]');
    // Mostly-ASCII query so detectLangFromText classifies it as 'en'.
    const r = await ask(ctx, { question: 'How do I authenticate with JWT?' });
    assert.equal(r.type, 'answer');
    if (r.type !== 'answer') return;
    assert.equal(r.answer_lang, 'zh', 'answer_lang follows the actual answer text, not the prompt hint');
    // Citations came from en chunks → cross-lang relative to corrected answer_lang.
    assert.notEqual(r.translation_notice, null);
  } finally {
    await ctx.cleanup();
  }
});

// Regression for codex round-8 citation-validation flake. LLMs occasionally
// omit [cit_N] markers on the first try; we now issue one transparent retry
// with a reinforced citation reminder. If the retry succeeds, the caller
// gets a normal answer (just slower); trace flags the retry for analyze.
test('ask: no_citations on first call → retry → answer on second call', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', { id: 'a', title: 'Config', body: 'System configuration docs.' });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    let call = 0;
    ctx.llm.setResponder((input) => {
      call += 1;
      if (call === 1) return 'Some answer text but with no citation markers.';
      // Second call: the reinforced reminder must be present in the system prompt.
      assert.match(input.systemPrompt, /Important correction|previous response|MUST/);
      // Pull any [cit_N] from userPrompt and cite it back.
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `Configured via the docs ${markers[0] ?? ''}.`;
    });
    const { result, trace } = await askWithTrace(ctx, { question: 'how to configure' });
    assert.equal(result.type, 'answer', 'retry should recover into a citable answer');
    assert.equal(call, 2, 'exactly one retry');
    assert.equal(trace.citation_retry_count, 1);
  } finally {
    await ctx.cleanup();
  }
});

// Codex round-11: bumped MAX_CITATION_RETRIES 1 → 2. When the first retry
// also fails but the second one succeeds, the caller still sees a normal
// answer; trace reflects both attempts.
test('ask: first two calls fail → second retry recovers → answer', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', { id: 'a', title: 'Config', body: 'System configuration docs.' });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    let call = 0;
    ctx.llm.setResponder((input) => {
      call += 1;
      if (call <= 2) return 'No citation marker on this attempt.';
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `Configured ${markers[0] ?? ''}.`;
    });
    const { result, trace } = await askWithTrace(ctx, { question: 'how to configure' });
    assert.equal(result.type, 'answer');
    assert.equal(call, 3, 'one initial + two retries');
    assert.equal(trace.citation_retry_count, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('ask: all retries fail → still no_citations, trace count = MAX', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', { id: 'a', title: 'Config', body: 'System configuration docs.' });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    let call = 0;
    ctx.llm.setResponder(() => {
      call += 1;
      return 'Still no citation marker on any attempt.';
    });
    const { result, trace } = await askWithTrace(ctx, { question: 'how to configure' });
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.equal(result.code, 'no_citations');
    assert.equal(call, 3, 'one initial + two retries');
    assert.equal(trace.citation_retry_count, 2);
    // detail stays stable across the retry path (user-facing message is the
    // same, retry just adds a chance to recover before surfacing the error).
    assert.equal(result.detail, 'LLM response contained no valid citations');
  } finally {
    await ctx.cleanup();
  }
});

test('ask: first call succeeds → no retry, trace count is 0', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', { id: 'a', title: 'Config', body: 'System configuration docs.' });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    let call = 0;
    ctx.llm.setResponder((input) => {
      call += 1;
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `Use the docs ${markers[0] ?? ''}.`;
    });
    const { result, trace } = await askWithTrace(ctx, { question: 'how to configure' });
    assert.equal(result.type, 'answer');
    assert.equal(call, 1, 'no retry on first-call success');
    assert.equal(trace.citation_retry_count, 0);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PRD §8 #11 — cross-lang translation fallback
// ---------------------------------------------------------------------------

test('PRD §8 #11 — zh question against an en-only project triggers translation fallback', async () => {
  const ctx = await bootstrap(async (root) => {
    // Only en pages exist; zh nav file is absent.
    await writePage(root, 'en', {
      id: 'auth',
      title: 'Authentication',
      body: 'Use a JWT bearer token in the Authorization header for every request.',
    });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'auth' }] });
  });
  try {
    const r = await ask(ctx, { question: '如何用 JWT 鉴权？' });
    assert.equal(r.type, 'answer', `expected answer, got ${JSON.stringify(r)}`);
    if (r.type === 'answer') {
      assert.equal(r.answer_lang, 'zh', 'answer_lang follows query lang');
      assert.notEqual(r.translation_notice, null, 'translation_notice fires on cross-lang');
      assert.ok(r.citations.length > 0, 'must cite at least one en chunk');
      for (const cit of r.citations) {
        assert.equal(cit.lang, 'en');
        assert.equal(cit.source_lang, 'en', 'source_lang preserved when crossing langs');
      }
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PRD §8 #12 — lang isolation when same-lang context is sufficient
// ---------------------------------------------------------------------------

test('PRD §8 #12 — same-lang context wins over cross-lang via lang_boost', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'auth',
      title: '鉴权说明',
      body: '使用 JWT 携带令牌完成鉴权请求。',
    });
    await writePage(root, 'en', {
      id: 'auth',
      title: 'Auth',
      body: 'Use JWT bearer token for authentication.',
    });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'auth' }] });
    await writeNav(root, 'en', { version: 1, items: [{ type: 'page', pageId: 'auth' }] });
  });
  try {
    const r = await ask(ctx, { question: '如何用 JWT 鉴权？' });
    assert.equal(r.type, 'answer');
    if (r.type === 'answer') {
      assert.equal(r.answer_lang, 'zh');
      assert.equal(r.translation_notice, null, 'no translation when same-lang context exists');
      assert.ok(r.citations.length > 0);
      for (const cit of r.citations) {
        assert.equal(cit.lang, 'zh', 'all citations should be zh thanks to lang_boost');
        assert.equal(cit.source_lang, null);
      }
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// PRD §8 #13 — clarify keeps options same-lang
// ---------------------------------------------------------------------------

test('PRD §8 #13 — split intent across two zh subtrees yields a same-lang clarify', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'frontend-auth',
      title: '前端鉴权',
      body: '前端 SDK 鉴权使用 JWT 通过 Authorization header 传递。',
    });
    await writePage(root, 'zh', {
      id: 'backend-auth',
      title: '后端 API 鉴权',
      body: '后端 API 鉴权使用 API Key 进行调用方认证。',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'frontend',
          title: '前端',
          children: [{ type: 'page', pageId: 'frontend-auth' }],
        },
        {
          type: 'section',
          id: 'backend',
          title: '后端',
          children: [{ type: 'page', pageId: 'backend-auth' }],
        },
      ],
    });
  });
  try {
    const r = await ask(ctx, { question: '鉴权' });
    assert.equal(r.type, 'clarify', `expected clarify, got ${JSON.stringify(r)}`);
    if (r.type === 'clarify') {
      assert.equal(r.answer_lang, 'zh');
      assert.ok(r.options.length >= 2, 'must offer at least two same-lang subtrees');
      const subtrees = new Set<string>();
      for (const opt of r.options) {
        assert.equal(opt.lang, 'zh', 'every clarify option must be same-lang');
        assert.ok(opt.scope_id);
        assert.ok(opt.label);
        assert.ok(opt.breadcrumb.length >= 1);
        subtrees.add(opt.scope_id);
      }
      assert.ok(subtrees.has('frontend'));
      assert.ok(subtrees.has('backend'));
      // LLM must not have been called — clarify short-circuits before generation.
      assert.equal(ctx.llm.calls.length, 0);
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// scope_id binds the search to a subtree (PRD §4.5)
// ---------------------------------------------------------------------------

test('ask: explicit scope_id constrains retrieval to that subtree', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'frontend-auth',
      title: '前端鉴权',
      body: '前端鉴权使用 JWT。',
    });
    await writePage(root, 'zh', {
      id: 'backend-auth',
      title: '后端鉴权',
      body: '后端鉴权使用 API Key。',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'frontend',
          title: '前端',
          children: [{ type: 'page', pageId: 'frontend-auth' }],
        },
        {
          type: 'section',
          id: 'backend',
          title: '后端',
          children: [{ type: 'page', pageId: 'backend-auth' }],
        },
      ],
    });
  });
  try {
    const r = await ask(ctx, {
      question: '鉴权',
      context: { scope_id: 'frontend' },
    });
    assert.equal(r.type, 'answer');
    if (r.type === 'answer') {
      for (const cit of r.citations) {
        assert.equal(cit.page_id, 'frontend-auth', 'scope_id must constrain citations');
      }
    }
  } finally {
    await ctx.cleanup();
  }
});
