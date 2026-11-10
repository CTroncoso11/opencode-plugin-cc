---
description: Check whether the local OpenCode CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(sh:*), Bash(npm:*), Bash(brew:*), Bash(curl:*), AskUserQuestion
---

Run, replacing `<repo>` with the absolute path of the repository the user is working in (the review gate setting belongs to that workspace):

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" setup --json --cwd "<repo>" $ARGUMENTS
```

If the result says OpenCode is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install OpenCode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install OpenCode (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @opencode/cli
```

- Then rerun:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" setup --json --cwd "<repo>" $ARGUMENTS
```

If OpenCode is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If OpenCode is installed but no provider is configured, guide the user to open OpenCode and run `/connect` to sign in.
