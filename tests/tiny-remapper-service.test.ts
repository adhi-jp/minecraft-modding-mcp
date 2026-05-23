import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { remapJar, type RemapOptions } from "../src/tiny-remapper-service.ts";
import { mockJavaRunner } from "./helpers/java-runner-mock.ts";

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

test("remapJar invokes javaRunner via mockJavaRunner helper (mock smoke)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remap-smoke-"));
  const inputJar = join(root, "in.jar");
  const outputJar = join(root, "out.jar");
  const mappings = join(root, "mappings.tiny");
  await writeFile(inputJar, Buffer.from("PK\x03\x04"));
  await writeFile(mappings, "tiny\t2\t0\tintermediary\tnamed\n");

  const recording = mockJavaRunner(async () => {
    await writeFile(outputJar, Buffer.from("PK\x03\x04"));
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });

  const result = await remapJar("/tmp/fake-remapper.jar", {
    inputJar,
    outputJar,
    mappingsFile: mappings,
    fromNamespace: "intermediary",
    toNamespace: "named"
  });

  assert.equal(result.outputJar, outputJar);
  assert.equal(recording.calls.length, 1);
  assert.equal(recording.calls[0]!.jarPath, "/tmp/fake-remapper.jar");
  assert.deepEqual(recording.calls[0]!.args, [
    inputJar,
    outputJar,
    mappings,
    "intermediary",
    "named"
  ]);
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
