/**
 * `anydocs-ask workspace init|ls|add|rm` — manage the runtime workspace.
 *
 * `init` creates the workspace skeleton (state/); idempotent.
 * `ls`   lists registered projects from projects.json with validity / index state.
 * `add`  registers a project path (creates or updates projects.json entry).
 * `rm`   removes a project from the registry (state data is preserved).
 *
 * All subcommands honor `--workspace <path>` resolution from cli.ts.
 */

import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  addToProjectRegistry,
  assertProjectRoot,
  ensureWorkspace,
  ensureWorkspaceEnv,
  isBareName,
  readProjectRegistry,
  removeFromProjectRegistry,
  scanProjects,
  WORKSPACE_SUBDIRS,
  type WorkspaceResolution,
} from '../workspace.ts';

export type WorkspaceInitOptions = {
  workspace: WorkspaceResolution;
};

export function runWorkspaceInit(opts: WorkspaceInitOptions): number {
  const { workspace } = opts;
  const result = ensureWorkspace(workspace.path);
  if (result.rootCreated) {
    process.stdout.write(`anydocs-ask: created workspace at ${workspace.path}\n`);
  } else {
    process.stdout.write(`anydocs-ask: workspace already exists at ${workspace.path}\n`);
  }
  if (result.subdirsCreated.length > 0) {
    process.stdout.write(`  created subdirs: ${result.subdirsCreated.join(', ')}\n`);
  }
  for (const sub of WORKSPACE_SUBDIRS) {
    process.stdout.write(`  ${sub}/\n`);
  }
  process.stdout.write(`  (source: ${workspace.source})\n`);

  const envPath = join(workspace.path, '.env');
  const envCreated = ensureWorkspaceEnv(workspace.path);
  if (envCreated) {
    process.stdout.write(`\nanydocs-ask: created credential file at ${envPath}\n`);
    process.stdout.write(`  Fill in your API key before starting the service:\n`);
    process.stdout.write(`  $EDITOR ${envPath}\n`);
  } else {
    process.stdout.write(`\nanydocs-ask: credential file already exists at ${envPath}\n`);
  }

  return 0;
}

export type WorkspaceLsOptions = {
  workspace: WorkspaceResolution;
};

export function runWorkspaceLs(opts: WorkspaceLsOptions): number {
  const { workspace } = opts;
  if (!existsSync(workspace.path)) {
    process.stderr.write(
      `workspace not initialized at ${workspace.path}; run 'anydocs-ask workspace init' first.\n`,
    );
    return 1;
  }
  const projects = scanProjects(workspace.path);

  process.stdout.write(`anydocs-ask workspace: ${workspace.path}\n`);
  if (projects.length === 0) {
    process.stdout.write(`  (no projects registered — use 'workspace add <path>')\n`);
    return 0;
  }
  const nameWidth = Math.max(...projects.map((p) => p.name.length));
  for (const p of projects) {
    const tags = [p.valid ? 'valid' : `invalid (${p.missing.join(', ')})`];
    if (p.projectId && p.projectId !== p.name) tags.push(`id=${p.projectId}`);
    if (p.indexed) tags.push('indexed');
    process.stdout.write(`  ${p.name.padEnd(nameWidth)}  [${tags.join('] [')}]  ${p.path}\n`);
  }
  return 0;
}

export type WorkspaceAddOptions = {
  workspace: WorkspaceResolution;
  projectPath: string;
  name?: string;
};

export function runWorkspaceAdd(opts: WorkspaceAddOptions): number {
  const { workspace } = opts;

  // Expand ~ and resolve to absolute path
  const rawPath = opts.projectPath;
  const expandedPath =
    rawPath === '~'
      ? homedir()
      : rawPath.startsWith('~/')
        ? join(homedir(), rawPath.slice(2))
        : resolve(rawPath);

  // Validate it is a valid anydocs project before registering
  try {
    assertProjectRoot(expandedPath);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  const name = opts.name ?? basename(expandedPath);
  if (!isBareName(name)) {
    process.stderr.write(
      `error: project name '${name}' is not a valid bare name (must match [A-Za-z0-9_][A-Za-z0-9_.-]*)\n` +
        `  use --name to specify a valid name\n`,
    );
    return 2;
  }

  // Warn if name already registered to a different path
  const existing = readProjectRegistry(workspace.path);
  if (name in existing && existing[name] !== expandedPath) {
    process.stderr.write(
      `error: name '${name}' already registered at ${existing[name]}\n` +
        `  use --name to choose a different name, or re-run without --name to overwrite\n`,
    );
    return 2;
  }

  ensureWorkspace(workspace.path);
  addToProjectRegistry(workspace.path, expandedPath, name);
  process.stdout.write(`anydocs-ask: registered '${name}' → ${expandedPath}\n`);
  return 0;
}

export type WorkspaceRmOptions = {
  workspace: WorkspaceResolution;
  name: string;
};

export function runWorkspaceRm(opts: WorkspaceRmOptions): number {
  const removed = removeFromProjectRegistry(opts.workspace.path, opts.name);
  if (!removed) {
    process.stderr.write(
      `error: '${opts.name}' not found in registry\n` +
        `  run 'anydocs-ask workspace ls' to see registered projects\n`,
    );
    return 2;
  }
  process.stdout.write(
    `anydocs-ask: removed '${opts.name}' from registry (state data preserved)\n`,
  );
  return 0;
}
