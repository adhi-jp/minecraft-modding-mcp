import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../../src/errors.ts";
import { ModDecompileService } from "../../src/mod-decompile-service.ts";
import { SourceService } from "../../src/source-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

const CLASS_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

test("getClassSource outputFile with a nonexistent parent directory maps to ERR_INVALID_INPUT, not ERR_INTERNAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "outputfile-src-"));
  const binaryJarPath = join(root, "snippet.jar");
  const sourcesJarPath = join(root, "snippet-sources.jar");
  await createJar(binaryJarPath, { "a/Out.class": CLASS_MAGIC });
  await createJar(sourcesJarPath, { "a/Out.java": "package a;\npublic class Out { int x = 1; }\n" });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });

  const outputPath = join(root, "does", "not", "exist", "out.java");

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: resolved.artifactId,
        className: "a.Out",
        mode: "full",
        outputFile: outputPath
      }),
    (error: unknown) => {
      assert.ok(isAppError(error), "expected an AppError, not a raw fs error");
      assert.equal(
        (error as { code?: string }).code,
        ERROR_CODES.INVALID_INPUT,
        `expected ${ERROR_CODES.INVALID_INPUT}, got ${(error as { code?: string }).code}`
      );
      assert.equal((error as { details?: { field?: string } }).details?.field, "outputFile");
      return true;
    }
  );
});

test("getModClassSource outputFile with a nonexistent parent directory maps to ERR_INVALID_INPUT, not ERR_INTERNAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "outputfile-mod-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });

  const outputDir = join(root, "decompiled");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  await writeFile(join(outputDir, "com/example/Demo.java"), "package com.example;\npublic class Demo {}", "utf8");

  const service = new ModDecompileService(buildTestConfig(root));
  (
    service as unknown as {
      ensureDecompiled: (
        jarPathArg: string,
        warnings: string[]
      ) => Promise<{
        outputDir: string;
        files: string[];
        analysis: { loader: "fabric" | "quilt" | "forge" | "neoforge" | "unknown"; modId?: string; classCount: number };
      }>;
    }
  ).ensureDecompiled = async () => ({
    outputDir,
    files: ["com/example/Demo.java"],
    analysis: { loader: "fabric" as const, modId: "test-mod", classCount: 1 }
  });

  const outPath = join(root, "missing", "nested", "output.java");

  await assert.rejects(
    () =>
      service.getModClassSource({
        jarPath,
        className: "com.example.Demo",
        outputFile: outPath
      }),
    (error: unknown) => {
      assert.ok(isAppError(error), "expected an AppError, not a raw fs error");
      assert.equal(
        (error as { code?: string }).code,
        ERROR_CODES.INVALID_INPUT,
        `expected ${ERROR_CODES.INVALID_INPUT}, got ${(error as { code?: string }).code}`
      );
      assert.equal((error as { details?: { field?: string } }).details?.field, "outputFile");
      return true;
    }
  );
});
