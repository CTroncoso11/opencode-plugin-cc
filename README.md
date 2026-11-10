# OpenCode V2 plugin for Claude Code

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

Maintained by [Cristian Troncoso](https://github.com/CTroncoso11) at
[CTroncoso11/opencode-plugin-cc](https://github.com/CTroncoso11/opencode-plugin-cc).
It continues [armedi/opencode-plugin-cc](https://github.com/armedi/opencode-plugin-cc)
(the OpenCode V2 port of [tasict/opencode-plugin-cc](https://github.com/tasict/opencode-plugin-cc)),
with safe prompt passing on Windows, `--cwd` and `--prompt-file`, job lookup by ID,
model defaults and validation, a Bun-or-Node launcher and cross-platform tests.

It targets **OpenCode V2** and is tested against **2.2.5** (client
`@opencode/client` 2.2.6) on Windows (Git Bash), with simulated macOS and Linux
tests. V1 is not supported; use tasict's project for V1.

> **Tribute:** Inspired by [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
> by OpenAI. Its architecture, command structure, and design patterns were adapted
> to work with [OpenCode](https://github.com/anomalyco/opencode).

This is a **Claude Code plugin**, not a native OpenCode plugin. It uses the
released `@opencode/client` V2 API to connect to OpenCode's background service.
Do not add it to OpenCode's `plugins` configuration.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [OpenCode V2](https://opencode.ai/v2/docs/) in your PATH
- A configured AI provider in OpenCode (open OpenCode and use `/connect`)
- Node.js **22 or later** (always needed by the installer and npm), or Bun **1.4 or later**
  to run the companion; plus npm, Git and a POSIX `sh` (Git Bash on Windows)

If you already have V2, keep your existing installation and configuration.
For a new installation:

```bash
npm install -g @opencode/cli
opencode --version
```

## Plugin marketplace

This repository is a Claude Code **plugin marketplace** with one plugin.

| Item | Value |
| --- | --- |
| Marketplace name | `ctroncoso-opencode-plugin-cc` |
| Marketplace source | GitHub `CTroncoso11/opencode-plugin-cc` (branch `main`) |
| Manifest | [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) |
| Plugin | `opencode` (folder `plugins/opencode`, manifest `plugins/opencode/.claude-plugin/plugin.json`) |
| Plugin ID | `opencode@ctroncoso-opencode-plugin-cc` |
| Commands | `/opencode:delegate`, `/opencode:review`, `/opencode:status`, `/opencode:result`, `/opencode:cancel`, `/opencode:setup` |

### Install

The same steps work on macOS, Linux and Windows. Inside Claude Code:

```text
/plugin marketplace add CTroncoso11/opencode-plugin-cc
/plugin install opencode@ctroncoso-opencode-plugin-cc
/reload-plugins
/opencode:setup
```

Choose the installation scope in the plugin panel (for example,
**Install for you (user scope)**). `/opencode:setup` checks OpenCode, its
service and its providers.

From the terminal, outside a session, the same steps are:

```bash
claude plugin marketplace add CTroncoso11/opencode-plugin-cc
claude plugin install opencode@ctroncoso-opencode-plugin-cc
```

Alternative: the installer script clones the marketplace, prepares the locked
`@opencode/client` dependency with npm and registers the marketplace (SSH first,
then HTTPS). It does **not** install or enable the plugin.

```bash
! curl -fsSL https://raw.githubusercontent.com/CTroncoso11/opencode-plugin-cc/main/install.sh | bash
```

Then run `/plugin install opencode@ctroncoso-opencode-plugin-cc` and `/reload-plugins`.

### Install from a local clone

Use this to test changes before you push them:

```bash
git clone git@github.com:CTroncoso11/opencode-plugin-cc.git
cd opencode-plugin-cc
npm --prefix plugins/opencode ci --omit=dev --ignore-scripts --workspaces=false
claude plugin marketplace add "$(pwd)"
claude plugin install opencode@ctroncoso-opencode-plugin-cc
```

Then run `/reload-plugins` in Claude Code.

### Update

```text
/plugin marketplace update ctroncoso-opencode-plugin-cc
/plugin update opencode@ctroncoso-opencode-plugin-cc
/reload-plugins
```

### Move from armedi's or tasict's marketplace

Remove the old plugin and marketplace first, so the commands and hooks are not
loaded twice:

```text
/plugin uninstall opencode@armedi-opencode-plugin-cc
/plugin marketplace remove armedi-opencode-plugin-cc
/plugin uninstall opencode@tasict-opencode-plugin-cc
/plugin marketplace remove tasict-opencode-plugin-cc
```

Then install as above. Old jobs stay in the plugin data folder; jobs made by
the old version are found with `--cwd` only.

### Diagnose

```bash
sh ~/.claude/plugins/cache/ctroncoso-opencode-plugin-cc/opencode/*/scripts/run.sh doctor
```

If the plugin is installed but disabled, enable it from the **Installed** tab (or run
`/plugin enable opencode@ctroncoso-opencode-plugin-cc`), then `/reload-plugins`.

### Use

```text
/opencode:delegate grep for XXX in src/ and summarize
```

### Uninstall

```text
/plugin uninstall opencode@ctroncoso-opencode-plugin-cc
/plugin marketplace remove ctroncoso-opencode-plugin-cc
/reload-plugins
```

### Release a new version

1. Raise `version` in `.claude-plugin/marketplace.json` (marketplace and plugin
   entry), `plugins/opencode/.claude-plugin/plugin.json`, `package.json` and
   `plugins/opencode/package.json` (and their lockfiles).
2. Run `npm test`, `npm run test:bun` and `claude plugin validate .`.
3. Push to `main`. Users run the update steps above.

## Commands

| Command | Purpose |
| --- | --- |
| `/opencode:review` | OpenCode's built-in `/review`; supports `--base <ref>`, `--scope` and `--model` |
| `/opencode:delegate` | Delegate work; supports `--model`, `--agent`, `--resume`, `--fresh`, `--background` |
| `/opencode:status` | Running/recent jobs for the current repository |
| `/opencode:result` | Finished output and OpenCode session ID |
| `/opencode:cancel` | Interrupt the V2 session and stop its companion worker |
| `/opencode:setup` | Check installation/service/providers and toggle the review gate |

Model references use `provider/model` or `provider/model#variant`. The model is
chosen in this order: `--model`, the `OPENCODE_PLUGIN_MODEL` environment
variable, the default saved with `companion config --set-model <provider/model>`
(clear it with `--unset-model`), and finally the model configured for the agent
in OpenCode. The model is checked against OpenCode's model list before a job is
created; an unknown provider, model or variant fails with exit code 3. The
report shows the model and agent OpenCode really used. Resuming reuses the same
OpenCode session.

Claude prepares the delegation prompt with the context needed for the request,
referencing existing artifacts by path or URL and including conversation-only
details inline. Claude calls the companion directly with that prepared prompt,
not through a forwarding Claude subagent or with raw command arguments.
For `/opencode:delegate --fresh implement the plan`, this means
supplying the plan's path or its inline contents; `--fresh` changes session
routing, not context preparation.

Foreground delegation waits through bounded companion calls. Background delegation uses
a Claude background Bash waiter, whose completion notification returns the
terminal report. Both modes retain companion job tracking and OpenCode sessions;
no forwarding subagent or separate Monitor is needed. Status, result, and cancel
remain available while a task runs.

### Permissions and review gate

The companion **never rewrites global OpenCode permissions**. Delegated sessions
deny interactive questions so unattended jobs do not wait for a user response.
Other configured permissions remain in effect. If an operation requests approval,
the companion interrupts the session and reports the requested action/resources;
add an appropriately narrow allow rule yourself before retrying.

Read-only task sessions additionally deny edits, shell execution, and subagents.
They can inspect code through read/glob/grep tools, but cannot run tests or shell
commands. `/opencode:review` is different: it runs OpenCode's built-in `/review`
on the plan agent, and that command collects the diff with git, so the review
session allows shell and subagents while still denying edits and questions.
The stop gate uses that same review permission set.
This is permission enforcement, not an OS sandbox; custom tools/plugins
must also enforce their own permissions. A resumed read-only session retains
its restrictions; use `--fresh` when switching to writable work.

Enable the optional Stop review gate with `/opencode:setup --enable-review-gate`.
It reviews Claude's response before allowing a stop. It is disabled by default
and may increase latency and model usage.

## Companion CLI

Claude Code calls the companion through one launcher, `scripts/run.sh`. It runs
the companion with Bun when `bun` 1.4 or later is on PATH, else with Node 22 or
later (`OPENCODE_COMPANION_RUNTIME=node|bun` forces one). The hooks use the
same launcher. Background workers start with the same runtime as the companion.

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" task --background --cwd /path/to/repo --prompt-file /tmp/prompt.md
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" wait-and-result <task-id> --max-wait 480
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" status <task-id> --json
```

- `--cwd <dir>` (alias `--workspace <dir>`) works on every subcommand and
  selects the workspace (its git root). Without it the current directory is used.
- `status`, `result`, `wait-and-result` and `cancel` find a job by ID (or a
  unique ID prefix) in any workspace, so they work from any folder.
- `task` takes the prompt from `--prompt-file <path>`, from stdin with
  `--prompt-file -`, or as the remaining words. Use `--` before text that starts
  with `--`. No prompt ever goes through a shell or onto a worker's command line,
  so quotes, `$`, `&`, `%` and newlines arrive unchanged.
- `review` runs OpenCode's built-in `/review` and accepts no custom instructions
  (positional or `--prompt-file`); use `task --agent plan` for that.
- Unknown options are errors. Errors are one line on stderr.
- Every finished job prints the same report: status, agent, model, duration,
  OpenCode session, workspace, files changed (`git diff --stat` of what changed
  during the job), then the output.
- `status --json` has a stable, versioned shape (`schemaVersion: 1`); see
  `plugins/opencode/skills/opencode-result-handling/SKILL.md`.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Job failed or was cancelled, or OpenCode returned an error |
| 2 | Job still running (`wait-and-result` timed out, or `result` on an active job) |
| 3 | Usage error (unknown option, bad `--cwd`, unreadable prompt file, unknown model) |
| 4 | Job not found, or the ID prefix is ambiguous |

## V2 service and job lifecycle

The companion discovers (or starts) the shared local V2 service with
`Service.discover()` / `Service.ensure()`, using its registered URL and
authentication. No fixed port, manually spawned V1 daemon, or global config repair
is needed. Status, diagnostics, and hooks do not start a service just to inspect it.

V2 prompt admission returns an inbox acknowledgement, not model output. The
companion polls session outcome, active execution, and pending inbox state before
returning the final assistant message. A completed tool-call step is **not** a
completed job. Failed or interrupted sessions are reported as failures.

Status/result automatically reconcile jobs whose worker exited after the server
finished. `companion heal --dry-run --json` previews this reconciliation;
`--all` includes jobs from other Claude sessions. Unreachable services or sessions
that are still running are left alone rather than incorrectly marked failed.

Inspect live messages with the V2 CLI (which handles discovery/authentication).
In Git Bash on Windows, `MSYS_NO_PATHCONV=1` keeps the path from being rewritten:

```bash
MSYS_NO_PATHCONV=1 opencode api get /api/session/<session-id>/message
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_PLUGIN_MODEL` | Unset | Default model for `task` and `review` when `--model` is not given |
| `OPENCODE_COMPANION_RUNTIME` | Auto | `node` or `bun` to override the launcher's choice |
| `OPENCODE_SERVER_URL` | Discovered service | Explicit V2 server URL; never falls back to starting a different server |
| `OPENCODE_SERVER_PASSWORD` | Unset | Basic authentication for an explicit server |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic authentication username for an explicit server |
| `OPENCODE_REQUEST_TIMEOUT_MS` | `1800000` | HTTP request timeout |
| `OPENCODE_PROMPT_TIMEOUT_MS` | `14400000` | Session completion timeout; interrupts the session on expiry |
| `OPENCODE_COMPLETION_POLL_MS` | `5000` | Session completion poll interval |
| `OPENCODE_COMPANION_DATA` | Self-derived | Override plugin data directory |

`companion config --json` prints resolved settings, including the default model
and where it comes from (passwords are redacted).
The old V1 idle/pgrep/strict-terminal environment settings are no longer used.

## Troubleshooting

- **Service unavailable:** run `opencode service status`, then
  `opencode service start`. For an unhealthy service, use
  `opencode service restart`.
- **No providers:** open OpenCode and use `/connect`, then rerun setup.
- **Missing `@opencode/client`:** run
  `npm ci --omit=dev --ignore-scripts --workspaces=false` in the plugin folder
  (`plugins/opencode` of the marketplace, or the cached copy), or rerun the installer.
- **Permission requested:** configure a narrow V2 `permissions` rule for the
  reported action/resource; the companion deliberately does not auto-approve.
- **Plugin not loading:** run
  `/plugin install opencode@ctroncoso-opencode-plugin-cc`, then `/reload-plugins`.
  Restart Claude Code if necessary.

V2 reads global `~/.config/opencode/opencode.json(c)` (or `$XDG_CONFIG_HOME`)
and project `opencode.json(c)` / `.opencode/opencode.json(c)` through normal
configuration discovery. Existing supported V1 configuration remains compatible.

## Development

```bash
npm ci
npm test            # Node's test runner
npm run test:bun    # the same suite under Bun (bun test)
sh plugins/opencode/scripts/run.sh setup --json
sh plugins/opencode/scripts/run.sh doctor --json
```

Runtime dependencies and a standalone lockfile live in `plugins/opencode/` so
the cached Claude Code plugin can run independently of this repository.

## License

Copyright 2026 OpenCode Plugin Contributors; modifications copyright 2026
Cristian Troncoso.
Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for the license and attribution notices.
