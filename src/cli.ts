#!/usr/bin/env node
/**
 * anydocs-ask CLI
 *
 * Subcommands (PRD §5.5 / §12):
 *   serve   <projectRoot> [--port 3100] [--host 127.0.0.1]
 *   reindex <projectRoot>
 *   status  <projectRoot>
 *   workspace init
 *   workspace ls
 *
 * Global flags:
 *   --workspace <path>   override the runtime workspace (else
 *                        $ANYDOCS_ASK_WORKSPACE, else ~/anydocs-ask-runtime)
 *
 * <projectRoot> accepts either:
 *   - a filesystem path (absolute or relative to cwd) — v1 legacy behavior
 *   - a bare name (e.g. `docs-zh`) — resolved as
 *     `<workspace>/projects/<name>` (ARCH §16.1)
 *
 * Runtime data (index.db / runs / golden / reports) always lives under
 * `<workspace>/state/<projectId>/`, where projectId is read from
 * `<projectRoot>/anydocs.config.json`. Source repos stay clean.
 *
 * v1 keeps the parser minimal — no commander/yargs dependency.
 *
 * Environment variables: each command loads `.env` files in order
 * (<workspace>/.env, then <projectRoot>/.env). Missing files are silently
 * skipped. Existing process.env entries are NOT overridden — shell exports
 * beat <projectRoot>/.env beat <workspace>/.env beat nothing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runServe } from './commands/serve.ts';
import { runReindex } from './commands/reindex.ts';
import { runStatus } from './commands/status.ts';
import { runWorkspaceInit, runWorkspaceLs } from './commands/workspace.ts';
import { runRunsExport, runRunsTail } from './commands/runs.ts';
import { runGoldenGenerate, runGoldenReview } from './commands/golden.ts';
import { runEval } from './commands/eval.ts';
import {
  assertProjectRoot,
  ensureStateRoot,
  ensureWorkspace,
  loadProjectId,
  resolveProjectRoot,
  resolveStateRoot,
  resolveWorkspace,
} from './workspace.ts';

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
  anydocs-ask serve            <projectRoot> [--port 3100] [--host 127.0.0.1]
  anydocs-ask reindex          <projectRoot>
  anydocs-ask status           <projectRoot>
  anydocs-ask runs tail        <projectRoot> [--n 50]
  anydocs-ask runs export      <projectRoot> --since <when> [--format jsonl|csv]
  anydocs-ask golden generate  <projectRoot> [--from structure] [--limit N]
                                             [--no-llm-rewrite] [--force]
  anydocs-ask golden review    <projectRoot> [--reviewer <name>]
  anydocs-ask eval             <projectRoot> [--baseline <path>]
  anydocs-ask workspace init
  anydocs-ask workspace ls
  anydocs-ask --help

<projectRoot> may be a filesystem path or a bare name resolved against
the runtime workspace (default: ~/anydocs-ask-runtime/projects/<name>).

--since accepts ISO date (2026-04-01), ISO datetime, or duration (7d / 48h / 30m).

Global flags:
  --workspace <path>   override the runtime workspace path
                       (else $ANYDOCS_ASK_WORKSPACE, else ~/anydocs-ask-runtime)

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

  const workspaceFlag = typeof flags.workspace === 'string' ? flags.workspace : undefined;
  const workspace = resolveWorkspace(workspaceFlag);

  // Workspace-management subcommand: positional[0] is the action (init / ls).
  if (command === 'workspace') {
    const action = positional[0];
    if (!action) {
      process.stderr.write(`error: 'workspace' requires an action (init | ls)\n\n`);
      printHelp();
      return 2;
    }
    switch (action) {
      case 'init':
        return runWorkspaceInit({ workspace });
      case 'ls':
        return runWorkspaceLs({ workspace });
      default:
        process.stderr.write(`error: unknown workspace action '${action}'\n\n`);
        printHelp();
        return 2;
    }
  }

  // `runs <action> <projectRoot> ...` and `golden <action> <projectRoot>...`
  // both shift positional indices by 1.
  let runsAction: 'tail' | 'export' | null = null;
  let goldenAction: 'generate' | 'review' | null = null;
  let projectArg: string | undefined;
  if (command === 'runs') {
    const action = positional[0];
    if (action !== 'tail' && action !== 'export') {
      process.stderr.write(`error: 'runs' requires an action (tail | export)\n\n`);
      printHelp();
      return 2;
    }
    runsAction = action;
    projectArg = positional[1];
  } else if (command === 'golden') {
    const action = positional[0];
    if (action !== 'generate' && action !== 'review') {
      process.stderr.write(`error: 'golden' requires an action (generate | review)\n\n`);
      printHelp();
      return 2;
    }
    goldenAction = action;
    projectArg = positional[1];
  } else {
    projectArg = positional[0];
  }
  if (!projectArg) {
    process.stderr.write(`error: missing <projectRoot>\n\n`);
    printHelp();
    return 2;
  }

  const projectResolution = resolveProjectRoot(projectArg, workspace.path);

  // 双根分离 (ARCH §16.1): every command needs both source-side projectRoot
  // and runtime-side stateRoot; the latter always lives under <workspace>/.
  // We therefore always ensure the workspace exists before any command (only
  // `workspace ls` skipped this above). This is a deliberate change from
  // earlier behavior where path-form invocations could avoid touching $HOME.
  const ensured = ensureWorkspace(workspace.path);
  if (ensured.rootCreated) {
    process.stdout.write(`anydocs-ask: created workspace at ${workspace.path}\n`);
  }

  // Friendly early-fail if the resolved project root isn't a valid anydocs
  // project. Lower layers (loadConfig / Runtime) would also catch this, but
  // their error surfaces are noisier.
  try {
    assertProjectRoot(projectResolution.path);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    if (projectResolution.source === 'workspace') {
      process.stderr.write(
        `  hint: bare name '${projectResolution.bareName}' resolved to ${projectResolution.path}\n` +
          `        place an anydocs project there, or pass an explicit path instead.\n`,
      );
    }
    return 2;
  }

  const projectRoot = projectResolution.path;

  // Resolve state-root from anydocs.config.json projectId (ARCH §16.1.2).
  let projectId: string;
  try {
    projectId = loadProjectId(projectRoot);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const stateRoot = ensureStateRoot(workspace.path, projectId);

  // Load .env files BEFORE constructing the runtime so AnthropicLLM /
  // gateway credentials are visible. workspace/.env first (low precedence,
  // shared across projects), then projectRoot/.env (per-project override).
  // process.loadEnvFile leaves already-set vars untouched → shell exports
  // beat projectRoot beat workspace beat nothing. cwd/.env is intentionally
  // not consulted (avoids shell-position-dependent behavior).
  const wsEnv = join(workspace.path, '.env');
  const projEnv = join(projectRoot, '.env');
  const wsLoaded = tryLoadEnvFile(wsEnv);
  const projLoaded = projEnv !== wsEnv ? tryLoadEnvFile(projEnv) : false;
  if (wsLoaded || projLoaded) {
    const sources = [wsLoaded ? wsEnv : null, projLoaded ? projEnv : null]
      .filter(Boolean)
      .join(', ');
    process.stdout.write(`anydocs-ask: loaded env from ${sources}\n`);
  }

  switch (command) {
    case 'serve':
      return await runServe({
        projectRoot,
        stateRoot,
        host: typeof flags.host === 'string' ? flags.host : undefined,
        port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
      });
    case 'reindex':
      return await runReindex({ projectRoot, stateRoot });
    case 'status':
      return await runStatus({ projectRoot, stateRoot });
    case 'runs': {
      if (runsAction === 'tail') {
        // -n / --n / --count all map to flags.n via the rough parser; for
        // the dash-n form the user must currently use `--n` (single-dash
        // -n is not parsed as a flag — see help). v1 keeps the surface
        // small; promoting to a real arg parser is a v1.5 question.
        const nRaw = typeof flags.n === 'string'
          ? flags.n
          : typeof flags.count === 'string'
            ? flags.count
            : undefined;
        const n = nRaw !== undefined ? Number(nRaw) : undefined;
        return runRunsTail({ projectRoot, stateRoot, count: n });
      }
      const since = typeof flags.since === 'string' ? flags.since : null;
      if (!since) {
        process.stderr.write(`error: 'runs export' requires --since <when>\n\n`);
        printHelp();
        return 2;
      }
      const format = flags.format === 'csv' ? 'csv' : 'jsonl';
      return runRunsExport({ projectRoot, stateRoot, since, format });
    }
    case 'golden': {
      if (goldenAction === 'generate') {
        const fromRaw = typeof flags.from === 'string' ? flags.from : 'structure';
        if (fromRaw !== 'structure' && fromRaw !== 'runs' && fromRaw !== 'inbox') {
          process.stderr.write(`error: --from must be one of: structure | runs | inbox\n`);
          return 2;
        }
        const limit = typeof flags.limit === 'string' ? Number(flags.limit) : undefined;
        // --no-llm-rewrite parses as flags['no-llm-rewrite'] === true.
        const llmRewrite = flags['no-llm-rewrite'] !== true;
        const force = flags.force === true;
        return await runGoldenGenerate({
          projectRoot,
          stateRoot,
          from: fromRaw,
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
          llmRewrite,
          force,
        });
      }
      // golden review
      const reviewer = typeof flags.reviewer === 'string' ? flags.reviewer : undefined;
      return runGoldenReview({
        projectRoot,
        stateRoot,
        ...(reviewer !== undefined ? { reviewer } : {}),
      });
    }
    case 'eval': {
      const baseline = typeof flags.baseline === 'string' ? flags.baseline : undefined;
      return await runEval({
        projectRoot,
        stateRoot,
        ...(baseline !== undefined ? { baselinePath: baseline } : {}),
      });
    }
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
