/**
 * Runtime workspace resolution — ARCHITECTURE.md §16.1.
 *
 * The workspace is a host-level directory that holds two kinds of data,
 * each in its own top-level dir (双根分离, 2026-05-08 三次订正):
 *
 *   <workspace>/
 *   ├── .env                       # global credentials (ANTHROPIC_*, ...)
 *   ├── projects.json              # project registry: { name -> absolute path }
 *   └── state/<projectId>/         # RUNTIME: index.db, runs, golden, reports, ...
 *
 * Resolution order for the workspace path:
 *   1. `--workspace <path>` CLI flag (caller passes through)
 *   2. `$ANYDOCS_ASK_WORKSPACE` env var
 *   3. default `~/anydocs-ask-runtime/`
 *
 * Project-root arg resolution:
 *   - bare name (e.g. `docs-zh`)  -> looked up in projects.json registry
 *   - anything containing `/`, `\`, `.`, or starting with a path-like char
 *     is treated as a filesystem path and `path.resolve`d against cwd
 *
 * State-root resolution:
 *   - state-key  = projectId from <projectRoot>/anydocs.config.json
 *   - state-root = <workspace>/state/<state-key>/
 *
 * Both bare-name and path-form invocations land on the same state dir as
 * long as their projectId agrees — runtime data is fully decoupled from
 * source-repo location.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

/**
 * Minimal credential template written to <workspace>/.env on `workspace init`.
 * Single source of truth — do not duplicate in .env.example files.
 */
export const WORKSPACE_ENV_TEMPLATE = `# anydocs-ask workspace credentials
# Shared across all projects in this workspace.
# Shell exports > per-project .env > this file.

# Pick ONE auth path:

# (A) Native Anthropic API key — https://api.anthropic.com
ANTHROPIC_API_KEY=

# (B) Internal Anthropic-compatible gateway (Bearer auth + custom base URL)
# ANTHROPIC_AUTH_TOKEN=
# ANTHROPIC_BASE_URL=https://gateway.your-company.example.com
`;

export const WORKSPACE_SUBDIRS = ['state'] as const;
export type WorkspaceSubdir = (typeof WORKSPACE_SUBDIRS)[number];

export type WorkspaceResolution = {
  path: string;
  source: 'flag' | 'env' | 'default';
};

export type EnsureWorkspaceResult = {
  rootCreated: boolean;
  subdirsCreated: WorkspaceSubdir[];
};

export type ProjectRootResolution = {
  path: string;
  source: 'workspace' | 'path';
  bareName: string | null;
};

const BARE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function resolveWorkspace(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceResolution {
  if (flag && flag.length > 0) {
    return { path: resolve(flag), source: 'flag' };
  }
  const envVal = env.ANYDOCS_ASK_WORKSPACE;
  if (envVal && envVal.length > 0) {
    return { path: resolve(envVal), source: 'env' };
  }
  return { path: join(homedir(), 'anydocs-ask-runtime'), source: 'default' };
}

export function ensureWorkspace(workspacePath: string): EnsureWorkspaceResult {
  const rootCreated = !existsSync(workspacePath);
  if (rootCreated) {
    mkdirSync(workspacePath, { recursive: true });
  }
  const subdirsCreated: WorkspaceSubdir[] = [];
  for (const sub of WORKSPACE_SUBDIRS) {
    const p = join(workspacePath, sub);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      subdirsCreated.push(sub);
    }
  }
  return { rootCreated, subdirsCreated };
}

/**
 * Write WORKSPACE_ENV_TEMPLATE to <workspace>/.env if it does not already
 * exist. Returns true if the file was created, false if it was already there.
 * Never overwrites an existing file so that credentials are never clobbered.
 */
export function ensureWorkspaceEnv(workspacePath: string): boolean {
  const envPath = join(workspacePath, '.env');
  if (existsSync(envPath)) return false;
  writeFileSync(envPath, WORKSPACE_ENV_TEMPLATE, 'utf8');
  return true;
}

export function isBareName(arg: string): boolean {
  if (!arg || arg.length === 0) return false;
  if (isAbsolute(arg)) return false;
  if (arg.includes('/') || arg.includes('\\')) return false;
  return BARE_NAME_RE.test(arg);
}

export function resolveProjectRoot(arg: string, workspacePath: string): ProjectRootResolution {
  if (isBareName(arg)) {
    const registry = readProjectRegistry(workspacePath);
    return {
      path: registry[arg] ?? join(workspacePath, 'projects', arg),
      source: 'workspace',
      bareName: arg,
    };
  }
  return { path: resolve(arg), source: 'path', bareName: null };
}

// ---------------------------------------------------------------------------
// Project registry — projects.json
// ---------------------------------------------------------------------------

/** name → absolute project path */
export type ProjectRegistry = Record<string, string>;

const REGISTRY_FILENAME = 'projects.json';

export function readProjectRegistry(workspacePath: string): ProjectRegistry {
  const p = join(workspacePath, REGISTRY_FILENAME);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ProjectRegistry;
  } catch {
    return {};
  }
}

function writeProjectRegistry(workspacePath: string, registry: ProjectRegistry): void {
  const dest = join(workspacePath, REGISTRY_FILENAME);
  const tmp = dest + '.tmp';
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  renameSync(tmp, dest);
}

