/**
 * Pre-migration baseline capture — named-test inventory (regression set-difference baseline).
 *
 * Run with: node scripts/premigration/capture-test-list.mjs [--validate-only]
 *
 * Runs the SAME ordinary test file selection as `npm test`
 * (scripts/run-tests.mjs -> scripts/test-file-selection.mjs) with node's TAP
 * reporter and captures every `ok` / `not ok` line.
 *
 * Normalization (recorded here and in the fixtures README):
 *  - test point indices are stripped (they depend on file interleaving),
 *  - timings/YAML diagnostics are not captured (only the ok/not ok lines),
 *  - indentation depth is preserved as a numeric prefix (subtest nesting),
 *  - lines are sorted lexicographically (the inventory is a named SET for the
 *    planned set-difference check, not an ordering baseline).
 *
 * Output: tests/fixtures/premigration/test-list.txt
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import { REPO_ROOT, FIXTURES_DIR } from "./lib.mjs";
import { selectOrdinaryTestFiles } from "../test-file-selection.mjs";

const validateOnly = process.argv.includes("--validate-only");

const files = await selectOrdinaryTestFiles(join(REPO_ROOT, "tests"));
if (files.length === 0) throw new Error("No ordinary .test.ts files selected");
console.log(`running ${files.length} test files (same selection as npm test) with TAP reporter`);

const child = spawn(
  process.execPath,
  ["--test", "--import", "tsx", "--test-reporter=tap", ...files],
  { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] }
);

let stdout = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

const exitCode = await new Promise((resolvePromise) => {
  child.on("close", (code) => resolvePromise(code ?? 1));
});

const TAP_POINT_RE = /^(\s*)(not ok|ok) (\d+) - (.*)$/;
const lines = [];
for (const rawLine of stdout.split("\n")) {
  const match = TAP_POINT_RE.exec(rawLine);
  if (!match) continue;
  const depth = Math.floor(match[1].length / 4);
  const status = match[2];
  // Strip trailing TAP directives' timing decorations if any; keep SKIP/TODO.
  const name = match[4].trimEnd();
  lines.push(`${depth}\t${status}\t${name}`);
}
lines.sort();

const summaryMatch = stdout.match(/^# pass (\d+)$/m);
const failMatch = stdout.match(/^# fail (\d+)$/m);
console.log(
  `captured ${lines.length} named test points; pass=${summaryMatch?.[1] ?? "?"} fail=${failMatch?.[1] ?? "?"}; runner exit=${exitCode}`
);

if (exitCode !== 0) {
  console.error("FAILED: test runner exited non-zero; not freezing a failing baseline");
  process.exit(1);
}

if (!validateOnly) {
  const header = [
    "# Pre-migration named-test inventory. One line per TAP test point:",
    "# <subtest-depth>\\t<ok|not ok>\\t<test name>",
    "# Same file selection as npm test; indices and timings stripped; lines sorted",
    "# (set semantics for the planned named-test set-difference check).",
    ""
  ].join("\n");
  const target = join(FIXTURES_DIR, "test-list.txt");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${header}${lines.join("\n")}\n`, "utf8");
  console.log(`fixture written: ${target}`);
}
console.log("test-list capture: OK");
