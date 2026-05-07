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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureWorkspace,
  resolveStateRoot,
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

type ProjectListing = {
  name: string;
  valid: boolean;
  indexed: boolean;
  missing: string[];
  projectId: string | null;
};

export function runWorkspaceLs(opts: WorkspaceLsOptions): number {
  const { workspace } = opts;
  const projectsDir = join(workspace.path, 'projects');
  if (!existsSync(projectsDir)) {
    process.stderr.write(
      `workspace not initialized at ${workspace.path}; run 'anydocs-ask workspace init' first.\n`,
    );
    return 1;
  }
  const entries = readdirSync(projectsDir, { withFileTypes: true });
  const projects: ProjectListing[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const projPath = join(projectsDir, ent.name);
    let isDir = false;
    try {
      isDir = statSync(projPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const missing: string[] = [];
    if (!existsSync(join(projPath, 'pages'))) missing.push('pages/');
    if (!existsSync(join(projPath, 'navigation'))) missing.push('navigation/');

    const projectId = readProjectIdSafe(projPath);
    const indexed =
      projectId !== null && existsSync(join(resolveStateRoot(workspace.path, projectId), 'index.db'));

    projects.push({
      name: ent.name,
      valid: missing.length === 0,
      indexed,
      missing,
      projectId,
    });
  }

  process.stdout.write(`anydocs-ask workspace: ${workspace.path}\n`);
  if (projects.length === 0) {
    process.stdout.write(`  (no projects in projects/)\n`);
    return 0;
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.max(...projects.map((p) => p.name.length));
  for (const p of projects) {
    const tags = [p.valid ? 'valid' : `invalid (${p.missing.join(', ')})`];
    if (p.projectId && p.projectId !== p.name) tags.push(`id=${p.projectId}`);
    if (p.indexed) tags.push('indexed');
    process.stdout.write(`  ${p.name.padEnd(nameWidth)}  [${tags.join('] [')}]\n`);
  }
  return 0;
}

function readProjectIdSafe(projPath: string): string | null {
  const configPath = join(projPath, 'anydocs.config.json');
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { projectId?: unknown };
    return typeof parsed.projectId === 'string' && parsed.projectId.length > 0
      ? parsed.projectId
      : null;
  } catch {
    return null;
  }
}
