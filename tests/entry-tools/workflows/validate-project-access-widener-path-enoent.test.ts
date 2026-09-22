import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../../src/errors.ts";
import { ValidateProjectService } from "../../../src/entry-tools/validate-project-service.ts";

// validate-project AW/AT with subject.input.mode "path": a
// nonexistent or unreadable file must not leak a raw fs ENOENT at the tool
// boundary (which maps to ERR_INTERNAL) -- it must surface as
// ERR_INVALID_INPUT naming the path and the OS error code.
test("ValidateProjectService access-widener reports ERR_INVALID_INPUT naming the path and OS error code when the path-mode file does not exist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-aw-missing-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missingPath = join(root, "missing.accesswidener");

  let validatorCalls = 0;
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      validatorCalls += 1;
      throw new Error("must not be called");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  await assert.rejects(
    () =>
      service.execute({
        task: "access-widener",
        detail: "summary",
        version: "1.21.10",
        subject: {
          kind: "access-widener",
          input: { mode: "path", path: missingPath }
        }
      }),
    (error: any) =>
      error.code === ERROR_CODES.INVALID_INPUT &&
      typeof error.message === "string" &&
      error.message.includes(missingPath) &&
      error.message.includes("ENOENT")
  );
  assert.equal(validatorCalls, 0);
});
