import assert from "node:assert/strict";
import test from "node:test";

import { parseAccessTransformer } from "../../src/access-transformer-parser.ts";
import { parseAccessWidener } from "../../src/access-widener-parser.ts";
import { validateParsedAccessTransformer, validateParsedAccessWidener } from "../../src/mixin/access-validators.ts";

test("an AW method entry missing its descriptor makes the file invalid, not valid:true/total:0", () => {
  const parsed = parseAccessWidener(
    ["accessWidener v2 intermediary", "accessible method net/minecraft/server/MinecraftServer tick"].join("\n")
  );
  assert.equal(parsed.entries.length, 0, "the malformed entry must still be dropped from entries");
  const result = validateParsedAccessWidener(parsed, new Map(), []);
  assert.equal(result.summary.total, 0);
  assert.equal(
    result.valid,
    false,
    "an entry the parser had to reject must force the verdict invalid, not silently pass as valid:true/total:0"
  );
  assert.ok(
    result.warnings.some((w) => /line 2/i.test(w) && /descriptor/i.test(w)),
    `expected a line+reason warning, got: ${JSON.stringify(result.warnings)}`
  );
});

test("an AT file whose only line is bare 'public' makes the file invalid, not valid:true/total:0", () => {
  const parsed = parseAccessTransformer("public");
  assert.equal(parsed.entries.length, 0, "the malformed entry must still be dropped from entries");
  const result = validateParsedAccessTransformer(parsed, new Map(), []);
  assert.equal(result.summary.total, 0);
  assert.equal(
    result.valid,
    false,
    "an entry the parser had to reject must force the verdict invalid, not silently pass as valid:true/total:0"
  );
  assert.ok(
    result.warnings.some((w) => /line 1/i.test(w)),
    `expected a line+reason warning, got: ${JSON.stringify(result.warnings)}`
  );
});

test("an AW file with a missing/malformed header makes the file invalid, naming line 1 and the rule", () => {
  const parsed = parseAccessWidener("accessible class example/Target");
  assert.equal(parsed.headerVersion, "", "the header must not be recognized when the first line isn't an accessWidener header");
  const result = validateParsedAccessWidener(parsed, new Map(), []);
  assert.equal(result.entries.length, 0);
  assert.equal(
    result.valid,
    false,
    "a missing/malformed accessWidener header must force the verdict invalid, not silently pass as valid:true/total:0"
  );
  assert.ok(
    result.warnings.some((w) => /line 1/i.test(w) && /header/i.test(w)),
    `expected a line+rule warning naming the header, got: ${JSON.stringify(result.warnings)}`
  );
});

test("validateAccessWidener reports a classTweaker file as an unsupported format, not an invalid accessWidener", async () => {
  const { validateAccessWidener } = await import("../../src/source/access-validate.ts");
  for (const header of ["classTweaker v1 official", "classTweaker v2 named"]) {
    await assert.rejects(
      validateAccessWidener({} as never, {
        version: "1.21.10",
        content: `# comment\n\n${header}\naccessible class net/minecraft/server/MinecraftServer\n`
      }),
      (error: { code?: string; message?: string; details?: Record<string, unknown> }) => {
        assert.equal(error.code, "ERR_INVALID_INPUT");
        assert.match(error.message ?? "", /classTweaker format is not supported/);
        assert.ok((error.message ?? "").includes(header), error.message);
        assert.doesNotMatch(error.message ?? "", /missing|expected accessWidener header/i);
        assert.equal(error.details?.unsupportedFormat, "classTweaker");
        return true;
      }
    );
  }
});
