/**
 * Tests for the page → chunks pipeline. Uses real DocContentV1 shapes via
 * the starter-docs fixture (which exercises heading + paragraph + list +
 * codeBlock blocks).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPage } from '../src/content/chunk.ts';
import { contentHash } from '../src/content/normalize.ts';
import { loadProject } from '../src/anydocs/loader.ts';
import { fileURLToPath } from 'node:url';
import type { PageDoc } from '../src/anydocs/types.ts';

const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/starter-docs/', import.meta.url));

test('chunkPage: starter-docs welcome page produces ≥1 chunk per heading section', async () => {
  const proj = await loadProject(FIXTURES_ROOT);
  const zhWelcome = proj.pagesByLangAndId.get('zh')!.get('welcome')!;
  const chunks = chunkPage(zhWelcome);

  assert.ok(chunks.length >= 4, `expected at least 4 chunks for welcome.json, got ${chunks.length}`);
  for (const c of chunks) {
    assert.equal(c.page_id, 'welcome');
    assert.equal(c.lang, 'zh');
    assert.ok(c.text.length > 0);
    assert.equal(c.content_hash, contentHash(c.text));
    assert.ok(c.token_count >= 1);
    assert.match(c.in_page_path, /p\[\d+\]$/);
  }
});

test('chunkPage: code block inside section stays inside the section text', async () => {
  const proj = await loadProject(FIXTURES_ROOT);
  const zhWelcome = proj.pagesByLangAndId.get('zh')!.get('welcome')!;
  const chunks = chunkPage(zhWelcome);
  // welcome.json has a "如何运行" section with a bash codeBlock — it should
  // appear inside the chunk for that section, not as its own chunk.
  const runChunk = chunks.find((c) => c.heading_path.includes('如何运行'));
  assert.ok(runChunk, 'expected a chunk for 如何运行 heading');
  assert.match(
    runChunk!.text,
    /node --experimental-strip-types/,
    `code identifier missing from chunk text: ${runChunk!.text.slice(0, 200)}`,
  );
});

test('chunkPage: deterministic — same PageDoc produces same content_hashes', async () => {
  const proj = await loadProject(FIXTURES_ROOT);
  const page = proj.pagesByLangAndId.get('zh')!.get('welcome')!;
  const a = chunkPage(page).map((c) => c.content_hash);
  const b = chunkPage(page).map((c) => c.content_hash);
  assert.deepEqual(a, b);
});

test('chunkPage: empty content yields zero chunks', () => {
  const empty: PageDoc = {
    id: 'p',
    lang: 'zh',
    slug: 'p',
    title: 'P',
    status: 'published',
    content: { version: 1, blocks: [] },
  };
  assert.deepEqual(chunkPage(empty), []);
});

test('chunkPage: table chunks preserve complete rows and repeat structural context', () => {
  const target = '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3';
  const rows = Array.from({ length: 12 }, (_, index) => {
    const contract = index === 7 ? target : `token-${index}`;
    return `| opBNB | USDT-${index} | 67 | ${contract} | 18 |`;
  });
  const page: PageDoc = {
    id: 'waas-supported-tokens',
    lang: 'zh',
    slug: 'waas-supported-tokens',
    title: '支持的网络与代币',
    status: 'published',
    content: { version: 1, blocks: [] },
    render: {
      markdown: [
        '# 支持的网络与代币',
        '',
        '## 支持列表',
        '',
        '| 网络 | 代币 | chain_id | token_id | 精度 |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n'),
    },
  };

  const chunks = chunkPage(page, { maxChars: 420 });
  assert.ok(chunks.length > 1, 'long table should span multiple chunks');
  for (const chunk of chunks) {
    assert.match(chunk.text, /^Page: 支持的网络与代币\nSection: 支持列表/m);
    assert.match(chunk.text, /Columns: 网络 \| 代币 \| chain_id \| token_id \| 精度/);
    for (const line of chunk.text.split('\n').filter((line) => line.startsWith('- '))) {
      assert.match(line, /^- 网络: .+ \| 代币: .+ \| chain_id: .+ \| token_id: .+ \| 精度: .+$/);
    }
  }
  const targetChunk = chunks.find((chunk) => chunk.text.includes(target));
  assert.ok(targetChunk, 'the exact contract address must survive chunking');
  assert.match(
    targetChunk!.text,
    new RegExp(`网络: opBNB \\| 代币: USDT-7 \\| chain_id: 67 \\| token_id: ${target} \\| 精度: 18`),
  );
});

test('chunkPage: long prose continuations repeat page and section context', () => {
  const page: PageDoc = {
    id: 'long-guide',
    lang: 'en',
    slug: 'long-guide',
    title: 'Long Guide',
    status: 'published',
    content: { version: 1, blocks: [] },
    render: {
      markdown: `# Long Guide\n\n## Authentication\n\n${'signature parameter timestamp nonce '.repeat(45)}`,
    },
  };

  const chunks = chunkPage(page, { maxChars: 360 });
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.match(chunk.text, /^Page: Long Guide\nSection: Authentication\n/);
  }
});
