#!/usr/bin/env node
/**
 * anydocs-ask CLI
 *
 * Subcommands (PRD §5.5):
 *   serve   <projectRoot> [--port 3100] [--host 127.0.0.1]
 *   reindex <projectRoot>
 *   status  <projectRoot>
 *
 * v1 keeps the parser minimal — no commander/yargs dependency.
 *
 * Environment variables: each command tries to load `.env` files in order
 * (cwd/.env, then <projectRoot>/.env). Missing files are silently skipped.
 * Existing process.env entries are NOT overridden — explicit > file > nothing.
 */

import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runServe } from './commands/serve.ts';
import { runReindex } from './commands/reindex.ts';
import { runStatus } from './commands/status.ts';

function tryLoadEnvFile(path: string): boolean {
  if (!existsSync(path)) return false;
  // process.loadEnvFile is stable in Node 21.7+. We don't override existing
  // process.env entries (loadEnvFile's documented behavior), which is exactly
  // what we want: shell-exported vars beat .env beat nothing.
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    process.stderr.write(`[ask] warning: failed to read ${path}: ${(err as Error).message}\n`);
    return false;
  }
}

type ParsedArgs = {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [, , command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(tok);
    }
  }

  return { command, positional, flags };
}

function printHelp(): void {
  process.stdout.write(`anydocs-ask — local Q&A service for anydocs projects

Usage:
  anydocs-ask serve   <projectRoot> [--port 3100] [--host 127.0.0.1]
  anydocs-ask reindex <projectRoot>
  anydocs-ask status  <projectRoot>
  anydocs-ask --help

Defaults:
  --host 127.0.0.1
  --port 3100

See PRD.md / ARCHITECTURE.md in the package for design details.
`);
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }

  const projectRoot = positional[0];
  if (!projectRoot) {
    process.stderr.write(`error: missing <projectRoot>\n\n`);
    printHelp();
    return 2;
  }

  // Load .env files BEFORE constructing the runtime so AnthropicLLM /
  // gateway credentials are visible. cwd first (developer-machine .env),
  // then projectRoot/.env (per-project gateway pin) — projectRoot wins
  // because it's loaded second and process.loadEnvFile leaves existing
  // values untouched, but new keys land.
  const cwdEnv = resolve(process.cwd(), '.env');
  const projEnv = join(resolve(projectRoot), '.env');
  const cwdLoaded = tryLoadEnvFile(cwdEnv);
  const projLoaded = projEnv !== cwdEnv ? tryLoadEnvFile(projEnv) : false;
  if (cwdLoaded || projLoaded) {
    const sources = [cwdLoaded ? cwdEnv : null, projLoaded ? projEnv : null]
      .filter(Boolean)
      .join(', ');
    process.stdout.write(`anydocs-ask: loaded env from ${sources}\n`);
  }

  switch (command) {
    case 'serve':
      return await runServe({
        projectRoot,
        host: typeof flags.host === 'string' ? flags.host : undefined,
        port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
      });
    case 'reindex':
      return await runReindex({ projectRoot });
    case 'status':
      return await runStatus({ projectRoot });
    default:
      process.stderr.write(`error: unknown command '${command}'\n\n`);
      printHelp();
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`fatal: ${msg}\n`);
    process.exit(1);
  },
);
