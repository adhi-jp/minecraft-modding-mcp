#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateNamedSetGate } from "./named-set-gate.mjs";
import { selectOrdinaryTestFiles } from "./test-file-selection.mjs";
import {
  collectNamedSetFromTapFile,
  compareNamedTestSets,
  parseFrozenNamedSet
} from "./test-name-inventory.mjs";

const FROZEN_NAMED_SET_PATH = fileURLToPath(
  new URL("../tests/fixtures/premigration/test-list.txt", import.meta.url)
);

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

// The named-set gate only runs for a plain, complete suite run: a filtered run selects a
// subset of names, and the coverage/lcov modes own the reporter configuration.
const namedSetGateEnabled =
  !options.coverage && options.lcovPath === undefined && options.testNamePattern === undefined;

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

let tapDirectory;
let tapPath;
if (namedSetGateEnabled) {
  // One run, two reporters: the human-readable spec output keeps flowing to stdout while
  // the TAP stream lands in a temp file for the post-run named-set comparison. Re-running
  // the suite to capture TAP would double the runtime and diff two nondeterministic runs.
  tapDirectory = mkdtempSync(join(tmpdir(), "named-test-set-"));
  tapPath = join(tapDirectory, "test-run.tap");
  args.push(
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapPath}`
  );
}
args.push(...files);

function discardTapCapture() {
  if (tapDirectory !== undefined) {
    rmSync(tapDirectory, { recursive: true, force: true });
    tapDirectory = undefined;
  }
}

/**
 * Post-run regression gate: every named test point frozen in the premigration baseline
 * must still be present in this run AND must actually have executed. Additions never
 * fail. A frozen name that vanished is MISSING and always fails; a frozen name that was
 * present but skipped is UNPROVEN, which fails by default and can be downgraded to a loud
 * warning on a capability-limited machine — see `scripts/named-set-gate.mjs` for the
 * category definitions and the `MCP_ALLOW_UNPROVEN_NAMED_TESTS` contract.
 */
async function checkNamedTestSet() {
  const frozen = parseFrozenNamedSet(await readFile(FROZEN_NAMED_SET_PATH, "utf8"));
  const live = await collectNamedSetFromTapFile(tapPath);
  const comparison = compareNamedTestSets(frozen.keys, live.provenKeys, live.unproven);

  const verdict = evaluateNamedSetGate({
    frozen,
    live,
    comparison,
    env: process.env,
    // The captured TAP path is only rendered when the gate fails, which is exactly when
    // `finish` leaves the capture on disk for inspection.
    context: { frozenPath: FROZEN_NAMED_SET_PATH, tapPath }
  });
  // A downgraded-UNPROVEN run still exits 0, but its warning belongs on stderr where a
  // "passed" summary cannot bury it.
  const write = verdict.status === "ok" ? console.log : console.error;
  for (const line of verdict.report) {
    write(line);
  }
  return verdict.ok;
}

let spawnFailed = false;

async function finish(code, signal) {
  if (spawnFailed) {
    discardTapCapture();
    process.exitCode = 1;
    return;
  }
  if (signal) {
    console.error(`Test runner terminated by signal ${signal}`);
    discardTapCapture();
    process.exitCode = 1;
    return;
  }
  const exitCode = code ?? 1;
  // A failing suite propagates unchanged: the named-set gate must never mask it, and a
  // partial run cannot prove the baseline.
  if (exitCode !== 0 || !namedSetGateEnabled) {
    discardTapCapture();
    process.exitCode = exitCode;
    return;
  }
  try {
    if (await checkNamedTestSet()) {
      discardTapCapture();
      process.exitCode = 0;
      return;
    }
    process.exitCode = 1;
  } catch (error) {
    console.error("\nnamed-test set gate: FAILED (could not evaluate the frozen baseline)");
    console.error(error);
    process.exitCode = 1;
  }
}

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  spawnFailed = true;
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  void finish(code, signal);
});
