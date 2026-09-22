import assert from "node:assert/strict";
import test from "node:test";

import { ValidateProjectService } from "../../../src/entry-tools/validate-project-service.ts";

// validate-project task=mixin ignores the batch-level
// processingErrors count returned by validateMixin. When every input fails
// to load, valid/partial/invalid are all 0, so the current status logic
// falls through to "ok" and the headline says "Validated N mixin input(s)."
// even though nothing was actually validated.
test("ValidateProjectService task=mixin does not report ok when every input fails to load (processingErrors)", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => ({
      mode: "paths",
      results: [
        { sourcePath: "BadMixinA.java", result: undefined, error: "ENOENT" },
        { sourcePath: "BadMixinB.java", result: undefined, error: "ENOENT" }
      ],
      summary: {
        total: 2,
        valid: 0,
        partial: 0,
        invalid: 0,
        processingErrors: 2,
        totalValidationErrors: 0,
        totalValidationWarnings: 0
      },
      warnings: []
    }),
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "mixin",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "mixin",
      input: { mode: "paths", paths: ["BadMixinA.java", "BadMixinB.java"] }
    }
  });

  assert.notEqual(result.summary.status, "ok", `expected non-ok status, got headline: ${result.summary.headline}`);
  assert.equal(
    result.summary.counts?.processingErrors,
    2,
    `expected processingErrors surfaced in counts, got: ${JSON.stringify(result.summary.counts)}`
  );
  assert.match(
    result.summary.headline,
    /2/,
    `expected headline to surface the processingErrors count, got: ${result.summary.headline}`
  );
});
