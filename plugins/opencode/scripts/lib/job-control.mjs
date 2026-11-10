// Job control: query, sort, enrich, and build status snapshots.

import { tailLines } from "./fs.mjs";
import { jobLogPath, listWorkspaceStates, loadState } from "./state.mjs";

// "starting", "investigating" and "finalizing" are phases that older records
// stored as statuses; they still mean the job has not finished.
const ACTIVE_STATUSES = new Set(["pending", "queued", "running", "starting", "investigating", "finalizing"]);
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * @param {object|null|undefined} job
 * @returns {boolean}
 */
export function isActiveJob(job) {
  return ACTIVE_STATUSES.has(job?.status);
}

/**
 * @param {object|null|undefined} job
 * @returns {boolean}
 */
export function isFinishedJob(job) {
  return FINISHED_STATUSES.has(job?.status);
}

/**
 * Sort jobs newest first by updatedAt.
 * @param {object[]} jobs
 * @returns {object[]}
 */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Enrich a job with computed fields: elapsed time, progress preview, phase.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {object}
 */
export function enrichJob(job, workspacePath) {
  const enriched = { ...job };

  // Elapsed time
  if (job.createdAt) {
    const start = new Date(job.createdAt).getTime();
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    enriched.elapsedMs = end - start;
    enriched.elapsed = formatDuration(enriched.elapsedMs);
  }

  // Progress preview from log tail
  if (isActiveJob(job)) {
    const logFile = jobLogPath(workspacePath, job.id);
    const lines = tailLines(logFile, 3);
    if (lines.length > 0) {
      enriched.progressPreview = lines.join("\n");
    }
  }

  // Infer phase from log
  if (isActiveJob(job) && !job.phase) {
    enriched.phase = inferPhase(job, workspacePath);
  }

  return enriched;
}

/**
 * The stable public shape of a job, used by `status --json`. Every key is
 * always present; unknown values are null. Internal fields (prompt text, pid)
 * are left out.
 * @param {object} job - an enriched job
 * @param {string} workspacePath
 * @returns {object}
 */
export function toJobView(job, workspacePath) {
  return {
    id: job.id,
    type: job.type ?? null,
    status: job.status ?? null,
    phase: job.phase ?? null,
    agent: job.agent ?? null,
    model: job.model ?? null,
    workspace: job.workspace ?? workspacePath,
    opencodeSessionId: job.opencodeSessionId ?? null,
    claudeSessionId: job.sessionId ?? null,
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    completedAt: job.completedAt ?? null,
    elapsedMs: job.elapsedMs ?? null,
    elapsed: job.elapsed ?? null,
    filesChanged: job.filesChanged ?? null,
    errorMessage: job.errorMessage ?? null,
    logFile: job.logFile ?? jobLogPath(workspacePath, job.id),
    progressPreview: job.progressPreview ?? null,
    breadcrumb: job.breadcrumb ?? null,
  };
}

/**
 * Infer the current phase of a running job from its log.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {string}
 */
function inferPhase(job, workspacePath) {
  const logFile = jobLogPath(workspacePath, job.id);
  const lines = tailLines(logFile, 20);
  const text = lines.join("\n").toLowerCase();

  if (text.includes("error") || text.includes("failed")) return "failed";
  if (text.includes("finalizing") || text.includes("complete")) return "finalizing";
  if (text.includes("editing") || text.includes("writing")) return "editing";
  if (text.includes("verifying") || text.includes("testing")) return "verifying";
  if (text.includes("investigating") || text.includes("analyzing")) return "investigating";
  if (text.includes("reviewing")) return "reviewing";
  if (text.includes("starting") || text.includes("initializing")) return "starting";
  return "running";
}

/**
 * Build a status snapshot for display.
 * @param {object[]} jobs
 * @param {string} workspacePath
 * @param {{ sessionId?: string }} opts
 * @returns {{ running: object[], latestFinished: object|null, recent: object[] }}
 */
export function buildStatusSnapshot(jobs, workspacePath, opts = {}) {
  let filtered = jobs;
  if (opts.sessionId) {
    filtered = jobs.filter((j) => j.sessionId === opts.sessionId);
  }

  const sorted = sortJobsNewestFirst(filtered);
  const enriched = sorted.map((j) => enrichJob(j, workspacePath));

  const running = enriched.filter(isActiveJob);
  const finished = enriched.filter((j) => !isActiveJob(j));
  const latestFinished = finished[0] ?? null;
  const recent = finished.slice(0, 5);

  return { running, latestFinished, recent };
}

/**
 * Find a single job by ID or prefix match.
 * @param {object[]} jobs
 * @param {string} ref
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function matchJobReference(jobs, ref) {
  if (!ref) return { job: null, ambiguous: false };

  // Exact match first
  const exact = jobs.find((j) => j.id === ref);
  if (exact) return { job: exact, ambiguous: false };

  // Prefix match
  const matches = jobs.filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return { job: matches[0], ambiguous: false };
  if (matches.length > 1) return { job: null, ambiguous: true };

  return { job: null, ambiguous: false };
}

/**
 * Find a job by ID or prefix: first in `workspace`, then in every other
 * workspace the companion has state for. A job started from another folder
 * is found without --cwd.
 * @param {string} ref
 * @param {string} workspace
 * @returns {{ job: object|null, workspace: string, ambiguous: boolean }}
 */
export function locateJob(ref, workspace) {
  const local = matchJobReference(loadState(workspace).jobs ?? [], ref);
  if (local.job || local.ambiguous) return { ...local, workspace };

  const others = listWorkspaceStates()
    .filter((entry) => entry.workspace !== workspace)
    .flatMap((entry) => entry.jobs.map((job) => ({ job, workspace: entry.workspace })));
  const found = matchJobReference(others.map((entry) => entry.job), ref);
  const owner = found.job ? others.find((entry) => entry.job === found.job).workspace : workspace;
  return { ...found, workspace: owner };
}

/**
 * Resolve a job that has finished (completed, failed or cancelled).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveResultJob(jobs, ref) {
  const finished = jobs.filter(isFinishedJob);
  if (!ref) {
    const sorted = sortJobsNewestFirst(finished);
    return { job: sorted[0] ?? null, ambiguous: false };
  }
  return matchJobReference(finished, ref);
}

/**
 * Resolve a job that can be canceled (not finished yet).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveCancelableJob(jobs, ref) {
  const running = jobs.filter(isActiveJob);
  if (!ref) {
    return { job: running[0] ?? null, ambiguous: running.length > 1 };
  }
  return matchJobReference(running, ref);
}

/**
 * Format a duration in milliseconds to human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/**
 * The newest task job that has an OpenCode session, limited to the current
 * Claude session when its ID is known.
 * @param {object[]} jobs
 * @param {string|undefined} claudeSessionId
 * @param {(job: object) => boolean} [accept] - extra filter, e.g. on status
 * @returns {object|null}
 */
export function latestTaskSession(jobs, claudeSessionId, accept = () => true) {
  const candidates = (jobs ?? []).filter((j) =>
    j.type === "task" && j.opencodeSessionId &&
    (!claudeSessionId || j.sessionId === claudeSessionId) && accept(j));
  return sortJobsNewestFirst(candidates)[0] ?? null;
}
