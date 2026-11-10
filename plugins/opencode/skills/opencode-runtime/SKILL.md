---
name: opencode-runtime
description: Delegate directly to OpenCode when the user requests it, Claude is stuck, or a substantial debugging or implementation task needs a second pass. Use the companion runtime without a Claude subagent.
user-invocable: false
allowed-tools: Skill Read Write AskUserQuestion Bash
---

# OpenCode Runtime

Call the companion directly from the main Claude thread. OpenCode performs the investigation and implementation; Claude prepares context, dispatches, and returns the report.

Always start the companion through the launcher, which picks Bun 1.4+ when it is installed and Node 22+ otherwise:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" <subcommand> [options]
```

Two rules for every call:

- Pass `--cwd "<repo>"`, where `<repo>` is the absolute path of the repository the work is for. The Bash tool's working directory resets between calls and is often not the repository.
- Never put the prompt on the command line. Write it to a file with the Write tool and pass `--prompt-file <absolute path>`. Quotes, `$`, `&`, `%`, backticks and newlines then reach OpenCode unchanged.

## Prepare and route

Invoke the inline `opencode:opencode-prompting` skill when preparing a prompt. Send the prepared prompt, not raw slash-command arguments. Keep routing selections separate from task text.

Unless the user supplied `--resume` or `--fresh`, check:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" task-resume-candidate --cwd "<repo>" --json
```

If `available: true`, ask once whether to continue the current OpenCode session (`--resume`) or start a new one (`--fresh`). Recommend continue for follow-ups, otherwise new. If unavailable, proceed.

- Pass explicit `--model` and `--agent` selections; otherwise leave them unset. Without `--model` the companion uses `OPENCODE_PLUGIN_MODEL`, then the default saved with `config --set-model`, then the agent's configured model. A bad model id fails at once with exit code 3 and names the bad part.
- Map `--resume` to `--resume-last`. For `--fresh`, omit `--resume-last`.
- Writable work is the default (`build` agent). For read-only work, select `--agent plan` (the companion enforces read-only permissions for this selection). Resolve a conflicting explicit agent selection with the user before dispatch.
- Foreground (`--wait`) is the default. `--background` selects a Claude background Bash waiter, not a Claude subagent.

## Dispatch once

Write the prepared prompt to a file in your scratchpad (for example `<scratchpad>/opencode-prompt.md`), then run:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" task --background --cwd "<repo>" --prompt-file "<scratchpad>/opencode-prompt.md"
```

Apply the routing selections above. Capture the `task-...` ID from the first stdout line (`OpenCode task started in background: <task-id>`). The companion's `--background` starts its tracked worker in both execution modes so each foreground wait can stay within Bash's execution limit. The worker reads the prompt from the job record, never from a command line.

## Foreground waiting

Call the following with a Bash timeout of 600000 ms, up to 20 rounds. The job ID is found from any folder, so `--cwd` is optional here:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" wait-and-result <task-id> --max-wait 480
```

`wait-and-result` reconciles server-side completion itself when a detached worker exited before saving its result. A dead worker alone does not mean the OpenCode session finished.

- Exit 0: the job completed. Return stdout verbatim; it starts with `## Job:`.
- Exit 1 with a `## Job:` report on stdout: the job failed or was cancelled. Return the report verbatim; stderr has the reason on one line.
- Exit 2: the job is still running (stdout is one JSON line with `status`, `elapsed`, `task_id`, `workspace`, `log_file`); wait again using the same task ID.
- Exit 3 (bad arguments) or 4 (job not found), or no report: report `ERROR: companion dispatch failed (<stderr line>)`.
- After 20 timeouts: report the task ID and that waiting timed out; the OpenCode job may still be running. Offer `/opencode:status`, `/opencode:result`, or `/opencode:cancel` rather than dispatching a duplicate job.

## Background waiting

Launch this shell loop through `Bash` with `run_in_background: true`, replacing `<task-id>` with the captured ID:

```bash
for ((round = 0; round < 20; round++)); do
  sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" wait-and-result <task-id> --max-wait 480
  code=$?
  if [ "$code" -ne 2 ]; then
    exit "$code"
  fi
done
printf '%s\n' 'OpenCode task <task-id> is still running after 20 wait rounds; check /opencode:status or /opencode:result.'
exit 2
```

Return a brief started acknowledgement with the OpenCode task ID. Let Claude's background Bash completion notification bring the result back; no extra Monitor or Agent is needed. On completion, return the terminal `## Job:` report verbatim. A timeout or waiter failure is not job completion; check status/result for the same ID before retrying anything.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (job completed, command done) |
| 1 | Job failed or was cancelled, or OpenCode returned an error |
| 2 | Job still running (`wait-and-result` timed out, `result` on an active job) |
| 3 | Usage error: unknown option, bad `--cwd`, unreadable `--prompt-file`, bad model |
| 4 | Job not found, or the ID prefix matches more than one job |

Errors are one line on stderr, prefixed with `opencode-companion <subcommand>:`.

For progress inspection or failure handling, invoke the inline `opencode:opencode-result-handling` skill so its plugin paths resolve too. Report dispatch failures without substituting a Claude implementation.
