#!/usr/bin/env node

// OpenCode Companion - CLI entry point for the Claude Code plugin.
// Talks to OpenCode's V2 HTTP API through the released client.
//
// Every subcommand accepts --cwd <dir> (alias --workspace <dir>) to choose
// the workspace instead of the process working directory.
//
// Exit codes: 0 ok, 1 failed (job or OpenCode error), 2 job still running,
// 3 usage error, 4 job not found or ambiguous.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { parseArgs, readPrompt, workspaceOption } from "./lib/args.mjs";
import { EXIT, CompanionError, usageError, oneLine } from "./lib/errors.mjs";
import { resolveOpencodeBinary, getOpencodeVersion, spawnDetached, runCommand, isProcessAlive } from "./lib/process.mjs";
import {
  isServerRunning, discoverServer, connect, extractResponseText,
  parseModel, formatModel, validateModel,
} from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { snapshotWorktree, worktreeChanges } from "./lib/git.mjs";
import {
  loadState, updateState, upsertJob, jobDataPath, jobLogPath, stateRoot,
  loadPluginConfig, updatePluginConfig,
} from "./lib/state.mjs";
import {
  buildStatusSnapshot, resolveResultJob, resolveCancelableJob, enrichJob, locateJob,
  isActiveJob, latestTaskSession, toJobView,
} from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderNativeReview, renderSetup } from "./lib/render.mjs";
import { readJson } from "./lib/fs.mjs";
import { autoHealJobs, healableJobs, getSessionLastActivity } from "./lib/auto-heal.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");
const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");
const STATUS_SCHEMA_VERSION = 1;
const MODEL_ENV = "OPENCODE_PLUGIN_MODEL";

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const handlers = {
  setup: handleSetup,
  review: handleReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  result: handleResult,
  "wait-and-result": handleWaitAndResult,
  cancel: handleCancel,
  heal: handleHeal,
  doctor: handleDoctor,
  config: handleConfig,
};

const [subcommand, ...subcommandArgv] = process.argv.slice(2);

async function main() {
  const handler = handlers[subcommand];
  if (!handler) {
    throw usageError(`Unknown subcommand "${subcommand ?? ""}". Available: ${Object.keys(handlers).join(", ")}.`);
  }
  return (await handler(subcommandArgv)) ?? EXIT.OK;
}

function finish(code) {
  process.exitCode = code;
  // An idle keep-alive socket must not hold the process open.
  setTimeout(() => process.exit(code), 1000).unref();
}

main().then(finish, (err) => {
  console.error(`opencode-companion ${subcommand ?? ""}: ${oneLine(err?.message ?? err)}`);
  finish(err instanceof CompanionError ? err.exitCode : EXIT.FAILED);
});

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

/**
 * Parse a subcommand's arguments and resolve its workspace.
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 */
async function commandContext(argv, schema) {
  const { options, positional } = parseArgs(argv, schema);
  const workspace = await resolveWorkspace(workspaceOption(options));
  return { options, positional, workspace };
}

/**
 * The model to use: --model, then OPENCODE_PLUGIN_MODEL, then `config --set-model`.
 * Undefined means OpenCode uses the agent's configured model.
 * @param {string|boolean|undefined} explicit
 * @returns {{ model: string|undefined, source: string }}
 */
function configuredModel(explicit) {
  if (typeof explicit === "string" && explicit) return { model: explicit, source: "--model" };
  if (process.env[MODEL_ENV]) return { model: process.env[MODEL_ENV], source: MODEL_ENV };
  const saved = loadPluginConfig().model;
  if (saved) return { model: saved, source: "config" };
  return { model: undefined, source: "agent default" };
}

/**
 * Connect to OpenCode and reject an unknown model before any job is created.
 * @param {string} workspace
 * @param {string|undefined} model
 */
async function connectChecked(workspace, model) {
  if (model) parseModel(model);
  const client = await connect({ cwd: workspace });
  if (model) await validateModel(client, model);
  return client;
}

function findJob(workspace, id) {
  return loadState(workspace).jobs?.find((j) => j.id === id) ?? null;
}

/**
 * Reconcile jobs whose worker may have exited after the server finished.
 * @param {string} workspace
 * @param {object[]} jobs
 */
async function healJobs(workspace, jobs) {
  const stuck = healableJobs(jobs);
  if (stuck.length > 0) await autoHealJobs(workspace, stuck);
}

