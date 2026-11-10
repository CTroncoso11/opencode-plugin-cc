// Process utilities for the OpenCode companion.
//
// Nothing here runs through a shell by default: arguments reach the child
// process exactly as given. On Windows a command name is resolved on PATH
// (native .exe/.com first). Only .cmd/.bat shims go through cmd.exe, with
// every argument escaped for it, and .ps1 shims go through PowerShell -File.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";
const NATIVE_EXTENSIONS = [".exe", ".com"];
const SHIM_EXTENSIONS = [".cmd", ".bat", ".ps1"];
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Read an environment variable without caring about its case (Windows uses "Path").
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string|undefined}
 */
function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Overlay variables on the current environment. Windows names are
 * case-insensitive, so an override replaces the existing key ("PATH" over "Path").
 * @param {NodeJS.ProcessEnv} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function mergeEnv(extra = {}) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(extra)) {
    if (IS_WINDOWS) {
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      }
    }
    env[name] = value;
  }
  return env;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return isFile(file);
  } catch {
    return false;
  }
}

/**
 * Find an executable the way a shell would, without running a shell.
 * On Windows, native binaries win over .cmd/.bat/.ps1 shims anywhere on PATH.
 * @param {string} name - a command name or a path
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, exists?: (file: string) => boolean }} [opts]
 *   `platform` and `exists` let tests simulate another operating system.
 * @returns {string|null}
 */
export function resolveExecutable(name, opts = {}) {
  const env = opts.env ?? process.env;
  const windows = opts.platform ? opts.platform === "win32" : IS_WINDOWS;
  const pathApi = windows ? path.win32 : path.posix;
  const check = opts.exists ?? (windows ? isFile : isExecutable);
  const hasExtension = pathApi.extname(name) !== "";
  const candidates = (base, extensions) =>
    hasExtension && windows ? [base] : windows ? extensions.map((ext) => base + ext) : [base];

  if (name.includes("/") || (windows && name.includes("\\"))) {
    const found = candidates(name, [...NATIVE_EXTENSIONS, ...SHIM_EXTENSIONS]).find(check);
    return found ?? null;
  }

  const dirs = (envValue(env, "PATH") ?? "").split(pathApi.delimiter).filter(Boolean);
  const passes = windows ? [NATIVE_EXTENSIONS, SHIM_EXTENSIONS] : [[]];
  for (const extensions of passes) {
    for (const dir of dirs) {
      const found = candidates(pathApi.join(dir, name), extensions).find(check);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Quote one argument for cmd.exe running a batch file. The batch file parses
 * its arguments a second time, so metacharacters are escaped twice.
 * @param {string} arg
 * @returns {string}
 */
export function escapeCmdArgument(arg) {
  if (/[\r\n]/.test(arg)) {
    throw new Error("A multi-line argument cannot pass through a Windows batch shim.");
  }
  const quoted = `"${String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * Build the spawn call for a command so it never runs through an implicit shell.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, exists?: (file: string) => boolean }} [opts]
 * @returns {{ command: string, args: string[], windowsVerbatimArguments?: boolean }}
 */
export function buildSpawnCommand(cmd, args, opts = {}) {
  const windows = opts.platform ? opts.platform === "win32" : IS_WINDOWS;
  if (!windows) return { command: cmd, args };

  const file = resolveExecutable(cmd, opts) ?? cmd;
  const ext = path.win32.extname(file).toLowerCase();
  const env = opts.env ?? process.env;
  if (ext === ".cmd" || ext === ".bat") {
    const line = [file.replace(CMD_META, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
    return {
      command: envValue(env, "COMSPEC") ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (ext === ".ps1") {
    return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args] };
  }
  return { command: file, args };
}

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {string|null}
 */
export function resolveOpencodeBinary() {
  return resolveExecutable("opencode");
}

/**
 * The command the V2 client should use to start the background service, when
 * it can be started without a shell. Undefined keeps the client's default.
 * @returns {string[]|undefined}
 */
export function opencodeServiceCommand() {
  const bin = resolveOpencodeBinary();
  if (!bin) return undefined;
  if (IS_WINDOWS && !NATIVE_EXTENSIONS.includes(path.extname(bin).toLowerCase())) return undefined;
  return [bin, "serve", "--service"];
}

/**
 * Get the installed opencode version.
 * @returns {Promise<string|null>}
 */
export async function getOpencodeVersion() {
  const bin = resolveOpencodeBinary();
  if (!bin) return null;
  const { stdout, exitCode } = await runCommand(bin, ["--version"]);
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Run a command and return { stdout, stderr, exitCode }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const env = mergeEnv(opts.env);
    let proc;
    try {
      const spec = buildSpawnCommand(cmd, args, { env });
      proc = spawn(spec.command, spec.args, {
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        cwd: opts.cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (err) {
      resolve({ stdout: "", stderr: String(err), exitCode: 1 });
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    proc.on("error", (err) => resolve({ stdout, stderr: stderr + String(err), exitCode: 1 }));
    if (opts.input !== undefined) proc.stdin.end(opts.input);
  });
}

/**
 * Spawn a detached background process with no console window.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, logFile?: string }} [opts]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(cmd, args, opts = {}) {
  const env = mergeEnv(opts.env);
  const spec = buildSpawnCommand(cmd, args, { env });
  const logFd = opts.logFile ? fs.openSync(opts.logFile, "a") : null;
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      detached: true,
      cwd: opts.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
  child.unref();
  return child;
}

/**
 * Check whether a process is still alive.
 * @param {number|undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
