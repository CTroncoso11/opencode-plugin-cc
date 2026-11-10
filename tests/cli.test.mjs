import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { cli, serveV2 } from "./v2-fixture.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

const TRICKY_PROMPT = [
  `Line 1: "double" and 'single' quotes, $HOME and \`backticks\``,
  "Line 2: a & b | c ; d %PATH% !bang! ^caret <in> >out",
  "Line 3: trailing backslash \\",
].join("\n");

const JOB_VIEW_KEYS = [
  "id", "type", "status", "phase", "agent", "model", "workspace", "opencodeSessionId", "claudeSessionId",
  "createdAt", "updatedAt", "completedAt", "elapsedMs", "elapsed", "filesChanged", "errorMessage",
  "logFile", "progressPreview", "breadcrumb",
];

async function gitRepo(t) {
  const dir = createTmpDir("opencode-repo");
  t.after(() => cleanupTmpDir(dir));
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "T"], ["config", "core.autocrlf", "false"]]) {
    await runCommand("git", args, { cwd: dir });
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  await runCommand("git", ["add", "."], { cwd: dir });
  await runCommand("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return fs.realpathSync(dir);
}

function sessionCalls(calls, suffix) {
  return calls.filter((c) => c.path.startsWith("/api/session/") && c.path.endsWith(suffix));
}

test("foreground and detached CLI tasks honor --model and report the model and agent", async (t) => {
  const { baseUrl, calls } = await serveV2(t);
  const run = cli(t, baseUrl);
  const foreground = await run("task", "--model", "vendor/requested#high", "Reply with the final output");
  assert.equal(foreground.exitCode, 0, foreground.stderr);
  assert.equal(foreground.stderr, "", "stderr stays quiet on success");
  assert.match(foreground.stdout, /Final V2 output/);
  assert.match(foreground.stdout, /- \*\*Model\*\*: vendor\/requested#high/);
  assert.match(foreground.stdout, /- \*\*Agent\*\*: build/);
  assert.match(foreground.stdout, /- \*\*OpenCode Session\*\*: ses_fixture/);
  assert.match(foreground.stdout, /- \*\*Duration\*\*: \S+/);
  assert.match(foreground.stdout, /- \*\*Files Changed\*\*: /);

  const background = await run("task", "--background", "--model", "vendor/requested#high", "Reply with the final output");
  assert.equal(background.exitCode, 0, background.stderr);
  assert.equal(background.stderr, "");
  const jobID = background.stdout.match(/background: (\S+)/)[1];
  const result = await run("wait-and-result", jobID, "--max-wait", "10");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Final V2 output/);
  assert.match(result.stdout, /- \*\*Model\*\*: vendor\/requested#high/);
  const switches = sessionCalls(calls, "/model");
  assert.equal(switches.length, 2);
  for (const call of switches) {
    assert.deepEqual(call.body, { model: { providerID: "vendor", id: "requested", variant: "high" } });
  }
  const prompts = sessionCalls(calls, "/prompt");
  assert.equal(prompts.length, 2);
  for (const call of prompts) {
    assert.equal(call.body.text, "Reply with the final output");
  }
});

test("multi-line prompts with shell characters arrive intact from --prompt-file, stdin and argv", async (t) => {
  const { baseUrl, calls } = await serveV2(t);
  const run = cli(t, baseUrl);
  const promptFile = path.join(run.dataDir, "prompt.txt");
  fs.writeFileSync(promptFile, `﻿${TRICKY_PROMPT}\n`);

  const background = await run("task", "--background", "--prompt-file", promptFile);
  assert.equal(background.exitCode, 0, background.stderr);
  const jobID = background.stdout.match(/background: (\S+)/)[1];
  assert.equal((await run("wait-and-result", jobID, "--max-wait", "10")).exitCode, 0);

  const stdin = await run.exec({ input: TRICKY_PROMPT }, "task", "--prompt-file", "-");
  assert.equal(stdin.exitCode, 0, stdin.stderr);
  const argv = await run("task", "--", TRICKY_PROMPT);
  assert.equal(argv.exitCode, 0, argv.stderr);

  const prompts = sessionCalls(calls, "/prompt").map((c) => c.body.text);
  assert.deepEqual(prompts, [TRICKY_PROMPT, TRICKY_PROMPT, TRICKY_PROMPT]);

  const both = await run("task", "--prompt-file", promptFile, "extra words");
  assert.equal(both.exitCode, 3);
  const missing = await run("task", "--prompt-file", path.join(run.dataDir, "nope.txt"));
  assert.equal(missing.exitCode, 3);
  assert.match(missing.stderr, /Cannot read prompt file .*ENOENT/);
  const empty = await run("task");
  assert.equal(empty.exitCode, 3);
  assert.match(empty.stderr, /^opencode-companion task: No task text\. .*\n$/);
});

test("--cwd picks the workspace and status/result/wait find a job by ID from any folder", async (t) => {
  const repo = await gitRepo(t);
  fs.writeFileSync(path.join(repo, "dirty-before.txt"), "not ours\n");
  const { baseUrl } = await serveV2(t, {
    onPrompt: () => fs.writeFileSync(path.join(repo, "made-by-opencode.txt"), "one\ntwo\n"),
  });
  const run = cli(t, baseUrl);
  const elsewhere = createTmpDir("opencode-elsewhere");
  t.after(() => cleanupTmpDir(elsewhere));

  const started = await run("task", "--background", "--cwd", repo, "Write a file");
  assert.equal(started.exitCode, 0, started.stderr);
  assert.match(started.stdout, new RegExp(`Workspace: ${repo.replace(/\\/g, "\\\\")}`));
  const jobID = started.stdout.match(/background: (\S+)/)[1];

  const waited = await run.exec({ cwd: elsewhere }, "wait-and-result", jobID, "--max-wait", "10");
  assert.equal(waited.exitCode, 0, waited.stderr);
  assert.match(waited.stdout, /- \*\*Files Changed\*\*: 1 file changed, 2 insertions\(\+\)/);
  assert.match(waited.stdout, /made-by-opencode\.txt/);
  assert.doesNotMatch(waited.stdout, /dirty-before\.txt/, "changes made before the job are not reported");

  const status = await run.exec({ cwd: elsewhere }, "status", jobID, "--json");
  assert.equal(status.exitCode, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.workspaceRoot, repo);
  assert.deepEqual(Object.keys(parsed.job), JOB_VIEW_KEYS);
  assert.equal(parsed.job.status, "completed");
  assert.equal(parsed.job.workspace, repo);
  assert.deepEqual(parsed.job.filesChanged.files, ["made-by-opencode.txt"]);
  assert.equal(JSON.stringify(parsed).includes("Write a file"), false, "the prompt stays out of status");

  const result = await run.exec({ cwd: elsewhere }, "result", jobID.slice(0, -2));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`## Job: ${jobID}`));

  for (const flag of [["--workspace", repo], [`--cwd=${repo}`]]) {
    const listed = await run.exec({ cwd: elsewhere }, "status", "--json", "--all", ...flag);
    assert.equal(JSON.parse(listed.stdout).recent[0].id, jobID);
  }
  const bad = await run("status", "--cwd", path.join(elsewhere, "missing"));
  assert.equal(bad.exitCode, 3);
  assert.match(bad.stderr, /Workspace directory does not exist/);
});

