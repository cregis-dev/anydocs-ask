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
 * skipped. Values defined in a .env file OVERRIDE any pre-existing
 * process.env entries — the workspace/project .env is the authoritative
 * source for anydocs-ask. Rationale: shell-rc exports for other tools
 * (e.g. Claude Code's ANTHROPIC_BASE_URL=https://api.anthropic.com)
 * silently mismatching the project's intended gateway is a footgun;
 * users who put a value in .env clearly intend it to take effect.
 * Precedence: <projectRoot>/.env beats <workspace>/.env beats shell.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runServe } from './commands/serve.ts';
import { runReindex } from './commands/reindex.ts';
import { runStatus } from './commands/status.ts';
import { runWorkspaceInit, runWorkspaceLs, runWorkspaceAdd, runWorkspaceRm } from './commands/workspace.ts';
import { runRunsExport, runRunsTail } from './commands/runs.ts';
import { runGoldenGenerate, runGoldenImport, runGoldenReview } from './commands/golden.ts';
import { runEval, runRetrievalEval } from './commands/eval.ts';
import { runAnalyzeRuns } from './commands/analyze.ts';
import { runConsole } from './commands/console.ts';
import {
  runFeedbackDiagnose,
  runFeedbackExport,
  runFeedbackImport,
  runFeedbackStatus,
} from './commands/feedback.ts';
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
  // Custom loader instead of process.loadEnvFile because (a) the latter
  // treats existing entries — even empty-string placeholders — as set, and
  // (b) we want .env to OVERRIDE shell exports, not the other way around.
  // Rationale: a global shell-rc `export ANTHROPIC_BASE_URL=...` for one
  // tool silently breaks another tool's local gateway config. If you've
  // gone to the trouble of writing a value into <workspace>/.env, you
  // clearly want it to take effect inside this command.
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`[ask] warning: failed to read ${path}: ${(err as Error).message}\n`);
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue; // comment / blank / unparseable
    const key = m[1]!;
    let val = m[2]!;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
  return true;
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
  anydocs-ask golden generate  <projectRoot> [--from structure|runs] [--limit N]
                                             [--since 14d] [--no-llm-rewrite] [--force]
                                             [--rewrite-batch-size N] [--include-console]
  anydocs-ask golden review    <projectRoot> [--reviewer <name>]
  anydocs-ask golden import    <projectRoot> --file <jsonl> [--replace]
  anydocs-ask eval             <projectRoot> [--baseline <path>] [--retrieval-only] [--no-router]
  anydocs-ask analyze runs     <projectRoot> [--since 7d] [--include-console]
  anydocs-ask feedback export   <projectRoot>
  anydocs-ask feedback import   <projectRoot>
  anydocs-ask feedback status   <projectRoot>
  anydocs-ask feedback diagnose <projectRoot> [--threshold N] [--observation-window 28d] [--shadow] [--dry-run]
  anydocs-ask workspace init
  anydocs-ask workspace ls
  anydocs-ask workspace add    <path> [--name <name>]
  anydocs-ask workspace rm     <name>
  anydocs-ask console          [--port 4100] [--idle-timeout-min 15]
  anydocs-ask --help

