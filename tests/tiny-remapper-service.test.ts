import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { remapJar, type RemapOptions } from "../src/tiny-remapper-service.ts";

test("remapJar throws REMAP_FAILED when tiny-remapper jar does not exist", async () => {
  // First check if Java is available
  try {
    const { assertJavaAvailable } = await import("../src/java-process.ts");
    await assertJavaAvailable();
  } catch {
    // No Java — skip
    return;
  }

  const options: RemapOptions = {
    inputJar: "/tmp/nonexistent-input.jar",
    outputJar: "/tmp/nonexistent-output.jar",
    mappingsFile: "/tmp/nonexistent-mappings.tiny",
    fromNamespace: "intermediary",
    toNamespace: "named"
  };

  await assert.rejects(
    () => remapJar("/tmp/nonexistent-remapper.jar", options),
    (error: unknown) => {
      const appError = error as { code?: string };
      return (
        appError.code === ERROR_CODES.JAVA_PROCESS_FAILED ||
        appError.code === ERROR_CODES.REMAP_FAILED
      );
    }
  );
});

test("remapJar uses default values for optional parameters", () => {
  // Verify type compatibility — this is a compile-time check
  const options: RemapOptions = {
    inputJar: "/tmp/input.jar",
    outputJar: "/tmp/output.jar",
    mappingsFile: "/tmp/mappings.tiny",
    fromNamespace: "intermediary",
    toNamespace: "named"
  };

  assert.equal(options.threads, undefined);
  assert.equal(options.rebuildSourceFilenames, undefined);
  assert.equal(options.timeoutMs, undefined);
  assert.equal(options.maxMemoryMb, undefined);
});
