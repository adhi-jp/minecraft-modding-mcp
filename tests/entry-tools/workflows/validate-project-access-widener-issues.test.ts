import assert from "node:assert/strict";
import test from "node:test";

import { ValidateProjectService } from "../../../src/entry-tools/validate-project-service.ts";

// validate-project task=access-widener publishes output.issues, a
// key the real validator (AccessWidenerValidationResult) never returns -- the
// real result has `entries`. The issues block must be built from the invalid
// entries, mirroring how the access-transformer case already does it.
test("ValidateProjectService access-widener issues block only includes invalid entries", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => ({
      valid: false,
      headerVersion: "v2",
      namespace: "named",
      entries: [
        {
          access: "accessible",
          targetKind: "class",
          target: "net/minecraft/world/item/Item",
          valid: true
        },
        {
          access: "accessible",
          targetKind: "field",
          target: "net/minecraft/world/item/Item",
          member: "missingField",
          valid: false,
          issue: "Field missingField not found."
        }
      ],
      summary: { total: 2, valid: 1, invalid: 1 },
      warnings: []
    }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "access-widener",
    detail: "full",
    version: "1.21.10",
    subject: {
      kind: "access-widener",
      input: {
        mode: "inline",
        content: "accessWidener v2 named\naccessible class net/minecraft/world/item/Item"
      }
    }
  });

  assert.equal(result.summary.status, "invalid");
  assert.equal(Array.isArray(result.issues), true);
  assert.equal((result.issues as Array<Record<string, unknown>>).length, 1);
  assert.equal((result.issues as Array<Record<string, unknown>>)[0]?.valid, false);
  assert.equal(
    (result.issues as Array<Record<string, unknown>>)[0]?.issue,
    "Field missingField not found."
  );
});

test("ValidateProjectService access-widener issues block appears under include:[\"issues\"] at summary detail", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => ({
      valid: false,
      headerVersion: "v2",
      namespace: "named",
      entries: [
        {
          access: "accessible",
          targetKind: "field",
          target: "net/minecraft/world/item/Item",
          member: "missingField",
          valid: false,
          issue: "Field missingField not found."
        }
      ],
      summary: { total: 1, valid: 0, invalid: 1 },
      warnings: []
    }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "access-widener",
    detail: "summary",
    include: ["issues"],
    version: "1.21.10",
    subject: {
      kind: "access-widener",
      input: {
        mode: "inline",
        content: "accessWidener v2 named\naccessible field net/minecraft/world/item/Item missingField"
      }
    }
  });

  assert.equal(Array.isArray(result.issues), true);
  assert.equal((result.issues as Array<Record<string, unknown>>).length, 1);
});

test("ValidateProjectService project-summary counts a classTweaker file as a processing error, not an invalid access widener", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createError } = await import("../../../src/errors.ts");
  const root = await mkdtemp(join(tmpdir(), "validate-project-class-tweaker-"));
  const awPath = join(root, "demo.classtweaker");
  await writeFile(awPath, "classTweaker v1 official\n", "utf8");
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw createError({
        code: "ERR_INVALID_INPUT",
        message: 'The classTweaker format is not supported (header "classTweaker v1 official").',
        details: { unsupportedFormat: "classTweaker" }
      });
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [awPath]
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: root }
  });

  assert.equal(result.summary.status, "partial", result.summary.headline);
  assert.equal(result.summary.counts?.invalid, 0);
  assert.equal(result.summary.counts?.processingErrors, 1);
  assert.match(result.summary.headline, /; 1 access widener\(s\) could not be processed\.$/);
  assert.ok(
    (result.warnings as string[]).some((warning) => warning.startsWith(`${awPath}: `) && /classTweaker/.test(warning)),
    JSON.stringify(result.warnings)
  );
});
