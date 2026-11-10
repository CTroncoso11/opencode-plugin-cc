import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { resolveExecutable, runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

const LAUNCHER = path.resolve("plugins/opencode/scripts/run.sh");
const SH = resolveExecutable("sh");
const PROBE = `process.stdout.write(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node", script: "SCRIPT", args: process.argv.slice(2) }))`;

describe("run.sh launcher", { skip: !SH && "sh is not on PATH" }, () => {
  let dir;
  let fakeBin;
  let pathWithoutBun;

  before(() => {
    dir = createTmpDir("opencode-launcher");
    fs.copyFileSync(LAUNCHER, path.join(dir, "run.sh"));
    fs.writeFileSync(path.join(dir, "opencode-companion.mjs"), PROBE.replace("SCRIPT", "companion"));
    fs.writeFileSync(path.join(dir, "hook.mjs"), PROBE.replace("SCRIPT", "hook"));
    fakeBin = path.join(dir, "fake-bin");
    fs.mkdirSync(fakeBin);
    const hasBun = (entry) => ["bun", "bun.exe", "bun.cmd"].some((name) => fs.existsSync(path.join(entry, name)));
    pathWithoutBun = process.env.PATH.split(path.delimiter).filter((entry) => entry && !hasBun(entry)).join(path.delimiter);
  });
  after(() => cleanupTmpDir(dir));

  function fakeBun(version) {
    fs.writeFileSync(path.join(fakeBin, "bun"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nprintf 'fake-bun %s' "$*"\n`, { mode: 0o755 });
  }

  const launch = (env, ...args) => runCommand(SH, [path.join(dir, "run.sh"), ...args], {
    env: { OPENCODE_COMPANION_RUNTIME: "", ...env },
  });

  it("uses node when bun is not on PATH, and passes arguments through", async () => {
    const out = await launch({ PATH: pathWithoutBun }, "status", "a b", "--json");
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { runtime: "node", script: "companion", args: ["status", "a b", "--json"] });
  });

  it("runs another script in the folder when the first argument is a .mjs file", async () => {
    const out = await launch({ PATH: pathWithoutBun }, "hook.mjs", "SessionEnd");
    assert.deepEqual(JSON.parse(out.stdout), { runtime: "node", script: "hook", args: ["SessionEnd"] });
  });

  it("uses bun 1.4 or later when it is on PATH", async () => {
    fakeBun("1.4.0");
    const out = await launch({ PATH: `${fakeBin}${path.delimiter}${pathWithoutBun}` }, "status");
    assert.match(out.stdout, /^fake-bun .*opencode-companion\.mjs status$/);
  });

  it("falls back to node for bun older than 1.4, and honors OPENCODE_COMPANION_RUNTIME", async () => {
    fakeBun("1.3.9");
    const PATH = `${fakeBin}${path.delimiter}${pathWithoutBun}`;
    assert.equal(JSON.parse((await launch({ PATH }, "status")).stdout).runtime, "node");
    assert.match((await launch({ PATH, OPENCODE_COMPANION_RUNTIME: "bun" }, "status")).stdout, /^fake-bun /);
    fakeBun("2.0.0");
    assert.equal(JSON.parse((await launch({ PATH, OPENCODE_COMPANION_RUNTIME: "node" }, "status")).stdout).runtime, "node");
  });

  it("fails clearly when neither runtime is usable", async (t) => {
    const shDir = path.dirname(SH);
    if (resolveExecutable("node", { env: { PATH: shDir } })) return t.skip("node sits next to sh");
    const out = await launch({ PATH: `${fakeBin}${path.delimiter}${shDir}`, OPENCODE_COMPANION_RUNTIME: "node" }, "status");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /Node\.js 22 or later, or Bun 1\.4 or later, is required/);
  });
});
