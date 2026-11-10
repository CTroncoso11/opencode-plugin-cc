// Workspace detection for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";
import { getGitRoot } from "./git.mjs";
import { usageError } from "./errors.mjs";

/**
 * Resolve the workspace root directory: the git root of `cwd`, or `cwd`
 * itself outside a repository. Defaults to the process working directory.
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function resolveWorkspace(cwd) {
  const dir = path.resolve(cwd || process.cwd());
  if (cwd && !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw usageError(`Workspace directory does not exist: ${dir}`);
  }
  const gitRoot = await getGitRoot(dir);
  return gitRoot ? path.resolve(gitRoot) : dir;
}
