import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startLangfuseObservability,
  traceAskTurn,
} from '../src/observability/langfuse.ts';

test('Langfuse observability is a fail-open no-op without credentials', async () => {
  const previousPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const previousSecretKey = process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  try {
    const lifecycle = await startLangfuseObservability();
    assert.equal(lifecycle.enabled, false);

    const traced = await traceAskTurn(
      {
        requestId: 'req-test',
        sessionId: 'session-test',
        source: 'console',
        question: 'hello',
      },
      async () => ({ result: 'ok' }),
      (value) => value,
    );
    assert.deepEqual(traced, { value: { result: 'ok' }, traceId: null });
    await lifecycle.shutdown();
  } finally {
    if (previousPublicKey === undefined) delete process.env.LANGFUSE_PUBLIC_KEY;
    else process.env.LANGFUSE_PUBLIC_KEY = previousPublicKey;
    if (previousSecretKey === undefined) delete process.env.LANGFUSE_SECRET_KEY;
    else process.env.LANGFUSE_SECRET_KEY = previousSecretKey;
  }
});
