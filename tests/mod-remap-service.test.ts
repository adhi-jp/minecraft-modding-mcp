import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { remapModJar, type ModRemapInput } from "../src/mod-remap-service.ts";
import type { Config } from "../src/types.ts";

function makeTempDir(): string {
  const dir = join(tmpdir(), `mcp-test-remap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTestConfig(cacheDir: string): Config {
  return {
    cacheDir,
    sqlitePath: join(cacheDir, "test.db"),
    sourceRepos: ["https://maven.fabricmc.net"],
    localM2Path: join(cacheDir, ".m2"),
    vineflowerJarPath: undefined,
    indexedSearchEnabled: false,
    mappingSourcePriority: "loom-first",
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 15_000,
    fetchRetries: 2,
    searchScanPageSize: 250,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024,
    tinyRemapperJarPath: undefined,
    remapTimeoutMs: 600_000,
    remapMaxMemoryMb: 4096
  };
}

function legacyCachePath(cacheDir: string, inputJar: string, targetMapping: "yarn" | "mojang"): string {
  const stat = statSync(inputJar, { throwIfNoEntry: false });
  const signature = stat ? `${stat.mtimeMs}:${stat.size}` : "unknown";
  const key = createHash("sha256")
    .update(`${inputJar}|${signature}|${targetMapping}`)
    .digest("hex");
  return join(cacheDir, "remapped-mods", `${key}.jar`);
}

function scopedCachePath(
  cacheDir: string,
  inputJar: string,
  fromNamespace: string,
  targetNamespace: string,
  mcVersion: string
): string {
  const stat = statSync(inputJar, { throwIfNoEntry: false });
  const signature = stat ? `${stat.mtimeMs}:${stat.size}` : "unknown";
  const key = createHash("sha256")
    .update(`${inputJar}|${signature}|${fromNamespace}|${targetNamespace}|${mcVersion}`)
    .digest("hex");
  return join(cacheDir, "remapped-mods", `${key}.jar`);
}

async function createMinimalFabricJar(path: string): Promise<void> {
  const { createJar } = await import("./helpers/zip.ts");
  await createJar(path, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "example-mod",
      version: "1.0.0",
      depends: { minecraft: "1.21.1" }
    }),
    "com/example/ExampleMod.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
}

test("remapModJar rejects non-.jar input", async () => {
  const tempDir = makeTempDir();
  try {
    const config = makeTestConfig(tempDir);
    const input: ModRemapInput = {
      inputJar: "/tmp/not-a-jar.txt",
      targetMapping: "yarn"
    };

    await assert.rejects(
      () => remapModJar(input, config),
      (error: unknown) => {
        const appError = error as { code?: string };
        return appError.code === ERROR_CODES.INVALID_INPUT;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar rejects missing input jar", async () => {
  const tempDir = makeTempDir();
  try {
    const config = makeTestConfig(tempDir);
    const input: ModRemapInput = {
      inputJar: "/tmp/nonexistent-mod.jar",
      targetMapping: "yarn"
    };

    await assert.rejects(
      () => remapModJar(input, config),
      (error: unknown) => {
        const appError = error as { code?: string };
        return appError.code === ERROR_CODES.JAR_NOT_FOUND;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar rejects unknown loader", async () => {
  const tempDir = makeTempDir();
  try {
    // Create a minimal JAR (zip) with no mod metadata
    const { createJar } = await import("./helpers/zip.ts");
    const jarPath = join(tempDir, "empty-mod.jar");
    await createJar(jarPath, { "com/example/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]) });

    const config = makeTestConfig(tempDir);
    const input: ModRemapInput = {
      inputJar: jarPath,
      targetMapping: "yarn"
    };

    await assert.rejects(
      () => remapModJar(input, config),
      (error: unknown) => {
        const appError = error as { code?: string };
        return appError.code === ERROR_CODES.REMAP_FAILED;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar accepts mojang target and returns cached output", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath);

    const cachedOutput = scopedCachePath(tempDir, jarPath, "intermediary", "mojang", "1.21.1");
    mkdirSync(dirname(cachedOutput), { recursive: true });
    writeFileSync(cachedOutput, "cached-remapped-jar");

    const config = makeTestConfig(tempDir);
    const input: ModRemapInput = {
      inputJar: jarPath,
      mcVersion: "1.21.1",
      targetMapping: "mojang"
    };

    const result = await remapModJar(input, config);
    assert.equal(result.outputJar, cachedOutput);
    assert.equal(result.targetMapping, "mojang");
    assert.equal(result.mcVersion, "1.21.1");
    assert.equal(result.fromMapping, "intermediary");
    assert.equal(result.resolvedTargetNamespace, "mojang");
    assert.ok(result.warnings.some((warning) => warning.toLowerCase().includes("cache")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar accepts mojang target with auto-detected version and returns cached output", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath);

    const cachedOutput = scopedCachePath(tempDir, jarPath, "intermediary", "mojang", "1.21.1");
    mkdirSync(dirname(cachedOutput), { recursive: true });
    writeFileSync(cachedOutput, "cached-remapped-jar");

    const config = makeTestConfig(tempDir);
    const input: ModRemapInput = {
      inputJar: jarPath,
      targetMapping: "mojang"
    };

    const result = await remapModJar(input, config);
    assert.equal(result.outputJar, cachedOutput);
    assert.equal(result.targetMapping, "mojang");
    assert.equal(result.mcVersion, "1.21.1");
    assert.equal(result.fromMapping, "intermediary");
    assert.equal(result.resolvedTargetNamespace, "mojang");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar ignores legacy cache entries that are not scoped by mapping context", async () => {
  const tempDir = makeTempDir();
  try {
    // Create a minimal JAR with no recognized mod metadata.
    const { createJar } = await import("./helpers/zip.ts");
    const jarPath = join(tempDir, "unknown-loader.jar");
    await createJar(jarPath, { "com/example/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]) });

    // Pre-seed a legacy cache entry using the old cache key format.
    const staleCache = legacyCachePath(tempDir, jarPath, "yarn");
    mkdirSync(dirname(staleCache), { recursive: true });
    writeFileSync(staleCache, "stale-cache");

    const config = makeTestConfig(tempDir);

    await assert.rejects(
      () =>
        remapModJar(
          {
            inputJar: jarPath,
            mcVersion: "1.21.1",
            targetMapping: "yarn"
          },
          config
        ),
      (error: unknown) => {
        const appError = error as { code?: string };
        return appError.code === ERROR_CODES.REMAP_FAILED;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ModRemapInput type accepts valid configurations", () => {
  const yarnInput: ModRemapInput = {
    inputJar: "/path/to/mod.jar",
    targetMapping: "yarn"
  };
  assert.equal(yarnInput.targetMapping, "yarn");
  assert.equal(yarnInput.mcVersion, undefined);
  assert.equal(yarnInput.outputJar, undefined);

  const mojangInput: ModRemapInput = {
    inputJar: "/path/to/mod.jar",
    outputJar: "/path/to/output.jar",
    mcVersion: "1.20.4",
    targetMapping: "mojang"
  };
  assert.equal(mojangInput.targetMapping, "mojang");
  assert.equal(mojangInput.mcVersion, "1.20.4");
});