/**
 * Store what the job really used and changed, once OpenCode has answered.
 * Outside git, OpenCode's own session diff gives the changed file names.
 */
async function recordOutcome(workspace, jobId, { client, sessionId, response, before, request }) {
  let filesChanged = await worktreeChanges(workspace, before);
  if (!filesChanged && !before) {
    try {
      const diff = await client.getSessionDiff(sessionId);
      filesChanged = { files: (diff ?? []).map((f) => f.file).filter(Boolean), stat: null };
    } catch {
      filesChanged = null;
    }
  }
  upsertJob(workspace, {
    id: jobId,
    model: formatModel(response?.model) ?? request.model ?? null,
    agent: response?.agent ?? request.agentName,
    filesChanged,
  });
}

/**
 * Print the terminal report for a finished job.
 * @returns {number} 0 when the job completed, 1 when it failed or was cancelled
 */
function printJobReport(workspace, jobId) {
  const job = findJob(workspace, jobId);
  if (!job) throw new CompanionError(`Job ${jobId} is no longer in ${workspace}.`, EXIT.NOT_FOUND);
  console.log(renderResult(enrichJob(job, workspace), readJson(jobDataPath(workspace, job.id))));
  if (job.status === "completed") return EXIT.OK;
  console.error(`opencode-companion ${subcommand}: job ${job.id} ${job.status}: ${oneLine(job.errorMessage ?? "no details")}`);
  return EXIT.FAILED;
}

/**
 * Find a job by reference in the workspace or, failing that, anywhere.
 * @returns {{ job: object, workspace: string }}
 */
function requireJob(ref, workspace) {
  const located = locateJob(ref, workspace);
  if (located.ambiguous) {
    throw new CompanionError(`Job reference "${ref}" matches more than one job. Use a longer ID.`, EXIT.NOT_FOUND);
  }
  if (!located.job) throw new CompanionError(`No job found for "${ref}".`, EXIT.NOT_FOUND);
  return located;
}

async function addBreadcrumbs(jobs, workspace) {
  await Promise.all(jobs.map(async (job) => {
    if (!job.opencodeSessionId) return;
    const act = await getSessionLastActivity(job.opencodeSessionId, { cwd: workspace });
    if (!act) return;
    const age = act.ageSec != null ? ` (${act.ageSec}s ago)` : "";
    if (act.kind === "tool") {
      job.breadcrumb = `running — ${act.tool}${act.command ? `: ${act.command}` : ""}${age}`;
    } else if (act.kind === "text") {
      job.breadcrumb = `running — "${act.text}"${age}`;
    }
  }));
}

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options, workspace } = await commandContext(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const installed = resolveOpencodeBinary() !== null;
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];

  if (installed) {
    serverRunning = await isServerRunning();

    if (serverRunning) {
      try {
        const client = await connect({ start: false, cwd: workspace });
        const providerList = await client.listProviders();
        providers = providerList.data.map((p) => p.id);
      } catch {
        // Server may not be fully ready
      }
    }
  }

  let reviewGate;
  if (options["enable-review-gate"] || options["disable-review-gate"]) {
    reviewGate = !!options["enable-review-gate"];
    updateState(workspace, (state) => {
      state.config = { ...state.config, reviewGate };
    });
  } else {
    reviewGate = loadState(workspace).config?.reviewGate ?? false;
  }

  const status = { installed, version, serverRunning, providers, reviewGate };
  console.log(options.json ? JSON.stringify(status, null, 2) : renderSetup(status));
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

const REVIEW_SCOPES = new Set(["auto", "working-tree", "branch"]);

// Permissions for a review session. Plan denies edits. Shell and subagents
// stay available because OpenCode's /review command runs git and may call Explore.
const REVIEW_SESSION = { readOnly: true, allowShell: true, allowSubagent: true };
const REVIEW_PROMPT = { agent: "plan", allowShell: true, allowSubagent: true };

