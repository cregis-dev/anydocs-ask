/**
 * LLM abstraction. Mirrors the Embedder interface in spirit: thin contract,
 * deterministic mock for tests, real provider implementations swappable via
 * config (ARCH §8 / §9).
 */

export type LLMGenerateInput = {
  systemPrompt: string;
  userPrompt: string;
  /** Provider-side hint; provider is free to clamp. */
  maxTokens?: number;
  /**
   * Forces lower-temperature output for deterministic flows (e.g. clarify
   * message rendering). Optional — providers default to a sensible value.
   */
  temperature?: number;
};

export type LLMGenerateOutput = {
  /** The model's text output. Markdown when the prompt asked for markdown. */
  text: string;
  /** The actual model id used (for the response payload). */
  modelUsed: string;
};

export interface LLM {
  /** Stable identifier reported back in AskAnswer.model. */
  readonly model: string;
  generate(input: LLMGenerateInput): Promise<LLMGenerateOutput>;
}