/**
 * Register a project in the workspace. `projectPath` must be absolute.
 * If `name` is omitted, the basename of `projectPath` is used.
 * Returns the name that was registered.
 */
export function addToProjectRegistry(
  workspacePath: string,
  projectPath: string,
  name?: string,
): string {
  const resolvedName = name ?? basename(projectPath);
  const registry = readProjectRegistry(workspacePath);
  registry[resolvedName] = projectPath;
  writeProjectRegistry(workspacePath, registry);
  return resolvedName;
}

/**
 * Remove a project from the registry by name. Returns true if it existed.
 * Never touches state/ data.
 */
export function removeFromProjectRegistry(workspacePath: string, name: string): boolean {
  const registry = readProjectRegistry(workspacePath);
  if (!(name in registry)) return false;
  delete registry[name];
  writeProjectRegistry(workspacePath, registry);
  return true;
}

/**
 * Verify a directory looks like a valid anydocs project — `pages/` and
 * `navigation/` must both exist. Throws with a friendly message if not.
 *
 * v1 indexer also enforces this lower in the stack, but we surface it
 * early so `serve docs-zh` fails fast if the workspace project is empty.
 */
export function assertProjectRoot(projectRoot: string): void {
  if (!existsSync(projectRoot)) {
    throw new Error(`project root does not exist: ${projectRoot}`);
  }
  const pages = join(projectRoot, 'pages');
  const navigation = join(projectRoot, 'navigation');
  const missing: string[] = [];
  if (!existsSync(pages)) missing.push('pages/');
  if (!existsSync(navigation)) missing.push('navigation/');
  if (missing.length > 0) {
    throw new Error(
      `${projectRoot} is not a valid anydocs project (missing: ${missing.join(', ')})`,
    );
  }
}

/**
 * Read `projectId` from `<projectRoot>/anydocs.config.json`. This id is the
 * stable key under `<workspace>/state/<projectId>/`, independent of the
 * source-side directory name (symlinks, renames, multiple checkouts can all
 * point at the same logical project).
 *
 * The id is constrained to filesystem-safe characters so it can be used as a
 * directory name verbatim. anydocs.config.json schema already enforces
 * non-empty string; we further reject any value containing path separators
 * to prevent state-dir traversal.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function loadProjectId(projectRoot: string): string {
  const configPath = join(projectRoot, 'anydocs.config.json');
  if (!existsSync(configPath)) {
    throw new Error(
      `anydocs.config.json not found at ${configPath} — required to derive the runtime state directory key`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `anydocs.config.json is not valid JSON (${(err as Error).message}): ${configPath}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`anydocs.config.json must be a JSON object: ${configPath}`);
  }
  const id = (parsed as { projectId?: unknown }).projectId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`anydocs.config.json: 'projectId' must be a non-empty string: ${configPath}`);
  }
  if (!PROJECT_ID_RE.test(id)) {
    throw new Error(
      `anydocs.config.json: 'projectId' must match ${PROJECT_ID_RE} (got '${id}'): ${configPath}`,
    );
  }
  return id;
}

/**
 * Compute the state directory for a project. Caller should mkdir-p before
 * the first write — `ensureStateRoot` does this idempotently.
 */
export function resolveStateRoot(workspacePath: string, projectId: string): string {
  return join(workspacePath, 'state', projectId);
}

export function ensureStateRoot(workspacePath: string, projectId: string): string {
  const stateRoot = resolveStateRoot(workspacePath, projectId);
  if (!existsSync(stateRoot)) {
    mkdirSync(stateRoot, { recursive: true });
  }
  return stateRoot;
}

export type ProjectListing = {
  /** Registered name in projects.json */
  name: string;
  /** Absolute path to the project root */
  path: string;
  /** pages/ + navigation/ both present */
  valid: boolean;
  /** Required dirs that are missing (subset of ['pages/', 'navigation/']) */
  missing: string[];
  /** projectId from anydocs.config.json, or null if missing/unreadable */
  projectId: string | null;
  /** state/<projectId>/index.db exists */
  indexed: boolean;
};

/**
 * Read projects.json and report each registered project's validity / index
 * state. Used by `workspace ls` and the dev console `GET /api/projects`.
 * Returns [] if projects.json does not exist or is empty.
 *
 * Sorted by name (locale order). Stale paths (not found on disk) are
 * included with valid=false so the console can surface them.
 */
export function scanProjects(workspacePath: string): ProjectListing[] {
  const registry = readProjectRegistry(workspacePath);
  const out: ProjectListing[] = [];

  for (const [name, projPath] of Object.entries(registry)) {
    if (!existsSync(projPath)) {
      out.push({ name, path: projPath, valid: false, missing: ['path not found'], projectId: null, indexed: false });
      continue;
    }
    const missing: string[] = [];
    if (!existsSync(join(projPath, 'pages'))) missing.push('pages/');
    if (!existsSync(join(projPath, 'navigation'))) missing.push('navigation/');
    const projectId = readProjectIdSafe(projPath);
    const indexed =
      projectId !== null &&
      existsSync(join(resolveStateRoot(workspacePath, projectId), 'index.db'));
    out.push({ name, path: projPath, valid: missing.length === 0, missing, projectId, indexed });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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
