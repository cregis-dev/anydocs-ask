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
import { loadIndexSnapshot } from '../src/console/index-state.ts';
import { projectStructure } from '../src/structure/project.ts';

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
    await fs.writeFile(
      join(root, 'navigation', 'zh.json'),
      JSON.stringify({
        version: 1,
        items: [{
          type: 'section',
          id: 'payment-engine',
          title: '支付引擎',
          children: [
            { type: 'page', pageId: 'p1' },
            { type: 'link', title: '支付引擎 API 参考', href: '/zh/reference/payment-api/' },
          ],
        }],
      }),
    );
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
              operationId: 'createOrder',
              summary: '创建订单',
              description: '创建订单后返回 cregis_id 和 checkout_url。频率限制：1000 次/分钟。',
              parameters: [{ $ref: '#/components/parameters/AccessKeyHeader' }],
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
                          enum: ['USDT', 'BTC'],
                          maxLength: 10,
                          description: '订单货币，支持 USDT、BTC 等加密货币代码',
                        },
                      },
                    },
                  },
                },
              },
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        allOf: [
                          { $ref: '#/components/schemas/StandardResponse' },
                          {
                            type: 'object',
                            required: ['data'],
                            properties: {
                              data: { $ref: '#/components/schemas/PagedData' },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          parameters: {
            AccessKeyHeader: {
              name: 'Access-Key',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'API Key identifier',
            },
          },
          schemas: {
            StandardResponse: {
              type: 'object',
              required: ['code', 'msg'],
              properties: {
                code: { type: 'string', example: '00000' },
                msg: { type: 'string', example: 'ok' },
              },
            },
            PagedData: {
              type: 'object',
              required: ['page_num', 'rows'],
              properties: {
                page_num: { type: 'integer', format: 'int32' },
                rows: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Transaction' },
                },
              },
            },
            Transaction: {
              type: 'object',
              required: ['status'],
              properties: {
                status: { type: 'integer', format: 'int32', enum: [1, 2], description: '交易状态' },
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
    assert.equal(apiPage.slug, 'reference/payment-api/createOrder');

    const paymentSection = proj.navigationsByLang.get('zh')?.items[0];
    assert.equal(paymentSection?.type, 'section');
    if (paymentSection?.type === 'section') {
      const apiFolder = paymentSection.children[1];
      assert.deepEqual(apiFolder, {
        type: 'folder',
        id: 'api-reference:payment-engine',
        title: 'API 参考',
        children: [{ type: 'page', pageId: apiPage.id }],
      });
    }

    const structure = projectStructure(proj);
    const apiRow = structure.rows.find((row) => row.page_id === apiPage.id);
    assert.ok(apiRow);
    assert.equal(apiRow.subtree_root, 'payment-engine');
    assert.equal(apiRow.parent_id, 'api-reference:payment-engine');
    assert.notEqual(apiRow.nav_index, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(
      JSON.parse(apiRow.breadcrumb).map((item: { title: string }) => item.title),
      ['支付引擎', 'API 参考', apiPage.title],
    );
    assert.equal(
      structure.warnings.some((warning) => warning.includes(apiPage.id) && warning.includes('orphan')),
      false,
    );

    const snapshot = await loadIndexSnapshot(root);
    const zhSummary = snapshot.langs.find((entry) => entry.lang === 'zh');
    assert.ok(zhSummary?.pages.some((page) => page.id === apiPage.id));
    assert.equal(zhSummary?.orphans.some((page) => page.id === apiPage.id), false);

    const chunks = chunkPage(apiPage);
    const text = chunks.map((c) => c.text).join('\n');
    assert.match(text, /POST \/api\/v2\/checkout/);
    assert.match(text, /order_currency/);
    assert.match(text, /USDT/);
    assert.match(text, /1000 次\/分钟/);
    assert.match(text, /data\.page_num/);
    assert.match(text, /data\.rows\[\]\.status/);
    assert.match(text, /Access-Key \(header\).*required/);
    assert.match(text, /Section: Request Headers/);
    assert.match(text, /enum=USDT, BTC; maxLength=10/);
    assert.match(text, /Response Object: data\.rows\[\]/);
    assert.match(text, /Response Example:/);
  } finally {
    await cleanup();
  }
});

test('loader: OpenAPI groupId falls back to the route group for team-api navigation', async () => {
  const { root, cleanup } = await makeProjectDir({ config: null });
  try {
    await fs.writeFile(
      join(root, 'navigation', 'zh.json'),
      JSON.stringify({
        version: 1,
        items: [{
          type: 'section',
          id: 'team-api',
          title: '团队 API',
          children: [
            { type: 'page', pageId: 'p1' },
            { type: 'link', title: '团队 API 参考', href: '/zh/reference/team-api/' },
          ],
        }],
      }),
    );
    await fs.mkdir(join(root, 'api-sources', 'specs'), { recursive: true });
    await fs.writeFile(
      join(root, 'api-sources', 'team-api.json'),
      JSON.stringify({
        id: 'team-api',
        type: 'openapi',
        lang: 'zh',
        status: 'published',
        source: { kind: 'file', path: 'api-sources/specs/team-api.json' },
        display: { title: 'Cregis 团队 API', groupId: 'team' },
        runtime: { routeBase: '/zh/reference/team-api' },
      }),
    );
    await fs.writeFile(
      join(root, 'api-sources', 'specs', 'team-api.json'),
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Cregis 团队 API' },
        paths: { '/openapi/v1/wallets': { post: { summary: '列出团队钱包' } } },
      }),
    );

    const proj = await loadProject(root);
    const structure = projectStructure(proj);
    const apiRow = structure.rows.find(
      (row) => row.page_id === 'api-team-api-post-openapi-v1-wallets',
    );
    assert.ok(apiRow);
    assert.equal(apiRow.subtree_root, 'team-api');
    assert.equal(apiRow.parent_id, 'api-reference:team');
  } finally {
    await cleanup();
  }
});
