#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { selectOrdinaryTestFiles } from "./test-file-selection.mjs";
import {
  collectNamedSetFromTapFile,
  compareNamedTestSets,
  formatMissingReport,
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
 * must still be present in this run. Additions are expected and never fail; only
 * removals, renames, malformed TAP, and SKIP/TODO directives do.
 */
async function checkNamedTestSet() {
  const frozen = parseFrozenNamedSet(await readFile(FROZEN_NAMED_SET_PATH, "utf8"));
  const live = await collectNamedSetFromTapFile(tapPath);

  const failures = [];
  if (live.pointCount === 0 || live.unterminatedYaml) {
    failures.push(
      `captured TAP is malformed (points=${live.pointCount}, unterminatedYaml=${live.unterminatedYaml})`
    );
  }
  if (live.directiveRows.length > 0) {
    failures.push(
      `${live.directiveRows.length} test point(s) carry a SKIP/TODO directive; a skipped test cannot ` +
        `prove its frozen name still runs:\n` +
        live.directiveRows
          .slice(0, 20)
          .map((key) => `  - ${key.split("\t").slice(2).join("\t")}`)
          .join("\n")
    );
  }
  const comparison = compareNamedTestSets(frozen.keys, live.keys);
  if (!comparison.ok) {
    failures.push(formatMissingReport(comparison));
  }

  if (failures.length > 0) {
    console.error("\nnamed-test set gate: FAILED");
    for (const failure of failures) {
      console.error(failure);
    }
    console.error(
      `\nbaseline: ${FROZEN_NAMED_SET_PATH} (${frozen.rowCount} rows)\ncaptured TAP kept at: ${tapPath}`
    );
    return false;
  }

  console.log(
    `named-test set gate: OK (all ${frozen.rowCount} frozen named rows present; ` +
      `${live.pointCount} live points, ${comparison.addedCount} added)`
  );
  return true;
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
