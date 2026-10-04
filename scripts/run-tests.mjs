#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { selectOrdinaryTestFiles } from "./test-file-selection.mjs";

function parseArgs(argv) {
  const options = {
    coverage: false,
    lcovPath: undefined,
    testNamePattern: undefined
  };
  const remaining = [...argv];
  while (remaining.length > 0) {
    const arg = remaining.shift();
    if (arg === "--coverage") {
      options.coverage = true;
      continue;
    }
    if (arg === "--lcov") {
      const value = remaining.shift();
      if (!value) {
        throw new Error("--lcov requires an output path");
      }
      options.lcovPath = value;
      continue;
    }
    if (arg === "--test-name-pattern") {
      const value = remaining.shift();
      if (!value) {
        throw new Error("--test-name-pattern requires a pattern");
      }
      options.testNamePattern = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const files = await selectOrdinaryTestFiles();
if (files.length === 0) {
  throw new Error("No ordinary .test.ts files were selected");
}

const args = ["--test", "--import", "tsx"];
if (options.testNamePattern !== undefined) {
  args.push("--test-name-pattern", options.testNamePattern);
}
if (options.coverage) {
  args.push(
    "--experimental-test-coverage",
    "--test-coverage-lines=80",
    "--test-coverage-branches=70",
    "--test-coverage-functions=80"
  );
}
if (options.lcovPath) {
  mkdirSync(dirname(options.lcovPath), { recursive: true });
  args.push("--test-reporter=lcov", `--test-reporter-destination=${options.lcovPath}`);
}

// Every test file that calls mkdtemp without cleanup lands in this per-run directory, which
// is removed when the run finishes. KEEP_TEST_TMP keeps it for debugging, like withTempDir.
const runTmp = mkdtempSync(join(tmpdir(), "mcp-test-run-"));

function discardRunTmp() {
  if (!process.env.KEEP_TEST_TMP) {
    rmSync(runTmp, { recursive: true, force: true });
  }
}

args.push(...files);

let spawnFailed = false;

function finish(code, signal) {
  discardRunTmp();
  if (spawnFailed) {
    process.exitCode = 1;
    return;
  }
  if (signal) {
    console.error(`Test runner terminated by signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
}

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, TMPDIR: runTmp, TMP: runTmp, TEMP: runTmp }
});
child.on("error", (error) => {
  console.error(error);
  spawnFailed = true;
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  finish(code, signal);
});
