/**
 * Anthropic-compatible LLM provider — wraps @anthropic-ai/sdk.
 *
 * Two deployment shapes:
 *   1. Anthropic native: `apiKey` (sent as `x-api-key`), default baseURL
 *      points at https://api.anthropic.com.
 *   2. Internal Anthropic-compatible gateway: `authToken` (sent as
 *      `Authorization: Bearer <token>`) + custom `baseURL`. The SDK supports
 *      both auth modes via the `apiKey` and `authToken` constructor options;
 *      whichever is set wins. baseURL defaults to the SDK's default if unset.
 *
 * Lazy-imports the SDK on first generate() call so MockLLM users / tests
 * don't pay the SDK cost.
 *
 * Single-turn use: system + one user message, no tools / streaming. v1's
 * answer postprocessor consumes the whole text at once.
 */

import type { LLM, LLMGenerateInput, LLMGenerateOutput, LLMStreamOptions } from './types.ts';

export type AnthropicLLMOptions = {
  model: string;
  /** API key (sent as `x-api-key`). Mutually exclusive-ish with authToken. */
  apiKey?: string;
  /** Bearer token (sent as `Authorization: Bearer ...`). Used for gateways. */
  authToken?: string;
  /** Override base URL — point at an Anthropic-compatible gateway. */
  baseURL?: string;
  /** Extra headers to send on every request (e.g. internal routing tags). */
  defaultHeaders?: Record<string, string>;
  /** Hard cap when the caller doesn't pass maxTokens. */
  defaultMaxTokens?: number;
};

const DEFAULT_MAX_TOKENS = 1024;

export class AnthropicLLM implements LLM {
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly authToken: string | undefined;
  private readonly baseURL: string | undefined;
  private readonly defaultHeaders: Record<string, string> | undefined;
  private readonly defaultMaxTokens: number;
  private clientPromise: Promise<unknown> | null = null;

  constructor(opts: AnthropicLLMOptions) {
    if (!opts.apiKey && !opts.authToken) {
      throw new Error(
        'AnthropicLLM: either apiKey or authToken is required (set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)',
      );
    }
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.authToken = opts.authToken;
    this.baseURL = opts.baseURL;
    this.defaultHeaders = opts.defaultHeaders;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const client = (await this.getClient()) as {
      messages: {
        create: (req: AnthropicMessageRequest) => Promise<AnthropicMessageResponse>;
      };
    };
    let response: AnthropicMessageResponse;
    try {
      response = await client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? this.defaultMaxTokens,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: input.userPrompt }],
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      });
    } catch (err) {
      throw new Error(`AnthropicLLM request failed (model=${this.model}): ${describeRequestError(err)}`);
    }
    if (!response || typeof response !== 'object') {
      throw new Error(
        `AnthropicLLM: gateway returned non-object response (model=${this.model}): ${describeNonObject(response)}`,
      );
    }
    const text = extractText(response);
    return { text, modelUsed: response.model ?? this.model };
  }

  async streamGenerate(
    input: LLMGenerateInput,
    options: LLMStreamOptions,
  ): Promise<LLMGenerateOutput> {
    const client = (await this.getClient()) as {
      messages: {
        stream: (
          req: AnthropicMessageRequest,
          options?: { signal?: AbortSignal },
        ) => AsyncIterable<AnthropicMessageStreamEvent>;
      };
    };
    let text = '';
    let modelUsed = this.model;
    try {
      const stream = client.messages.stream(
        {
          model: this.model,
          max_tokens: input.maxTokens ?? this.defaultMaxTokens,
          system: input.systemPrompt,
          messages: [{ role: 'user', content: input.userPrompt }],
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        },
        { signal: options.signal },
      );
      for await (const event of stream) {
        if (options.signal?.aborted) break;
        if (event.type === 'message_start' && event.message.model) {
          modelUsed = event.message.model;
        }
        if (event.type === 'content_block_delta' && isTextDelta(event.delta)) {
          text += event.delta.text;
          await options.onDelta(event.delta.text);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`AnthropicLLM stream request failed (model=${this.model}): ${msg}`);
    }
    return { text, modelUsed };
  }

  private async getClient(): Promise<unknown> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const sdk = (await import('@anthropic-ai/sdk')) as {
        default: new (opts: SDKConstructorOptions) => unknown;
      };
      const Ctor = sdk.default;
      const sdkOpts: SDKConstructorOptions = {};
      if (this.apiKey) sdkOpts.apiKey = this.apiKey;
      if (this.authToken) sdkOpts.authToken = this.authToken;
      if (this.baseURL) sdkOpts.baseURL = this.baseURL;
      if (this.defaultHeaders) sdkOpts.defaultHeaders = this.defaultHeaders;
      return new Ctor(sdkOpts);
    })();
    return this.clientPromise;
  }
}

type SDKConstructorOptions = {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// SDK shape (narrow types so we don't pull SDK types into the public surface)
// ---------------------------------------------------------------------------

type AnthropicMessageRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
};

type AnthropicMessageResponse = {
  model?: string;
  content?: Array<{ type: string; text?: string }>;
};

type AnthropicMessageStreamEvent =
  | {
      type: 'message_start';
      message: { model?: string };
    }
  | {
      type: 'content_block_delta';
      delta:
        | { type: 'text_delta'; text: string }
        | { type: string; [key: string]: unknown };
    }
  | { type: 'message_delta' | 'message_stop' | 'content_block_start' | 'content_block_stop' };

function extractText(resp: AnthropicMessageResponse): string {
  const blocks = resp.content ?? [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Error diagnostics
//
// Dogfood 2026-05-14 F3: `gateway returned non-object response ... undefined`
// did not tell the author whether the gateway sent 401 / 502 / truncated JSON /
// or empty body — debug required tcpdump. These helpers enrich the message at
// the point of failure so analyze D1 / runs.jsonl carry the diagnostic verbatim.
// ---------------------------------------------------------------------------

/** Duck-typed view of the SDK's APIError. Avoids importing the SDK type
 *  here — we only want to read fields when they happen to exist. */
type APIErrorLike = {
  status?: number;
  type?: string | null;
  error?: unknown;
  requestID?: string | null;
  message?: string;
};

function describeRequestError(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  if (typeof err !== 'object') return String(err);
  const e = err as APIErrorLike;
  const parts: string[] = [];
  if (typeof e.status === 'number') parts.push(`status=${e.status}`);
  if (e.type) parts.push(`type=${e.type}`);
  if (e.requestID) parts.push(`requestID=${e.requestID}`);
  const msg = typeof e.message === 'string' ? e.message : (err instanceof Error ? err.message : '');
  if (msg) parts.push(msg);
  if (e.error !== undefined) {
    const bodyStr = safeStringify(e.error);
    if (bodyStr && bodyStr !== msg) parts.push(`body=${truncate(bodyStr, 240)}`);
  }
  return parts.length > 0 ? parts.join(' ') : (err instanceof Error ? err.message : String(err));
}

function describeNonObject(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return `string=${truncate(JSON.stringify(value), 200)}`;
  return `${t}=${truncate(safeStringify(value), 200)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `… (+${s.length - max}B)`;
}

function isTextDelta(delta: unknown): delta is { type: 'text_delta'; text: string } {
  return (
    typeof delta === 'object' &&
    delta !== null &&
    (delta as { type?: unknown }).type === 'text_delta' &&
    typeof (delta as { text?: unknown }).text === 'string'
  );
}
