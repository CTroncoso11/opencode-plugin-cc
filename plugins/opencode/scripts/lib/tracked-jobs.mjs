// Job lifecycle tracking and progress reporting for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendLine } from "./fs.mjs";
import { generateJobId, upsertJob, loadState, jobLogPath, jobDataPath } from "./state.mjs";

const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

/**
 * Get the current Claude session ID from environment.
 * @returns {string|undefined}
 */
export function getClaudeSessionId() {
  return process.env[SESSION_ID_ENV] || process.env.CLAUDE_SESSION_ID;
}

function currentStatus(workspacePath, jobId) {
  return loadState(workspacePath).jobs?.find((j) => j.id === jobId)?.status;
}

/**
 * Create a new job record.
 * @param {string} workspacePath
 * @param {string} type - "review" | "task"
 * @param {object} [meta] - additional metadata
 * @returns {object} the created job
 */
export function createJobRecord(workspacePath, type, meta = {}) {
  const job = {
    id: generateJobId(type),
    type,
    status: "pending",
    sessionId: getClaudeSessionId(),
    workspace: workspacePath,
    ...meta,
  };
  upsertJob(workspacePath, job);
  return job;
}

/**
 * Run a tracked job with full lifecycle management. Progress goes to the
 * job log only; stdout and stderr stay free for the caller.
 * @param {string} workspacePath
 * @param {{ id: string }} job
 * @param {(ctx: { report: Function, log: Function }) => Promise<object>} runner
 * @returns {Promise<object>} the job result
 */
export async function runTrackedJob(workspacePath, job, runner) {
  if (currentStatus(workspacePath, job.id) === "cancelled") {
    throw new Error(`Job ${job.id} was cancelled before it started.`);
  }
  upsertJob(workspacePath, { id: job.id, status: "running", pid: process.pid });

  const logFile = jobLogPath(workspacePath, job.id);
  ensureDir(path.dirname(logFile));

  const log = (message) => {
    appendLine(logFile, `[${new Date().toISOString()}] ${message}`);
  };
  const report = (phase, message) => {
    log(`[${phase}] ${message}`);
    upsertJob(workspacePath, { id: job.id, phase });
  };

  try {
    report("starting", `Job ${job.id} started`);
    const result = await runner({ report, log });

    const dataFile = jobDataPath(workspacePath, job.id);
    ensureDir(path.dirname(dataFile));
    fs.writeFileSync(dataFile, JSON.stringify(result, null, 2), "utf8");

    upsertJob(workspacePath, {
      id: job.id,
      status: "completed",
      phase: "completed",
      completedAt: new Date().toISOString(),
      result: result?.summary ?? null,
    });
    log(`[completed] Job ${job.id} completed`);
    return result;
  } catch (err) {
    if (currentStatus(workspacePath, job.id) !== "cancelled") {
      upsertJob(workspacePath, {
        id: job.id,
        status: "failed",
        phase: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: err.message,
      });
    }
    log(`[failed] Job ${job.id} failed: ${err.message}`);
    throw err;
  }
}
