import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ResolvedConfig } from '../config.ts';
import { resolveAnthropicCredentials } from '../llm/factory.ts';

export function buildAgentLanguageModel(config: ResolvedConfig): LanguageModel {
  if (config.llm.provider !== 'anthropic') {
    throw new Error(`Agentic RAG requires an Anthropic-compatible provider; got '${config.llm.provider}'`);
  }
  const credentials = resolveAnthropicCredentials(config);
  const provider = createAnthropic({
    ...credentials,
    ...(credentials.baseURL ? { baseURL: normalizeAnthropicBaseUrl(credentials.baseURL) } : {}),
  });
  return provider(config.llm.model);
}

export function normalizeAnthropicBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
