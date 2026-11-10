import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { autoHealJob } from "../plugins/opencode/scripts/lib/auto-heal.mjs";
import { validateModel } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { jobDataPath, loadState, updateState, upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { serveV2 } from "./v2-fixture.mjs";

test("prompt admission waits past tool-call completion and applies agent/model/permissions", async (t) => {
  const { client, calls, sessionID } = await serveV2(t);
  const session = await client.createSession({ title: "Review", readOnly: true });
  assert.deepEqual(session.location, { directory: "/workspace" });
  assert.ok(session.permissions.some((p) => p.action === "shell" && p.effect === "deny"));
  const response = await client.sendPrompt(sessionID, "Review the code", { agent: "plan", model: "vendor/model/name#high" });
  assert.equal(response.id, "msg_final");
  const prompt = calls.find((c) => c.path.endsWith("/prompt"));
  assert.equal(prompt.body.delivery ?? "steer", "steer", "Immediate tasks must not be deferred behind the Plan reminder");
  const model = calls.find((c) => c.path.endsWith(`/session/${sessionID}/model`));
  assert.deepEqual(model.body, { model: { providerID: "vendor", id: "model/name", variant: "high" } });
  assert.equal(calls.find((c) => c.path.endsWith("/agent")).body.agent, "plan");
  const permissions = calls.find((c) => c.method === "PATCH").body.permissions;
  assert.ok(permissions.some((p) => p.resource === "secrets/*" && p.effect === "deny"));
  assert.ok(permissions.some((p) => p.action === "question" && p.effect === "deny"));
  assert.ok(permissions.some((p) => p.action === "edit" && p.resource === "*" && p.effect === "deny"));
  assert.ok(calls.every((c) => c.headers["x-opencode-directory"] === "/workspace"));
});

test("prompt without explicit model uses the model configured for the agent", async (t) => {
  const { client, calls, sessionID } = await serveV2(t);
  await client.sendPrompt(sessionID, "Review the code", { agent: "plan" });
  assert.deepEqual(calls.find((c) => c.path.endsWith(`/session/${sessionID}/model`)).body, { model: { providerID: "cfg", id: "agent-model" } });
});

test("permission requests fail clearly and interrupt instead of hanging or auto-approving", async (t) => {
  const { client, sessionID, calls } = await serveV2(t, { permission: true, active: true });
  await assert.rejects(client.sendPrompt(sessionID, "Read external files"), /needs permission for external_directory: \/private\/\*/);
  assert.equal(calls.filter((c) => c.path.endsWith("/interrupt")).length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith("/reply")).length, 0);
});

test("failed and interrupted session outcomes are not successful model output", async (t) => {
  for (const outcome of ["failed", "interrupted"]) {
    const { client, sessionID } = await serveV2(t, { outcome });
    await assert.rejects(client.sendPrompt(sessionID, "Run task"), new RegExp(`session ${outcome}`));
  }
});

test("V2 paginated messages, diffs and cancellation use the released contract", async (t) => {
  const { client, sessionID, calls } = await serveV2(t);
  assert.equal((await client.getMessages(sessionID, { limit: 1 }))[0].type, "assistant");
  const listed = calls.find((c) => c.path.endsWith("/message"));
  assert.equal(listed.query.get("limit"), "1");
  assert.equal(listed.query.get("order"), "desc");
  assert.equal((await client.getSessionDiff(sessionID))[0].file, "src/fixed.js");
  await client.abortSession(sessionID);
  assert.equal(calls.find((c) => c.path.endsWith("/interrupt")).query.get("resume"), "false");
});

test("auto-heal persists V2 final text, not reasoning, and preserves active or stale jobs", async (t) => {
  const workspace = createTmpDir();
  const previous = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = workspace;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_COMPANION_DATA;
    else process.env.OPENCODE_COMPANION_DATA = previous;
    cleanupTmpDir(workspace);
  });
  const fixture = await serveV2(t);
  const job = { id: "task-heal", type: "task", status: "investigating", opencodeSessionId: fixture.sessionID, startedAt: new Date(fixture.now).toISOString() };
  upsertJob(workspace, job);
  const healed = await autoHealJob(workspace, job, fixture);
  assert.equal(healed.job.status, "completed");
  assert.equal(loadState(workspace).jobs[0].status, "completed");
  assert.equal(JSON.parse(fs.readFileSync(jobDataPath(workspace, job.id), "utf8")).rendered, "Final V2 output");
  const active = await serveV2(t, { active: true });
  assert.equal((await autoHealJob(workspace, job, active)).action, "skip");
  const stale = { ...job, startedAt: new Date(fixture.now + 10_000).toISOString() };
  assert.equal((await autoHealJob(workspace, stale, fixture)).action, "skip");
  const failed = await serveV2(t, { outcome: "failed" });
  assert.equal((await autoHealJob(workspace, job, failed)).job.status, "failed");
});

function runStopHook(baseUrl, workspace, input) {
  const script = path.resolve("plugins/opencode/scripts/stop-review-gate-hook.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: workspace,
      env: {
        ...process.env,
        OPENCODE_SERVER_URL: baseUrl,
        OPENCODE_SERVER_PASSWORD: "fixture",
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_COMPANION_DATA: workspace,
        OPENCODE_COMPLETION_POLL_MS: "10",
        OPENCODE_PROMPT_TIMEOUT_MS: "5000",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    child.stdin.end(JSON.stringify({ cwd: workspace, session_id: "claude-session", ...input }));
  });
}

test("stop gate sends the previous assistant message and blocks an unexpected answer", async (t) => {
  const workspace = createTmpDir();
  t.after(() => cleanupTmpDir(workspace));
  const previous = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = workspace;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_COMPANION_DATA;
    else process.env.OPENCODE_COMPANION_DATA = previous;
  });
  updateState(workspace, (state) => {
    state.config = { reviewGate: true };
  });

  const allowed = await serveV2(t, { text: "ALLOW: the previous turn made no edits" });
  const allow = await runStopHook(allowed.baseUrl, workspace, { last_assistant_message: "I only reported status." });
  assert.equal(allow.exitCode, 0, allow.stderr);
  assert.equal(allow.stdout, "");
  const prompt = allowed.calls.find((c) => c.path.endsWith("/prompt")).body.text;
  assert.match(prompt, /Previous Claude response:\nI only reported status\./);
  assert.doesNotMatch(prompt, /session_id|claude_response/);

  const blocked = await serveV2(t, { text: "Final V2 output" });
  const block = await runStopHook(blocked.baseUrl, workspace, { last_assistant_message: "Edited auth." });
  assert.equal(block.exitCode, 0, block.stderr);
  assert.equal(JSON.parse(block.stdout).decision, "block");
});

test("model validation names the bad part and skips when the list is unavailable", async (t) => {
  const { client } = await serveV2(t);
  await validateModel(client, "vendor/requested#high");
  await assert.rejects(validateModel(client, "vendor/missing"), (err) => err.exitCode === 3 && /Provider "vendor" has no model "missing"/.test(err.message));
  await assert.rejects(validateModel(client, "nobody/model"), /Unknown provider "nobody". Configured providers: cfg, env, saved, vendor./);
  await assert.rejects(validateModel(client, "vendor/requested#ultra"), /no variant "ultra". Variants: high./);
  await assert.rejects(validateModel(client, "no-slash"), /Invalid model "no-slash"/);
  const unavailable = await serveV2(t, { models: null });
  await validateModel(unavailable.client, "anything/goes");
});