<projectRoot> may be a filesystem path or a bare name looked up in the
workspace registry (projects.json).  Register projects with:
  anydocs-ask workspace add <path>

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

  // `console` is workspace-scoped (no projectRoot); special-case before
  // the projectArg parsing below.
  if (command === 'console') {
    const ensured = ensureWorkspace(workspace.path);
    if (ensured.rootCreated) {
      process.stdout.write(`anydocs-ask: created workspace at ${workspace.path}\n`);
    }
    // Load <workspace>/.env so in-process console ops (eval/analyze/golden)
    // see ANTHROPIC_API_KEY etc. Spawned `serve` children additionally load
    // their own <projectRoot>/.env via the cli.ts serve branch below.
    const wsEnv = join(workspace.path, '.env');
    if (tryLoadEnvFile(wsEnv)) {
      process.stdout.write(`anydocs-ask: loaded env from ${wsEnv}\n`);
    }
    const portRaw = typeof flags.port === 'string' ? Number(flags.port) : undefined;
    const idleRaw =
      typeof flags['idle-timeout-min'] === 'string'
        ? Number(flags['idle-timeout-min'])
        : undefined;
    if (portRaw !== undefined && !Number.isInteger(portRaw)) {
      process.stderr.write(`error: --port must be an integer\n`);
      return 2;
    }
    if (idleRaw !== undefined && (!Number.isInteger(idleRaw) || idleRaw < 1)) {
      process.stderr.write(`error: --idle-timeout-min must be a positive integer\n`);
      return 2;
    }
    return await runConsole({
      workspace,
      ...(portRaw !== undefined ? { port: portRaw } : {}),
      ...(idleRaw !== undefined ? { idleTimeoutMin: idleRaw } : {}),
    });
  }

  // Workspace-management subcommand: positional[0] is the action (init / ls).
  if (command === 'workspace') {
    const action = positional[0];
    if (!action) {
      process.stderr.write(`error: 'workspace' requires an action (init | ls | add | rm)\n\n`);
      printHelp();
      return 2;
    }
    switch (action) {
      case 'init':
        return runWorkspaceInit({ workspace });
      case 'ls':
        return runWorkspaceLs({ workspace });
      case 'add': {
        const projectPath = positional[1];
        if (!projectPath) {
          process.stderr.write(`error: 'workspace add' requires a <path>\n\n`);
          printHelp();
          return 2;
        }
        const name = typeof flags.name === 'string' ? flags.name : undefined;
        return runWorkspaceAdd({ workspace, projectPath, name });
      }
      case 'rm': {
        const name = positional[1];
        if (!name) {
          process.stderr.write(`error: 'workspace rm' requires a <name>\n\n`);
          printHelp();
          return 2;
        }
        return runWorkspaceRm({ workspace, name });
      }
      default:
        process.stderr.write(`error: unknown workspace action '${action}'\n\n`);
        printHelp();
        return 2;
    }
  }

  // `runs <action> <projectRoot> ...` and `golden <action> <projectRoot>...`
  // both shift positional indices by 1.
  let runsAction: 'tail' | 'export' | null = null;
  let goldenAction: 'generate' | 'review' | 'import' | null = null;
  let analyzeAction: 'runs' | null = null;
  let feedbackAction: 'export' | 'import' | 'status' | 'diagnose' | null = null;
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
  } else if (command === 'analyze') {
    const action = positional[0];
    if (action !== 'runs') {
      process.stderr.write(`error: 'analyze' requires an action (runs)\n\n`);
      printHelp();
      return 2;
    }
    analyzeAction = action;
    projectArg = positional[1];
  } else if (command === 'golden') {
    const action = positional[0];
    if (action !== 'generate' && action !== 'review' && action !== 'import') {
      process.stderr.write(`error: 'golden' requires an action (generate | review | import)\n\n`);
      printHelp();
      return 2;
    }
    goldenAction = action;
    projectArg = positional[1];
  } else if (command === 'feedback') {
    const action = positional[0];
    if (
      action !== 'export' &&
      action !== 'import' &&
      action !== 'status' &&
      action !== 'diagnose'
    ) {
      process.stderr.write(
        `error: 'feedback' requires an action (export | import | status | diagnose)\n\n`,
      );
      printHelp();
      return 2;
    }
    feedbackAction = action;
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
        `  hint: '${projectResolution.bareName}' is not in the project registry\n` +
          `        run: anydocs-ask workspace add <path> --name ${projectResolution.bareName}\n`,
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
        const rewriteBatchSize =
          typeof flags['rewrite-batch-size'] === 'string'
            ? Number(flags['rewrite-batch-size'])
            : undefined;
        // --no-llm-rewrite parses as flags['no-llm-rewrite'] === true.
        const llmRewrite = flags['no-llm-rewrite'] !== true;
        const force = flags.force === true;
        const since = typeof flags.since === 'string' ? flags.since : undefined;
        const includeConsole = flags['include-console'] === true;
        return await runGoldenGenerate({
          projectRoot,
          stateRoot,
          from: fromRaw,
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(rewriteBatchSize !== undefined && Number.isFinite(rewriteBatchSize)
            ? { rewriteBatchSize }
            : {}),
          llmRewrite,
          force,
          ...(includeConsole ? { includeConsole: true } : {}),
        });
      }
      // golden review
      const reviewer = typeof flags.reviewer === 'string' ? flags.reviewer : undefined;
      if (goldenAction === 'review') {
        return runGoldenReview({
          projectRoot,
          stateRoot,
          ...(reviewer !== undefined ? { reviewer } : {}),
        });
      }
      const file = typeof flags.file === 'string' ? flags.file : undefined;
      if (!file) {
        process.stderr.write(`error: 'golden import' requires --file <jsonl>\n\n`);
        printHelp();
        return 2;
      }
      return runGoldenImport({
        projectRoot,
        stateRoot,
        file,
        ...(flags.replace === true ? { replace: true } : {}),
      });
    }
    case 'eval': {
      const baseline = typeof flags.baseline === 'string' ? flags.baseline : undefined;
      if (flags['retrieval-only'] === true) {
        return await runRetrievalEval({
          projectRoot,
          stateRoot,
          ...(baseline !== undefined ? { baselinePath: baseline } : {}),
          ...(flags['no-router'] === true ? { retrievalNoRouter: true } : {}),
        });
      }
      if (flags['no-router'] === true) {
        process.stderr.write(`error: --no-router requires --retrieval-only\n`);
        return 2;
      }
      return await runEval({
        projectRoot,
        stateRoot,
        ...(baseline !== undefined ? { baselinePath: baseline } : {}),
      });
    }
    case 'analyze': {
      // Only 'runs' action exists in v1; future actions (e.g. analyze golden)
      // would land here. analyzeAction is non-null per the dispatch above.
      void analyzeAction;
      const since = typeof flags.since === 'string' ? flags.since : undefined;
      const includeConsole = flags['include-console'] === true;
      return await runAnalyzeRuns({
        projectRoot,
        stateRoot,
        ...(since !== undefined ? { since } : {}),
        ...(includeConsole ? { includeConsole: true } : {}),
      });
    }
    case 'feedback': {
      switch (feedbackAction) {
        case 'export':
          return await runFeedbackExport({ projectRoot, stateRoot });
        case 'import':
          return await runFeedbackImport({ projectRoot, stateRoot });
        case 'status':
          return await runFeedbackStatus({ projectRoot, stateRoot });
        case 'diagnose': {
          // RFC 0006 alpha.0 stub — accepts --threshold / --observation-window
          // / --shadow / --dry-run flags but does not yet write suggestions/.
          const thresholdRaw = flags.threshold;
          const threshold =
            typeof thresholdRaw === 'string' ? Number(thresholdRaw) : undefined;
          if (threshold !== undefined && !Number.isFinite(threshold)) {
            process.stderr.write(`error: --threshold must be a number\n`);
            return 2;
          }
          const observationWindow =
            typeof flags['observation-window'] === 'string'
              ? (flags['observation-window'] as string)
              : undefined;
          return await runFeedbackDiagnose({
            projectRoot,
            stateRoot,
            ...(threshold !== undefined ? { threshold } : {}),
            ...(observationWindow !== undefined ? { observationWindow } : {}),
            shadow: flags.shadow === true,
            dryRun: flags['dry-run'] === true,
          });
        }
        default:
          // Unreachable — dispatch above guarantees feedbackAction is non-null.
          process.stderr.write(`error: missing feedback action\n`);
          return 2;
      }
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
