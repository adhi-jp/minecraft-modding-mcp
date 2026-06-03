import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    searchScanMaxBytes: 67_108_864,
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

// Must mirror buildCacheKey() in src/mod-remap-service.ts, including the
// REMAP_PIPELINE_VERSION prefix ("v3") and the mapping-identity token. For a
// mojang target the identity is the deterministic version-keyed tiny path
// string; for yarn it is the resolved build coordinate (pass it explicitly).
const REMAP_PIPELINE_VERSION = "v3";
function scopedCachePath(
  cacheDir: string,
  inputJar: string,
  fromNamespace: string,
  targetNamespace: string,
  mcVersion: string,
  mappingIdentity?: string
): string {
  const stat = statSync(inputJar, { throwIfNoEntry: false });
  const signature = stat ? `${stat.mtimeMs}:${stat.size}` : "unknown";
  const identity =
    mappingIdentity ??
    (targetNamespace === "mojang"
      ? `${mcVersion}-mojang-merged.tiny`
      : `copy:${targetNamespace}`);
  const key = createHash("sha256")
    .update(
      `${REMAP_PIPELINE_VERSION}|${inputJar}|${signature}|${fromNamespace}|${targetNamespace}|${mcVersion}|${identity}`
    )
    .digest("hex");
  return join(cacheDir, "remapped-mods", `${key}.jar`);
}

function fakeClassBytesForNamespace(namespace: "intermediary" | "mojang"): Buffer {
  if (namespace === "mojang") {
    return Buffer.from(
      [
        "CAFEBABE",
        "Lnet/minecraft/server/MinecraftServer;",
        "Lnet/minecraft/world/level/Level;",
        "method_3735"
      ].join("\0"),
      "latin1"
    );
  }

  return Buffer.from(
    [
      "CAFEBABE",
      "Lnet/minecraft/class_1132;",
      "Lnet/minecraft/class_1937;",
      "method_3735"
    ].join("\0"),
    "latin1"
  );
}

async function createMinimalFabricJar(
  path: string,
  namespace: "intermediary" | "mojang" = "intermediary"
): Promise<void> {
  const { createJar } = await import("./helpers/zip.ts");
  await createJar(path, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "example-mod",
      version: "1.0.0",
      depends: { minecraft: "1.21.1" }
    }),
    "com/example/ExampleMod.class": fakeClassBytesForNamespace(namespace)
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

test("remapModJar remaps an intermediary jar to mojang in two passes with valid namespaces", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath);

    // Write real tiny files with the headers the production resolvers emit.
    const intermediaryTiny = join(tempDir, "1.21.1-intermediary.tiny");
    writeFileSync(intermediaryTiny, "tiny\t2\t0\tofficial\tintermediary\n");
    const mojangTiny = join(tempDir, "1.21.1-mojang.tiny");
    writeFileSync(mojangTiny, "tiny\t2\t0\tobfuscated\tmojang\n");

    function namespacesIn(tinyPath: string): string[] {
      const header = readFileSync(tinyPath, "utf8").split("\n")[0] as string;
      return header.split("\t").slice(3);
    }

    const remapCalls: Array<{ mappingsFile: string; fromNamespace: string; toNamespace: string }> = [];
    const config = makeTestConfig(tempDir);

    const result = await remapModJar(
      { inputJar: jarPath, mcVersion: "1.21.1", targetMapping: "mojang" },
      config,
      {
        resolveTinyRemapperJar: async () => join(tempDir, "tiny-remapper.jar"),
        resolveTinyMappingFile: async (_v, mapping) => {
          assert.equal(mapping, "intermediary");
          return { path: intermediaryTiny };
        },
        resolveMojangTinyFile: async () => ({ path: mojangTiny, warnings: [] }),
        remapJar: async (_jar, opts) => {
          remapCalls.push({
            mappingsFile: opts.mappingsFile,
            fromNamespace: opts.fromNamespace,
            toNamespace: opts.toNamespace
          });
          // The fromNamespace MUST exist in the mapping file this pass uses, or
          // tiny-remapper finds no keys and silently no-ops (the original bug).
          const namespaces = namespacesIn(opts.mappingsFile);
          assert.ok(
            namespaces.includes(opts.fromNamespace),
            `fromNamespace "${opts.fromNamespace}" not in ${opts.mappingsFile} (${namespaces.join(",")})`
          );
          assert.ok(
            namespaces.includes(opts.toNamespace),
            `toNamespace "${opts.toNamespace}" not in ${opts.mappingsFile} (${namespaces.join(",")})`
          );
          writeFileSync(opts.outputJar, "remapped");
          return { outputJar: opts.outputJar, durationMs: 0 };
        }
      }
    );

    assert.equal(result.resolvedTargetNamespace, "mojang");
    assert.equal(remapCalls.length, 2, "intermediary->mojang must use two passes");
    assert.deepEqual(remapCalls[0], {
      mappingsFile: intermediaryTiny,
      fromNamespace: "intermediary",
      toNamespace: "official"
    });
    assert.deepEqual(remapCalls[1], {
      mappingsFile: mojangTiny,
      fromNamespace: "obfuscated",
      toNamespace: "mojang"
    });
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

