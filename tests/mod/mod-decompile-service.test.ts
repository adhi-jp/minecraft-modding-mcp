import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { ModDecompileService } from "../../src/mod-decompile-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

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
// getModClassSource truncation params
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

test("getModClassSource maxLines truncates output", async () => {
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

test("getModClassSource maxChars truncates output", async () => {
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

test("getModClassSource outputFile writes to file and returns placeholder", async () => {
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

test("getModClassSource outputFile honors maxLines truncation", async () => {
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

test("getModClassSource with no truncation params returns full content", async () => {
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

test("ModDecompileService refreshes cache hits before eviction so hot jars stay resident", async () => {
  const source = await readFile("src/mod-decompile-service.ts", "utf8");

  assert.match(source, /this\.decompileCache\.delete\(cacheKey\);\s*this\.decompileCache\.set\(cacheKey, cached\);/);
  assert.match(source, /while \(this\.decompileCache\.size > 8\)/);
});

// ---------------------------------------------------------------------------
// getModClassSource validation / lookup failures
// ---------------------------------------------------------------------------

test("getModClassSource throws CLASS_NOT_FOUND when the class is absent from decompiled output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-class-not-found-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });
  const outputDir = join(root, "decompiled");
  await mkdir(outputDir, { recursive: true });

  const service = buildMockService(root, outputDir, ["com/example/Demo.java"]);
  await assert.rejects(
    () => service.getModClassSource({ jarPath, className: "com.example.Missing" }),
    (error: unknown) => {
      const appError = error as { code?: string; details?: { availableCount?: number } };
      assert.equal(appError.code, ERROR_CODES.CLASS_NOT_FOUND);
      assert.equal(appError.details?.availableCount, 1);
      return true;
    }
  );
});

test("getModClassSource rejects an empty className with INVALID_INPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-empty-class-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, { "com/example/Demo.class": Buffer.alloc(4) });
  const outputDir = join(root, "decompiled");
  await mkdir(outputDir, { recursive: true });

  const service = buildMockService(root, outputDir, ["com/example/Demo.java"]);
  await assert.rejects(
    () => service.getModClassSource({ jarPath, className: "   " }),
    (error: unknown) => {
      const appError = error as { code?: string };
      assert.equal(appError.code, ERROR_CODES.INVALID_INPUT);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Real decompileAndCache: in-flight dedup + size>8 eviction
//
// These drive the real ensureDecompiled/decompileAndCache pipeline (no
// ensureDecompiled stub). The Vineflower decompile cache is pre-seeded so
// decompileBinaryJar short-circuits on its completion-marker cache hit instead
// of spawning Java, while the service-level LRU/in-flight logic runs for real.
// ---------------------------------------------------------------------------

async function createFabricBinaryJar(jarPath: string, modId: string): Promise<void> {
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: modId, version: "1.0.0" }),
    "com/example/Demo.class": Buffer.alloc(4)
  });
}

/**
 * Replicates modDecompileCacheKey() + decompileOutputDir() so the on-disk
 * Vineflower cache can be pre-populated for a given jar, and returns the
 * service-level cache key so eviction can be asserted directly.
 */
async function seedDecompileCache(
  cacheDir: string,
  jarRealPath: string
): Promise<{ serviceCacheKey: string; outputDir: string }> {
  const stats = statSync(jarRealPath);
  const signature = `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
  const serviceCacheKey = createHash("sha256").update(`${jarRealPath}|${signature}`).digest("hex");
  const digest = createHash("sha256").update(jarRealPath).update(serviceCacheKey).digest("hex");
  const outputDir = join(cacheDir, "decompiled", digest);
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  await writeFile(
    join(outputDir, "com/example/Demo.java"),
    "package com.example;\npublic class Demo {}",
    "utf8"
  );
  await writeFile(join(outputDir, ".decompile-complete"), "default", "utf8");
  return { serviceCacheKey, outputDir };
}

test("decompileModJar dedups concurrent requests for the same jar via the in-flight map", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-decompile-inflight-"));
  const jarPath = join(root, "demo.jar");
  await createFabricBinaryJar(jarPath, "inflight-mod");
  const jarRealPath = realpathSync(jarPath);

  const config = buildTestConfig(root, { vineflowerJarPath: join(root, "vineflower.jar") });
  await seedDecompileCache(config.cacheDir, jarRealPath);

  const service = new ModDecompileService(config);
  const realDecompileAndCache = (
    service as unknown as { decompileAndCache: (...args: unknown[]) => Promise<unknown> }
  ).decompileAndCache.bind(service);
  let decompileAndCacheCalls = 0;
  (service as unknown as { decompileAndCache: (...args: unknown[]) => Promise<unknown> }).decompileAndCache =
    (...args: unknown[]) => {
      decompileAndCacheCalls += 1;
      return realDecompileAndCache(...args);
    };

  const [first, second] = await Promise.all([
    service.decompileModJar({ jarPath }),
    service.decompileModJar({ jarPath })
  ]);

  assert.equal(decompileAndCacheCalls, 1, "two concurrent requests must share a single decompile");
  assert.equal(first.fileCount, 1);
  assert.equal(second.fileCount, 1);
  assert.equal(first.modId, "inflight-mod");
  assert.equal(second.modId, "inflight-mod");
});

test("decompileAndCache evicts the oldest entry once more than 8 jars are resident", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-decompile-evict-"));
  const config = buildTestConfig(root, { vineflowerJarPath: join(root, "vineflower.jar") });
  const service = new ModDecompileService(config);

  const cacheKeys: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    const jarPath = join(root, `mod-${index}.jar`);
    await createFabricBinaryJar(jarPath, `evict-mod-${index}`);
    const jarRealPath = realpathSync(jarPath);
    const { serviceCacheKey } = await seedDecompileCache(config.cacheDir, jarRealPath);
    cacheKeys.push(serviceCacheKey);
    await service.decompileModJar({ jarPath });
  }

  const decompileCache = (service as unknown as { decompileCache: Map<string, unknown> }).decompileCache;
  assert.equal(decompileCache.size, 8, "the LRU must stay capped at 8 resident jars");
  assert.equal(decompileCache.has(cacheKeys[0]!), false, "the oldest jar must be evicted");
  assert.equal(decompileCache.has(cacheKeys.at(-1)!), true, "the most recent jar must stay resident");
});
