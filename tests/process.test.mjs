import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  runCommand, resolveExecutable, buildSpawnCommand, escapeCmdArgument, spawnDetached, isProcessAlive,
} from "../plugins/opencode/scripts/lib/process.mjs";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

const IS_WINDOWS = process.platform === "win32";
const TRICKY_ARGS = [
  "multi\nline",
  `"double" 'single' $HOME \`tick\``,
  "a & b | c ; d %PATH% !x! ^y <in> >out",
  "trailing backslash \\",
  "",
];
const PRINT_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

const fakeFs = (files) => (file) => files.includes(file);

describe("process", () => {
  it("runCommand captures stdout, stderr and exit codes without a shell", async () => {
    const ok = await runCommand(process.execPath, ["-e", "console.log('hello'); console.error('err')"]);
    assert.equal(ok.stdout.trim(), "hello");
    assert.match(ok.stderr, /err/);
    assert.equal(ok.exitCode, 0);
    const failed = await runCommand(process.execPath, ["-e", "process.exit(3)"]);
    assert.equal(failed.exitCode, 3);
    const missing = await runCommand("definitely-not-a-command-xyz", []);
    assert.notEqual(missing.exitCode, 0);
  });

  it("runCommand passes every argument through unchanged and feeds stdin", async () => {
    const { stdout } = await runCommand(process.execPath, ["-e", PRINT_ARGV, ...TRICKY_ARGS]);
    assert.deepEqual(JSON.parse(stdout), TRICKY_ARGS);
    const echoed = await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "a\nb" });
    assert.equal(echoed.stdout, "a\nb");
  });

  it("spawnDetached runs without a shell and keeps arguments intact", async () => {
    const dir = createTmpDir("opencode-detached");
    after(() => cleanupTmpDir(dir));
    const logFile = path.join(dir, "out.log");
    const child = spawnDetached(process.execPath, ["-e", PRINT_ARGV, ...TRICKY_ARGS], { logFile });
    await new Promise((resolve) => child.on("exit", resolve));
    assert.deepEqual(JSON.parse(fs.readFileSync(logFile, "utf8")), TRICKY_ARGS);
    assert.equal(isProcessAlive(child.pid), false);
    assert.equal(isProcessAlive(process.pid), true);
  });
});

describe("resolveExecutable on simulated platforms", () => {
  for (const platform of ["linux", "darwin"]) {
    it(`${platform}: searches PATH in order and never adds extensions`, () => {
      const env = { PATH: "/opt/first:/usr/local/bin:/usr/bin" };
      const exists = fakeFs(["/usr/local/bin/opencode", "/usr/bin/opencode", "/usr/bin/opencode.exe"]);
      assert.equal(resolveExecutable("opencode", { platform, env, exists }), "/usr/local/bin/opencode");
      assert.equal(resolveExecutable("missing", { platform, env, exists }), null);
      assert.equal(resolveExecutable("/usr/bin/opencode", { platform, env, exists }), "/usr/bin/opencode");
    });

    it(`${platform}: spawns the command directly with untouched arguments`, () => {
      const spec = buildSpawnCommand("opencode", TRICKY_ARGS, { platform, env: { PATH: "/usr/bin" }, exists: () => true });
      assert.deepEqual(spec, { command: "opencode", args: TRICKY_ARGS });
    });
  }

  it("win32: a native .exe anywhere on PATH wins over an earlier .cmd shim", () => {
    const env = { Path: "C:\\npm;C:\\Users\\me\\.bun\\bin" };
    const exists = fakeFs(["C:\\npm\\opencode.cmd", "C:\\Users\\me\\.bun\\bin\\opencode.exe", "C:\\Users\\me\\.bun\\bin\\opencode"]);
    assert.equal(resolveExecutable("opencode", { platform: "win32", env, exists }), "C:\\Users\\me\\.bun\\bin\\opencode.exe");
    const shimOnly = fakeFs(["C:\\npm\\opencode.cmd"]);
    assert.equal(resolveExecutable("opencode", { platform: "win32", env, exists: shimOnly }), "C:\\npm\\opencode.cmd");
    assert.equal(resolveExecutable("opencode", { platform: "win32", env, exists: fakeFs(["C:\\npm\\opencode"]) }), null);
  });

  it("win32: .exe spawns directly; .cmd goes through cmd.exe with escaped arguments; .ps1 through PowerShell -File", () => {
    const env = { PATH: "C:\\bin", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    const native = buildSpawnCommand("tool", ["a b", "c\"d"], { platform: "win32", env, exists: fakeFs(["C:\\bin\\tool.exe"]) });
    assert.deepEqual(native, { command: "C:\\bin\\tool.exe", args: ["a b", "c\"d"] });

    const shim = buildSpawnCommand("tool", ["a & b", "50%"], { platform: "win32", env, exists: fakeFs(["C:\\bin\\tool.cmd"]) });
    assert.equal(shim.command, "C:\\Windows\\system32\\cmd.exe");
    assert.equal(shim.windowsVerbatimArguments, true);
    assert.deepEqual(shim.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(shim.args[3], `"C:\\bin\\tool.cmd ${escapeCmdArgument("a & b")} ${escapeCmdArgument("50%")}"`);

    const ps = buildSpawnCommand("tool", ["x"], { platform: "win32", env, exists: fakeFs(["C:\\bin\\tool.ps1"]) });
    assert.deepEqual(ps, { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\bin\\tool.ps1", "x"] });
  });

  it("escapeCmdArgument quotes, doubles carets for batch files and refuses newlines", () => {
    assert.equal(escapeCmdArgument("a&b"), '^^^"a^^^&b^^^"');
    assert.equal(escapeCmdArgument('say "hi"\\'), '^^^"say^^^ \\^^^"hi\\^^^"\\\\^^^"');
    assert.throws(() => escapeCmdArgument("two\nlines"), /multi-line/);
  });
});

describe("Windows batch shims (real cmd.exe)", { skip: !IS_WINDOWS && "Windows only" }, () => {
  it("a .cmd shim receives quotes, $, &, %, ^ and < > intact", async () => {
    const dir = createTmpDir("opencode-shim");
    after(() => cleanupTmpDir(dir));
    fs.writeFileSync(path.join(dir, "print-args.js"), `${PRINT_ARGV}\n`);
    fs.writeFileSync(path.join(dir, "print-args.cmd"), `@"${process.execPath}" "%~dp0print-args.js" %*\r\n`);
    const args = TRICKY_ARGS.filter((a) => !a.includes("\n"));
    const env = { PATH: `${dir};${process.env.PATH}` };
    const { stdout, stderr, exitCode } = await runCommand("print-args", args, { env });
    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).slice(1), args);
  });
});
