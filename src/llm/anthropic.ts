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

import type { LLM, LLMGenerateInput, LLMGenerateOutput } from './types.ts';

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
    const response = await client.messages.create({
      model: this.model,
      max_tokens: input.maxTokens ?? this.defaultMaxTokens,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt }],
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    });
    const text = extractText(response);
    return { text, modelUsed: response.model ?? this.model };
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
