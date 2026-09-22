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
