/**
 * `anydocs-ask workspace init|ls` — manage the runtime workspace.
 *
 * `init` creates the workspace skeleton (projects/ + state/); idempotent.
 * `ls`   lists `projects/*` and reports for each one whether it looks like
 *        a valid anydocs project (pages/ + navigation/) and whether it has
 *        been indexed (state/<projectId>/index.db exists).
 *
 * Both subcommands honor `--workspace <path>` resolution from cli.ts.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureWorkspace,
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
  return 0;
}

export type WorkspaceLsOptions = {
  workspace: WorkspaceResolution;
};

export function runWorkspaceLs(opts: WorkspaceLsOptions): number {
  const { workspace } = opts;
  if (!existsSync(join(workspace.path, 'projects'))) {
    process.stderr.write(
      `workspace not initialized at ${workspace.path}; run 'anydocs-ask workspace init' first.\n`,
    );
    return 1;
  }
  const projects = scanProjects(workspace.path);

  process.stdout.write(`anydocs-ask workspace: ${workspace.path}\n`);
  if (projects.length === 0) {
    process.stdout.write(`  (no projects in projects/)\n`);
    return 0;
  }
  const nameWidth = Math.max(...projects.map((p) => p.name.length));
  for (const p of projects) {
    const tags = [p.valid ? 'valid' : `invalid (${p.missing.join(', ')})`];
    if (p.projectId && p.projectId !== p.name) tags.push(`id=${p.projectId}`);
    if (p.indexed) tags.push('indexed');
    process.stdout.write(`  ${p.name.padEnd(nameWidth)}  [${tags.join('] [')}]\n`);
  }
  return 0;
}
