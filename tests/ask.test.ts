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

test('ask: API-intent questions promote API reference snippets into the prompt', async () => {
  const ctx = await bootstrap(async (root) => {
    const guideItems: Array<{ type: 'page'; pageId: string }> = [];
    for (let i = 0; i < 12; i++) {
      const id = `checkout-guide-${i}`;
      guideItems.push({ type: 'page', pageId: id });
      await writePage(root, 'zh', {
        id,
        title: `创建订单指南 ${i}`,
        body: '创建订单接口 checkout 返回字段 checkout checkout checkout guide 快速接入说明。',
      });
    }
    await writePage(root, 'zh', {
      id: 'api-payment-engine-api-post-api-v2-checkout',
      title: 'POST /api/v2/checkout — 创建订单',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/checkout. Response fields: checkout_url, cregis_id.',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        { type: 'section', id: 'payment-engine', title: '支付引擎', children: guideItems },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [{ type: 'page', pageId: 'api-payment-engine-api-post-api-v2-checkout' }],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.systemPrompt, /API reference/);
      assert.match(input.systemPrompt, /完整接口路径/);
      assert.match(input.userPrompt, /POST \/api\/v2\/checkout/);
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `调用 /api/v2/checkout 后保存 checkout_url 和 cregis_id ${markers[0] ?? ''}.`;
    });
    const r = await ask(ctx, { question: '创建订单接口 checkout 返回哪些字段？' });
    assert.equal(r.type, 'answer');
    if (r.type === 'answer') {
      assert.ok(
        r.citations.some((c) => c.page_id === 'api-payment-engine-api-post-api-v2-checkout'),
        'answer should cite the API reference page',
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

test('ask: API-intent questions keep same-product API reference snippets in prompt context', async () => {
  const ctx = await bootstrap(async (root) => {
    const guideItems: Array<{ type: 'page'; pageId: string }> = [];
    for (let i = 0; i < 12; i++) {
      const id = `payment-engine-callback-guide-${i}`;
      guideItems.push({ type: 'page', pageId: id });
      await writePage(root, 'zh', {
        id,
        title: `支付引擎回调指南 ${i}`,
        body: '支付引擎回调 event_type data.status 查询订单状态 状态映射 幂等 处理说明。',
      });
    }
    await writePage(root, 'zh', {
      id: 'api-payment-engine-api-post-api-v2-order-info',
      title: 'POST /api/v2/order/info — 查询订单信息',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/order/info. Response fields: data.status, order_amount.',
    });
    await writePage(root, 'zh', {
      id: 'api-waas-api-post-api-v1-address-update',
      title: 'POST /api/v1/address/update — 更新子地址信息',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/address/update. Response fields: data.status.',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        { type: 'section', id: 'payment-engine', title: '支付引擎', children: guideItems },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [
            { type: 'page', pageId: 'api-payment-engine-api-post-api-v2-order-info' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-address-update' },
          ],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /POST \/api\/v2\/order\/info/, input.userPrompt);
      assert.doesNotMatch(input.userPrompt, /POST \/api\/v1\/address\/update/, input.userPrompt);
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `查询订单终态看 /api/v2/order/info 的 data.status ${markers[0] ?? ''}.`;
    });
    const r = await ask(ctx, {
      question: '支付引擎回调里的 event_type 和查询订单返回的 data.status 为什么名字不一样？',
      context: { current_page_id: 'payment-engine-callback-guide-0' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
  } finally {
    await ctx.cleanup();
  }
});

test('ask: API-intent answers append matching API reference citation when the model cites only guide chunks', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'payment-engine-quickstart-30min',
      title: '支付引擎 30 分钟接入实战',
      body: '状态口径对照：回调的 event_type 是事件类型，并需要做状态映射；查询接口返回 data.status 表示当前状态；处理重复回调要做好幂等。',
    });
    await writePage(root, 'zh', {
      id: 'api-payment-engine-api-post-api-v2-order-info',
      title: 'POST /api/v2/order/info — 查询订单信息',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/order/info. Response fields: data.status.',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'payment-engine',
          title: '支付引擎',
          children: [{ type: 'page', pageId: 'payment-engine-quickstart-30min' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [{ type: 'page', pageId: 'api-payment-engine-api-post-api-v2-order-info' }],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /POST \/api\/v2\/order\/info/);
      const guideMarker = input.userPrompt.match(/\[(cit_\d+)\][^\n]*支付引擎 30 分钟接入实战/)?.[1] ?? 'cit_2';
      return `回调事件类型 event_type 需要做状态映射，查询看 data.status，并且重复回调要做好幂等 [${guideMarker}]。`;
    });
    const r = await ask(ctx, {
      question: '支付引擎回调里的 event_type 和查询订单返回的 data.status 为什么名字不一样？应该怎么处理？',
      context: { current_page_id: 'payment-engine-quickstart-30min' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
    if (r.type === 'answer') {
      assert.ok(r.answer_md.includes('/api/v2/order/info'));
      assert.ok(r.citations.some((c) => c.page_id === 'api-payment-engine-api-post-api-v2-order-info'));
      assert.ok(r.citations.some((c) => c.page_id === 'payment-engine-quickstart-30min'));
    }
  } finally {
    await ctx.cleanup();
  }
});

test('ask: checkout field answers append API reference citation when the model cites only guide chunks', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'payment-engine-quickstart-30min',
      title: '支付引擎 30 分钟接入实战',
      body: '创建订单后，保存 cregis_id 和 checkout_url，并将 checkout_url 提供给用户跳转到托管收银台完成支付。',
    });
    await writePage(root, 'zh', {
      id: 'api-payment-engine-api-post-api-v2-checkout',
      title: 'POST /api/v2/checkout — 创建订单',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/checkout. Response fields: checkout_url, cregis_id, order_amount, order_currency.',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'payment-engine',
          title: '支付引擎',
          children: [{ type: 'page', pageId: 'payment-engine-quickstart-30min' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [{ type: 'page', pageId: 'api-payment-engine-api-post-api-v2-checkout' }],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /POST \/api\/v2\/checkout/);
      const guideMarker = input.userPrompt.match(/\[(cit_\d+)\][^\n]*支付引擎 30 分钟接入实战/)?.[1] ?? 'cit_2';
      return `创建订单后需要保存 checkout_url 和 cregis_id。把 checkout_url 提供给用户，用户就可以跳转到托管收银台完成付款 [${guideMarker}]。`;
    });
    const r = await ask(ctx, {
      question: '支付引擎创建订单后我要保存哪些字段，怎么让用户去付款？',
      context: { current_page_id: 'payment-engine-quickstart-30min' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
    if (r.type === 'answer') {
      assert.ok(r.answer_md.includes('/api/v2/checkout'));
      assert.ok(r.citations.some((c) => c.page_id === 'api-payment-engine-api-post-api-v2-checkout'));
      assert.ok(r.citations.some((c) => c.page_id === 'payment-engine-quickstart-30min'));
    }
  } finally {
    await ctx.cleanup();
  }
});

test('ask: current page context does not constrain product-specific API references', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'waas-setup',
      title: 'WaaS 接入准备',
      body: 'WaaS 项目用于钱包、地址、出款和提币能力。',
    });
    await writePage(root, 'zh', {
      id: 'payment-engine-quickstart-30min',
      title: '支付引擎 30 分钟接入实战',
      body: '创建订单后，保存 cregis_id 和 checkout_url，并将 checkout_url 提供给用户跳转到托管收银台完成支付。',
    });
    await writePage(root, 'zh', {
      id: 'api-payment-engine-api-post-api-v2-checkout',
      title: 'POST /api/v2/checkout — 创建订单',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/checkout. Response fields: checkout_url, cregis_id, order_amount, order_currency.',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS 钱包',
          children: [{ type: 'page', pageId: 'waas-setup' }],
        },
        {
          type: 'section',
          id: 'payment-engine',
          title: '支付引擎',
          children: [{ type: 'page', pageId: 'payment-engine-quickstart-30min' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [{ type: 'page', pageId: 'api-payment-engine-api-post-api-v2-checkout' }],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /POST \/api\/v2\/checkout/);
      const guideMarker = input.userPrompt.match(/\[(cit_\d+)\][^\n]*支付引擎 30 分钟接入实战/)?.[1] ?? 'cit_2';
      return `创建订单后需要保存 checkout_url 和 cregis_id。把 checkout_url 提供给用户跳转到托管收银台付款 [${guideMarker}]。`;
    });
    const r = await ask(ctx, {
      question: '支付引擎创建订单后我要保存哪些字段，怎么让用户去付款？',
      context: { current_page_id: 'waas-setup' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
    if (r.type === 'answer') {
      assert.ok(r.answer_md.includes('/api/v2/checkout'));
      assert.ok(r.citations.some((c) => c.page_id === 'api-payment-engine-api-post-api-v2-checkout'));
    }
  } finally {
    await ctx.cleanup();
  }
});

test('ask: WaaS payout flow defaults API reference context to v1 when no v2 is requested', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'waas-quickstart-30min',
      title: 'WaaS 30 分钟接入实战',
      body: 'WaaS API 出款流程：发起提币后保存 cid，并通过回调 callback 接收结果，也可以查询最终状态。',
    });
    await writePage(root, 'zh', {
      id: 'api-waas-api-post-api-v1-payout',
      title: 'POST /api/v1/payout — 发起钱包提币',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/payout. Response fields: cid.',
    });
    await writePage(root, 'zh', {
      id: 'api-waas-api-post-api-v1-payout-query',
      title: 'POST /api/v1/payout/query — 查询钱包提币信息',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/payout/query. Request field cid. Response fields: status.',
    });
    await writePage(root, 'zh', {
      id: 'api-waas-api-post-api-v2-payout',
      title: 'POST /api/v2/payout — 发起钱包提币（v2）',
      body: 'API reference: WaaS API. HTTP Request POST /api/v2/payout. Response fields: request_id.',
    });
    const decoyApiPages = [
      ['api-waas-api-post-api-v1-coins', 'POST /api/v1/coins — 查询项目支持币种', 'API reference: WaaS API. HTTP Request POST /api/v1/coins.'],
      ['api-waas-api-post-api-v1-collection', 'POST /api/v1/collection — 发起资金归集', 'API reference: WaaS API. HTTP Request POST /api/v1/collection.'],
      ['api-waas-api-post-api-v1-address-create', 'POST /api/v1/address/create — 创建子地址', 'API reference: WaaS API. HTTP Request POST /api/v1/address/create.'],
      ['api-waas-api-post-api-v1-batch-address-create', 'POST /api/v1/batch/address/create — 批量创建子地址', 'API reference: WaaS API. HTTP Request POST /api/v1/batch/address/create.'],
    ] as const;
    for (const [id, title, body] of decoyApiPages) {
      await writePage(root, 'zh', { id, title, body });
    }
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS 钱包',
          children: [{ type: 'page', pageId: 'waas-quickstart-30min' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [
            { type: 'page', pageId: 'api-waas-api-post-api-v1-payout' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-payout-query' },
            { type: 'page', pageId: 'api-waas-api-post-api-v2-payout' },
            ...decoyApiPages.map(([id]) => ({ type: 'page' as const, pageId: id })),
          ],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /POST \/api\/v1\/payout/);
      assert.match(input.userPrompt, /POST \/api\/v1\/payout\/query/);
      assert.doesNotMatch(input.userPrompt, /POST \/api\/v2\/payout/);
      assert.doesNotMatch(input.userPrompt, /POST \/api\/v1\/coins/);
      assert.match(input.userPrompt, /cid/);
      assert.match(input.userPrompt, /callback/);
      assert.match(input.userPrompt, /WaaS API 出款流程/);
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `先调用 /api/v1/payout 保存 cid，再用 /api/v1/payout/query 查询最终状态，回调 callback 也要做幂等 ${markers[0] ?? ''}.`;
    });
    const { result: r } = await askWithTrace(ctx, {
      question: 'WaaS API 出款最小流程是什么？发起后用哪个接口查询最终状态？',
      context: { current_page_id: 'waas-quickstart-30min' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
  } finally {
    await ctx.cleanup();
  }
});

test('ask: sub-address withdrawal questions promote the specific endpoint without generic payout API noise', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', {
      id: 'waas-quickstart-30min',
      title: 'WaaS 30-Minute Quickstart',
      body: 'WaaS payout flow stores third_party_id and callback_url for reconciliation.',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-sub-address-withdrawal',
      title: 'POST /api/v1/sub_address_withdrawal — Create Sub-address Withdrawal',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/sub_address_withdrawal. Request fields: from_address, to_address, amount, currency, third_party_id.',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-payout',
      title: 'POST /api/v1/payout — Create Wallet Payout',
      body: "API reference: WaaS API. HTTP Request POST /api/v1/payout. Initiate payout from the project's default payout wallet. Request fields: address, amount, currency, third_party_id.",
    });
    await writeNav(root, 'en', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS',
          children: [{ type: 'page', pageId: 'waas-quickstart-30min' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API Reference',
          children: [
            { type: 'page', pageId: 'api-waas-api-post-api-v1-sub-address-withdrawal' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-payout' },
          ],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /POST \/api\/v1\/sub_address_withdrawal/);
      assert.match(input.userPrompt, /from_address/);
      assert.match(input.userPrompt, /third_party_id/);
      assert.doesNotMatch(input.userPrompt, /POST \/api\/v1\/payout/);
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `Use /api/v1/sub_address_withdrawal with from_address, to_address, and third_party_id ${markers[0] ?? ''}.`;
    });
    const r = await ask(ctx, {
      question:
        'If I need to withdraw from a specific user deposit address instead of the default payout wallet, which endpoint and fields should I use?',
      context: { current_page_id: 'waas-quickstart-30min' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
  } finally {
    await ctx.cleanup();
  }
});

test('ask: token-network payout questions keep both coins and payout API references in prompt', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', {
      id: 'supported-tokens',
      title: 'Supported Networks & Tokens',
      body: 'Use chain_id and token_id to build the currency identifier for network-specific token requests.',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-coins',
      title: 'POST /api/v1/coins — Query Supported Project Coins',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/coins. Returns chain_id and token_id values for supported project coins.',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-payout',
      title: 'POST /api/v1/payout — Create Wallet Payout',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/payout. Request field currency is formatted as chain_id@token_id, for example 195@195.',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-sub-address-withdrawal',
      title: 'POST /api/v1/sub_address_withdrawal — Create Sub-address Withdrawal',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/sub_address_withdrawal. Request field currency identifies the token.',
    });
    await writeNav(root, 'en', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS',
          children: [{ type: 'page', pageId: 'supported-tokens' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API Reference',
          children: [
            { type: 'page', pageId: 'api-waas-api-post-api-v1-payout' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-sub-address-withdrawal' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-coins' },
          ],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /POST \/api\/v1\/coins/);
      assert.match(input.userPrompt, /POST \/api\/v1\/payout/);
      assert.doesNotMatch(input.userPrompt, /POST \/api\/v1\/sub_address_withdrawal/);
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `Use /api/v1/coins for chain_id/token_id and pass currency to /api/v1/payout as 195@195 ${markers[0] ?? ''}.`;
    });
    const r = await ask(ctx, {
      question:
        'For USDT payouts on Ethereum versus Polygon, what changes in the WaaS payout request and how do I find the right token identifier?',
      context: { current_page_id: 'supported-tokens' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
  } finally {
    await ctx.cleanup();
  }
});

test('ask: token-network payout answers keep required currency format example', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', {
      id: 'supported-tokens',
      title: 'Supported Networks & Tokens',
      body: 'The table below lists supported networks, tokens, chain_id, and token_id values for request parameter mapping.',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-coins',
      title: 'POST /api/v1/coins — Query Supported Project Coins',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/coins. Returns chain_id and token_id values for supported project coins.',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-payout',
      title: 'POST /api/v1/payout — Create Wallet Payout',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/payout. Request field currency is formatted as chain_id@token_id, for example 195@195.',
    });
    await writeNav(root, 'en', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS',
          children: [{ type: 'page', pageId: 'supported-tokens' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API Reference',
          children: [
            { type: 'page', pageId: 'api-waas-api-post-api-v1-payout' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-coins' },
          ],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /195@195/);
      const coinsMarker = input.userPrompt.match(/\[(cit_\d+)\][^\n]*Query Supported Project Coins/)?.[1] ?? 'cit_1';
      return `Use /api/v1/coins to find chain_id/token_id and pass currency to /api/v1/payout as chain_id@token_id [${coinsMarker}].`;
    });
    const r = await ask(ctx, {
      question:
        'For USDT payouts on Ethereum versus Polygon, what changes in the WaaS payout request and how do I find the right token identifier?',
      context: { current_page_id: 'supported-tokens' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
    if (r.type === 'answer') {
      assert.match(r.answer_md, /195@195/);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('ask: same-page ids across languages prefer same-language prompt context', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', {
      id: 'waas-quickstart-30min',
      title: 'WaaS 30-Minute Quickstart',
      body: 'Call /api/v1/payout to submit payout and use third_party_id for idempotency.',
    });
    await writePage(root, 'zh', {
      id: 'waas-quickstart-30min',
      title: 'WaaS 30 分钟接入实战',
      body: '调用 /api/v1/payout 发起出款，third_party_id 用于幂等。',
    });
    await writePage(root, 'en', {
      id: 'api-waas-api-post-api-v1-payout',
      title: 'POST /api/v1/payout — Create Wallet Payout',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/payout. Request field third_party_id.',
    });
    const nav = {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS',
          children: [{ type: 'page', pageId: 'waas-quickstart-30min' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API Reference',
          children: [{ type: 'page', pageId: 'api-waas-api-post-api-v1-payout' }],
        },
      ],
    };
    await writeNav(root, 'en', nav);
    await writeNav(root, 'zh', nav);
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /Call \/api\/v1\/payout to submit payout/);
      assert.doesNotMatch(input.userPrompt, /调用 \/api\/v1\/payout 发起出款/);
      const markers = input.userPrompt.match(/\[cit_\d+\]/g) ?? [];
      return `Use /api/v1/payout and third_party_id ${markers[0] ?? ''}.`;
    });
    const r = await ask(ctx, {
      question: 'How do I submit a WaaS payout and keep it idempotent?',
      context: { current_page_id: 'waas-quickstart-30min' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
  } finally {
    await ctx.cleanup();
  }
});

test('ask: non-API signature questions keep unrelated API reference chunks out of prompt', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'authentication',
      title: '认证与签名',
      body: 'Cregis API 签名规则：将参数按字典序升序排列，sign 字段不参与签名计算，最后追加 API Key 做 MD5。',
    });
    await writePage(root, 'zh', {
      id: 'api-payment-engine-api-post-api-v2-order-info',
      title: 'POST /api/v2/order/info — 查询订单信息',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/order/info. Request field sign is required.',
    });
    await writePage(root, 'zh', {
      id: 'api-waas-api-post-api-v1-payout-query',
      title: 'POST /api/v1/payout/query — 查询提币',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/payout/query. Request field sign is required.',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'get-started',
          title: '快速入门',
          children: [{ type: 'page', pageId: 'authentication' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [
            { type: 'page', pageId: 'api-payment-engine-api-post-api-v2-order-info' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-payout-query' },
          ],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /认证与签名/);
      assert.match(input.userPrompt, /API Key/);
      assert.doesNotMatch(input.userPrompt, /\/api\/v2\/order\/info/);
      assert.doesNotMatch(input.userPrompt, /\/api\/v1\/payout\/query/);
      return '签名时按字典序升序排列参数，排除 sign 字段，最后追加 API Key 做 MD5 [cit_1]。';
    });
    const r = await ask(ctx, {
      question: 'Cregis API 签名应该怎么拼接参数？sign 字段本身要不要参与签名？',
      context: { current_page_id: 'authentication' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
  } finally {
    await ctx.cleanup();
  }
});

test('ask: short signature questions answer from authentication without current-page context', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', {
      id: 'authentication',
      title: '认证与签名',
      body: 'Cregis API 签名规则：将参数按字典序升序排列，sign 字段不参与签名计算，最后追加 API Key 做 MD5。',
    });
    await writePage(root, 'zh', {
      id: 'webhook-mechanism',
      title: 'Webhook 回调机制',
      body: 'Webhook 回调需要验签，并返回 HTTP 200 和 success。',
    });
    await writePage(root, 'zh', {
      id: 'waas-setup',
      title: 'WaaS 接入准备',
      body: 'WaaS API 项目需要准备 API Key、Base URL 和 Project ID。',
    });
    await writePage(root, 'zh', {
      id: 'payment-engine-setup',
      title: '支付引擎接入准备',
      body: '支付引擎项目需要准备 API Key、Base URL 和 Project ID。',
    });
    await writePage(root, 'zh', {
      id: 'api-payment-engine-api-post-api-v2-order-info',
      title: 'POST /api/v2/order/info — 查询订单信息',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/order/info. Request field sign is required.',
    });
    await writePage(root, 'zh', {
      id: 'api-waas-api-post-api-v1-payout-query',
      title: 'POST /api/v1/payout/query — 查询提币',
      body: 'API reference: WaaS API. HTTP Request POST /api/v1/payout/query. Request field sign is required.',
    });
    await writeNav(root, 'zh', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'quickstart',
          title: '快速入门',
          children: [
            { type: 'page', pageId: 'authentication' },
            { type: 'page', pageId: 'webhook-mechanism' },
          ],
        },
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS 钱包',
          children: [{ type: 'page', pageId: 'waas-setup' }],
        },
        {
          type: 'section',
          id: 'payment-engine',
          title: '支付引擎',
          children: [{ type: 'page', pageId: 'payment-engine-setup' }],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API 参考',
          children: [
            { type: 'page', pageId: 'api-payment-engine-api-post-api-v2-order-info' },
            { type: 'page', pageId: 'api-waas-api-post-api-v1-payout-query' },
          ],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /认证与签名/);
      assert.match(input.userPrompt, /字典序升序排列/);
      assert.doesNotMatch(input.userPrompt, /\/api\/v2\/order\/info/);
      assert.doesNotMatch(input.userPrompt, /\/api\/v1\/payout\/query/);
      return 'Cregis API 签名参数需要按字典序升序排列，排除 sign 字段，最后追加 API Key 做 MD5 [cit_1]。';
    });
    const { result: r, trace } = await askWithTrace(ctx, {
      question: 'Cregis API 签名应该怎么拼接参数？',
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
    assert.equal(trace.subtree_ask_triggered, false);
  } finally {
    await ctx.cleanup();
  }
});

test('ask: English crypto order questions promote checkout API reference snippets', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', {
      id: 'supported-currencies',
      title: 'Supported Currencies',
      body: 'Order currencies: crypto can be used directly as the order currency. Set order_currency to USDT and order_amount to the crypto amount. CoinMarketCap conversion is not needed when the amount is already denominated in crypto.',
    });
    await writePage(root, 'en', {
      id: 'introduction',
      title: 'Platform Overview',
      body: 'Platform overview content says Payment Engine is for checkout, and WaaS projects are for payout and withdrawal operations.',
    });
    await writePage(root, 'en', {
      id: 'payment-engine-setup',
      title: 'Payment Engine Integration Setup',
      body: 'Setup content says if your integration includes API payouts or withdrawals, also create a WaaS API project.',
    });
    for (let i = 0; i < 10; i++) {
      await writePage(root, 'en', {
        id: `payment-engine-guide-${i}`,
        title: `Payment Engine Guide ${i}`,
        body: 'Payment Engine guide content about callbacks, checkout, order status, and common troubleshooting.',
      });
    }
    await writePage(root, 'en', {
      id: 'api-payment-engine-api-post-api-v2-checkout',
      title: 'POST /api/v2/checkout — Create Order',
      body: 'API reference: Payment Engine API. HTTP Request POST /api/v2/checkout. Request fields: order_currency, order_amount, tokens.',
    });
    await writeNav(root, 'en', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'payment-engine',
          title: 'Payment Engine',
          children: [
            { type: 'page', pageId: 'supported-currencies' },
            { type: 'page', pageId: 'introduction' },
            { type: 'page', pageId: 'payment-engine-setup' },
            ...Array.from({ length: 10 }, (_, i) => ({ type: 'page' as const, pageId: `payment-engine-guide-${i}` })),
          ],
        },
        {
          type: 'section',
          id: 'api-reference',
          title: 'API Reference',
          children: [{ type: 'page', pageId: 'api-payment-engine-api-post-api-v2-checkout' }],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.systemPrompt, /API reference/);
      assert.match(input.userPrompt, /POST \/api\/v2\/checkout/);
      assert.match(input.userPrompt, /order_currency/);
      assert.match(input.userPrompt, /order_amount/);
      assert.doesNotMatch(input.userPrompt, /also create a WaaS API project/);
      assert.doesNotMatch(input.userPrompt, /WaaS projects are for payout/);
      const apiMarker = input.userPrompt.match(/\[(cit_\d+)\][^\n]*Create Order/)?.[1] ?? 'cit_1';
      return `Yes. Set order_currency to USDT and order_amount to the crypto amount when calling /api/v2/checkout [${apiMarker}].`;
    });
    const r = await ask(ctx, {
      question: 'Can I create a Payment Engine order directly in USDT if my system already calculated the FX price?',
      context: { current_page_id: 'supported-currencies' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
    if (r.type === 'answer') {
      assert.ok(r.citations.some((c) => c.page_id === 'api-payment-engine-api-post-api-v2-checkout'));
    }
  } finally {
    await ctx.cleanup();
  }
});