test("remapModJar detects mojang-mapped Fabric jars and returns a copied output for mojang target", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath, "mojang");

    const config = makeTestConfig(tempDir);
    const input: ModRemapInput = {
      inputJar: jarPath,
      targetMapping: "mojang"
    };

    const result = await remapModJar(input, config);
    assert.equal(result.targetMapping, "mojang");
    assert.equal(result.fromMapping, "mojang");
    assert.equal(result.resolvedTargetNamespace, "mojang");
    assert.ok(result.warnings.some((warning) => warning.includes("already uses mojang")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar rejects mojang-mapped Fabric jars when targetMapping=yarn", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath, "mojang");

    const config = makeTestConfig(tempDir);

    await assert.rejects(
      () =>
        remapModJar(
          {
            inputJar: jarPath,
            targetMapping: "yarn"
          },
          config
        ),
      (error: unknown) => {
        const appError = error as { code?: string; details?: Record<string, unknown> };
        return (
          appError.code === ERROR_CODES.REMAP_FAILED &&
          appError.details?.fromMapping === "mojang"
        );
      }
    );
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

// --- New high-priority coverage tests ---------------------------------------

async function createMinimalQuiltJar(path: string): Promise<void> {
  const { createJar } = await import("./helpers/zip.ts");
  await createJar(path, {
    "quilt.mod.json": JSON.stringify({
      schema_version: 1,
      quilt_loader: {
        group: "com.example",
        id: "example-mod",
        version: "1.0.0",
        depends: [{ id: "minecraft", versions: "1.21.1" }]
      }
    }),
    "com/example/ExampleMod.class": fakeClassBytesForNamespace("intermediary")
  });
}

async function createFabricJarWithoutMcDep(path: string): Promise<void> {
  const { createJar } = await import("./helpers/zip.ts");
  await createJar(path, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: "no-mc-dep",
      version: "2.0.0"
      // depends omitted on purpose
    }),
    "com/example/Mod.class": fakeClassBytesForNamespace("intermediary")
  });
}

