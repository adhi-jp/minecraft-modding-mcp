import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { normalizeJarPath } from "../src/path-resolver.ts";

test("normalizeJarPath rejects malformed windows-drive path format", () => {
  assert.throws(
    () => normalizeJarPath("C:bad\\minecraft.jar"),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
      );
    }
  );
});
