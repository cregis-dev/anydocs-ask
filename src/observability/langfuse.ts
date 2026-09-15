import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../query/diagnostic-input.ts';

type ObservationType = 'span' | 'generation' | 'embedding' | 'retriever';

export type Observation = {
  update(attributes: Record<string, unknown>): void;
};

type TracingModule = typeof import('@langfuse/tracing');
type LangfuseClient = InstanceType<typeof import('@langfuse/client').LangfuseClient>;
type NodeSdk = InstanceType<typeof import('@opentelemetry/sdk-node').NodeSDK>;

type LangfuseState = {
  tracing: TracingModule;
  client: LangfuseClient;
  sdk: NodeSdk;
};

let state: LangfuseState | null = null;

export type LangfuseLifecycle = {
  enabled: boolean;
  shutdown(): Promise<void>;
};

export type TraceTurnOptions = {
  requestId: string;
  sessionId: string;
  source: string;
  question: string;
  currentPageId?: string | null;
  dryRun?: boolean;
};

export type TraceTurnResult<T> = {
  value: T;
  traceId: string | null;
};

export async function startLangfuseObservability(): Promise<LangfuseLifecycle> {
  if (state) return lifecycleFor(state);
  if (process.env.LANGFUSE_TRACING_ENABLED?.toLowerCase() === 'false') {
    return disabledLifecycle();
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    process.stdout.write('[langfuse] disabled (LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY not set)\n');
    return disabledLifecycle();
  }

  try {
    // Import after loadConfig() has loaded the project env file. Both clients
    // read LANGFUSE_* values during construction.
    const [{ NodeSDK }, { LangfuseSpanProcessor }, tracing, { LangfuseClient }] =
      await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@langfuse/otel'),
        import('@langfuse/tracing'),
        import('@langfuse/client'),
      ]);
    const baseUrl = process.env.LANGFUSE_BASE_URL?.trim();
    const processor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      ...(baseUrl ? { baseUrl } : {}),
      mask: ({ data }) => maskSensitiveData(data),
      mediaUploadEnabled: false,
    });
    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    const client = new LangfuseClient({
      publicKey,
      secretKey,
      ...(baseUrl ? { baseUrl } : {}),
    });
    state = { tracing, client, sdk };
    process.stdout.write(
      `[langfuse] tracing enabled (${baseUrl ?? 'https://cloud.langfuse.com'})\n`,
    );
    return lifecycleFor(state);
  } catch (err) {
    process.stderr.write(
      `[langfuse] initialization failed; continuing without tracing: ${describeError(err)}\n`,
    );
    state = null;
    return disabledLifecycle();
  }
}

export async function traceAskTurn<T>(
  options: TraceTurnOptions,
  fn: () => Promise<T>,
  output: (value: T) => unknown,
): Promise<TraceTurnResult<T>> {
  const current = state;
  if (!current) return { value: await fn(), traceId: null };

  const run = () => current.tracing.startActiveObservation(
    'answer-docs-question',
    async (observation) => {
      observation.update({
        input: { question: options.question },
        metadata: {
          request_id: options.requestId,
          source: options.source,
          dry_run: options.dryRun === true,
          ...(options.currentPageId ? { current_page_id: options.currentPageId } : {}),
        },
      });
      const traceId = current.tracing.getActiveTraceId() ?? null;
      try {
        const value = await fn();
        observation.update({ output: output(value) });
        return { value, traceId };
      } catch (err) {
        observation.update({ level: 'ERROR', statusMessage: describeError(err) });
        throw err;
      }
    },
  );

  return current.tracing.propagateAttributes(
    {
      traceName: 'answer-docs-question',
      sessionId: options.sessionId,
      metadata: {
        request_id: options.requestId,
        source: options.source,
        dry_run: String(options.dryRun === true),
      },
      tags: ['rag', options.source, ...(options.dryRun ? ['dry-run'] : [])],
    },
    run,
  );
}

export async function observeLangfuse<T>(
  name: string,
  type: ObservationType,
  attributes: Record<string, unknown>,
  fn: (observation: Observation | null) => Promise<T>,
): Promise<T> {
  const current = state;
  if (!current || !current.tracing.getActiveTraceId()) return fn(null);

  const start = current.tracing.startActiveObservation as unknown as (
    observationName: string,
    callback: (observation: Observation) => Promise<T>,
    options: { asType: ObservationType },
  ) => Promise<T>;
  return start(
    name,
    async (observation) => {
      observation.update(attributes);
      try {
        return await fn(observation);
      } catch (err) {
        observation.update({ level: 'ERROR', statusMessage: describeError(err) });
        throw err;
      }
    },
    { asType: type },
  );
}

export async function recordUserThumb(args: {
  traceId: string | null;
  answerId: string;
  rating: number;
  comment?: string | null;
}): Promise<void> {
  if (!state || !args.traceId || args.rating === 0) return;
  try {
    state.client.score.create({
      id: scoreIdForAnswer(args.answerId),
      traceId: args.traceId,
      name: 'user-thumbs',
      value: args.rating > 0 ? 1 : 0,
      dataType: 'BOOLEAN',
      ...(args.comment ? { comment: redactSensitiveText(args.comment) } : {}),
    });
  } catch (err) {
    process.stderr.write(`[langfuse] feedback score failed: ${describeError(err)}\n`);
  }
}

function lifecycleFor(active: LangfuseState): LangfuseLifecycle {
  let stopped = false;
  return {
    enabled: true,
    async shutdown() {
      if (stopped) return;
      stopped = true;
      state = null;
      const settled = await Promise.allSettled([
        active.client.score.shutdown(),
        active.sdk.shutdown(),
      ]);
      for (const result of settled) {
        if (result.status === 'rejected') {
          process.stderr.write(`[langfuse] shutdown flush failed: ${describeError(result.reason)}\n`);
        }
      }
    },
  };
}

function disabledLifecycle(): LangfuseLifecycle {
  return { enabled: false, shutdown: async () => undefined };
}

function maskSensitiveData(data: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof data === 'string') return maskSensitiveText(data);
  if (!data || typeof data !== 'object') return data;
  if (seen.has(data)) return '[CIRCULAR]';
  seen.add(data);
  if (Array.isArray(data)) return data.map((item) => maskSensitiveData(item, seen));

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    masked[key] = isSensitiveKey(key) ? '[REDACTED]' : maskSensitiveData(value, seen);
  }
  return masked;
}

function maskSensitiveText(value: string): string {
  return redactSensitiveText(value)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-(?:ant|lf)-|ghp_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    );
}

function scoreIdForAnswer(answerId: string): string {
  const hex = createHash('sha256').update(`user-thumbs:${answerId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|api[_-]?key|access[_-]?(?:key|signature)|secret|password|cookie|auth[_-]?token|private[_-]?key)/i.test(key);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