async function handleReview(argv) {
  const { options, positional, workspace } = await commandContext(argv, {
    valueOptions: ["base", "scope", "model", "prompt-file"],
    booleanOptions: ["wait", "background"],
  });

  if (readPrompt(options, positional)) {
    throw usageError("review runs OpenCode's built-in /review, which takes no custom instructions. For a review with your own instructions use /opencode:delegate --agent plan, or task --agent plan --prompt-file <file>.");
  }
  const scope = options.scope ?? "auto";
  if (!REVIEW_SCOPES.has(scope)) {
    throw usageError(`Unsupported review scope "${scope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`);
  }
  const { model } = configuredModel(options.model);
  const client = await connectChecked(workspace, model);
  const request = { agentName: REVIEW_PROMPT.agent, model: model ?? null };
  const job = createJobRecord(workspace, "review", { base: options.base, agent: request.agentName, model: request.model });

  try {
    await runTrackedJob(workspace, job, async ({ report, log }) => {
      const before = await snapshotWorktree(workspace);
      upsertJob(workspace, { id: job.id, worktreeBefore: before });
      report("reviewing", "Creating review session...");
      const session = await client.createSession({ title: `Code Review ${job.id}`, ...REVIEW_SESSION });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      let target;
      if (options.base) {
        target = { label: `branch diff against ${options.base}`, commandText: options.base };
      } else if (scope === "working-tree" || (scope === "auto" && (await client.vcsStatus()).length > 0)) {
        target = { label: "working tree changes", commandText: "" };
      } else {
        const base = await client.vcsBase();
        if (!base?.name) {
          throw new Error("Unable to detect the repository review base. Pass --base <ref> or use --scope working-tree.");
        }
        target = { label: `branch diff against ${base.name}`, commandText: base.name };
      }
      report("reviewing", "Running OpenCode /review...");
      log(`Built-in /review target: ${target.label}`);

      const response = await client.sendCommand(session.id, "review", target.commandText, { ...REVIEW_PROMPT, model });
      report("finalizing", "Processing review output...");
      await recordOutcome(workspace, job.id, { client, sessionId: session.id, response, before, request });
      const text = extractResponseText(response);
      return { rendered: renderNativeReview(text, target), summary: text.slice(0, 500) };
    });
  } catch {
    // The failure is stored in the job and shown by the report below.
  }
  return printJobReport(workspace, job.id);
}

// ------------------------------------------------------------------
// Task (delegation)
// ------------------------------------------------------------------

/**
 * Run a task job to the end. Shared by foreground tasks and the detached worker.
 * @param {string} workspace
 * @param {string} jobId
 * @param {{ taskText: string, agentName: string, isWrite: boolean, resumeSessionId: string|null, model: string|null }} request
 */
async function runTask(workspace, jobId, request) {
  return runTrackedJob(workspace, { id: jobId }, async ({ report, log }) => {
    report("starting", "Connecting to OpenCode server...");
    const client = await connect({ cwd: workspace });
    const before = await snapshotWorktree(workspace);
    upsertJob(workspace, { id: jobId, worktreeBefore: before });

    let sessionId = request.resumeSessionId;
    if (sessionId) {
      report("starting", `Resuming OpenCode session ${sessionId}`);
    } else {
      const session = await client.createSession({ title: `Task ${jobId}`, readOnly: !request.isWrite });
      sessionId = session.id;
      report("starting", `Created OpenCode session ${sessionId}`);
    }
    upsertJob(workspace, { id: jobId, opencodeSessionId: sessionId });

    report("investigating", "Sending task to OpenCode...");
    log(`Agent: ${request.agentName}, Model: ${request.model ?? "agent default"}, Write: ${request.isWrite}, Prompt: ${request.taskText.length} chars`);
    const response = await client.sendPrompt(sessionId, request.taskText, {
      agent: request.agentName,
      model: request.model ?? undefined,
      readOnly: !request.isWrite,
    });

    report("finalizing", "Collecting results...");
    await recordOutcome(workspace, jobId, { client, sessionId, response, before, request });
    const text = extractResponseText(response);
    return { rendered: text, summary: text.slice(0, 500) };
  });
}

