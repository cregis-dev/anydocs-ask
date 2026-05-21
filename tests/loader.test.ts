/**
 * loadProject: anydocs.config.json#defaultLanguage propagation.
 *
 * Covers the read path added for golden-generator lang-bias fix (dogfood
 * 2026-05-14 F2). loadProject is otherwise covered transitively by the
 * structure / embedding / indexer tests using the fixtures root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/anydocs/loader.ts';
import { chunkPage } from '../src/content/chunk.ts';

async function makeProjectDir(args: {
  config?: string | null;
  nav?: boolean;
}): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-loader-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  if (args.nav !== false) {
    await fs.writeFile(
      join(root, 'navigation', 'zh.json'),
      JSON.stringify({ version: 1, items: [{ type: 'page', pageId: 'p1' }] }),
    );
    await fs.writeFile(
      join(root, 'pages', 'zh', 'p1.json'),
      JSON.stringify({
        id: 'p1', lang: 'zh', slug: 'p1', title: '页面', status: 'published',
        content: { version: 1, blocks: [] },
      }),
    );
  }
  if (args.config !== null && args.config !== undefined) {
    await fs.writeFile(join(root, 'anydocs.config.json'), args.config);
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('loader: defaultLanguage="zh" in anydocs.config.json surfaces on LoadedProject', async () => {
  const { root, cleanup } = await makeProjectDir({
    config: JSON.stringify({ projectId: 'demo', defaultLanguage: 'zh' }),
  });
  try {
    const proj = await loadProject(root);
    assert.equal(proj.defaultLanguage, 'zh');
  } finally {
    await cleanup();
  }
});

test('loader: defaultLanguage missing from config → null, no warning', async () => {
  const { root, cleanup } = await makeProjectDir({
    config: JSON.stringify({ projectId: 'demo' }),
  });
  try {
    const proj = await loadProject(root);
    assert.equal(proj.defaultLanguage, null);
    assert.deepEqual(
      proj.warnings.filter((w) => w.includes('defaultLanguage')),
      [],
    );
  } finally {
    await cleanup();
  }
});

test('loader: defaultLanguage="fr" (not a DocsLang) → null + a single warning', async () => {
  const { root, cleanup } = await makeProjectDir({
    config: JSON.stringify({ projectId: 'demo', defaultLanguage: 'fr' }),
  });
  try {
    const proj = await loadProject(root);
    assert.equal(proj.defaultLanguage, null);
    const warns = proj.warnings.filter((w) => w.includes('defaultLanguage'));
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /"fr"/);
  } finally {
    await cleanup();
  }
});

test('loader: anydocs.config.json absent → null, no warning, no throw', async () => {
  // Test fixtures and unit-test scratch dirs do not always include a config
  // file — loadProject must remain lenient on this.
  const { root, cleanup } = await makeProjectDir({ config: null });
  try {
    const proj = await loadProject(root);
    assert.equal(proj.defaultLanguage, null);
    assert.deepEqual(
      proj.warnings.filter((w) => w.includes('anydocs.config.json')),
      [],
    );
  } finally {
    await cleanup();
  }
});

test('loader: malformed anydocs.config.json → null + warning, project still loads', async () => {
  const { root, cleanup } = await makeProjectDir({ config: '{ not valid json' });
  try {
    const proj = await loadProject(root);
    assert.equal(proj.defaultLanguage, null);
    assert.ok(
      proj.warnings.some((w) => w.includes('anydocs.config.json') && w.includes('parse')),
    );
    // navigation + page still loaded — config parse failure is non-fatal
    assert.equal(proj.pagesByLangAndId.get('zh')?.size, 1);
  } finally {
    await cleanup();
  }
});

test('loader: OpenAPI descriptors become synthetic API reference pages', async () => {
  const { root, cleanup } = await makeProjectDir({
    config: JSON.stringify({ projectId: 'demo', defaultLanguage: 'zh' }),
  });
  try {
    await fs.mkdir(join(root, 'api-sources', 'specs'), { recursive: true });
    await fs.writeFile(
      join(root, 'api-sources', 'payment-api.json'),
      JSON.stringify({
        id: 'payment-api',
        type: 'openapi',
        lang: 'zh',
        status: 'published',
        source: { kind: 'file', path: 'api-sources/specs/payment-api.json' },
        display: { title: 'Payment API', groupId: 'payment-engine' },
        runtime: { routeBase: '/zh/reference/payment-api' },
      }),
    );
    await fs.writeFile(
      join(root, 'api-sources', 'specs', 'payment-api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Payment API' },
        paths: {
          '/api/v2/checkout': {
            post: {
              summary: '创建订单',
              description: '创建订单后返回 cregis_id 和 checkout_url。频率限制：1000 次/分钟。',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['pid', 'order_currency'],
                      properties: {
                        pid: { type: 'integer', description: '支付引擎项目 ID' },
                        order_currency: {
                          type: 'string',
                          description: '订单货币，支持 USDT、BTC 等加密货币代码',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    const proj = await loadProject(root);
    const apiPage = proj.pagesByLangAndId.get('zh')?.get('api-payment-api-post-api-v2-checkout');
    assert.ok(apiPage, 'OpenAPI operation should be loaded as a synthetic page');
    assert.equal(apiPage.title, 'POST /api/v2/checkout — 创建订单');
    assert.equal(apiPage.slug, 'reference/payment-api/post-api-v2-checkout');

    const chunks = chunkPage(apiPage);
    const text = chunks.map((c) => c.text).join('\n');
    assert.match(text, /POST \/api\/v2\/checkout/);
    assert.match(text, /order_currency/);
    assert.match(text, /USDT/);
    assert.match(text, /1000 次\/分钟/);
  } finally {
    await cleanup();
  }
});
