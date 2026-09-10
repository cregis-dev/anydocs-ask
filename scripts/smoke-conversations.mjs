// Isolated preview and browser smoke test. Never writes to real project logs.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { createConsoleApp } from '../dist/console/server.js';
import { ProcessRegistry } from '../dist/console/registry.js';
import { addToProjectRegistry, ensureStateRoot } from '../dist/workspace.js';
import { RunsWriter } from '../dist/runs/writer.js';
import { createInputCapture } from '../dist/runs/input-snapshot.js';

const workspace = mkdtempSync(join(tmpdir(), 'ask-conversation-preview-'));
const name = 'conversation-preview';
const project = join(workspace, 'project');
for (const dir of ['pages', 'navigation']) mkdirSync(join(project, dir), { recursive: true });
writeFileSync(join(project, 'anydocs.config.json'), JSON.stringify({ version: 1, projectId: name }));
addToProjectRegistry(workspace, project, name);
const root = ensureStateRoot(workspace, name);
function append(index, session, query, md, age = index * 1000, kind = 'answer') {
  const date = new Date(Date.now() - age);
  let snapshot;
  if (index === 1) {
    const capture = createInputCapture({ question: query, prompt_question: query,
      search_question: '历史交易 fee 字段定义', retrieve_question: '历史交易 fee 字段定义', current_page: 'reference/team-api/history',
      history: [{ question: '查询交易记录，是否包含矿工费？', answer_summary: '预览摘要：历史交易记录中有 fee 字段。' }],
      documents: [{ citation_id: 'cit_1', chunk_id: 1, page_id: 'reference/team-api/history', title: '查询钱包历史交易记录', lang: 'zh', url: null, path: 'response/rows', parent_id: null, text: '预览文档正文：data.rows[].fee 是字符串类型的矿工费字段。此段仅用于界面验证。' }],
    });
    const attempt = capture.addAttempt({ systemPrompt: 'Preview system prompt: answer only from supplied documentation.', userPrompt: 'Preview actual input: history summary + question + cit_1 document.' });
    attempt.outcome = 'returned'; attempt.accepted = true; attempt.model = 'preview-fixture';
    snapshot = capture.snapshot;
  }
  new RunsWriter({ stateRoot: root, enabled: true, now: () => date }).append({
    request_id: `preview-${index}`, session_id: session, query, ts: date.toISOString(), source: 'reader',
    filters: {}, context_pageId: 'reference/team-api/history',
    retrieval: { fused: [], subtree_ask_triggered: false },
    answer: { kind, answer_id: null, md, citations: [], latency_ms: 3400, tokens_in: null, tokens_out: null, model: 'preview-fixture', error_code: kind === 'error' ? 'timeout' : null, history_window: index === 1 ? 1 : 0 },
    feedback: { beta: null, gamma: null },
    ...(snapshot ? { input_snapshot: snapshot, input_snapshot_status: 'captured' } : {}),
  });
}
append(0, 'session-fee', '查询交易记录，是否包含矿工费？', '预览数据：历史交易响应中的 `data.rows[].fee` 是矿工费字段。', 9 * 86400000);
append(1, 'session-fee', '返回的参数 fee 是以什么计算的呢？', '这是用于界面验证的示例回答，不代表实际 API 规则。\n\n- 请核对目标接口和币种。\n- 每轮的诊断数据保留在 Run detail。');
append(2, 'session-status', 'What does pending signature mean?', 'Preview answer: check the matching withdrawal documentation.', 4000);
append(3, 'session-status', 'And how long does it take?', 'Preview answer: no processing duration has been verified.', 3000);
append(4, null, 'Legacy run without a session ID', null, 5000, 'error');
for (let i = 5; i < 34; i++) append(i, `session-${i}`, `API integration question ${i}`, 'Preview answer.');
for (let i = 100; i < 154; i++) append(i, 'long-session', `Long conversation turn ${i - 99}`, `Saved response ${i - 99}`, (200 - i) * 1000);

