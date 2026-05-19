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
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAndValidateAskConfig, type ResolvedConfig } from '../config.ts';

export type AskConfigView = {
  path: string;
  exists: boolean;
  mtimeISO: string | null;
  /** Merged with defaults — fields not present in the file fall back. */
  config: ResolvedConfig;
  /** Raw file text — null when file missing. */
  rawText: string | null;
  /** Non-fatal merge warnings from validation. */
  warnings: string[];
  /** Fatal parse error (malformed JSON / non-object root) — null when clean. */
  parseError: string | null;
};

export function loadAskConfigForView(projectRoot: string): AskConfigView {
  const path = join(projectRoot, 'anydocs.ask.json');
  if (!existsSync(path)) {
    const { config } = parseAndValidateAskConfig('{}');
    return {
      path,
      exists: false,
      mtimeISO: null,
      config,
      rawText: null,
      warnings: [],
      parseError: null,
    };
  }
  let rawText: string;
  try {
    rawText = readFileSync(path, 'utf8');
  } catch (err) {
    const { config } = parseAndValidateAskConfig('{}');
    return {
      path,
      exists: true,
      mtimeISO: null,
      config,
      rawText: null,
      warnings: [],
      parseError: (err as Error).message,
    };
  }
  const mtimeISO = new Date(statSync(path).mtimeMs).toISOString();
  try {
    const { config, warnings } = parseAndValidateAskConfig(rawText);
    return { path, exists: true, mtimeISO, config, rawText, warnings, parseError: null };
  } catch (err) {
    const { config } = parseAndValidateAskConfig('{}');
    return {
      path,
      exists: true,
      mtimeISO,
      config,
      rawText,
      warnings: [],
      parseError: (err as Error).message,
    };
  }
}
