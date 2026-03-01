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