test('ask: project setup questions avoid quickstart citations when setup pages answer directly', async () => {
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'en', {
      id: 'payment-engine-setup',
      title: 'Payment Engine Integration Setup',
      body: 'A Payment Engine project is mainly used for collections, orders, checkout, and payment callbacks. If your integration also includes API payouts, withdrawals, addresses, or wallet operations, create a WaaS API project and retrieve its API Key and project parameters as well.',
    });
    await writePage(root, 'en', {
      id: 'waas-setup',
      title: 'WaaS Wallet Integration Setup',
      body: 'Create a WaaS API project for payout, withdrawal, address, and wallet operations.',
    });
    await writePage(root, 'en', {
      id: 'payment-engine-quickstart-30min',
      title: 'Payment Engine 30-Minute Quickstart',
      body: 'Quickstart callback_url setup for Payment Engine orders and checkout flow.',
    });
    await writeNav(root, 'en', {
      version: 1,
      items: [
        {
          type: 'section',
          id: 'payment-engine',
          title: 'Payment Engine',
          children: [
            { type: 'page', pageId: 'payment-engine-setup' },
            { type: 'page', pageId: 'payment-engine-quickstart-30min' },
          ],
        },
        {
          type: 'section',
          id: 'waas',
          title: 'WaaS',
          children: [{ type: 'page', pageId: 'waas-setup' }],
        },
      ],
    });
  });
  try {
    ctx.llm.setResponder((input) => {
      assert.match(input.userPrompt, /Payment Engine Integration Setup/);
      assert.match(input.userPrompt, /WaaS Wallet Integration Setup/);
      assert.doesNotMatch(input.userPrompt, /Payment Engine 30-Minute Quickstart/);
      return 'Use Payment Engine for orders and checkout, and also create a WaaS API project for payout or withdrawals [cit_1].';
    });
    const r = await ask(ctx, {
      question: 'For API payout or withdrawals, do I only need a Payment Engine project, or should I also create a WaaS API project?',
      context: { current_page_id: 'payment-engine-setup' },
    });
    assert.equal(r.type, 'answer', JSON.stringify(r));
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
// Automatic clarify is disabled: split intent still answers.
// ---------------------------------------------------------------------------

test('ask: split intent across two zh subtrees answers instead of auto-clarifying', async () => {
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
    assert.equal(r.type, 'answer', `expected answer, got ${JSON.stringify(r)}`);
    if (r.type === 'answer') {
      assert.equal(r.answer_lang, 'zh');
      assert.ok(r.citations.some((citation) => citation.page_id === 'frontend-auth'));
      assert.ok(r.citations.some((citation) => citation.page_id === 'backend-auth'));
      assert.equal(ctx.llm.calls.length, 1, 'answer path should call the LLM');
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

// ---------------------------------------------------------------------------
// RFC 0003 M1 — multi-turn history-aware retrieve query
// ---------------------------------------------------------------------------

test('ask: context.history splices prior questions into the retrieve-time embedding (separate from γ vector)', async () => {
  // Multi-turn path: server layer pulls last N prior turns from the session
  // table and stuffs them into `context.history`. The query pipeline now
  // runs TWO embeds per ask:
  //   1. Raw current_q — what γ similarity comparison uses across turns.
  //   2. History-augmented input — what feeds the vector retrieve path.
  // Splitting them was forced by the alpha.1 default flip: identical
  // questions across turns must still cosine-1.0 each other on the γ side
  // even though history makes their retrieve-time inputs differ.
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: '配置', body: '系统配置说明。' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    await ask(ctx, {
      question: '它怎么改？',
      context: {
        history: [
          { question: '什么是配置？', answer_summary: '配置是 ...' },
          { question: '配置在哪里？', answer_summary: '在 anydocs.json' },
        ],
      },
    });
    // Both inputs must have hit the embedder, in either order. Use
    // allEmbeddedTexts so we see across calls.
    assert.ok(
      ctx.embedder.allEmbeddedTexts.includes('它怎么改？'),
      'raw current_q must be embedded for γ',
    );
    assert.ok(
      ctx.embedder.allEmbeddedTexts.includes(
        '什么是配置？\n配置在哪里？\n它怎么改？',
      ),
      'history-augmented input must be embedded for retrieve',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('ask: missing / empty history → ONE embed call on the raw question (single-turn byte-equivalent)', async () => {
  // The default single-turn path must be untouched: when callers omit
  // `history` OR pass an empty array, exactly one embed call goes out with
  // the raw question — alpha.0 byte-equivalent.
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: '配置', body: '系统配置说明。' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    // (a) No context at all.
    const beforeA = ctx.embedder.calls;
    await ask(ctx, { question: '怎么配置？' });
    assert.equal(ctx.embedder.calls - beforeA, 1, 'single-turn should call embed exactly once');
    assert.equal(ctx.embedder.lastEmbeddedTexts[0], '怎么配置？');

    // (b) Explicit empty history array — same path, same single-call.
    const beforeB = ctx.embedder.calls;
    await ask(ctx, { question: '怎么配置？', context: { history: [] } });
    assert.equal(ctx.embedder.calls - beforeB, 1);
    assert.equal(ctx.embedder.lastEmbeddedTexts[0], '怎么配置？');

    // (c) Other context fields without history — also untouched.
    const beforeC = ctx.embedder.calls;
    await ask(ctx, {
      question: '怎么配置？',
      context: { current_page_id: 'a' },
    });
    assert.equal(ctx.embedder.calls - beforeC, 1);
    assert.equal(ctx.embedder.lastEmbeddedTexts[0], '怎么配置？');
  } finally {
    await ctx.cleanup();
  }
});

test('ask: history populated → result.history_window = entry count + trace mirrors', async () => {
  // RFC 0003 M4 — the result body advertises how many turns this call ate
  // so Studio + trace consumers don't need to re-derive from session_id.
  // Trace mirrors the same number for runs.jsonl analyze paths.
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: '配置', body: '系统配置说明。' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    const { askWithTrace } = await import('../src/query/answer.ts');
    const out = await askWithTrace(ctx, {
      question: '它怎么改？',
      context: {
        history: [
          { question: '什么是配置？', answer_summary: 'A1' },
          { question: '配置在哪里？', answer_summary: 'A2' },
        ],
      },
    });
    // History was 2 turns; result body + trace must both expose 2.
    const hw =
      out.result.type === 'answer' || out.result.type === 'clarify'
        ? out.result.history_window
        : undefined;
    assert.equal(hw, 2, `result.history_window should be 2, got ${hw}`);
    assert.equal(out.trace.history_window, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('ask: empty history → history_window field absent on result + trace', async () => {
  // Backward-compat invariant: single-turn calls must not gain a
  // history_window=0 field. Absent vs. 0 matters for runs.jsonl filters
  // and Studio multi-turn vs. single-turn grouping.
  const ctx = await bootstrap(async (root) => {
    await writePage(root, 'zh', { id: 'a', title: '配置', body: '系统配置说明。' });
    await writeNav(root, 'zh', { version: 1, items: [{ type: 'page', pageId: 'a' }] });
  });
  try {
    const { askWithTrace } = await import('../src/query/answer.ts');
    const out = await askWithTrace(ctx, { question: '怎么配置？' });
    if (out.result.type === 'answer' || out.result.type === 'clarify') {
      assert.equal(
        out.result.history_window,
        undefined,
        'single-turn result must not carry history_window',
      );
    }
    assert.equal(out.trace.history_window, undefined);
  } finally {
    await ctx.cleanup();
  }
});
