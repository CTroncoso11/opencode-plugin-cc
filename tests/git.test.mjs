import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { getGitRoot, snapshotWorktree, worktreeChanges } from "../plugins/opencode/scripts/lib/git.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = createTmpDir("git-test");
  await runCommand("git", ["init"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: tmpDir });
  await runCommand("git", ["config", "core.autocrlf", "false"], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n");
  fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored/\n");
  await runCommand("git", ["add", "."], { cwd: tmpDir });
  await runCommand("git", ["commit", "-m", "init"], { cwd: tmpDir });
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("git", () => {
  it("getGitRoot returns the repo root", async () => {
    const root = await getGitRoot(tmpDir);
    assert.equal(path.resolve(root), fs.realpathSync(tmpDir));
  });

  it("getGitRoot returns null outside a repository", async () => {
    const outside = createTmpDir("git-none");
    try {
      assert.equal(await getGitRoot(outside), null);
      assert.equal(await snapshotWorktree(outside), null);
    } finally {
      cleanupTmpDir(outside);
    }
  });

  it("worktreeChanges lists only what changed after the snapshot", async () => {
    fs.writeFileSync(path.join(tmpDir, "before.txt"), "already dirty\n");
    await runCommand("git", ["add", "before.txt"], { cwd: tmpDir });
    const staged = (await runCommand("git", ["diff", "--cached", "--name-only"], { cwd: tmpDir })).stdout;
    const before = await snapshotWorktree(tmpDir);
    assert.match(before, /^[0-9a-f]{40,64}$/);

    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\nchanged\n");
    fs.writeFileSync(path.join(tmpDir, "new.txt"), "new\n");
    fs.mkdirSync(path.join(tmpDir, "ignored"));
    fs.writeFileSync(path.join(tmpDir, "ignored", "skip.txt"), "skip\n");

    const changes = await worktreeChanges(tmpDir, before);
    assert.deepEqual(changes.files, ["README.md", "new.txt"]);
    assert.match(changes.stat, /2 files changed, 2 insertions\(\+\)/);
    const stagedAfter = (await runCommand("git", ["diff", "--cached", "--name-only"], { cwd: tmpDir })).stdout;
    assert.equal(stagedAfter, staged, "the user's index is untouched");
  });

  it("worktreeChanges is null without a snapshot", async () => {
    assert.equal(await worktreeChanges(tmpDir, null), null);
  });
});
