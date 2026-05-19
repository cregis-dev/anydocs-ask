/**
 * SSR view of a project's `anydocs.ask.json` — feeds the Settings tab.
 *
 * Synchronous: the project page handler is async but the request is
 * cheap enough that staying on readFileSync keeps the helper composable
 * with the rest of the SSR pipeline (which is sync).
 *
 * Critical: we DO NOT apply env overrides here. `applyEnvOverrides()`
 * exists to honor `ANTHROPIC_MODEL` etc. at runtime, but the Settings
 * tab prefills *form values* — an env-overridden value displayed and
 * saved back would silently overwrite the file with the env's value.
 * Always show the file-as-written.
 *
 * We return both `raw` (the parsed file root, untouched) and `defaults`
 * (a default-merged ResolvedConfig) so the UI can distinguish "field is
 * present in the file" (prefill the value) from "field is just the
 * default" (show placeholder, leave the input empty so saving doesn't
 * pin a default into the file).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAndValidateAskConfig, type ResolvedConfig } from '../config.ts';

export type AskConfigView = {
  path: string;
  exists: boolean;
  mtimeISO: string | null;
  /** Parsed file root — null when file missing or malformed. UI uses this
   *  to know which fields are *actually* set in the file. */
  raw: Record<string, unknown> | null;
  /** Pure defaults (no env override, no merge with file). UI uses this
   *  as placeholder text + ensures the form is renderable when the file
   *  doesn't exist or has parse errors. */
  defaults: ResolvedConfig;
  /** Raw file text — null when file missing. */
  rawText: string | null;
  /** Non-fatal merge warnings from validation. */
  warnings: string[];
  /** Fatal parse error (malformed JSON / non-object root) — null when clean. */
  parseError: string | null;
};

export function loadAskConfigForView(projectRoot: string): AskConfigView {
  const path = join(projectRoot, 'anydocs.ask.json');
  // Pure defaults via "empty file" parse — keeps a single source of truth.
  const { config: defaults } = parseAndValidateAskConfig('{}');

  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      mtimeISO: null,
      raw: null,
      defaults,
      rawText: null,
      warnings: [],
      parseError: null,
    };
  }
  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      path,
      exists: true,
      mtimeISO: null,
      raw: null,
      defaults,
      rawText: null,
      warnings: [],
      parseError: (err as Error).message,
    };
  }
  const mtimeISO = new Date(statSync(path).mtimeMs).toISOString();

  // Two passes:
  //   1. JSON.parse to get the raw object (untouched, no merge).
  //   2. parseAndValidateAskConfig to surface warnings (it does the
  //      merge internally; we discard the merged value here — defaults
  //      is enough for placeholders).
  let raw: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    } else {
      parseError = 'top-level value must be a JSON object';
    }
  } catch (err) {
    parseError = `malformed JSON: ${(err as Error).message}`;
  }

  let warnings: string[] = [];
  if (parseError === null) {
    try {
      const res = parseAndValidateAskConfig(rawText);
      warnings = res.warnings;
    } catch (err) {
      // Shouldn't happen — same input passed JSON.parse above — but be safe.
      parseError = (err as Error).message;
    }
  }

  return { path, exists: true, mtimeISO, raw, defaults, rawText, warnings, parseError };
}