async function handleTask(argv) {
  const { options, positional, workspace } = await commandContext(argv, {
    valueOptions: ["model", "agent", "prompt-file"],
    booleanOptions: ["write", "background", "wait", "resume-last", "fresh"],
  });

  const taskText = readPrompt(options, positional);
  if (!taskText) {
    throw usageError("No task text. Pass the prompt as text, with --prompt-file <path>, or with --prompt-file - to read stdin.");
  }
  if (options["resume-last"] && options.fresh) {
    throw usageError("Use either --resume-last or --fresh, not both.");
  }

  const isWrite = options.agent !== "plan";
  const agentName = options.agent ?? "build";
  const { model } = configuredModel(options.model);
  await connectChecked(workspace, model);

  const resumeSessionId = options["resume-last"]
    ? latestTaskSession(loadState(workspace).jobs, getClaudeSessionId())?.opencodeSessionId ?? null
    : null;
  const request = { taskText, agentName, isWrite, resumeSessionId, model: model ?? null };
  const job = createJobRecord(workspace, "task", { agent: agentName, model: request.model, resumeSessionId, request });

  if (options.background) {
    const logFile = jobLogPath(workspace, job.id);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // The worker reads the prompt from the job record, so the prompt never
    // passes through a command line.
    const child = spawnDetached(process.execPath, [COMPANION_SCRIPT, "task-worker", "--job-id", job.id, "--cwd", workspace], {
      cwd: workspace,
      logFile,
    });
    // Recorded before the worker's first write, so cancel can stop a queued worker.
    upsertJob(workspace, { id: job.id, status: "queued", phase: "queued", logFile, pid: child.pid });
    child.once("error", (err) => {
      upsertJob(workspace, { id: job.id, status: "failed", completedAt: new Date().toISOString(), errorMessage: `Worker did not start: ${err.message}` });
    });
    console.log(`OpenCode task started in background: ${job.id}`);
    console.log(`Workspace: ${workspace}`);
    return EXIT.OK;
  }

  try {
    await runTask(workspace, job.id, request);
  } catch {
    // The failure is stored in the job and shown by the report below.
  }
  return printJobReport(workspace, job.id);
}

async function handleTaskWorker(argv) {
  const { options, workspace } = await commandContext(argv, { valueOptions: ["job-id"] });
  const jobId = options["job-id"];
  if (!jobId || !workspaceOption(options)) throw usageError("task-worker needs --job-id and --cwd.");
  const request = findJob(workspace, jobId)?.request;
  if (!request?.taskText) throw new CompanionError(`No queued task ${jobId} in ${workspace}.`, EXIT.NOT_FOUND);
  try {
    await runTask(workspace, jobId, request);
  } catch {
    return EXIT.FAILED;
  }
  return EXIT.OK;
}

async function handleTaskResumeCandidate(argv) {
  const { options, workspace } = await commandContext(argv, { booleanOptions: ["json"] });
  await healJobs(workspace, loadState(workspace).jobs);

  const lastTask = latestTaskSession(loadState(workspace).jobs, getClaudeSessionId(),
    (j) => j.status === "completed" || isActiveJob(j));
  const result = {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.available ? `Resumable session: ${result.opencodeSessionId}` : "No resumable session.");
  }
}

// ------------------------------------------------------------------
// Status / Result / Cancel
// ------------------------------------------------------------------

async function handleStatus(argv) {
  const { options, positional, workspace: cwdWorkspace } = await commandContext(argv, {
    booleanOptions: ["json", "all"],
  });
  const wantJson = !!options.json;
  const ref = positional[0];

  if (ref) {
    const located = locateJob(ref, cwdWorkspace);
    if (!located.job) {
      const error = located.ambiguous ? "ambiguous" : "not_found";
      if (wantJson) {
        console.log(JSON.stringify({ schemaVersion: STATUS_SCHEMA_VERSION, workspaceRoot: cwdWorkspace, job: null, error }));
      } else {
        console.error(`opencode-companion status: ${located.ambiguous ? `"${ref}" matches more than one job` : `no job found for "${ref}"`}.`);
      }
      return EXIT.NOT_FOUND;
    }
    const { workspace } = located;
    await healJobs(workspace, [located.job]);
    const job = toJobView(enrichJob(findJob(workspace, located.job.id) ?? located.job, workspace), workspace);
    if (isActiveJob(job)) await addBreadcrumbs([job], workspace);
    if (wantJson) {
      console.log(JSON.stringify({ schemaVersion: STATUS_SCHEMA_VERSION, workspaceRoot: workspace, job }));
    } else {
      const active = isActiveJob(job);
      console.log(renderStatus({ running: active ? [job] : [], latestFinished: active ? null : job, recent: [] }));
    }
    return EXIT.OK;
  }

  const workspace = cwdWorkspace;
  await healJobs(workspace, loadState(workspace).jobs);
  // --all shows every Claude session's jobs; otherwise only this session's.
  const sessionFilter = options.all ? undefined : getClaudeSessionId();
  const snapshot = buildStatusSnapshot(loadState(workspace).jobs ?? [], workspace, { sessionId: sessionFilter });
  await addBreadcrumbs(snapshot.running, workspace);

  if (wantJson) {
    const view = (job) => toJobView(job, workspace);
    console.log(JSON.stringify({
      schemaVersion: STATUS_SCHEMA_VERSION,
      workspaceRoot: workspace,
      running: snapshot.running.map(view),
      latestFinished: snapshot.latestFinished ? view(snapshot.latestFinished) : null,
      recent: snapshot.recent.map(view),
    }));
    return EXIT.OK;
  }

  console.log(renderStatus(snapshot));
  return EXIT.OK;
}

