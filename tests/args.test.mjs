import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, readPrompt, workspaceOption } from "../plugins/opencode/scripts/lib/args.mjs";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

describe("parseArgs", () => {
  it("parses value options", () => {
    const { options } = parseArgs(["--base", "main", "--scope", "branch"], {
      valueOptions: ["base", "scope"],
    });
    assert.equal(options.base, "main");
    assert.equal(options.scope, "branch");
  });

  it("parses boolean options", () => {
    const { options } = parseArgs(["--wait", "--write"], {
      booleanOptions: ["wait", "write"],
    });
    assert.equal(options.wait, true);
    assert.equal(options.write, true);
  });

  it("collects positional arguments", () => {
    const { positional } = parseArgs(["hello", "--wait", "world"], {
      booleanOptions: ["wait"],
    });
    assert.deepEqual(positional, ["hello", "world"]);
  });

  it("handles mixed args", () => {
    const { options, positional } = parseArgs(
      ["fix", "--model", "claude-sonnet", "--write", "the", "bug"],
      { valueOptions: ["model"], booleanOptions: ["write"] }
    );
    assert.equal(options.model, "claude-sonnet");
    assert.equal(options.write, true);
    assert.deepEqual(positional, ["fix", "the", "bug"]);
  });

  it("accepts --key=value and the global --cwd/--workspace options", () => {
    const { options } = parseArgs(["--model=a/b", "--cwd", "/x", "--workspace=/y"], { valueOptions: ["model"] });
    assert.deepEqual(options, { model: "a/b", cwd: "/x", workspace: "/y" });
    assert.equal(workspaceOption(options), "/x");
    assert.equal(workspaceOption({ workspace: "/y" }), "/y");
  });

  it("treats everything after -- as positional text", () => {
    const { positional } = parseArgs(["--wait", "--", "--not-a-flag", "text"], { booleanOptions: ["wait"] });
    assert.deepEqual(positional, ["--not-a-flag", "text"]);
  });

  it("rejects unknown options and missing values as usage errors", () => {
    assert.throws(() => parseArgs(["--modle", "x"], { valueOptions: ["model"] }), (err) => err.exitCode === 3 && /--modle/.test(err.message));
    assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /--model needs a value/);
    assert.throws(() => parseArgs(["--wait=yes"], { booleanOptions: ["wait"] }), /Unknown option --wait/);
  });
});

describe("readPrompt", () => {
  const dir = createTmpDir("opencode-args");
  after(() => cleanupTmpDir(dir));

  it("joins positional words when no file is given", () => {
    assert.equal(readPrompt({}, ["fix", "the", "bug"]), "fix the bug");
  });

  it("reads a file verbatim apart from a BOM and outer whitespace", () => {
    const file = path.join(dir, "prompt.txt");
    fs.writeFileSync(file, "﻿\n  line \"1\"\r\nline $2 & %3%\n\n");
    assert.equal(readPrompt({ "prompt-file": file }, []), "line \"1\"\r\nline $2 & %3%");
  });

  it("reads stdin for --prompt-file -", () => {
    assert.equal(readPrompt({ "prompt-file": "-" }, [], { readStdin: () => "from\nstdin\n" }), "from\nstdin");
  });

  it("refuses a file plus positional text, and unreadable files", () => {
    assert.throws(() => readPrompt({ "prompt-file": "-" }, ["x"]), (err) => err.exitCode === 3);
    assert.throws(() => readPrompt({ "prompt-file": path.join(dir, "missing") }, []), /Cannot read prompt file .*ENOENT/);
  });
});
