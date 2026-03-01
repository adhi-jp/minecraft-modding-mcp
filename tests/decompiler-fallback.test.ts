import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { decompileBinaryJar } from "../src/decompiler/vineflower.ts";

test("decompileBinaryJar returns ERR_DECOMPILER_UNAVAILABLE when vineflower path is missing", async () => {
  await assert.rejects(
    () => decompileBinaryJar("/tmp/example.jar", "/tmp/cache"),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.DECOMPILER_UNAVAILABLE
      );
    }
  );
});

test("decompileBinaryJar rejects non-jar input path", async () => {
  await assert.rejects(
    () =>
      decompileBinaryJar("/tmp/example.txt", "/tmp/cache", {
        vineflowerJarPath: "/tmp/vineflower.jar"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.DECOMPILER_UNAVAILABLE
      );
    }
  );
});