async function handleResult(argv) {
  const { positional, workspace: cwdWorkspace } = await commandContext(argv, {});
  const ref = positional[0];

  if (!ref) {
    await healJobs(cwdWorkspace, loadState(cwdWorkspace).jobs);
    const { job } = resolveResultJob(loadState(cwdWorkspace).jobs ?? []);
    if (!job) throw new CompanionError(`No finished job in ${cwdWorkspace}.`, EXIT.NOT_FOUND);
    return printJobReport(cwdWorkspace, job.id);
  }

  const { job, workspace } = requireJob(ref, cwdWorkspace);
  await healJobs(workspace, [job]);
  const current = findJob(workspace, job.id);
  if (isActiveJob(current)) {
    throw new CompanionError(`Job ${job.id} is still ${current.status}. Use wait-and-result ${job.id}.`, EXIT.RUNNING);
  }
  return printJobReport(workspace, job.id);
}

async function handleWaitAndResult(argv) {
  const { options, positional, workspace: cwdWorkspace } = await commandContext(argv, {
    valueOptions: ["max-wait"],
    booleanOptions: ["json"],
  });

  const ref = positional[0];
  if (!ref) throw usageError("wait-and-result needs a job ID.");

  const maxWait = Number(options["max-wait"] ?? "480");
  if (!Number.isInteger(maxWait) || maxWait < 1 || maxWait > 600) {
    throw usageError("--max-wait must be a whole number of seconds between 1 and 600.");
  }

  const { job, workspace } = requireJob(ref, cwdWorkspace);
  const startTime = Date.now();
  const deadline = startTime + maxWait * 1000;
  let nextHeal = 0;

  while (true) {
    let current = findJob(workspace, job.id);
    // A worker that died before saving its result leaves the job running;
    // ask the server whether the session finished.
    if (isActiveJob(current) && Date.now() >= nextHeal && !isProcessAlive(current.pid)) {
      await healJobs(workspace, [current]);
      current = findJob(workspace, job.id);
      nextHeal = Date.now() + 30_000;
    }
    if (!isActiveJob(current)) return printJobReport(workspace, job.id);
    if (Date.now() >= deadline) break;
    await delay(250);
  }

  console.log(JSON.stringify({
    status: "running",
    elapsed: Math.floor((Date.now() - startTime) / 1000),
    task_id: job.id,
    workspace,
    log_file: jobLogPath(workspace, job.id),
  }));
  return EXIT.RUNNING;
}

async function handleCancel(argv) {
  const { positional, workspace: cwdWorkspace } = await commandContext(argv, {});
  const ref = positional[0];

  let job;
  let workspace = cwdWorkspace;
  if (ref) {
    ({ job, workspace } = requireJob(ref, cwdWorkspace));
    if (!isActiveJob(job)) {
      console.log(`Job ${job.id} is already ${job.status}; nothing to cancel.`);
      return EXIT.OK;
    }
  } else {
    const resolved = resolveCancelableJob(loadState(workspace).jobs ?? []);
    if (resolved.ambiguous) throw usageError("More than one job is running. Pass the job ID to cancel.");
    job = resolved.job;
    if (!job) {
      console.log("No active job to cancel.");
      return EXIT.OK;
    }
  }

  if (job.opencodeSessionId) {
    try {
      const client = await connect({ start: false, cwd: workspace });
      await client.abortSession(job.opencodeSessionId);
    } catch {
      // Server may not be running
    }
  }

  if (job.pid && job.pid !== process.pid && isProcessAlive(job.pid)) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  upsertJob(workspace, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    completedAt: new Date().toISOString(),
    errorMessage: "Cancelled by user",
  });

  console.log(`Cancelled job: ${job.id}`);
  return EXIT.OK;
}

// ------------------------------------------------------------------
// Heal (batch auto-reconcile stuck jobs)
// ------------------------------------------------------------------

