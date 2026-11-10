import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderStatus, renderResult, renderSetup } from "../plugins/opencode/scripts/lib/render.mjs";

describe("renderStatus", () => {
  it("renders empty state", () => {
    const output = renderStatus({ running: [], latestFinished: null, recent: [] });
    assert.ok(output.includes("No OpenCode jobs"));
  });

  it("renders running jobs", () => {
    const output = renderStatus({
      running: [{ id: "task-1", type: "task", phase: "investigating", elapsed: "2m 30s" }],
      latestFinished: null,
      recent: [],
    });
    assert.ok(output.includes("task-1"));
    assert.ok(output.includes("investigating"));
  });
});

describe("renderSetup", () => {
  it("renders installed status", () => {
    const output = renderSetup({ installed: true, version: "1.3.9", serverRunning: true, providers: ["anthropic"], reviewGate: false });
    assert.ok(output.includes("Yes"));
    assert.ok(output.includes("1.3.9"));
    assert.ok(output.includes("anthropic"));
  });

  it("renders not installed status", () => {
    const output = renderSetup({ installed: false });
    assert.ok(output.includes("No"));
  });
});

describe("renderResult", () => {
  it("renders completed job", () => {
    const output = renderResult(
      { id: "task-1", type: "task", status: "completed", elapsed: "5m" },
      { rendered: "Fixed the bug in api.ts" }
    );
    assert.ok(output.includes("task-1"));
    assert.ok(output.includes("Fixed the bug"));
  });

  it("renders failed job", () => {
    const output = renderResult(
      { id: "task-2", type: "task", status: "failed", elapsed: "1m", errorMessage: "Connection timeout" },
      null
    );
    assert.ok(output.includes("Connection timeout"));
  });
});

describe("renderResult header", () => {
  it("always lists agent, model, duration, session and changed files", () => {
    const output = renderResult(
      { id: "task-3", type: "task", status: "completed", elapsed: "12s", agent: "plan", model: "deepseek/deepseek-flash",
        opencodeSessionId: "ses_1", workspace: "/repo",
        filesChanged: { files: ["a.js"], stat: " a.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)" } },
      { rendered: "done" },
    );
    for (const line of ["- **Agent**: plan", "- **Model**: deepseek/deepseek-flash", "- **Duration**: 12s",
      "- **OpenCode Session**: ses_1", "- **Files Changed**: 1 file changed, 1 insertion(+), 1 deletion(-)", " a.js | 2 +-"]) {
      assert.ok(output.includes(line), line);
    }
  });

  it("says unknown or none instead of leaving fields out", () => {
    const output = renderResult({ id: "task-4", type: "task", status: "completed", filesChanged: { files: [], stat: "" } }, null);
    assert.ok(output.includes("- **Model**: agent default"));
    assert.ok(output.includes("- **OpenCode Session**: none"));
    assert.ok(output.includes("- **Files Changed**: none"));
    assert.ok(output.includes("(No output captured)"));
  });
});
