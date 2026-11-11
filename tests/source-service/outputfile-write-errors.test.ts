import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../../src/errors.ts";
import { ModDecompileService } from "../../src/mod-decompile-service.ts";
import { SourceService } from "../../src/source-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

const CLASS_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

async function resolveOutputArtifact(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const binaryJarPath = join(root, "snippet.jar");
  const sourcesJarPath = join(root, "snippet-sources.jar");
  await createJar(binaryJarPath, { "a/Out.class": CLASS_MAGIC });
  await createJar(sourcesJarPath, { "a/Out.java": "package a;\npublic class Out { int x = 1; }\n" });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });
  return { root, service, artifactId: resolved.artifactId };
}

function assertOutputFileInvalidInput(error: unknown, expectedValue: string): true {
  assert.ok(isAppError(error), "expected an AppError, not a raw fs error");
  assert.equal(
    (error as { code?: string }).code,
    ERROR_CODES.INVALID_INPUT,
    `expected ${ERROR_CODES.INVALID_INPUT}, got ${(error as { code?: string }).code}`
  );
  const details = (error as { details?: { field?: string; value?: string; osErrorCode?: string } }).details;
  assert.equal(details?.field, "outputFile");
  assert.equal(details?.value, expectedValue);
  assert.equal(typeof details?.osErrorCode, "string");
  assert.ok((details?.osErrorCode ?? "").length > 0, "osErrorCode must be non-empty");
  return true;
}

function buildModService(root: string, outputDir: string): ModDecompileService {
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
  return service;
}

async function prepareModJar(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });
  const outputDir = join(root, "decompiled");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  await writeFile(join(outputDir, "com/example/Demo.java"), "package com.example;\npublic class Demo {}", "utf8");
  return { root, jarPath, service: buildModService(root, outputDir) };
}

test("getClassSource outputFile under directories that do not exist creates them and writes the file", async () => {
  const { root, service, artifactId } = await resolveOutputArtifact("outputfile-src-");
  const outputPath = join(root, "does", "not", "exist", "out.java");

  const result = await service.getClassSource({
    artifactId,
    className: "a.Out",
    mode: "full",
    outputFile: outputPath
  });

  assert.ok(result.sourceText.includes(outputPath), "the reply names the written file");
  assert.match(await readFile(outputPath, "utf8"), /public class Out/);
});

test("getClassSource outputFile whose parent path component is a regular file maps to ERR_INVALID_INPUT with an osErrorCode", async () => {
  const { root, service, artifactId } = await resolveOutputArtifact("outputfile-src-file-parent-");
  const blocker = join(root, "blocker");
  await writeFile(blocker, "plain file", "utf8");
  const outputPath = join(blocker, "nested", "out.java");

  await assert.rejects(
    () => service.getClassSource({ artifactId, className: "a.Out", mode: "full", outputFile: outputPath }),
    (error: unknown) => assertOutputFileInvalidInput(error, outputPath)
  );
});

test("getClassSource outputFile that is an existing directory maps to ERR_INVALID_INPUT with an osErrorCode", async () => {
  const { root, service, artifactId } = await resolveOutputArtifact("outputfile-src-dir-dest-");
  const outputPath = join(root, "already-a-directory");
  await mkdir(outputPath, { recursive: true });

  await assert.rejects(
    () => service.getClassSource({ artifactId, className: "a.Out", mode: "full", outputFile: outputPath }),
    (error: unknown) => assertOutputFileInvalidInput(error, outputPath)
  );
});

test("getModClassSource outputFile under directories that do not exist creates them and writes the file", async () => {
  const { root, jarPath, service } = await prepareModJar("outputfile-mod-");
  const outPath = join(root, "missing", "nested", "output.java");

  const result = await service.getModClassSource({ jarPath, className: "com.example.Demo", outputFile: outPath });

  assert.equal(result.outputFilePath, outPath);
  assert.match(await readFile(outPath, "utf8"), /class Demo/);
});

test("getModClassSource outputFile whose parent path component is a regular file maps to ERR_INVALID_INPUT with an osErrorCode", async () => {
  const { root, jarPath, service } = await prepareModJar("outputfile-mod-file-parent-");
  const blocker = join(root, "blocker");
  await writeFile(blocker, "plain file", "utf8");
  const outPath = join(blocker, "nested", "output.java");

  await assert.rejects(
    () => service.getModClassSource({ jarPath, className: "com.example.Demo", outputFile: outPath }),
    (error: unknown) => assertOutputFileInvalidInput(error, outPath)
  );
});

test("getModClassSource outputFile that is an existing directory maps to ERR_INVALID_INPUT with an osErrorCode", async () => {
  const { root, jarPath, service } = await prepareModJar("outputfile-mod-dir-dest-");
  const outPath = join(root, "already-a-directory");
  await mkdir(outPath, { recursive: true });

  await assert.rejects(
    () => service.getModClassSource({ jarPath, className: "com.example.Demo", outputFile: outPath }),
    (error: unknown) => assertOutputFileInvalidInput(error, outPath)
  );
});
