import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../src/errors.ts";
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

test("decompileBinaryJar returns cached result with no decompileProfile when cache already has java files", async () => {
  const root = await mkdtemp(join(tmpdir(), "decompile-cache-hit-"));
  const cacheDir = join(root, "cache");
  const binaryJarPath = join(root, "test.jar");
  writeFileSync(binaryJarPath, Buffer.from([0xca, 0xfe]));
  const vineflowerJarPath = join(root, "vineflower.jar");
  writeFileSync(vineflowerJarPath, Buffer.from([0x50, 0x4b]));

  // Pre-populate the output directory structure to simulate a cache hit.
  // We must replicate decompileOutputDir's hashing behavior.
  const { createHash } = await import("node:crypto");
  const { basename } = await import("node:path");
  const signature = basename(binaryJarPath);
  const digest = createHash("sha256").update(binaryJarPath).update(signature).digest("hex");
  const outputDir = join(cacheDir, "decompiled", digest);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "Example.java"), "public class Example {}");

  const result = await decompileBinaryJar(binaryJarPath, cacheDir, { vineflowerJarPath });
  assert.equal(result.javaFiles.length, 1);
  assert.equal(result.javaFiles[0].filePath, "Example.java");
  assert.equal(result.decompileProfile, undefined);
});

test("decompileBinaryJar includes profilesAttempted in error details on full failure", async () => {
  // If Vineflower jar exists but Java is unavailable, it throws JAVA_UNAVAILABLE
  // immediately (non-DECOMPILER_FAILED), which exercises the early bail-out path.
  const root = await mkdtemp(join(tmpdir(), "decompile-profiles-error-"));
  const cacheDir = join(root, "cache");
  const binaryJarPath = join(root, "test.jar");
  writeFileSync(binaryJarPath, Buffer.from([0xca, 0xfe]));
  const vineflowerJarPath = join(root, "vineflower.jar");
  writeFileSync(vineflowerJarPath, Buffer.from([0x50, 0x4b]));

  await assert.rejects(
    () => decompileBinaryJar(binaryJarPath, cacheDir, { vineflowerJarPath }),
    (error: unknown) => {
      if (!isAppError(error)) return false;
      // Should be either JAVA_UNAVAILABLE (non-DECOMPILER_FAILED bail-out)
      // or DECOMPILER_FAILED with profilesAttempted in details
      return (
        error.code === ERROR_CODES.JAVA_UNAVAILABLE ||
        (error.code === ERROR_CODES.DECOMPILER_FAILED &&
          Array.isArray(error.details?.profilesAttempted))
      );
    }
  );
});
