import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../query/diagnostic-input.ts';

type ObservationType = 'span' | 'agent' | 'tool' | 'generation' | 'embedding' | 'retriever';

export type Observation = {
  id?: string;
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
let aiSdkTelemetryRegistered = false;

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
  agentic?: boolean;
  traceName?: string;
  environment?: string;
  version?: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

export type TraceTurnResult<T> = {
  value: T;
  traceId: string | null;
  observationId: string | null;
};

export type TraceScoreInput = {
  name: string;
  value: number;
  dataType?: 'NUMERIC' | 'BOOLEAN';
  comment?: string;
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
    const [
      { NodeSDK },
      { LangfuseSpanProcessor },
      tracing,
      { LangfuseClient },
      { registerTelemetry },
      { LangfuseVercelAiSdkIntegration },
    ] =
      await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@langfuse/otel'),
        import('@langfuse/tracing'),
        import('@langfuse/client'),
        import('ai'),
        import('@langfuse/vercel-ai-sdk'),
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
    if (!aiSdkTelemetryRegistered) {
      registerTelemetry(new LangfuseVercelAiSdkIntegration());
      aiSdkTelemetryRegistered = true;
    }
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
  if (!current) return { value: await fn(), traceId: null, observationId: null };

  const traceName = options.traceName ?? 'answer-docs-question';

  const start = current.tracing.startActiveObservation as unknown as (
    observationName: string,
    callback: (observation: Observation) => Promise<TraceTurnResult<T>>,
    options?: { asType: ObservationType },
  ) => Promise<TraceTurnResult<T>>;
  const run = () => start(
    traceName,
    async (observation) => {
      observation.update({
        input: { question: options.question },
        metadata: {
          request_id: options.requestId,
          source: options.source,
          dry_run: options.dryRun === true,
          ...(options.currentPageId ? { current_page_id: options.currentPageId } : {}),
          ...options.metadata,
        },
      });
      const traceId = current.tracing.getActiveTraceId() ?? null;
      const observationId = observation.id ?? null;
      try {
        const value = await fn();
        observation.update({ output: output(value) });
        return { value, traceId, observationId };
      } catch (err) {
        observation.update({ level: 'ERROR', statusMessage: describeError(err) });
        throw err;
      }
    },
    { asType: options.agentic ? 'agent' : 'span' },
  );

  return current.tracing.propagateAttributes(
    {
      traceName,
      sessionId: options.sessionId,
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.version ? { version: options.version } : {}),
      metadata: {
        request_id: options.requestId,
        source: options.source,
        dry_run: String(options.dryRun === true),
        ...options.metadata,
      },
      tags: [
        options.agentic ? 'agentic-rag' : 'rag',
        options.source,
        ...(options.dryRun ? ['dry-run'] : []),
        ...(options.tags ?? []),
      ],
    },
    run,
  );
}

export async function recordTraceScores(args: {
  traceId: string | null;
  observationId?: string | null;
  scores: TraceScoreInput[];
}): Promise<void> {
  if (!state || !args.traceId || args.scores.length === 0) return;
  try {
    for (const score of args.scores) {
      state.client.score.create({
        id: scoreIdForTrace(args.traceId, score.name),
        traceId: args.traceId,
        ...(args.observationId ? { observationId: args.observationId } : {}),
        name: score.name,
        value: score.value,
        dataType: score.dataType ?? 'NUMERIC',
        ...(score.comment ? { comment: score.comment } : {}),
      });
    }
    await state.client.score.flush();
  } catch (err) {
    process.stderr.write(`[langfuse] eval score upload failed: ${describeError(err)}\n`);
  }
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

function scoreIdForTrace(traceId: string, name: string): string {
  const hex = createHash('sha256').update(`trace-score:${traceId}:${name}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|api[_-]?key|access[_-]?(?:key|signature)|secret|password|cookie|auth[_-]?token|private[_-]?key)/i.test(key);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
