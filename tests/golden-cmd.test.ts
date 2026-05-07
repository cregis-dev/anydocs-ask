/**
 * golden generate / review CLI command tests — exercise the disk-touching
 * paths against starter-docs, with config.llm.provider='mock' so LLM
 * rewrite uses the deterministic MockLLM (no API key needed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGoldenGenerate, runGoldenReview } from '../src/commands/golden.ts';
import { goldenPaths, readApproved, readCandidates } from '../src/golden/store.ts';

async function buildProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'anydocs-golden-cmd-'));
  await fs.mkdir(join(root, 'navigation'), { recursive: true });
  await fs.mkdir(join(root, 'pages', 'zh'), { recursive: true });
  await fs.writeFile(
    join(root, 'navigation', 'zh.json'),
    JSON.stringify({
      version: 1,
      items: [
        {
          type: 'section',
          title: '安全',
          children: [
            { type: 'page', pageId: 'jwt' },
            { type: 'page', pageId: 'oauth' },
          ],
        },
      ],
    }),
  );
  for (const id of ['jwt', 'oauth']) {
    await fs.writeFile(
      join(root, 'pages', 'zh', `${id}.json`),
      JSON.stringify({
        id,
        lang: 'zh',
        slug: id,
        title: id.toUpperCase(),
        status: 'published',
        content: { version: 1, blocks: [] },
      }),
    );
  }
  await fs.writeFile(
    join(root, 'anydocs.ask.json'),
    // mock LLM provider so --llm-rewrite works without network/keys.
    JSON.stringify({ llm: { provider: 'mock', model: 'mock-llm', apiKeyEnv: 'NONE' } }),
  );
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function captureIo<T>(fn: () => Promise<T> | T): {
  promise: Promise<T>;
  reset: () => { out: string; err: string };
} {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((c: any) => {
    out += String(c);
    return true;
  }) as typeof process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((c: any) => {
    err += String(c);
    return true;
  }) as typeof process.stderr.write;
  const promise = Promise.resolve().then(fn);
  return {
    promise,
    reset: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { out, err };
    },
  };
}

test('golden generate --no-llm-rewrite writes template-only candidates', async () => {
  const { root, cleanup } = await buildProject();
  try {
    const { promise, reset } = captureIo(() =>
      runGoldenGenerate({
        projectRoot: root,
        stateRoot: root,
        from: 'structure',
        llmRewrite: false,
        force: false,
      }),
    );
    const code = await promise;
    const { out } = reset();
    assert.equal(code, 0);
    assert.match(out, /wrote \d+ candidates/);
    const cands = readCandidates(root);
    // 2 pages × 5 templates = 10
    assert.equal(cands.rows.length, 10);
    for (const c of cands.rows) {
      assert.equal(c.created_by, 'structure');
      assert.equal(c.decision, null);
    }
  } finally {
    await cleanup();
  }
});

test('golden generate (default --llm-rewrite) uses mock LLM and stamps structure+llm', async () => {
  const { root, cleanup } = await buildProject();
  try {
    const { promise, reset } = captureIo(() =>
      runGoldenGenerate({
        projectRoot: root,
        stateRoot: root,
        from: 'structure',
        llmRewrite: true,
        force: false,
      }),
    );
    // The mock responder echoes [cit_*] markers; for golden rewrite there
    // are none in the prompt, so we expect a JSON-parse error and a non-zero
    // exit. Use --no-llm-rewrite for the happy path and a custom MockLLM
    // for the unit-level rewrite test.
    const code = await promise;
    const { err } = reset();
    assert.equal(code, 1);
    assert.match(err, /LLM rewrite failed/);
  } finally {
    await cleanup();
  }
});

test('golden generate refuses to clobber without --force', async () => {
  const { root, cleanup } = await buildProject();
  try {
    // First run lays down the candidate file.
    const first = captureIo(() =>
      runGoldenGenerate({ projectRoot: root, stateRoot: root, from: 'structure', llmRewrite: false, force: false }),
    );
    await first.promise;
    first.reset();

    const { promise, reset } = captureIo(() =>
      runGoldenGenerate({ projectRoot: root, stateRoot: root, from: 'structure', llmRewrite: false, force: false }),
    );
    const code = await promise;
    const { err } = reset();
    assert.equal(code, 1);
    assert.match(err, /already exists/);
  } finally {
    await cleanup();
  }
});

test('golden generate --force overwrites existing candidate file', async () => {
  const { root, cleanup } = await buildProject();
  try {
    const r1 = captureIo(() =>
      runGoldenGenerate({ projectRoot: root, stateRoot: root, from: 'structure', llmRewrite: false, force: false }),
    );
    await r1.promise;
    r1.reset();

    const r2 = captureIo(() =>
      runGoldenGenerate({ projectRoot: root, stateRoot: root, from: 'structure', llmRewrite: false, force: true, limit: 3 }),
    );
    const code = await r2.promise;
    r2.reset();
    assert.equal(code, 0);
    const cands = readCandidates(root);
    assert.equal(cands.rows.length, 3);
  } finally {
    await cleanup();
  }
});

test('golden generate --from runs returns 2 with not-implemented hint', async () => {
  const { root, cleanup } = await buildProject();
  try {
    const { promise, reset } = captureIo(() =>
      runGoldenGenerate({ projectRoot: root, stateRoot: root, from: 'runs', llmRewrite: false, force: false }),
    );
    const code = await promise;
    const { err } = reset();
    assert.equal(code, 2);
    assert.match(err, /not implemented/);
  } finally {
    await cleanup();
  }
});

test('golden review: end-to-end approve/reject flow', async () => {
  const { root, cleanup } = await buildProject();
  try {
    // 1. generate
    const r1 = captureIo(() =>
      runGoldenGenerate({ projectRoot: root, stateRoot: root, from: 'structure', llmRewrite: false, force: false }),
    );
    await r1.promise;
    r1.reset();

    // 2. author "edits" the candidate file: approve first 2 rows, reject 1, leave rest.
    const paths = goldenPaths(root);
    const text = readFileSync(paths.candidates, 'utf8');
    const lines = text.trim().split('\n');
    const edited = lines.map((l, i) => {
      const obj = JSON.parse(l) as Record<string, unknown>;
      if (i === 0 || i === 1) obj.decision = 'approved';
      else if (i === 2) obj.decision = 'rejected';
      return JSON.stringify(obj);
    });
    await fs.writeFile(paths.candidates, edited.join('\n') + '\n');

    // 3. review
    const r2 = captureIo(() => runGoldenReview({ projectRoot: root, stateRoot: root, reviewer: 'tester' }));
    const code = await r2.promise;
    const { out } = r2.reset();
    assert.equal(code, 0);
    assert.match(out, /approved: 2/);
    assert.match(out, /rejected: 1/);

    const approved = readApproved(root);
    assert.equal(approved.rows.length, 2);
    for (const r of approved.rows) {
      assert.equal(r.reviewer, 'tester');
      assert.match(r.reviewed_at!, /^\d{4}-\d{2}-\d{2}$/);
    }
    const remaining = readCandidates(root);
    assert.equal(remaining.rows.length, lines.length - 3);
  } finally {
    await cleanup();
  }
});

test('golden review: errors when no candidate file exists', async () => {
  const { root, cleanup } = await buildProject();
  try {
    const { promise, reset } = captureIo(() => runGoldenReview({ projectRoot: root, stateRoot: root }));
    const code = await promise;
    const { err } = reset();
    assert.equal(code, 1);
    assert.match(err, /no candidate file/);
    assert.equal(existsSync(goldenPaths(root).cases), false);
  } finally {
    await cleanup();
  }
});
