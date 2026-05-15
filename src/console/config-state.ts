/**
 * Console Config view — ARCH §17.3.9.
 *
 * Read-only snapshot of the layered config sources that affect a
 * project at runtime:
 *   1. workspace `.env` (loaded by anydocs-ask before launching `serve`)
 *   2. workspace `.console.json` (idle reap / port range / etc.)
 *   3. per-project `anydocs.ask.json` (embedding / llm / retrieval / ...)
 *   4. per-project `ask.local.json` (gitignored local overrides)
 *
 * Secrets in `.env` (anything matching SECRET_KEYS_RE) are redacted to
 * `first4…last4`. Phase 1 ships read-only — inline edit is a Phase 2
 * question since it touches the v1 "console 自身零状态" lock.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_KEYS_RE = /(API_KEY|AUTH_TOKEN|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)$/i;

export type RedactedEnvEntry = {
  key: string;
  value: string;
  redacted: boolean;
};

export type ConfigViewModel = {
  workspaceEnv: ConfigFile<RedactedEnvEntry[]>;
  consoleJson: ConfigFile<unknown>;
  projectAskJson: ConfigFile<unknown> | null; // null when no project context (Home page)
  /** Per-project gitignored override. null when no project context (Home). */
  projectAskLocalJson: ConfigFile<unknown> | null;
};

export type ConfigFile<T> = {
  path: string;
  exists: boolean;
  mtimeISO: string | null;
  content: T | null;
  /** Raw text shown verbatim (after redaction for .env). null if absent. */
  rawText: string | null;
  error?: string;
};

export function loadConsoleConfigView(
  workspacePath: string,
  projectRoot: string | null,
): ConfigViewModel {
  const workspaceEnvPath = join(workspacePath, '.env');
  const consoleJsonPath = join(workspacePath, '.console.json');
  const projectAskPath = projectRoot ? join(projectRoot, 'anydocs.ask.json') : null;
  const projectAskLocalPath = projectRoot ? join(projectRoot, 'ask.local.json') : null;

  return {
    workspaceEnv: loadEnvFile(workspaceEnvPath),
    consoleJson: loadJsonFile(consoleJsonPath),
    projectAskJson: projectAskPath ? loadJsonFile(projectAskPath) : null,
    projectAskLocalJson: projectAskLocalPath ? loadJsonFile(projectAskLocalPath) : null,
  };
}

function loadEnvFile(path: string): ConfigFile<RedactedEnvEntry[]> {
  if (!existsSync(path)) {
    return { path, exists: false, mtimeISO: null, content: null, rawText: null };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const mtimeISO = new Date(statSync(path).mtimeMs).toISOString();
    const entries: RedactedEnvEntry[] = [];
    const redactedLines: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        redactedLines.push(line);
        continue;
      }
      const eq = line.indexOf('=');
      if (eq === -1) {
        redactedLines.push(line);
        continue;
      }
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      const isSecret = SECRET_KEYS_RE.test(key);
      const displayValue = isSecret ? maskSecret(value) : value;
      entries.push({ key, value: displayValue, redacted: isSecret });
      redactedLines.push(`${key}=${displayValue}`);
    }
    return {
      path,
      exists: true,
      mtimeISO,
      content: entries,
      rawText: redactedLines.join('\n'),
    };
  } catch (err) {
    return {
      path,
      exists: true,
      mtimeISO: null,
      content: null,
      rawText: null,
      error: (err as Error).message,
    };
  }
}

function loadJsonFile(path: string): ConfigFile<unknown> {
  if (!existsSync(path)) {
    return { path, exists: false, mtimeISO: null, content: null, rawText: null };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const mtimeISO = new Date(statSync(path).mtimeMs).toISOString();
    let content: unknown;
    try {
      content = JSON.parse(raw);
    } catch {
      // surface malformed but keep raw text
      return {
        path,
        exists: true,
        mtimeISO,
        content: null,
        rawText: raw,
        error: 'malformed JSON',
      };
    }
    return { path, exists: true, mtimeISO, content, rawText: raw };
  } catch (err) {
    return {
      path,
      exists: true,
      mtimeISO: null,
      content: null,
      rawText: null,
      error: (err as Error).message,
    };
  }
}

function maskSecret(value: string): string {
  if (value.length === 0) return '';
  if (value.length <= 8) return '***';
  // Keep first 4 + last 4 chars so the author can verify they're using the
  // right key without exposing it (design_handoff_console_redesign).
  return value.slice(0, 4) + '…' + value.slice(-4);
}