async function handleHeal(argv) {
  const { options, workspace } = await commandContext(argv, {
    booleanOptions: ["json", "dry-run", "all"],
  });
  const sessionId = getClaudeSessionId();
  const dryRun = !!options["dry-run"];

  let jobs = loadState(workspace).jobs ?? [];
  if (!options.all && sessionId) {
    jobs = jobs.filter((j) => !j.sessionId || j.sessionId === sessionId);
  }
  const healable = healableJobs(jobs);
  const { actions } = await autoHealJobs(workspace, healable, { dryRun });

  if (options.json) {
    console.log(JSON.stringify({ workspaceRoot: workspace, dryRun, scanned: healable.length, actions }, null, 2));
    return;
  }

  console.log(`## Auto-Heal ${dryRun ? "(dry-run)" : ""}\n`);
  console.log(`- Workspace: ${workspace}`);
  console.log(`- Scanned stuck jobs: ${healable.length}`);
  if (actions.length === 0) {
    console.log(`- No actions needed.`);
    return;
  }
  console.log(`- Actions: ${actions.length}\n`);
  for (const a of actions) {
    const det = a.details ? ` — ${JSON.stringify(a.details)}` : "";
    console.log(`- **${a.id}**: ${a.action}${det}`);
  }
}

// ------------------------------------------------------------------
// Doctor (onboarding self-test + optional auto-repair)
// ------------------------------------------------------------------

async function handleDoctor(argv) {
  const { options, workspace } = await commandContext(argv, {
    booleanOptions: ["json", "fix", "verbose"],
  });
  const fix = !!options.fix;
  const verbose = !!options.verbose;

  const checks = [];
  const push = (name, status, detail, hint) => checks.push({ name, status, detail, hint });

  const bin = resolveOpencodeBinary();
  if (bin) {
    push("opencode-binary", "PASS", bin, null);
  } else {
    push("opencode-binary", "FAIL", "not in PATH", "Install OpenCode V2: https://opencode.ai/v2/docs/cli/");
  }

  const version = bin ? await getOpencodeVersion() : null;
  if (version && /(?:^|\s)v?2\./.test(version)) {
    push("opencode-version", "PASS", version, null);
  } else {
    push("opencode-version", "FAIL", version || "could not resolve version", "OpenCode V2 is required.");
  }

  // V2 honors the user's configuration. Never rewrite global permissions.
  push("opencode-permissions", "PASS", "session-scoped headless policy; global config unchanged", null);

  const endpoint = await discoverServer().catch(() => undefined);
  const serverUrl = endpoint?.url || "(not discovered)";
  if (await isServerRunning()) {
    push("opencode-server", "PASS", `${serverUrl} reachable`, null);
  } else {
    push("opencode-server", "WARN", `${serverUrl} not reachable`, "Start OpenCode or run: opencode service start");
  }

  const envData = process.env.CLAUDE_PLUGIN_DATA;
  if (envData && !/opencode/i.test(path.basename(envData))) {
    push("plugin-data-env", "WARN",
      `CLAUDE_PLUGIN_DATA=${envData} — basename lacks "opencode"`,
      "State will self-derive from script path; env is ignored to avoid cross-plugin leak.");
  } else {
    push("plugin-data-env", "PASS", envData ? envData : "(unset — self-derived)", null);
  }

  const sRoot = stateRoot(workspace);
  push("state-dir", "PASS", sRoot, null);

  const sessionId = getClaudeSessionId();
  const jobs = (loadState(workspace).jobs ?? []).filter((j) => !sessionId || j.sessionId === sessionId);
  const healable = healableJobs(jobs);
  if (healable.length === 0) {
    push("stuck-jobs", "PASS", "none", null);
  } else if (fix) {
    const { actions } = await autoHealJobs(workspace, healable);
    push("stuck-jobs", "PASS", `healed ${actions.length}/${healable.length}`, null);
  } else {
    push("stuck-jobs", "WARN", `${healable.length} in non-terminal state`,
      "Run: companion heal  (or companion doctor --fix)");
  }

  if (process.platform === "win32") {
    push("disk-free", "PASS", "N/A (Windows)", null);
  } else {
    // Walk up to the first existing ancestor — stateRoot may not exist yet.
    let probe = sRoot;
    while (probe && probe !== "/" && !fs.existsSync(probe)) probe = path.dirname(probe);
    const df = await runCommand("df", ["-h", probe]);
    const lines = (df.stdout || "").split("\n").filter(Boolean);
    const last = lines[lines.length - 1] || "";
    if (last && last !== lines[0]) {
      push("disk-free", "PASS", last.split(/\s+/).slice(0, 5).join(" "), null);
    } else {
      push("disk-free", "WARN", "df unavailable", null);
    }
  }

  const nFail = checks.filter((c) => c.status === "FAIL").length;
  const nWarn = checks.filter((c) => c.status === "WARN").length;
  const summary = nFail + nWarn === 0
    ? "All good"
    : `${nWarn} warnings, ${nFail} failures${!fix ? " — run with --fix to repair" : ""}`;

  if (options.json) {
    console.log(JSON.stringify({
      summary: { failures: nFail, warnings: nWarn, fix },
      checks,
      workspace,
      stateRoot: sRoot,
    }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`[${c.status}] ${c.name} — ${c.detail}`);
      if (c.hint && (verbose || c.status !== "PASS")) console.log(`       ${c.hint}`);
    }
    console.log(`\n${nFail + nWarn === 0 ? "OK" : "!! "} ${summary}`);
  }
  return nFail > 0 ? EXIT.FAILED : EXIT.OK;
}

