/**
 * Anthropic LLM provider — wraps @anthropic-ai/sdk.
 *
 * Lazy-imports the SDK on first generate() call so:
 *   - tests using MockLLM never load the SDK (faster boot, smaller cold-CI
 *     footprint),
 *   - users who configured `llm.provider = "openai"` don't pay the cost of
 *     loading an Anthropic-only dependency.
 *
 * Single-turn use: system + one user message, no tools. v1 doesn't stream
 * (the answer pipeline already postprocesses the full text), so we use the
 * non-streaming `messages.create` form.
 *
 * API key is read from the environment variable name configured via
 * `llm.apiKeyEnv` (default `ANTHROPIC_API_KEY`); we never accept the key
 * inline.
 */

import type { LLM, LLMGenerateInput, LLMGenerateOutput } from './types.ts';

export type AnthropicLLMOptions = {
  model: string;
  apiKey: string;
  /** Hard cap when the caller doesn't pass maxTokens. */
  defaultMaxTokens?: number;
};

const DEFAULT_MAX_TOKENS = 1024;

export class AnthropicLLM implements LLM {
  readonly model: string;
  private readonly apiKey: string;
  private readonly defaultMaxTokens: number;
  private clientPromise: Promise<unknown> | null = null;

  constructor(opts: AnthropicLLMOptions) {
    if (!opts.apiKey) {
      throw new Error('AnthropicLLM: apiKey is required');
    }
    this.model = opts.model;
    this.apiKey = opts.apiKey;
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
        default: new (opts: { apiKey: string }) => unknown;
      };
      const Ctor = sdk.default;
      return new Ctor({ apiKey: this.apiKey });
    })();
    return this.clientPromise;
  }
}

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
