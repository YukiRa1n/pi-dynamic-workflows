/**
 * Filesystem layout for pi-dynamic-workflows state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered `.pi/workflows` directories. Project-scoped state is still isolated
 * by a stable cwd-derived namespace.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { WORKFLOW_RUNS_DIR, WORKFLOW_SAVED_DIR } from "./config.js";

export const WORKFLOW_HOME_RELATIVE_DIR = ".pi/workflows";
export const WORKFLOW_PROJECTS_SUBDIR = "projects";

export interface WorkflowProjectPaths {
  key: string;
  rootDir: string;
  runsDir: string;
  savedDir: string;
  settingsPath: string;
  legacyRunsDir: string;
  legacySavedDir: string;
}

export function workflowHomeDir(): string {
  return join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}

export function workflowUserSavedDir(): string {
  return join(workflowHomeDir(), "saved");
}

export function workflowProjectKey(cwd: string): string {
  const projectPath = canonicalProjectPath(cwd);
  const pathApi = isWindowsPath(cwd) ? win32 : posix;
  const slug = sanitizePathSegment(pathApi.basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

/**
 * Make the project namespace stable for equivalent Windows spellings. Windows
 * paths are case-insensitive and accept either slash character; hashing the
 * host-normalized input directly otherwise creates separate state directories
 * for `C:\\Work\\App`, `c:/work/app`, and paths containing dot segments.
 */
function canonicalProjectPath(cwd: string): string {
  const windows = isWindowsPath(cwd);
  if (!windows) {
    // Do not lower-case POSIX paths: unlike Windows, case is part of identity.
    return resolve(cwd);
  }

  // `win32.resolve()` gives drive-relative paths and dot segments the same
  // meaning as the Windows path APIs.  Strip the two namespace prefixes that
  // are aliases rather than part of the project identity, then canonicalize
  // separators, drive casing, and Windows' trailing-dot/space aliases before
  // hashing.  This also makes equivalent spellings work when tests exercise
  // Windows paths on a non-Windows host.
  const isUncNamespace =
    cwd.length >= 8 &&
    cwd[0] === "\\" &&
    cwd[1] === "\\" &&
    cwd[2] === "?" &&
    cwd[3] === "\\" &&
    cwd.slice(4, 8).toLowerCase() === "unc\\";
  const withoutNamespace = isUncNamespace
    ? cwd.slice(0, 2) + cwd.slice(8)
    : cwd.replace(/^\\\\[?\\.]\\/i, "");
  const normalized = win32.normalize(win32.resolve(withoutNamespace));
  const trimmed = normalized
    .split("\\")
    .map((segment, index) => (index === 0 ? segment : segment.replace(/[. ]+$/g, "")))
    .join("\\");
  return trimmed.toLowerCase();
}

function isWindowsPath(value: string): boolean {
  return process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function workflowProjectPaths(cwd: string): WorkflowProjectPaths {
  const key = workflowProjectKey(cwd);
  const rootDir = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR, key);
  return {
    key,
    rootDir,
    runsDir: join(rootDir, "runs"),
    savedDir: join(rootDir, "saved"),
    settingsPath: join(rootDir, "settings.json"),
    legacyRunsDir: resolve(cwd, WORKFLOW_RUNS_DIR),
    legacySavedDir: resolve(cwd, WORKFLOW_SAVED_DIR),
  };
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}