// ------------------------------------------------------------------
// Config (resolved settings, and the default model)
// ------------------------------------------------------------------

async function handleConfig(argv) {
  const { options, workspace } = await commandContext(argv, {
    valueOptions: ["set-model"],
    booleanOptions: ["json", "unset-model"],
  });

  if (options["set-model"] !== undefined && options["unset-model"]) {
    throw usageError("Use either --set-model or --unset-model, not both.");
  }
  if (options["set-model"] !== undefined) {
    const model = String(options["set-model"]);
    parseModel(model);
    if (await isServerRunning()) await validateModel(await connect({ start: false, cwd: workspace }), model);
    updatePluginConfig((config) => {
      config.model = model;
    });
  } else if (options["unset-model"]) {
    updatePluginConfig((config) => {
      delete config.model;
    });
  }

  const envSpec = [
    [MODEL_ENV, "(unset)", "Default model for task and review (provider/model[#variant])"],
    ["OPENCODE_REQUEST_TIMEOUT_MS", "1800000", "Per-HTTP-request abort timeout"],
    ["OPENCODE_PROMPT_TIMEOUT_MS", "14400000", "Session completion timeout"],
    ["OPENCODE_COMPLETION_POLL_MS", "5000", "Watcher poll interval during sendPrompt"],
    ["OPENCODE_COMPANION_DATA", "(self-derived)", "Override for plugin data dir"],
    ["OPENCODE_SERVER_URL", "(discovered)", "Explicit V2 server URL (otherwise use the local service)"],
    ["OPENCODE_SERVER_PASSWORD", "(unset)", "HTTP Basic auth password"],
    ["OPENCODE_SERVER_USERNAME", "opencode", "HTTP Basic auth username"],
  ];
  const envRows = envSpec.map(([name, dflt, description]) => {
    const v = process.env[name];
    return {
      name,
      value: name === "OPENCODE_SERVER_PASSWORD" && v ? "(redacted)" : v ?? dflt,
      source: v != null ? "env" : "default",
      description,
    };
  });

  const defaultModel = configuredModel(undefined);
  const endpoint = await discoverServer().catch(() => undefined);
  const serverUrl = endpoint?.url || "(not discovered)";
  const serverReachable = await isServerRunning();

  const out = {
    env: envRows,
    workspace,
    stateRoot: stateRoot(workspace),
    defaultModel: { value: defaultModel.model ?? null, source: defaultModel.source },
    permissions: "session-scoped; global config unchanged",
    server: { url: serverUrl, reachable: serverReachable },
  };

  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log("## OpenCode Companion Config\n");
  console.log(`- Workspace: ${workspace}`);
  console.log(`- State dir: ${out.stateRoot}`);
  console.log(`- Default model: ${out.defaultModel.value ?? "(agent default)"} [${out.defaultModel.source}]`);
  console.log(`- Permissions: ${out.permissions}`);
  console.log(`- Server: ${serverUrl} (${serverReachable ? "reachable" : "unreachable"})`);
  console.log("\n### Environment variables\n");
  for (const r of envRows) {
    console.log(`- ${r.name} = ${r.value} [${r.source}] — ${r.description}`);
  }
}
