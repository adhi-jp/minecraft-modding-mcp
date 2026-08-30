#!/usr/bin/env node
/**
 * Runner for the release CHANGELOG gate.
 *
 * Runs two audits over `CHANGELOG.md` and exits non-zero on any finding from either:
 *
 *  1. The release-maturity audit of a DATED section — by default the one matching the current
 *     `package.json` version, the section a release commit has just cut. The flags below
 *     choose which dated sections it covers.
 *  2. A structural audit of `## [Unreleased]` — duplicated heading, text outside any entry,
 *     empty bullet — which runs on EVERY invocation and is not selectable by any flag, so no
 *     mode can bypass it. The release-maturity checks are deliberately not applied there.
 *
 * Policy and rendering live in `scripts/changelog-release-gate.mjs`; this file owns I/O and
 * the exit code only.
 *
 * Usage:
 *   node scripts/check-changelog.mjs                 # audit the current package version
 *   node scripts/check-changelog.mjs --version 6.3.0 # audit a specific released section
 *   node scripts/check-changelog.mjs --all           # audit every dated section
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  auditChangelog,
  auditUnreleased,
  listReleaseVersions,
  renderReport,
  renderUnreleasedReport
} from "./changelog-release-gate.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(repoRoot, "CHANGELOG.md");

const USAGE = [
  "Usage:",
  "  node scripts/check-changelog.mjs                 # audit the current package version",
  "  node scripts/check-changelog.mjs --version 6.3.0 # audit a specific released section",
  "  node scripts/check-changelog.mjs --all           # audit every dated section"
].join("\n");

/**
 * Parse argv, or throw a usage error.
 *
 * A malformed invocation must not silently degrade into the default mode: someone
 * diagnosing a specific section with a mistyped flag would otherwise read a green result
 * for a section they never asked about.
 */
function parseArgs(argv) {
  const args = { all: false, version: undefined };

  const setVersion = (value) => {
    if (args.version !== undefined) throw new Error("--version was given more than once");
    // A flag-shaped value means the intended value is missing. Auditing a section named
    // "--all" would fail with `missing-section`, which reads like a CHANGELOG problem.
    if (value === undefined || value.trim() === "") throw new Error("--version requires a value");
    if (value.startsWith("-")) throw new Error(`--version requires a version, got the flag ${value}`);
    args.version = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") {
      if (args.all) throw new Error("--all was given more than once");
      args.all = true;
    } else if (arg === "--version") {
      setVersion(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--version=")) {
      setVersion(arg.slice("--version=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (args.all && args.version !== undefined) throw new Error("--all and --version are mutually exclusive");

  return args;
}

/**
 * Run the gate and return the process exit status.
 *
 * Exit status is returned rather than applied, and the caller assigns `process.exitCode`
 * instead of calling `process.exit()`. `process.exit()` terminates without waiting for a
 * pipe-backed stdout or stderr to drain, so a caller reading this output through a pipe —
 * CI log capture, a test harness, a shell pipeline — can receive the status with none of
 * the diagnostics that explain it.
 */
async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`changelog gate: ${error.message}`);
    console.error("");
    console.error(USAGE);
    return 2;
  }

  const markdown = await readFile(changelogPath, "utf8");

  // Structural checks on `## [Unreleased]` — a duplicated heading, text outside any entry, an
  // empty bullet — run on every invocation, in every mode below, so no caller can bypass them
  // by picking a mode. Release-maturity checks (forbidden markers, length, undated/empty
  // section) do not apply here; see auditUnreleasedSection in changelog-release-gate.mjs.
  let failed = false;
  const unreleasedResult = auditUnreleased(markdown);
  if (!unreleasedResult.ok) failed = true;
  console[unreleasedResult.ok ? "log" : "error"](renderUnreleasedReport(unreleasedResult));

  let versions;
  if (args.all) {
    versions = listReleaseVersions(markdown);
    if (versions.length === 0) {
      console.error("changelog gate: CHANGELOG.md contains no dated release section to audit.");
      return 1;
    }
  } else if (args.version) {
    versions = [args.version];
  } else {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    versions = [pkg.version];
  }

  for (const version of versions) {
    const result = auditChangelog(markdown, version);
    if (!result.ok) failed = true;
    console[result.ok ? "log" : "error"](renderReport(result));
  }

  if (!failed) return 0;

  console.error("");
  console.error("Fix CHANGELOG.md. Do not weaken this gate to make a release pass.");
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
