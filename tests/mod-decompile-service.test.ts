import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModDecompileService } from "../src/mod-decompile-service.ts";
import type { Config } from "../src/types.ts";
import { createJar } from "./helpers/zip.ts";

function buildTestConfig(root: string): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: join(root, "cache", "source-cache.db"),
    sourceRepos: [],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 1_000,
    fetchRetries: 0,
    indexedSearchEnabled: true,
    mappingSourcePriority: "loom-first",
    searchScanPageSize: 250,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024
  };
}

test("decompileModJar normalizes jarPath before decompile pipeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-decompile-normalize-"));
  const jarPath = join(root, "demo.jar");
  const symlinkPath = join(root, "demo-link.jar");
  await createJar(jarPath, {
    "com/example/Demo.class": Buffer.alloc(4)
  });
  await symlink(jarPath, symlinkPath);

  const outputDir = join(root, "decompiled");
  await mkdir(outputDir, { recursive: true });

  const service = new ModDecompileService(buildTestConfig(root));
  const calls: string[] = [];
  (
    service as unknown as {
      ensureDecompiled: (
        jarPath: string,
        warnings: string[]
      ) => Promise<{
        outputDir: string;
        files: string[];
        analysis: {
          loader: "fabric" | "quilt" | "forge" | "neoforge" | "unknown";
          modId?: string;
          classCount: number;
        };
      }>;
    }
  ).ensureDecompiled = async (normalizedJarPath: string) => {
    calls.push(normalizedJarPath);
    return {
      outputDir,
      files: ["com/example/Demo.java"],
      analysis: {
        loader: "fabric",
        modId: "demo-mod",
        classCount: 1
      }
    };
  };

  const result = await service.decompileModJar({ jarPath: symlinkPath });
  assert.equal(result.modId, "demo-mod");
  assert.equal(result.fileCount, 1);
  assert.deepEqual(calls, [realpathSync(jarPath)]);
});

test("getModClassSource normalizes jarPath before class lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-source-normalize-"));
  const jarPath = join(root, "demo.jar");
  const symlinkPath = join(root, "demo-link.jar");
  await createJar(jarPath, {
    "com/example/Demo.class": Buffer.alloc(4)
  });
  await symlink(jarPath, symlinkPath);

  const outputDir = join(root, "decompiled");
  const sourceFilePath = join(outputDir, "com/example/Demo.java");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  await writeFile(
    sourceFilePath,
    [
      "package com.example;",
      "public class Demo {}"
    ].join("\n"),
    "utf8"
  );

  const service = new ModDecompileService(buildTestConfig(root));
  const calls: string[] = [];
  (
    service as unknown as {
      ensureDecompiled: (
        jarPath: string,
        warnings: string[]
      ) => Promise<{
        outputDir: string;
        files: string[];
        analysis: {
          loader: "fabric" | "quilt" | "forge" | "neoforge" | "unknown";
          modId?: string;
          classCount: number;
        };
      }>;
    }
  ).ensureDecompiled = async (normalizedJarPath: string) => {
    calls.push(normalizedJarPath);
    return {
      outputDir,
      files: ["com/example/Demo.java"],
      analysis: {
        loader: "fabric",
        modId: "demo-mod",
        classCount: 1
      }
    };
  };

  const result = await service.getModClassSource({
    jarPath: symlinkPath,
    className: "com.example.Demo"
  });

  assert.equal(result.className, "com.example.Demo");
  assert.match(result.content, /class Demo/);
  assert.deepEqual(calls, [realpathSync(jarPath)]);
});

test("decompileModJar can omit the class list for compact responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-decompile-compact-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, {
    "com/example/Demo.class": Buffer.alloc(4)
  });

  const outputDir = join(root, "decompiled");
  await mkdir(outputDir, { recursive: true });

  const service = new ModDecompileService(buildTestConfig(root));
  (
    service as unknown as {
      ensureDecompiled: (
        jarPath: string,
        warnings: string[]
      ) => Promise<{
        outputDir: string;
        files: string[];
        analysis: {
          loader: "fabric" | "quilt" | "forge" | "neoforge" | "unknown";
          modId?: string;
          classCount: number;
        };
      }>;
    }
  ).ensureDecompiled = async () => ({
    outputDir,
    files: ["com/example/Demo.java", "com/example/Other.java"],
    analysis: {
      loader: "fabric",
      modId: "demo-mod",
      classCount: 2
    }
  });

  const result = await service.decompileModJar({
    jarPath,
    includeFiles: false
  } as never) as unknown as {
    files?: string[];
    filesOmitted?: boolean;
    returnedFileCount?: number;
    fileCount: number;
  };

  assert.equal(result.fileCount, 2);
  assert.equal(result.returnedFileCount, 0);
  assert.equal(result.filesOmitted, true);
  assert.equal(result.files, undefined);
});