const registry = new ProcessRegistry({ workspacePath: workspace, spawner: () => { throw new Error('Preview cannot start Ask'); }, healthProbe: async () => false,
  config: { childPortRangeStart: 4201, childPortRangeEnd: 4299, idleTimeoutMin: 15, healthTimeoutMs: 10 } });
const app = createConsoleApp({ workspacePath: workspace, consolePort: 4100, registry });
const serveOnly = process.argv.includes('--serve');
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: serveOnly ? Number(process.env.PORT ?? 4100) : 0 });
await new Promise((done) => server.listening ? done() : server.once('listening', done));
const url = `http://127.0.0.1:${server.address().port}/p/${name}?traffic_range=7#traffic`;
console.log(url);
const cleanup = () => { server.close(); rmSync(workspace, { recursive: true, force: true }); };
if (serveOnly) {
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
} else {
  let browser;
  try {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button', { name: /返回的参数 fee/ }).click();
    await page.getByText('2 saved runs · All dates').waitFor();
    await page.locator('.tc-user').filter({ hasText: '是否包含矿工费' }).waitFor();
    assert.equal(await page.locator('.tc-turn').count(), 2);
    await page.locator('.tc-turn').nth(0).locator('.rc-context > summary').click();
    await page.getByText('Input snapshot was not saved for this run.').waitFor();
    await page.locator('.tc-turn').nth(1).locator('.rc-context > summary').click();
    await page.getByText('预览摘要：历史交易记录中有 fee 字段。', { exact: true }).waitFor();
    await page.locator('.tc-turn').nth(1).locator('.rc-document > summary').click();
    await page.getByText(/预览文档正文：data.rows/).waitFor();
    const screenshots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), 'ask-conversations-screenshots'));
    mkdirSync(screenshots, { recursive: true });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true });
    await page.locator('.tc-transcript').evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
    await page.waitForFunction(() => { const el = document.querySelector('.tc-transcript'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2; });
    await page.screenshot({ path: join(screenshots, 'desktop-context.png'), fullPage: true });
    await page.getByRole('link', { name: 'Run detail for turn 2' }).click();
    await page.getByRole('heading', { name: 'Run detail', exact: true }).waitFor();
    await page.locator('.rc-context > summary').click();
    await page.getByText('Attempt 1', { exact: true }).click();
    await page.getByText('Preview actual input: history summary + question + cit_1 document.', { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, 'run-input.png'), fullPage: true });
    await page.getByRole('link', { name: 'Traffic', exact: true }).click();
    await page.getByText('2 saved runs · All dates').waitFor();
    await page.getByRole('textbox', { name: 'Search conversations' }).fill('pending signature');
    assert.equal(await page.locator('.tc-item').count(), 1);
    await page.locator('.tc-item').click();
    await page.getByText('2 saved runs · All dates').waitFor();
    await page.getByRole('textbox', { name: 'Search conversations' }).fill('not-present-anywhere');
    await page.getByText('No matching conversations').waitFor();
    await page.getByRole('textbox', { name: 'Search conversations' }).fill('');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    assert.equal(await page.locator('.tc-item').count(), 8);
    await page.getByRole('button', { name: /Long conversation turn/ }).click();
    await page.getByText('54 saved runs · All dates').waitFor();
    assert.equal(await page.locator('.tc-turn').count(), 50);
    await page.getByRole('button', { name: 'Load more turns' }).click();
    await page.getByText('54 loaded').waitFor();
    assert.equal(await page.locator('.tc-turn').count(), 54);
    await page.goto(url);
    await page.getByRole('button', { name: /返回的参数 fee/ }).click();
    await page.getByText('2 saved runs · All dates').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.tc-turn').nth(1).locator('.rc-context > summary').click();
    await page.getByText('预览摘要：历史交易记录中有 fee 字段。', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.ca-sidebar').getBoundingClientRect().right <= 1);
    assert.equal(await page.locator('.tc-list').isVisible(), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(screenshots, 'mobile-conversation.png'), fullPage: true });
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    assert.equal(await page.locator('.tc-list').isVisible(), true);
    await page.screenshot({ path: join(screenshots, 'mobile-list.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`Browser checks passed; screenshots: ${screenshots}`);
  } finally { await browser?.close(); cleanup(); }
}