test("default model comes from OPENCODE_PLUGIN_MODEL, then config; bad models fail before a job exists", async (t) => {
  const fromEnv = await serveV2(t);
  const envRun = cli(t, fromEnv.baseUrl, { OPENCODE_PLUGIN_MODEL: "env/model" });
  const envTask = await envRun("task", "Hello");
  assert.equal(envTask.exitCode, 0, envTask.stderr);
  assert.match(envTask.stdout, /- \*\*Model\*\*: env\/model/);
  assert.deepEqual(sessionCalls(fromEnv.calls, "/model")[0].body, { model: { providerID: "env", id: "model" } });

  const saved = await serveV2(t);
  const run = cli(t, saved.baseUrl, { OPENCODE_PLUGIN_MODEL: "" });
  const set = await run("config", "--set-model", "saved/model", "--json");
  assert.equal(set.exitCode, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout).defaultModel, { value: "saved/model", source: "config" });
  assert.match((await run("task", "Hello")).stdout, /- \*\*Model\*\*: saved\/model/);
  assert.match((await run("task", "--model", "vendor/requested", "Hello")).stdout, /- \*\*Model\*\*: vendor\/requested/);

  const unknown = await run("task", "--model", "vendor/typo", "Hello");
  assert.equal(unknown.exitCode, 3);
  assert.equal(unknown.stderr.trim().split("\n").length, 1);
  assert.match(unknown.stderr, /Unknown model "vendor\/typo"\. Provider "vendor" has no model "typo"/);
  assert.equal((await run("config", "--set-model", "nope")).exitCode, 3);
  const jobs = JSON.parse((await run("status", "--json", "--all")).stdout);
  assert.equal(jobs.recent.length, 2, "the rejected task left no job behind");

  await run("config", "--unset-model");
  assert.match((await run("task", "--agent", "plan", "Hello")).stdout, /- \*\*Model\*\*: cfg\/agent-model/);
});

