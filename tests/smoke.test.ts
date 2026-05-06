import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.ts';

test('GET /v1/health returns 200 with status ok', async () => {
  const app = createApp({ projectRoot: '/tmp/nonexistent' });
  const res = await app.request('/v1/health');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; warm: boolean };
  assert.equal(body.status, 'ok');
  assert.equal(body.warm, true);
});

test('unknown route returns 404 with structured error', async () => {
  const app = createApp({ projectRoot: '/tmp/nonexistent' });
  const res = await app.request('/v1/does-not-exist');
  assert.equal(res.status, 404);
  const body = (await res.json()) as { type: string; code: string };
  assert.equal(body.type, 'error');
  assert.equal(body.code, 'not_found');
});
