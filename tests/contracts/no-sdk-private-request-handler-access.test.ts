import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fastGlob from "fast-glob";

// Transport-boundary invariant: every protocol-level test drives the server
// through a public transport (the in-process `InMemoryTransport` session in
// tests/stdio/inprocess-era-serve.ts, or a spawned stdio process). Reaching
// into the SDK-private request-handler map couples the suite to an
// undocumented internal that the SDK may rename, reshape, or wrap at any
// release, and bypasses the real wire path (era negotiation, request context,
// envelope encoding) that production traffic exercises.
//
// The needle is built by concatenation so this scanner file can never match
// itself; the scan is a literal substring match per line, so comments count
// too (a comment naming the private map documents a coupling that should not
// exist).
//
// Allow-list: EMPTY. Any new reference must migrate to the public transport
// instead of being allow-listed.
const FORBIDDEN_PRIVATE_MAP_NAME = "_request" + "Handlers";

const ALLOWED_FILES = new Set<string>([]);

// Location-anchored scan root: this file lives in tests/contracts/, so the
// repo root is two directories up. Passing an explicit cwd keeps the scan
// correct no matter which directory the test runner was launched from, and
// fastGlob then returns repo-root-relative paths.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Per-line detection, extracted so the test can prove the matcher itself
 * works: a broken matcher (or a mangled needle) must fail the self-check
 * below instead of silently making the zero-offender scan vacuous.
 */
function lineReferencesPrivateMap(line: string): boolean {
  return line.includes(FORBIDDEN_PRIVATE_MAP_NAME);
}

test("protocol tests use public transports: no source, test, or script file reaches the SDK-private request-handler map", async () => {
  // Matcher self-check: the detection flags a synthetic offender line built
  // from the concatenated needle, and does NOT flag a benign look-alike.
  const syntheticOffender = `const handlers = (server as never)["${FORBIDDEN_PRIVATE_MAP_NAME}"];`;
  assert.ok(
    lineReferencesPrivateMap(syntheticOffender),
    "the matcher must flag a synthetic line referencing the private map"
  );
  assert.ok(
    !lineReferencesPrivateMap("const handlers = server.requestHandlers;"),
    "the matcher must not flag a benign public-looking line"
  );

  const files = await fastGlob(
    [
      "src/**/*.{ts,mts,cts,js,mjs,cjs}",
      "tests/**/*.{ts,mts,cts,js,mjs,cjs}",
      "scripts/**/*.{ts,mts,cts,js,mjs,cjs}"
    ],
    { cwd: REPO_ROOT, onlyFiles: true, dot: true }
  );

  // Non-vacuity floor: an empty or misrooted glob would make the
  // zero-offender assertion meaningless, so require a realistic file count
  // and the presence of two known transport-critical files.
  assert.ok(files.length >= 300, `the scan must cover >= 300 files, saw ${files.length}`);
  assert.ok(
    files.includes("tests/stdio/inprocess-era-serve.ts"),
    "the scan must include tests/stdio/inprocess-era-serve.ts"
  );
  assert.ok(files.includes("src/stdio-supervisor.ts"), "the scan must include src/stdio-supervisor.ts");

  const offenders: Array<{ file: string; line: number; text: string }> = [];

  for (const file of files) {
    if (ALLOWED_FILES.has(file)) {
      continue;
    }
    const content = await readFile(join(REPO_ROOT, file), "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (lineReferencesPrivateMap(line)) {
        offenders.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }

  if (offenders.length > 0) {
    const report = offenders
      .map((entry) => `  ${entry.file}:${entry.line}  ${entry.text}`)
      .join("\n");
    assert.fail(
      `Found ${offenders.length} reference(s) to the SDK-private request-handler map. ` +
        `Drive the server through the public in-process transport ` +
        `(tests/stdio/inprocess-era-serve.ts) instead. Offenders:\n${report}`
    );
  }
});
