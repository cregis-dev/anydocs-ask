/**
 * LLM-rewrite candidate questions — ARCH §16.5.1 step 3.
 *
 * One Anthropic call per `golden generate --from structure --llm-rewrite`
 * invocation: feed all candidate templates as a JSON array and ask for an
 * equally-sized array of natural-language rewrites. Keeping it batched (vs.
 * per-page) is intentional — sonnet-4-6 handles ~2K candidates in a single
 * call comfortably, and one network round-trip is much faster than N.
 *
 * Failure modes:
 *   - Provider missing API key → throw early with the "use --no-llm-rewrite"
 *     hint. Caller (commands/golden.ts) bubbles the error to stderr; we
 *     deliberately do NOT silently fall back to templates (per PRD §12.9
 *     verdict #7: report, don't fudge).
 *   - LLM returns malformed JSON / wrong array length → throw with details.
 *     Same surfacing rule.
 *
 * The function never mutates the input array.
 */

import type { LLM } from '../llm/types.ts';
import type { GoldenCaseCandidate } from './types.ts';

export type RewriteOptions = {
  llm: LLM;
  /** Hard cap on rewrite batch size to avoid token blow-ups on very large
   *  projects. Caller chunks above this. Default 200. */
  batchSize?: number;
  /**
   * Progress reporter. Called with already-newline-terminated lines so the
   * caller (CLI: stdout; Console: NDJSON stream) doesn't have to reformat.
   * Default writes to process.stdout. Errors still go to stderr at the
   * `runGoldenGenerate` layer — the reporter is for progress only.
   */
  reporter?: (line: string) => void;
};

export async function rewriteCandidatesWithLLM(
  candidates: GoldenCaseCandidate[],
  opts: RewriteOptions,
): Promise<GoldenCaseCandidate[]> {
  if (candidates.length === 0) return [];
  // 50 keeps the implied max_tokens under 5K, which any gateway/model in our
  // matrix can hold without truncation. 200 was attractive (one round-trip
  // per ~100-page project) but turned out fragile against gateways that cap
  // output tokens around 8K-16K.
  const batchSize = opts.batchSize ?? 50;
  const report = opts.reporter ?? ((s: string) => void process.stdout.write(s));

  const out: GoldenCaseCandidate[] = [];
  const total = Math.ceil(candidates.length / batchSize);
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const idx = Math.floor(i / batchSize) + 1;
    report(`  rewrite batch ${idx}/${total} (${batch.length} items)...\n`);
    const t0 = Date.now();
    let lastErr: unknown;
    let rewritten: GoldenCaseCandidate[] | null = null;
    // Gateways with output-token quota or concurrency throttling sometimes drop
    // the second/third back-to-back call (observed: undefined response after a
    // 30s wait). Retry up to 3 times with exponential backoff before giving up.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        rewritten = await rewriteBatch(batch, opts.llm);
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          const backoffMs = 2000 * 2 ** (attempt - 1);
          report(
            `    retry ${attempt}/2 after ${backoffMs}ms (${(err as Error).message})\n`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }
    if (rewritten === null) {
      report(`    FAIL in ${Date.now() - t0}ms\n`);
      throw lastErr;
    }
    report(`    ok in ${Date.now() - t0}ms\n`);
    out.push(...rewritten);
  }
  return out;
}

async function rewriteBatch(
  batch: GoldenCaseCandidate[],
  llm: LLM,
): Promise<GoldenCaseCandidate[]> {
  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(batch);

  // Output budget: each rewrite is a JSON-quoted question, roughly 30-60 tokens.
  // Reserve 80 tokens per item plus a 256-token JSON-frame overhead so the
  // model never truncates mid-array (the AnthropicLLM default of 1024 cannot
  // hold even a 30-item batch).
  const maxTokens = 256 + batch.length * 80;
  const result = await llm.generate({ systemPrompt, userPrompt, temperature: 0.2, maxTokens });
  const parsed = parseRewriteResponse(result.text, batch.length);
  return batch.map((c, i) => ({
    ...c,
    query: parsed[i] ?? c.query,
    created_by: 'structure+llm',
  }));
}

const SYSTEM_PROMPT = `You rewrite documentation evaluation questions to sound more natural while preserving their semantic intent.

Rules:
- Keep the same language as the input (Chinese stays Chinese, English stays English).
- Do NOT change which document the question points at.
- Do NOT add new facts.
- Do NOT shorten to a single keyword; questions must remain answerable from the linked page.
- Output STRICT JSON: an array of strings of the SAME length as the input array, in the same order. No prose, no code fences.`;

function buildUserPrompt(batch: GoldenCaseCandidate[]): string {
  const items = batch.map((c, i) => ({
    i,
    template: c.template_id,
    page_slug: c.expected.must_cite_pages[0],
    raw: c.query,
    lang: c.lang,
  }));
  return [
    `Rewrite the ${batch.length} questions below. Return JSON array of strings.`,
    '',
    JSON.stringify(items, null, 2),
  ].join('\n');
}

/**
 * Strict parser. The model is told "no prose, no code fences" but real-world
 * outputs often wrap JSON in ```json ... ``` anyway, so we tolerate that.
 * Anything else throws.
 */
export function parseRewriteResponse(text: string, expectedLen: number): string[] {
  let body = text.trim();
  // Strip ```json … ``` / ``` … ``` wrappers if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(body);
  if (fence && fence[1]) body = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`LLM rewrite returned invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`LLM rewrite expected an array, got ${typeof parsed}`);
  }
  if (parsed.length !== expectedLen) {
    throw new Error(
      `LLM rewrite returned ${parsed.length} items, expected ${expectedLen}`,
    );
  }
  for (let i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== 'string' || (parsed[i] as string).length === 0) {
      throw new Error(`LLM rewrite item ${i} is not a non-empty string`);
    }
  }
  return parsed as string[];
}
