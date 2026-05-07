/**
 * Anthropic LLM provider — placeholder.
 *
 * Stage 7 wires this to @anthropic-ai/sdk and reads ANTHROPIC_API_KEY from
 * the environment (or anydocs.ask.json). For now, the constructor records
 * the configured model so the typecheck-only path through the codebase
 * compiles, but generate() throws to make accidental production use loud.
 */

import type { LLM, LLMGenerateInput, LLMGenerateOutput } from './types.ts';

export type AnthropicLLMOptions = {
  model: string;
  apiKey?: string;
};

export class AnthropicLLM implements LLM {
  readonly model: string;
  constructor(opts: AnthropicLLMOptions) {
    this.model = opts.model;
  }

  async generate(_input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    throw new Error(
      'AnthropicLLM is not yet wired to @anthropic-ai/sdk; will land in stage 7 (HTTP + config).',
    );
  }
}
