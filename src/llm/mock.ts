/**
 * MockLLM — deterministic LLM stand-in used by tests.
 *
 * The default responder echoes back a tiny markdown answer that cites every
 * `[cit_N]` marker found in the user prompt. That's enough to exercise the
 * citation-legality, lang-fill, and hallucination-filter postprocessing
 * branches without coupling tests to actual LLM behavior.
 *
 * Tests can install a custom responder for branch-specific behavior
 * (e.g. simulate cross-lang fallback by replying in the answer_lang).
 */

import type { LLM, LLMGenerateInput, LLMGenerateOutput } from './types.ts';

export type MockResponder = (input: LLMGenerateInput) => string | LLMGenerateOutput;

export class MockLLM implements LLM {
  readonly model: string;
  /** Every call observed, in order. Tests assert prompt shape via this. */
  readonly calls: LLMGenerateInput[] = [];
  private responder: MockResponder;

  constructor(opts: { model?: string; responder?: MockResponder } = {}) {
    this.model = opts.model ?? 'mock-llm';
    this.responder = opts.responder ?? defaultResponder;
  }

  setResponder(responder: MockResponder): void {
    this.responder = responder;
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    this.calls.push(input);
    const out = this.responder(input);
    if (typeof out === 'string') {
      return { text: out, modelUsed: this.model };
    }
    return out;
  }
}

/**
 * Default mock: pull every `[cit_N]` marker from the user prompt and emit a
 * trivial answer that references them all. Output is intentionally short
 * and stable so tests can reason about it.
 */
function defaultResponder(input: LLMGenerateInput): string {
  const markers = Array.from(new Set(input.userPrompt.match(/\[cit_\d+\]/g) ?? []));
  if (markers.length === 0) {
    return 'No relevant context found.';
  }
  return `Based on the documentation: ${markers.join(' ')}`;
}
