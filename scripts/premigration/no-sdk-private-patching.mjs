#!/usr/bin/env node
/**
 * Generic "no SDK-private patching" source check (CLI).
 *
 * Run with: node scripts/premigration/no-sdk-private-patching.mjs
 *
 * This is a thin formatter over ./no-sdk-private-patching-core.mjs, which owns
 * the AST-based rules (A: patching through an `as any` / `as unknown as {...}`
 * cast, B: writes to SDK-private members in SDK-importing files, C: deep
 * imports of package internals). The same core runs as an ordinary test in
 * tests/contracts/no-sdk-private-patching.test.ts, so the rules are exercised
 * and proved self-falsifying on every test run rather than only when someone
 * remembers to invoke this script.
 *
 * Exit status: non-zero when any finding exists (prints file:line:column plus a
 * bounded excerpt). Pre-migration this check MUST FAIL by detecting the
 * validateToolInput patch in src/index.ts; post-Phase-1a it must pass.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatFindings, scanSourceTree } from "./no-sdk-private-patching-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

const { findings } = scanSourceTree({ repoRoot: REPO_ROOT, sourceRoot: SRC_ROOT });

if (findings.length === 0) {
  console.log(
    "SDK-private patching check PASSED: no SDK-private patching, private-member writes, or internal deep imports found under src/"
  );
  process.exit(0);
}

console.error(`SDK-private patching check FAILED: ${findings.length} finding(s):`);
console.error(formatFindings(findings, { limit: 50 }));
process.exit(1);
