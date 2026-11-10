// Git utilities for the OpenCode companion.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";

/**
 * Get the git repository root for a given directory.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getGitRoot(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Record the whole working tree (tracked and untracked, minus ignored files)
 * as a git tree object. A private index is used, so the user's index and
 * staged changes are never touched.
 * @param {string} cwd
 * @returns {Promise<string|null>} the tree id, or null outside a git repository
 */
export async function snapshotWorktree(cwd) {
  const indexPath = await runCommand("git", ["rev-parse", "--git-path", "index"], { cwd });
  if (indexPath.exitCode !== 0) return null;
  const realIndex = path.resolve(cwd, indexPath.stdout.trim());
  const privateIndex = path.join(os.tmpdir(), `opencode-companion-index-${crypto.randomUUID()}`);
  try {
    // Start from the real index so unchanged files are not hashed again.
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, privateIndex);
    const env = { GIT_INDEX_FILE: privateIndex };
    const add = await runCommand("git", ["add", "--all", "--", "."], { cwd, env });
    if (add.exitCode !== 0) return null;
    const tree = await runCommand("git", ["write-tree"], { cwd, env });
    return tree.exitCode === 0 ? tree.stdout.trim() : null;
  } finally {
    fs.rmSync(privateIndex, { force: true });
  }
}

/**
 * Compare two worktree snapshots.
 * @param {string} cwd
 * @param {string} before
 * @param {string} after
 * @returns {Promise<{ files: string[], stat: string }|null>}
 */
export async function diffSnapshots(cwd, before, after) {
  const [names, stat] = await Promise.all([
    runCommand("git", ["diff", "--name-only", "--no-renames", before, after], { cwd }),
    runCommand("git", ["diff", "--stat", "--no-renames", before, after], { cwd }),
  ]);
  if (names.exitCode !== 0 || stat.exitCode !== 0) return null;
  return {
    files: names.stdout.split(/\r?\n/).filter(Boolean),
    stat: stat.stdout.replace(/\s+$/, ""),
  };
}

/**
 * Files changed in the worktree since a snapshot taken with snapshotWorktree.
 * @param {string} cwd
 * @param {string|null|undefined} before
 * @returns {Promise<{ files: string[], stat: string }|null>} null when unknown
 */
export async function worktreeChanges(cwd, before) {
  if (!before) return null;
  const after = await snapshotWorktree(cwd);
  return after ? diffSnapshots(cwd, before, after) : null;
}
