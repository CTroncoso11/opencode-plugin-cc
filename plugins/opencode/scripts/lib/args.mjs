// Argument parsing for the OpenCode companion scripts.

import fs from "node:fs";
import path from "node:path";
import { usageError } from "./errors.mjs";

/** Options every subcommand accepts. */
export const GLOBAL_VALUE_OPTIONS = ["cwd", "workspace"];

/**
 * Parse CLI arguments into options and positional args.
 * Accepts `--key value` and `--key=value`; everything after `--` is positional.
 * Unknown options are a usage error.
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 * @returns {{ options: Record<string, string|boolean>, positional: string[] }}
 */
export function parseArgs(argv, schema = {}) {
  const valueSet = new Set([...GLOBAL_VALUE_OPTIONS, ...(schema.valueOptions ?? [])]);
  const boolSet = new Set(schema.booleanOptions ?? []);
  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (valueSet.has(key)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw usageError(`Option --${key} needs a value.`);
      options[key] = value;
    } else if (boolSet.has(key) && eq === -1) {
      options[key] = true;
    } else {
      throw usageError(`Unknown option --${key}. Use -- before text that starts with --.`);
    }
  }

  return { options, positional };
}

/**
 * The workspace directory the caller asked for with --cwd or --workspace.
 * @param {Record<string, string|boolean>} options
 * @returns {string|undefined}
 */
export function workspaceOption(options) {
  return /** @type {string|undefined} */ (options.cwd ?? options.workspace);
}

/**
 * Read the prompt from --prompt-file (a path, or "-" for stdin) or from the
 * positional words. A leading byte order mark and outer whitespace are removed.
 * @param {Record<string, string|boolean>} options
 * @param {string[]} positional
 * @param {{ readStdin?: () => string }} [io]
 * @returns {string}
 */
export function readPrompt(options, positional, io = {}) {
  const file = options["prompt-file"];
  if (file === undefined) return positional.join(" ").trim();
  if (positional.length > 0) {
    throw usageError("Pass the prompt either as text or with --prompt-file, not both.");
  }
  let text;
  try {
    text = file === "-"
      ? (io.readStdin ?? (() => fs.readFileSync(0, "utf8")))()
      : fs.readFileSync(path.resolve(String(file)), "utf8");
  } catch (err) {
    throw usageError(`Cannot read prompt file ${file}: ${err.code ?? err.message}`);
  }
  return text.replace(/^﻿/, "").trim();
}
