/**
 * /v1/ask/stream SSE integration tests.
 *
 * These mirror the existing /v1/ask server coverage, but assert the streaming
 * protocol shape that the Reader UI consumes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { Runtime } from '../src/server/runtime.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/index.ts';
import { MockEmbedder } from '../src/embedding/mock.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { LLM, LLMGenerateInput, LLMGenerateOutput, LLMStreamOptions } from '../src/llm/types.ts';
import type { AskResult } from '../src/query/types.ts';
import type { RunRecord } from '../src/runs/types.ts';

type SseEvent = {
  event: string;
  data: unknown;
};

async function buildProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-stream-'));
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

async function setup(opts: { runsEnabled?: boolean; llm?: LLM } = {}): Promise<{
  runtime: Runtime;
  cleanup: () => Promise<void>;
  stateRoot: string;
}> {
  const { root, cleanup: rmTmp } = await buildProject();
  const stateRoot = await fs.mkdtemp(join(tmpdir(), 'anydocs-ask-stream-state-'));
  const { config } = await loadConfig(root);
  config.runs.enabled = opts.runsEnabled ?? true;
  const db = openDatabase({ dbPath: ':memory:' });
  const runtime = new Runtime({
    projectRoot: root,
    stateRoot,
    config,
    db,
    embedder: new MockEmbedder(),
    llm: opts.llm ?? new MockLLM({ model: 'mock-llm' }),
    skipWatcher: true,
  });
  await runtime.start();
  return {
    runtime,
    stateRoot,
    cleanup: async () => {
      await runtime.stop();
      await rmTmp();
      await fs.rm(stateRoot, { recursive: true, force: true });
    },
  };
}

class SlowFirstDeltaLLM implements LLM {
  readonly model = 'slow-llm';
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async generate(_input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    return { text: 'Based on the documentation: [cit_1]', modelUsed: this.model };
  }

  async streamGenerate(
    input: LLMGenerateInput,
    options: LLMStreamOptions,
  ): Promise<LLMGenerateOutput> {
    const output = await this.generate(input);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (!options.signal?.aborted) {
      await options.onDelta(output.text);
    }
    return output;
  }
}

function findRunsFile(stateRoot: string): string | null {
  const dir = join(stateRoot, 'runs');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-W\d{2}\.jsonl$/.test(f));
  return files[0] ? join(dir, files[0]) : null;
}

function parseSse(raw: string): SseEvent[] {
  return raw
    .trim()
    .split(/\n\n+/)
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
      }
      return { event, data: JSON.parse(dataLines.join('\n')) as unknown };
    });
}

function resultEvent(events: SseEvent[]): AskResult & { _dry_run?: boolean } {
  const event = events.find((e) => e.event === 'result');
  assert.ok(event, 'expected result event');
  return event.data as AskResult & { _dry_run?: boolean };
}

test('POST /v1/ask/stream starts with an SSE padding comment for proxy flush', async () => {
  const { runtime, cleanup } = await setup({ runsEnabled: false });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });

    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.match(raw, /^: {2048,}\n\n/);
    assert.equal(parseSse(raw)[0]?.event, 'status');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask/stream emits status, deltas, final result, and persists once', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const streamRes = await app.request('/v1/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });

    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(streamRes.headers.get('x-accel-buffering'), 'no');

    const raw = await streamRes.text();
    assert.match(raw, /event: delta\ndata: \{"text":"Based "\}\n\n: {2048,}\n\n/);
    const events = parseSse(raw);
    assert.deepEqual(
      events.filter((e) => e.event === 'status').map((e) => (e.data as { stage: string }).stage),
      ['received', 'retrieving', 'generating'],
    );
    assert.ok(events.some((e) => e.event === 'delta'), 'expected at least one token delta');
    assert.equal(events.at(-1)?.event, 'done');

    const streamed = resultEvent(events);
    assert.equal(streamed.type, 'answer');
    assert.equal(streamed.type === 'answer' ? streamed.model : null, 'mock-llm');
    assert.ok(streamed.type === 'answer' && streamed.citations.length > 0);

    const jsonRes = await app.request('/v1/ask?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });
    const jsonBody = (await jsonRes.json()) as AskResult;
    assert.equal(jsonBody.type, 'answer');
    assert.equal(streamed.type === 'answer' ? streamed.answer_md : null, jsonBody.type === 'answer' ? jsonBody.answer_md : null);
    assert.equal(streamed.type === 'answer' ? streamed.citations.length : 0, jsonBody.type === 'answer' ? jsonBody.citations.length : 0);

    const file = findRunsFile(stateRoot);
    assert.ok(file, 'expected exactly one streamed run to be persisted');
    const lines = readFileSync(file!, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]!) as RunRecord).answer.kind, 'answer');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask/stream keeps the generating stream alive before the first token', async () => {
  const { runtime, cleanup } = await setup({ llm: new SlowFirstDeltaLLM(2_300) });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });

    assert.equal(res.status, 200);
    const raw = await res.text();
    const paddingFrames = raw.match(/^: {2048,}$/gm) ?? [];
    assert.ok(paddingFrames.length >= 2, `expected repeated proxy-flush padding, got ${paddingFrames.length}`);
    const events = parseSse(raw);
    const generatingStatuses = events.filter(
      (e) => e.event === 'status' && (e.data as { stage?: string }).stage === 'generating',
    );
    assert.ok(
      generatingStatuses.length >= 2,
      `expected repeated generating status events, got ${generatingStatuses.length}`,
    );
    assert.ok(events.some((e) => e.event === 'delta'), 'expected delayed token delta');
    assert.equal(events.at(-1)?.event, 'done');
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask/stream?dry_run=1 streams a dry result without runs or answer cache', async () => {
  const { runtime, cleanup, stateRoot } = await setup({ runsEnabled: true });
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask/stream?dry_run=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });

    assert.equal(res.status, 200);
    const body = resultEvent(parseSse(await res.text()));
    assert.equal(body.type, 'answer');
    assert.equal(body._dry_run, true);
    assert.equal(existsSync(join(stateRoot, 'runs')), false);
    assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS n FROM answers`).get().n, 0);
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask/stream malformed JSON returns a structured SSE error', async () => {
  const { runtime, cleanup } = await setup();
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    assert.equal(res.status, 200);
    const body = resultEvent(parseSse(await res.text()));
    assert.deepEqual(body, {
      type: 'error',
      code: 'invalid_request',
      message: 'malformed JSON body',
    });
  } finally {
    await cleanup();
  }
});

test('POST /v1/ask/stream rejects invalid source as a structured SSE error', async () => {
  const { runtime, cleanup } = await setup();
  try {
    const app = createApp({ runtime });
    const res = await app.request('/v1/ask/stream?source=tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何鉴权？' }),
    });

    assert.equal(res.status, 200);
    const body = resultEvent(parseSse(await res.text()));
    assert.equal(body.type, 'error');
    assert.equal(body.type === 'error' ? body.code : null, 'invalid_request');
    assert.match(body.type === 'error' ? body.message : '', /unknown source/);
  } finally {
    await cleanup();
  }
});