test("decompileModJar supports maxFiles for compact class listings", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-decompile-maxfiles-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, {
    "com/example/Demo.class": Buffer.alloc(4)
  });

  const outputDir = join(root, "decompiled");
  await mkdir(outputDir, { recursive: true });

  const service = new ModDecompileService(buildTestConfig(root));
  (
    service as unknown as {
      ensureDecompiled: (
        jarPath: string,
        warnings: string[]
      ) => Promise<{
        outputDir: string;
        files: string[];
        analysis: {
          loader: "fabric" | "quilt" | "forge" | "neoforge" | "unknown";
          modId?: string;
          classCount: number;
        };
      }>;
    }
  ).ensureDecompiled = async () => ({
    outputDir,
    files: ["com/example/A.java", "com/example/B.java", "com/example/C.java"],
    analysis: {
      loader: "fabric",
      modId: "demo-mod",
      classCount: 3
    }
  });

  const result = await service.decompileModJar({
    jarPath,
    maxFiles: 1
  } as never) as unknown as {
    files?: string[];
    filesTruncated?: boolean;
    returnedFileCount?: number;
    fileCount: number;
  };

  assert.equal(result.fileCount, 3);
  assert.equal(result.returnedFileCount, 1);
  assert.equal(result.filesTruncated, true);
  assert.deepEqual(result.files, ["com.example.A"]);
});

// ---------------------------------------------------------------------------
// F-04: getModClassSource truncation params
// ---------------------------------------------------------------------------
function buildMockService(
  root: string,
  outputDir: string,
  files: string[],
  modId = "test-mod"
): ModDecompileService {
  const service = new ModDecompileService(buildTestConfig(root));
  (
    service as unknown as {
      ensureDecompiled: (
        jarPath: string,
        warnings: string[]
      ) => Promise<{
        outputDir: string;
        files: string[];
        analysis: {
          loader: "fabric" | "quilt" | "forge" | "neoforge" | "unknown";
          modId?: string;
          classCount: number;
        };
      }>;
    }
  ).ensureDecompiled = async () => ({
    outputDir,
    files,
    analysis: { loader: "fabric" as const, modId, classCount: files.length }
  });
  return service;
}

test("F-04: getModClassSource maxLines truncates output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-f04-maxlines-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });

  const outputDir = join(root, "decompiled");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  await writeFile(join(outputDir, "com/example/Demo.java"), lines.join("\n"), "utf8");

  const service = buildMockService(root, outputDir, ["com/example/Demo.java"]);
  const result = await service.getModClassSource({
    jarPath,
    className: "com.example.Demo",
    maxLines: 10
  });

  assert.equal(result.totalLines, 100);
  assert.equal(result.content.split("\n").length, 10);
  assert.equal(result.truncated, true);
});

test("F-04: getModClassSource maxChars truncates output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-f04-maxchars-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });

  const outputDir = join(root, "decompiled");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  const content = "x".repeat(500);
  await writeFile(join(outputDir, "com/example/Demo.java"), content, "utf8");

  const service = buildMockService(root, outputDir, ["com/example/Demo.java"]);
  const result = await service.getModClassSource({
    jarPath,
    className: "com.example.Demo",
    maxChars: 100
  });

  assert.ok(result.content.length <= 100);
  assert.equal(result.charsTruncated, true);
  assert.equal(result.truncated, true);
});

test("F-04: getModClassSource outputFile writes to file and returns placeholder", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-f04-outfile-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });

  const outputDir = join(root, "decompiled");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  await writeFile(join(outputDir, "com/example/Demo.java"), "package com.example;\npublic class Demo {}", "utf8");

  const service = buildMockService(root, outputDir, ["com/example/Demo.java"]);
  const outPath = join(root, "output.java");
  const result = await service.getModClassSource({
    jarPath,
    className: "com.example.Demo",
    outputFile: outPath
  });

  assert.ok(result.content.includes("[Written to"));
  assert.equal(result.outputFilePath, outPath);
  const { readFileSync } = await import("node:fs");
  const written = readFileSync(outPath, "utf8");
  assert.ok(written.includes("class Demo"));
});

test("F-04: getModClassSource outputFile honors maxLines truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-f04-outfile-maxlines-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });

  const outputDir = join(root, "decompiled");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  await writeFile(join(outputDir, "com/example/Demo.java"), lines.join("\n"), "utf8");

  const service = buildMockService(root, outputDir, ["com/example/Demo.java"]);
  const outPath = join(root, "output.java");
  const result = await service.getModClassSource({
    jarPath,
    className: "com.example.Demo",
    maxLines: 5,
    outputFile: outPath
  });

  const { readFileSync } = await import("node:fs");
  const written = readFileSync(outPath, "utf8");
  assert.equal(written.split("\n").length, 5);
  assert.equal(result.truncated, true);
});

test("F-04: getModClassSource with no truncation params returns full content", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-f04-full-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });

  const outputDir = join(root, "decompiled");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  await writeFile(join(outputDir, "com/example/Demo.java"), lines.join("\n"), "utf8");

  const service = buildMockService(root, outputDir, ["com/example/Demo.java"]);
  const result = await service.getModClassSource({
    jarPath,
    className: "com.example.Demo"
  });

  assert.equal(result.totalLines, 50);
  assert.equal(result.content.split("\n").length, 50);
  assert.equal(result.truncated, undefined);
  assert.equal(result.charsTruncated, undefined);
});
