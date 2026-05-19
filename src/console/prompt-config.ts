/**
 * Project prompt configuration helpers for the web console.
 *
 * The source of truth remains `<project>/anydocs.ask.json`; the console only
 * edits the additive `prompt` section and preserves all other config keys.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizePromptConfig,
  type PromptConfig,
} from '../config.ts';

export type PromptConfigView = {
  path: string;
  exists: boolean;
  prompt: PromptConfig;
  warnings: string[];
  error: string | null;
};

export function promptConfigPath(projectRoot: string): string {
  return join(projectRoot, 'anydocs.ask.json');
}

export function readProjectPromptConfig(projectRoot: string): PromptConfigView {
  const path = promptConfigPath(projectRoot);
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      prompt: { assistantName: null, systemInstructions: [] },
      warnings: [],
      error: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      path,
      exists: true,
      prompt: { assistantName: null, systemInstructions: [] },
      warnings: [],
      error: `invalid JSON: ${(err as Error).message}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      path,
      exists: true,
      prompt: { assistantName: null, systemInstructions: [] },
      warnings: [],
      error: 'anydocs.ask.json must be a JSON object',
    };
  }

  const warnings: string[] = [];
  const prompt = normalizePromptConfig((parsed as Record<string, unknown>).prompt, warnings);
  return { path, exists: true, prompt, warnings, error: null };
}

export function writeProjectPromptConfig(
  projectRoot: string,
  prompt: PromptConfig,
): PromptConfig {
  const path = promptConfigPath(projectRoot);
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('anydocs.ask.json must be a JSON object');
    }
    root = parsed as Record<string, unknown>;
  }

  root.prompt = {
    assistantName: prompt.assistantName,
    systemInstructions: prompt.systemInstructions,
  };
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return prompt;
}

export function parsePromptConfigBody(body: unknown): PromptConfig {
  return parsePromptConfigBodyWithWarnings(body).prompt;
}

export function parsePromptConfigBodyWithWarnings(
  body: unknown,
): { prompt: PromptConfig; warnings: string[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('request body must be a JSON object');
  }
  const obj = body as Record<string, unknown>;
  let assistantName: string | null | undefined;
  if (obj.assistantName !== undefined && obj.assistantName !== null) {
    if (typeof obj.assistantName !== 'string') {
      throw new Error('assistantName must be a string or null');
    }
    const trimmed = obj.assistantName.trim();
    assistantName = trimmed.length > 0 ? trimmed : null;
  } else if (obj.assistantName === null) {
    assistantName = null;
  }

  const rawInstructions = obj.systemInstructions ?? [];
  if (!Array.isArray(rawInstructions)) {
    throw new Error('systemInstructions must be an array of strings');
  }
  const systemInstructions: string[] = [];
  for (const item of rawInstructions) {
    if (typeof item !== 'string') {
      throw new Error('systemInstructions must be an array of strings');
    }
    systemInstructions.push(item);
  }
  const warnings: string[] = [];
  const prompt = normalizePromptConfig({ assistantName, systemInstructions }, warnings);
  return { prompt, warnings };
}
