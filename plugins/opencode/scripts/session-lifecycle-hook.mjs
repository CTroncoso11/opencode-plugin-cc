#!/usr/bin/env node

// Session lifecycle hook for the OpenCode companion.
// Called on SessionEnd to close out jobs whose worker process is gone.

import process from "node:process";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, upsertJob } from "./lib/state.mjs";
import { isActiveJob } from "./lib/job-control.mjs";
import { isProcessAlive } from "./lib/process.mjs";

const event = process.argv[2];

async function main() {
  if (event !== "SessionEnd") return;
  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  for (const job of (state.jobs ?? []).filter(isActiveJob)) {
    if (job.pid && !isProcessAlive(job.pid)) {
      upsertJob(workspace, {
        id: job.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: "Session ended while job was running",
      });
    }
  }
}

main().catch(() => {
  // Hooks should never block the session, so swallow errors silently.
  process.exit(0);
});
