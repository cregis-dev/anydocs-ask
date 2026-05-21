/**
 * AnthropicLLM error-message detail tests (dogfood 2026-05-14 F3).
 *
 * The class lazy-imports @anthropic-ai/sdk on first generate(). Tests bypass
 * the SDK by writing a fake client into the private clientPromise field, so
 * we can drive what `messages.create` returns or throws and assert on the
 * resulting Error.message.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicLLM } from '../src/llm/anthropic.ts';

function withFakeClient(llm: AnthropicLLM, create: (req: unknown) => unknown): void {
  // Bypass getClient() / lazy SDK import by seeding the private cache.
  (llm as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve({
    messages: { create: async (req: unknown) => create(req) },
  });
}

const PROMPT = { systemPrompt: 'sys', userPrompt: 'usr' };

test('AnthropicLLM: non-object response (undefined) → message names "undefined"', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  withFakeClient(llm, () => undefined);
  await assert.rejects(
    llm.generate(PROMPT),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gateway returned non-object response/);
      assert.match(err.message, /model=m/);
      assert.match(err.message, /undefined$/);
      return true;
    },
  );
});

test('AnthropicLLM: retries one transient non-object gateway response', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  let calls = 0;
  withFakeClient(llm, () => {
    calls += 1;
    if (calls === 1) return undefined;
    return { model: 'm', content: [{ type: 'text', text: 'ok after retry' }] };
  });

  const result = await llm.generate(PROMPT);

  assert.equal(calls, 2);
  assert.equal(result.text, 'ok after retry');
  assert.equal(result.modelUsed, 'm');
});

test('AnthropicLLM: retries two transient non-object gateway responses', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  let calls = 0;
  withFakeClient(llm, () => {
    calls += 1;
    if (calls <= 2) return undefined;
    return { model: 'm', content: [{ type: 'text', text: 'ok after two retries' }] };
  });

  const result = await llm.generate(PROMPT);

  assert.equal(calls, 3);
  assert.equal(result.text, 'ok after two retries');
});

test('AnthropicLLM: retries one transient timeout error', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  let calls = 0;
  withFakeClient(llm, () => {
    calls += 1;
    if (calls === 1) throw new Error('Request timed out.');
    return { model: 'm', content: [{ type: 'text', text: 'ok after timeout' }] };
  });

  const result = await llm.generate(PROMPT);

  assert.equal(calls, 2);
  assert.equal(result.text, 'ok after timeout');
});

test('AnthropicLLM: non-object response (null) → message names "null"', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  withFakeClient(llm, () => null);
  await assert.rejects(
    llm.generate(PROMPT),
    (err: unknown) => err instanceof Error && /null$/.test(err.message),
  );
});

test('AnthropicLLM: non-object response (string) → quoted + typed', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  withFakeClient(llm, () => 'oops not JSON');
  await assert.rejects(
    llm.generate(PROMPT),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /string="oops not JSON"/);
      return true;
    },
  );
});

test('AnthropicLLM: long non-object response is truncated with byte hint', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  const longStr = 'x'.repeat(500);
  withFakeClient(llm, () => longStr);
  await assert.rejects(
    llm.generate(PROMPT),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /…\s*\(\+\d+B\)/);
      // raw 500-byte garbage should NOT appear in full
      assert.ok(err.message.length < longStr.length, 'error must be truncated');
      return true;
    },
  );
});

test('AnthropicLLM: SDK APIError-like throw → status, type, requestID, body all surfaced', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  // Duck-typed APIError shape — mirrors what @anthropic-ai/sdk's APIError class
  // exposes (status / type / requestID / error / message).
  const apiErr = Object.assign(new Error('Rate limit exceeded'), {
    status: 429,
    type: 'rate_limit_error',
    requestID: 'req_abc123',
    error: { type: 'rate_limit_error', message: 'Too many requests' },
  });
  withFakeClient(llm, () => {
    throw apiErr;
  });
  await assert.rejects(
    llm.generate(PROMPT),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /AnthropicLLM request failed.*model=m/);
      assert.match(err.message, /status=429/);
      assert.match(err.message, /type=rate_limit_error/);
      assert.match(err.message, /requestID=req_abc123/);
      assert.match(err.message, /Rate limit exceeded/);
      assert.match(err.message, /body=/);
      return true;
    },
  );
});

test('AnthropicLLM: plain Error (no status/type) → original message preserved', async () => {
  const llm = new AnthropicLLM({ model: 'm', apiKey: 'k' });
  withFakeClient(llm, () => {
    throw new Error('fetch failed: connect ECONNREFUSED');
  });
  await assert.rejects(
    llm.generate(PROMPT),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /AnthropicLLM request failed.*ECONNREFUSED/);
      // no status= field for plain Errors
      assert.doesNotMatch(err.message, /status=/);
      return true;
    },
  );
});