test("exit codes: usage 3, not found 4, still running 2, and cancel stops the job", async (t) => {
  const { baseUrl, calls } = await serveV2(t, { active: true });
  const run = cli(t, baseUrl);
  const typo = await run("task", "--modle", "x/y", "Hello");
  assert.equal(typo.exitCode, 3);
  assert.match(typo.stderr, /Unknown option --modle/);
  assert.equal((await run("bogus")).exitCode, 3);
  assert.equal((await run("wait-and-result", "task-missing")).exitCode, 4);
  const missing = await run("status", "task-missing", "--json");
  assert.equal(missing.exitCode, 4);
  assert.equal(JSON.parse(missing.stdout).error, "not_found");
  assert.equal((await run("wait-and-result", "x", "--max-wait", "0")).exitCode, 3);

  const started = await run("task", "--background", "Never finishes");
  const jobID = started.stdout.match(/background: (\S+)/)[1];
  const waited = await run("wait-and-result", jobID, "--max-wait", "1");
  assert.equal(waited.exitCode, 2, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).status, "running");
  assert.equal((await run("result", jobID)).exitCode, 2);

  const cancelled = await run("cancel", jobID);
  assert.equal(cancelled.exitCode, 0, cancelled.stderr);
  assert.ok(calls.some((c) => c.path.endsWith("/interrupt")));
  const report = await run("result", jobID);
  assert.equal(report.exitCode, 1);
  assert.match(report.stdout, /- \*\*Status\*\*: cancelled/);
});

test("review runs OpenCode's built-in /review command instead of a pasted diff", async (t) => {
  const dirty = await serveV2(t);
  const dirtyRun = cli(t, dirty.baseUrl);
  const working = await dirtyRun("review");
  assert.equal(working.exitCode, 0, working.stderr);
  assert.match(working.stdout, /Target: working tree changes/);
  assert.match(working.stdout, /Final V2 output/);
  assert.match(working.stdout, /- \*\*Agent\*\*: plan/);
  const command = dirty.calls.find((c) => c.path.endsWith("/command"));
  assert.equal(command.body.name, "review");
  assert.equal(command.body.text, "");
  assert.equal(command.body.delivery ?? "steer", "steer", "Immediate reviews must not be queued behind the Plan reminder");
  assert.equal(dirty.calls.filter((c) => c.path.endsWith("/prompt")).length, 0);
  const permissions = dirty.calls.find((c) => c.method === "PATCH").body.permissions;
  assert.ok(permissions.some((p) => p.action === "edit" && p.effect === "deny"));
  assert.ok(permissions.some((p) => p.action === "question" && p.effect === "deny"));
  assert.equal(permissions.some((p) => p.action === "shell" && p.effect === "deny"), false);
  assert.equal(dirty.calls.find((c) => c.path.endsWith("/agent")).body.agent, "plan");

  const branched = await serveV2(t, { status: [] });
  const branch = await cli(t, branched.baseUrl)("review", "--scope", "branch");
  assert.equal(branch.exitCode, 0, branch.stderr);
  assert.match(branch.stdout, /Target: branch diff against main/);
  assert.equal(branched.calls.find((c) => c.path.endsWith("/command")).body.text, "main");

  const explicit = await serveV2(t);
  const named = await cli(t, explicit.baseUrl)("review", "--base", "develop");
  assert.equal(named.exitCode, 0, named.stderr);
  assert.equal(explicit.calls.find((c) => c.path.endsWith("/command")).body.text, "develop");
  assert.equal(explicit.calls.some((c) => c.path.startsWith("/api/vcs")), false);

  const rejected = await serveV2(t);
  const rejectRun = cli(t, rejected.baseUrl);
  const focus = await rejectRun("review", "focus on auth");
  assert.equal(focus.exitCode, 3);
  assert.match(focus.stderr, /\/opencode:delegate --agent plan/);
  const promptFile = path.join(rejectRun.dataDir, "focus.txt");
  fs.writeFileSync(promptFile, "focus on auth");
  const fromFile = await rejectRun("review", "--prompt-file", promptFile);
  assert.equal(fromFile.exitCode, 3);
  assert.match(fromFile.stderr, /task --agent plan --prompt-file/);
  assert.equal(rejected.calls.some((c) => c.path.endsWith("/command")), false);
});

test("prompt timeout cancels an in-flight V2 request and interrupts server execution", async (t) => {
  const { baseUrl, calls } = await serveV2(t, { active: true, stall: true });
  const run = cli(t, baseUrl, { OPENCODE_PROMPT_TIMEOUT_MS: "100" });
  const result = await run("task", "Run task");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /time(d )?out/i);
  assert.match(result.stdout, /- \*\*Status\*\*: failed/);
  assert.equal(calls.filter((c) => c.path.endsWith("/interrupt")).length, 1);
});
