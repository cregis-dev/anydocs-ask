/**
 * Build an LLM instance from a resolved config — shared between the
 * server runtime (`/v1/ask`) and offline CLI commands (`golden generate`,
 * `eval`, etc.) so credential resolution stays identical across paths.
 */

import { AnthropicLLM } from './anthropic.ts';
import { MockLLM } from './mock.ts';
import type { LLM } from './types.ts';
import type { ResolvedConfig } from '../config.ts';

export function buildDefaultLLM(config: ResolvedConfig): LLM {
  if (config.llm.provider === 'mock') {
    return new MockLLM({ model: config.llm.model });
  }
  if (config.llm.provider === 'anthropic') {
    // Pick credentials in order of precedence:
    //   1. Custom env var named in config (apiKeyEnv) — always honored
    //   2. Native Anthropic env vars (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)
    // Bearer-token gateways set ANTHROPIC_AUTH_TOKEN; the official Anthropic
    // service uses ANTHROPIC_API_KEY (sent as x-api-key). Either is enough.
    const apiKey = process.env[config.llm.apiKeyEnv] ?? process.env.ANTHROPIC_API_KEY;
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    if (!apiKey && !authToken) {
      const keyEnv =
        config.llm.apiKeyEnv === 'ANTHROPIC_API_KEY'
          ? 'ANTHROPIC_API_KEY'
          : `${config.llm.apiKeyEnv} (or ANTHROPIC_API_KEY)`;
      throw new Error(
        `LLM provider 'anthropic' requires either '${keyEnv}' or 'ANTHROPIC_AUTH_TOKEN' env var. ` +
          `For internal Anthropic-compatible gateways set ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL.`,
      );
    }
    // Model id is already env-resolved by applyEnvOverrides() during
    // loadConfig — config.llm.model is the canonical value here.
    return new AnthropicLLM({
      model: config.llm.model,
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
      ...(baseURL ? { baseURL } : {}),
    });
  }
  throw new Error(`LLM provider '${config.llm.provider}' is not supported in v1`);
}
