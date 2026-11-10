---
name: opencode-result-handling
description: Guidance for returning OpenCode terminal reports and inspecting task progress
user-invocable: false
---

# OpenCode Result Handling

## Returning Results

Return the companion's terminal report verbatim. It starts with `## Job: <id>` and always lists type, status, agent, model, duration, OpenCode session ID, workspace and files changed (from `git diff --stat` between the worktree before and after the job; changes made before the job are not counted). Then come the output or the error, and the diff stat when files changed. The report is not a full session trace.

Claude dispatches and waits directly through Bash. Return OpenCode's report rather than implementing a substitute solution.

## Resuming Sessions

`task --resume-last` reuses the latest task session in the workspace, filtered to the current Claude session when its ID is available.

## Inspecting Progress

Claude can inspect progress when needed while a background Bash waiter handles completion.

### Job Status

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" status <task-id> --json
```

A job ID is found from any folder, so `--cwd` is not needed with an ID. Without an ID, pass `--cwd "<repo>"` to list that workspace's jobs (`--all` includes other Claude sessions).

The JSON shape is stable (`schemaVersion: 1`):

- `status <id> --json` prints `{ schemaVersion, workspaceRoot, job }`. When no job matches it prints `{ schemaVersion, workspaceRoot, job: null, error: "not_found" | "ambiguous" }` and exits 4.
- `status --json` prints `{ schemaVersion, workspaceRoot, running: Job[], latestFinished: Job | null, recent: Job[] }`.

Every `Job` has all of these keys; unknown values are `null`:

| Key | Meaning |
| --- | --- |
| `id`, `type` | Job ID and `task` or `review` |
| `status` | `pending`, `queued`, `running`, `completed`, `failed`, `cancelled` |
| `phase` | Last progress phase, such as `starting`, `investigating`, `finalizing` |
| `agent`, `model` | Agent and `provider/model#variant` used (requested model until OpenCode answers) |
| `workspace` | Workspace root the job runs in |
| `opencodeSessionId`, `claudeSessionId` | OpenCode session, and the Claude session that started the job |
| `createdAt`, `updatedAt`, `completedAt` | ISO timestamps |
| `elapsedMs`, `elapsed` | Duration in milliseconds and as text |
| `filesChanged` | `{ files: string[], stat: string \| null }` or `null` when unknown |
| `errorMessage` | Why a job failed or was cancelled |
| `logFile` | The job's progress log |
| `progressPreview` | Last log lines of an active job |
| `breadcrumb` | Last tool call or text of a running OpenCode session |

The prompt text is never part of the status output.

### Session Messages

Use the V2 CLI to inspect the session trace. It discovers the background service and supplies authentication; the service does not have a fixed port. In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` so the path is not rewritten:

```bash
MSYS_NO_PATHCONV=1 opencode api get /api/session/<sessionId>/message
```

Get `<sessionId>` from the status response's `job.opencodeSessionId`. The response contains `data` (messages) and `cursor` (pagination). Messages have `type`, `time`, and assistant `content[]`:
- `type: "text"` → `part.text` is visible assistant output
- `type: "reasoning"` → reasoning, separate from visible output
- `type: "tool"` → `part.tool`, `part.input`, and `part.state` describe the invocation

A completed tool-call message does not mean the job finished. Use companion status for completion; V2 session outcomes are `succeeded`, `failed`, or `interrupted`.

## When to Ask the User

If session messages show repeated errors or prolonged lack of progress, ask whether to cancel or continue. Cancel only when the user requests it:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" cancel <task-id>
```