async function createForgeJar(path: string): Promise<void> {
  const { createJar } = await import("./helpers/zip.ts");
  await createJar(path, {
    "META-INF/mods.toml": [
      "modLoader=\"javafml\"",
      "loaderVersion=\"[40,)\"",
      "license=\"MIT\"",
      "[[mods]]",
      "modId=\"forge-test\"",
      "version=\"1.0\""
    ].join("\n"),
    "com/example/Mod.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
}

test("remapModJar rejects forge loader with REMAP_FAILED (only fabric/quilt supported)", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "forge-mod.jar");
    await createForgeJar(jarPath);
    const config = makeTestConfig(tempDir);
    await assert.rejects(
      () => remapModJar({ inputJar: jarPath, targetMapping: "mojang" }, config),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.REMAP_FAILED);
        assert.equal(err.details?.loader, "forge");
        return true;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar throws INVALID_INPUT when mcVersion cannot be extracted from depends.minecraft", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "no-mc.jar");
    await createFabricJarWithoutMcDep(jarPath);
    const config = makeTestConfig(tempDir);
    await assert.rejects(
      () => remapModJar({ inputJar: jarPath, targetMapping: "mojang" }, config),
      (err: any) => {
        assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
        assert.match(err.message ?? "", /determine Minecraft version|mcVersion/i);
        return true;
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar auto-detects mcVersion from tilde / range / bracket version expressions", async () => {
  const tempDir = makeTempDir();
  try {
    const { createJar } = await import("./helpers/zip.ts");
    const cases = [
      { range: "~1.20.4", expected: "1.20.4" },
      { range: "^1.19.2", expected: "1.19.2" },
      { range: ">=1.21", expected: "1.21" },
      { range: "[1.21,)", expected: "1.21" }
    ];
    for (const { range, expected } of cases) {
      const jarPath = join(tempDir, `mod-${expected}.jar`);
      await createJar(jarPath, {
        "fabric.mod.json": JSON.stringify({
          schemaVersion: 1,
          id: "rng-mod",
          version: "1.0.0",
          depends: { minecraft: range }
        }),
        "com/example/Mod.class": fakeClassBytesForNamespace("intermediary")
      });
      const cachedOutput = scopedCachePath(tempDir, jarPath, "intermediary", "mojang", expected);
      mkdirSync(dirname(cachedOutput), { recursive: true });
      writeFileSync(cachedOutput, "cached");
      const result = await remapModJar(
        { inputJar: jarPath, targetMapping: "mojang" },
        makeTestConfig(tempDir)
      );
      assert.equal(result.mcVersion, expected, `expected ${range} → mcVersion ${expected}, got ${result.mcVersion}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar copies cache hit to an explicit outputJar destination", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample.jar");
    await createMinimalFabricJar(jarPath);
    const cachedOutput = scopedCachePath(tempDir, jarPath, "intermediary", "mojang", "1.21.1");
    mkdirSync(dirname(cachedOutput), { recursive: true });
    writeFileSync(cachedOutput, "cached-bytes");

    const explicit = join(tempDir, "custom-name.jar");
    const result = await remapModJar(
      {
        inputJar: jarPath,
        mcVersion: "1.21.1",
        targetMapping: "mojang",
        outputJar: explicit
      },
      makeTestConfig(tempDir)
    );
    assert.equal(result.outputJar, explicit);
    const written = statSync(explicit);
    assert.ok(written.size > 0, "explicit outputJar must receive the cached bytes");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar accepts quilt loader and returns cached output for mojang target", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "quilt-mod.jar");
    await createMinimalQuiltJar(jarPath);
    const cachedOutput = scopedCachePath(tempDir, jarPath, "intermediary", "mojang", "1.21.1");
    mkdirSync(dirname(cachedOutput), { recursive: true });
    writeFileSync(cachedOutput, "cached");

    const result = await remapModJar(
      { inputJar: jarPath, mcVersion: "1.21.1", targetMapping: "mojang" },
      makeTestConfig(tempDir)
    );
    assert.equal(result.outputJar, cachedOutput);
    assert.equal(result.targetMapping, "mojang");
    assert.equal(result.mcVersion, "1.21.1");
    assert.equal(result.fromMapping, "intermediary");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar exposes a numeric durationMs on cache-hit results", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "with-duration.jar");
    await createMinimalFabricJar(jarPath);
    const cachedOutput = scopedCachePath(tempDir, jarPath, "intermediary", "mojang", "1.21.1");
    mkdirSync(dirname(cachedOutput), { recursive: true });
    writeFileSync(cachedOutput, "x");
    const result = await remapModJar(
      { inputJar: jarPath, mcVersion: "1.21.1", targetMapping: "mojang" },
      makeTestConfig(tempDir)
    );
    assert.equal(typeof (result as any).durationMs, "number");
    assert.ok((result as any).durationMs >= 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar re-remaps when a newer yarn build is published (cache key tracks coordinate)", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath);

    const yarnTinyA = join(tempDir, "build.10.tiny");
    const yarnTinyB = join(tempDir, "build.11.tiny");
    writeFileSync(yarnTinyA, "tiny\t2\t0\tintermediary\tnamed\n");
    writeFileSync(yarnTinyB, "tiny\t2\t0\tintermediary\tnamed\n");

    const config = makeTestConfig(tempDir);
    const remapCalls: string[] = [];
    let resolveCount = 0;
    const deps = {
      resolveTinyRemapperJar: async () => join(tempDir, "tiny-remapper.jar"),
      // Simulate Fabric publishing build.11 between the two remaps.
      resolveTinyMappingFile: async (_v: string, mapping: string) => {
        assert.equal(mapping, "yarn");
        resolveCount += 1;
        return resolveCount === 1
          ? { path: yarnTinyA, coordinate: "1.21.1+build.10" }
          : { path: yarnTinyB, coordinate: "1.21.1+build.11" };
      },
      remapJar: async (_jar: string, opts: { outputJar: string; mappingsFile: string }) => {
        remapCalls.push(opts.mappingsFile);
        writeFileSync(opts.outputJar, "remapped");
        return { outputJar: opts.outputJar, durationMs: 0 };
      }
    };

    const input: ModRemapInput = { inputJar: jarPath, mcVersion: "1.21.1", targetMapping: "yarn" };
    await remapModJar(input, config, deps);
    await remapModJar(input, config, deps);

    assert.equal(
      remapCalls.length,
      2,
      "a newer yarn coordinate must produce a new cache key and re-remap, not serve the stale jar"
    );
    assert.deepEqual(remapCalls, [yarnTinyA, yarnTinyB]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar serves the cache when the yarn coordinate is unchanged (no always-remap regression)", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath);

    const yarnTiny = join(tempDir, "build.11.tiny");
    writeFileSync(yarnTiny, "tiny\t2\t0\tintermediary\tnamed\n");

    const config = makeTestConfig(tempDir);
    const remapCalls: string[] = [];
    const deps = {
      resolveTinyRemapperJar: async () => join(tempDir, "tiny-remapper.jar"),
      resolveTinyMappingFile: async () => ({ path: yarnTiny, coordinate: "1.21.1+build.11" }),
      remapJar: async (_jar: string, opts: { outputJar: string; mappingsFile: string }) => {
        remapCalls.push(opts.mappingsFile);
        writeFileSync(opts.outputJar, "remapped");
        return { outputJar: opts.outputJar, durationMs: 0 };
      }
    };

    const input: ModRemapInput = { inputJar: jarPath, mcVersion: "1.21.1", targetMapping: "yarn" };
    await remapModJar(input, config, deps);
    const second = await remapModJar(input, config, deps);

    assert.equal(remapCalls.length, 1, "identical coordinate must serve the cache, not re-remap");
    assert.ok(second.warnings.some((w) => w.includes("cache")), "second call should report a cache hit");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("remapModJar forceRemap bypasses the cache and re-resolves", async () => {
  const tempDir = makeTempDir();
  try {
    const jarPath = join(tempDir, "sample-fabric-mod.jar");
    await createMinimalFabricJar(jarPath);

    const yarnTiny = join(tempDir, "build.11.tiny");
    writeFileSync(yarnTiny, "tiny\t2\t0\tintermediary\tnamed\n");

    const config = makeTestConfig(tempDir);
    const remapCalls: string[] = [];
    let sawForceRefresh = false;
    const deps = {
      resolveTinyRemapperJar: async () => join(tempDir, "tiny-remapper.jar"),
      resolveTinyMappingFile: async (
        _v: string,
        _m: string,
        _c: string,
        _f?: unknown,
        options?: { forceRefresh?: boolean }
      ) => {
        if (options?.forceRefresh) sawForceRefresh = true;
        return { path: yarnTiny, coordinate: "1.21.1+build.11" };
      },
      remapJar: async (_jar: string, opts: { outputJar: string; mappingsFile: string }) => {
        remapCalls.push(opts.mappingsFile);
        writeFileSync(opts.outputJar, "remapped");
        return { outputJar: opts.outputJar, durationMs: 0 };
      }
    };

    const base: ModRemapInput = { inputJar: jarPath, mcVersion: "1.21.1", targetMapping: "yarn" };
    await remapModJar(base, config, deps);
    await remapModJar({ ...base, forceRemap: true }, config, deps);

    assert.equal(remapCalls.length, 2, "forceRemap must bypass the cache-hit short-circuit and re-remap");
    assert.ok(sawForceRefresh, "forceRemap must request a yarn coordinate re-resolution (forceRefresh)");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
