// An independent HTTP contract fixture for the OpenCode V2 API, plus a
// helper that runs the companion CLI against it.

import { createServer } from "node:http";
import path from "node:path";
import { createClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

const model = (providerID, id, variants = []) => ({ id, modelID: id, providerID, variants: variants.map((v) => ({ id: v })) });
const DEFAULT_MODELS = [
  model("vendor", "requested", ["high"]),
  model("vendor", "model/name", ["high"]),
  model("cfg", "agent-model"),
  model("env", "model"),
  model("saved", "model"),
];

export const authorization = `Basic ${Buffer.from("opencode:fixture").toString("base64")}`;

// An independent HTTP contract fixture, not a mocked SDK. Unknown V1 routes,
// missing authentication, or invalid V2 prompt fields are rejected.
export async function serveV2(t, {
  outcome = "succeeded", permission = false, active = false, stall = false, text = "Final V2 output",
  status = [{ file: "src/app.js", additions: 3, deletions: 1, status: "modified" }],
  base = { name: "main", ref: "refs/heads/main", source: "default" },
  models = DEFAULT_MODELS, onPrompt = () => {},
} = {}) {
  const sessionID = "ses_fixture";
  const now = Date.now();
  const session = {
    id: sessionID, location: { directory: "/workspace" },
    permissions: [{ action: "edit", resource: "secrets/*", effect: "deny" }],
    time: { created: now, updated: now },
  };
  let polls = 0;
  let admitted = false;
  let commandAccepted = false;
  const calls = [];
  const selected = { agent: "build", model: { providerID: "cfg", id: "agent-model" } };
  const assistant = (final) => ({
    id: final ? "msg_final" : "msg_tool", type: "assistant",
    agent: selected.agent, model: selected.model,
    time: { created: now + 1, completed: now + 2 },
    finish: final ? "stop" : "tool-calls",
    content: final
      ? [{ type: "reasoning", text: "private reasoning" }, { type: "text", text }]
      : [{ type: "text", text: "Still working" }, { type: "tool", tool: "read", state: { status: "completed" } }],
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : undefined;
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers });
    const json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== authorization) return json({ error: "unauthorized" }, 401);
    const path = url.pathname;
    if (path === "/api/info") return json({ version: "2.0.26" });
    if (path === "/api/agent") return json({ data: [{ id: "plan", model: { providerID: "cfg", id: "agent-model" } }] });
    if (path === "/api/session" && req.method === "POST") return json({ data: { ...session, ...body } });
    if (path === "/api/model") return models ? json({ data: models }) : json({ error: "unavailable" }, 500);
    if (path === `/api/session/${sessionID}/agent` || path === `/api/session/${sessionID}/model`) {
      if (body?.agent) selected.agent = body.agent;
      if (body?.model) selected.model = body.model;
      res.writeHead(204).end(); return;
    }
    if (path === `/api/session/${sessionID}` && req.method === "PATCH") {
      session.permissions = body.permissions;
      res.writeHead(204).end(); return;
    }
    if (path === `/api/session/${sessionID}/prompt`) {
      if (!body.text || body.parts || body.agent || body.model) return json({ error: "invalid prompt" }, 400);
      admitted = true;
      await onPrompt(body.text);
      return json({ data: { id: "msg_user", sessionID, time: { created: now }, type: "user", payload: { text: body.text }, delivery: body.delivery ?? "steer" } });
    }
    if (path === `/api/session/${sessionID}/command` && req.method === "POST") {
      if (!body?.name) return json({ error: "missing command" }, 400);
      admitted = true;
      commandAccepted = true;
      res.writeHead(204).end();
      return;
    }
    if (path === "/api/vcs/status") return json({ data: status });
    if (path === "/api/vcs/base") return json({ data: base });
    // The context route counts polls, so "idle" is only ever reported once
    // the final message is already served, whatever order requests arrive in.
    if (path === "/api/session/active") {
      return json({ data: active || (admitted && polls < 2) ? { [sessionID]: { type: "running" } } : {} });
    }
    if (path === `/api/session/${sessionID}`) {
      return json({ data: { ...session, outcome, time: { ...session.time, idle: commandAccepted ? now + 10 : now + 3 } } });
    }
    if (path === `/api/session/${sessionID}/context`) {
      if (stall) return; // Deliberately leave this HTTP response open.
      if (admitted) polls++;
      return json({ data: [assistant(polls >= 2 || !admitted)] });
    }
    if (path === `/api/session/${sessionID}/inbox`) return json({ data: [] });
    if (path === `/api/session/${sessionID}/permission`) {
      return json({ data: permission ? [{ id: "per_fixture", action: "external_directory", resources: ["/private/*"] }] : [] });
    }
    if (path === `/api/session/${sessionID}/interrupt`) return json({ interrupted: true });
    if (path === `/api/session/${sessionID}/message`) {
      return json({ data: [assistant(true)], cursor: { next: null, previous: null } });
    }
    if (path === `/api/session/${sessionID}/diff`) return json({ data: [{ file: "src/fixed.js", additions: 1, deletions: 0 }] });
    return json({ error: `unknown route ${path}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization };
  return { client: createClient(baseUrl, { directory: "/workspace", headers }), baseUrl, headers, calls, sessionID, now };
}

/**
 * Run the companion CLI against a fixture server. The returned function runs
 * a command in a fresh data directory; `run.exec({ cwd, input }, ...args)`
 * runs it from another folder or with stdin.
 */
export function cli(t, baseUrl, overrides = {}) {
  const workspace = createTmpDir();
  t.after(() => cleanupTmpDir(workspace));
  const script = path.resolve("plugins/opencode/scripts/opencode-companion.mjs");
  const env = {
    ...process.env,
    OPENCODE_SERVER_URL: baseUrl,
    OPENCODE_SERVER_PASSWORD: "fixture",
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_COMPANION_DATA: workspace,
    OPENCODE_COMPLETION_POLL_MS: "10",
    OPENCODE_PROMPT_TIMEOUT_MS: "5000",
    OPENCODE_COMPANION_SESSION_ID: "cli-fixture",
    ...overrides,
  };
  const exec = (opts, ...args) => runCommand(process.execPath, [script, ...args], { cwd: opts.cwd ?? workspace, env, input: opts.input });
  return Object.assign((...args) => exec({}, ...args), { exec, dataDir: workspace });
}
