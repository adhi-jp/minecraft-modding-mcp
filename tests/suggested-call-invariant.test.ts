import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fastGlob from "fast-glob";

// D12 invariant: forbid raw `suggestedCall: { ... }` literal construction in `src/`.
// Sites must go through `buildSuggestedCall(...)` so every published payload is
// gated by the schema registry.
//
// Allow-list:
//   - src/build-suggested-call.ts   (the helper itself constructs the payload)
//   - src/tool-schema-registry.ts   (no construction; listed defensively)
//   - tests/*.test.ts               (test fixtures may build raw payloads)
//
// The regex requires a `{` immediately after the colon so type annotations
// (e.g. `suggestedCall?: SuggestedCall`, `let suggestedCall: GetClass…["suggestedCall"]`)
// do NOT trigger the test. Field-spread shapes such as `{ suggestedCall: pre.suggestedCall }`
// also do not match because the value is an identifier, not an object literal.
const FORBIDDEN_PATTERN = /\bsuggestedCall\s*:\s*\{/;

const ALLOWED_FILES = new Set([
  "src/build-suggested-call.ts",
  "src/tool-schema-registry.ts"
]);

test("D12: no raw `suggestedCall: { ... }` literal construction remains in src/", async () => {
  const files = await fastGlob("src/**/*.ts", {
    onlyFiles: true,
    ignore: ["**/*.test.ts"]
  });

  const offenders: Array<{ file: string; line: number; text: string }> = [];

  for (const file of files) {
    if (ALLOWED_FILES.has(file)) {
      continue;
    }
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (FORBIDDEN_PATTERN.test(line)) {
        offenders.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }

  if (offenders.length > 0) {
    const report = offenders
      .map((entry) => `  ${entry.file}:${entry.line}  ${entry.text}`)
      .join("\n");
    assert.fail(
      `Found ${offenders.length} raw \`suggestedCall: { ... }\` literal sites in src/. ` +
        `Each site MUST route through \`buildSuggestedCall(...)\` so the schema gate validates ` +
        `the payload before emission. Offenders:\n${report}`
    );
  }
});
