// Output rendering for the OpenCode companion.

/**
 * Render a status snapshot as human-readable text.
 * @param {{ running: object[], latestFinished: object|null, recent: object[] }} snapshot
 * @returns {string}
 */
export function renderStatus(snapshot) {
  const lines = [];

  if (snapshot.running.length > 0) {
    lines.push("## Running Jobs\n");
    for (const job of snapshot.running) {
      const phase = job.breadcrumb || job.phase || "running";
      lines.push(`- **${job.id}** (${job.type}) — ${phase} — ${job.elapsed ?? "just started"}`);
      if (!job.breadcrumb && job.progressPreview) {
        lines.push(`  > ${job.progressPreview.split("\n").join("\n  > ")}`);
      }
    }
    lines.push("");
  }

  if (snapshot.latestFinished) {
    lines.push("## Latest Finished\n");
    const j = snapshot.latestFinished;
    lines.push(`- **${j.id}** (${j.type}) — ${j.status} — ${j.elapsed}`);
    if (j.errorMessage) {
      lines.push(`  Error: ${j.errorMessage}`);
    }
    lines.push("");
  }

  if (snapshot.recent.length > 1) {
    lines.push("## Recent Jobs\n");
    for (const j of snapshot.recent.slice(1)) {
      lines.push(`- **${j.id}** (${j.type}) — ${j.status} — ${j.elapsed}`);
    }
    lines.push("");
  }

  if (lines.length === 0) {
    lines.push("No OpenCode jobs found for this workspace.");
  }

  return lines.join("\n");
}

/**
 * Describe the files a job changed.
 * @param {object} job
 * @param {object} [resultData]
 * @returns {{ summary: string, stat: string|null, files: string[] }}
 */
function describeChanges(job, resultData) {
  const changes = job.filesChanged ?? resultData?.filesChanged;
  const files = changes?.files ?? resultData?.changedFiles ?? null;
  if (!files) return { summary: "unknown", stat: null, files: [] };
  if (files.length === 0) return { summary: "none", stat: null, files };
  const stat = changes?.stat || null;
  const summary = stat ? stat.split("\n").pop().trim() : `${files.length} file(s)`;
  return { summary, stat, files };
}

/**
 * Render a job result as the terminal report. The header always lists
 * status, agent, model, duration, OpenCode session and changed files.
 * @param {object} job - an enriched job
 * @param {object} [resultData]
 * @returns {string}
 */
export function renderResult(job, resultData) {
  const changes = describeChanges(job, resultData);
  const lines = [
    `## Job: ${job.id}`,
    "",
    `- **Type**: ${job.type ?? "unknown"}`,
    `- **Status**: ${job.status}`,
    `- **Agent**: ${job.agent ?? "unknown"}`,
    `- **Model**: ${job.model ?? "agent default"}`,
    `- **Duration**: ${job.elapsed ?? "unknown"}`,
    `- **OpenCode Session**: ${job.opencodeSessionId ?? "none"}`,
    `- **Workspace**: ${job.workspace ?? "unknown"}`,
    `- **Files Changed**: ${changes.summary}`,
    "",
  ];

  if (job.status === "failed" || job.status === "cancelled") {
    lines.push("### Error", "", job.errorMessage ?? "Unknown error");
  } else {
    const output = resultData?.rendered ?? resultData?.summary ?? job.result;
    lines.push("### Output", "", output || "(No output captured)");
  }

  if (changes.stat) {
    lines.push("", "### Changed Files", "", "```", changes.stat, "```");
  } else if (changes.files.length > 0) {
    lines.push("", "### Changed Files", "", ...changes.files.map((f) => `- ${f}`));
  }

  return lines.join("\n");
}

/**
 * Render the built-in review's text with its target.
 * @param {string} text
 * @param {{ label: string }} target
 * @returns {string}
 */
export function renderNativeReview(text, target) {
  const body = String(text ?? "").trim() || "OpenCode review completed without any output.";
  return [`# OpenCode Review`, "", `Target: ${target.label}`, "", body, ""].join("\n");
}

/**
 * Render setup status.
 * @param {object} status
 * @returns {string}
 */
export function renderSetup(status) {
  const lines = [];
  lines.push("## OpenCode Setup Status\n");

  lines.push(`- **Installed**: ${status.installed ? "Yes" : "No"}`);
  if (status.version) {
    lines.push(`- **Version**: ${status.version}`);
  }
  if (status.serverRunning !== undefined) {
    lines.push(`- **Server Running**: ${status.serverRunning ? "Yes" : "No"}`);
  }
  if (status.providers?.length > 0) {
    lines.push(`- **Configured Providers**: ${status.providers.join(", ")}`);
  } else if (status.installed) {
    lines.push(`- **Providers**: None configured. Open OpenCode and run \`/connect\` to sign in.`);
  }
  if (status.reviewGate !== undefined) {
    lines.push(`- **Review Gate**: ${status.reviewGate ? "Enabled" : "Disabled"}`);
  }

  return lines.join("\n");
}
