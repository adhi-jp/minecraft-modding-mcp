import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fastGlob from "fast-glob";

// D12 invariant: every emitted `suggestedCall` payload must route through
// `buildSuggestedCall(...)`. Two raw construction shapes are forbidden in
// `src/`:
//   (a) `{ suggestedCall: { tool, params } }` — object-literal property
//   (b) `obj.suggestedCall = { tool, params }` — assignment
//
// Allow-list:
//   - src/build-suggested-call.ts   (the helper itself constructs the payload)
//   - src/tool-schema-registry.ts   (no construction; listed defensively)
//   - tests/*.test.ts               (test fixtures may build raw payloads)
//
// The regex requires `{` immediately after `:` / `=` so type annotations
// (`suggestedCall?: SuggestedCall`) and field-spread shapes
// (`{ suggestedCall: pre.suggestedCall }`) do not trigger.
const FORBIDDEN_LITERAL_PATTERN = /\bsuggestedCall\s*:\s*\{/;
const FORBIDDEN_ASSIGN_PATTERN = /\.suggestedCall\s*=\s*\{/;

const ALLOWED_FILES = new Set([
  "src/build-suggested-call.ts",
  "src/tool-schema-registry.ts"
]);

test("D12: no raw `suggestedCall: { ... }` or `.suggestedCall = { ... }` construction remains in src/", async () => {
  const files = await fastGlob("src/**/*.ts", {
    onlyFiles: true,
    ignore: ["**/*.test.ts"]
  });

  const offenders: Array<{ file: string; line: number; text: string; shape: "literal" | "assign" }> = [];

  for (const file of files) {
    if (ALLOWED_FILES.has(file)) {
      continue;
    }
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (FORBIDDEN_LITERAL_PATTERN.test(line)) {
        offenders.push({ file, line: i + 1, text: line.trim(), shape: "literal" });
      } else if (FORBIDDEN_ASSIGN_PATTERN.test(line)) {
        offenders.push({ file, line: i + 1, text: line.trim(), shape: "assign" });
      }
    }
  }

  if (offenders.length > 0) {
    const report = offenders
      .map((entry) => `  ${entry.file}:${entry.line}  [${entry.shape}]  ${entry.text}`)
      .join("\n");
    assert.fail(
      `Found ${offenders.length} raw \`suggestedCall\` construction sites in src/. ` +
        `Each site MUST route through \`buildSuggestedCall(...)\` so the schema gate validates ` +
        `the payload before emission. Offenders:\n${report}`
    );
  }
});
