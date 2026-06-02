import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildArtifactAlias, DEFAULTS, loadConfig, stableArtifactId } from "../src/config.ts";
import { ERROR_CODES } from "../src/errors.ts";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const baseline = { ...process.env };
  const nextEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(nextEnv)) {
    const value = nextEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const key of Object.keys(baseline)) {
    if (!(key in nextEnv)) {
      delete process.env[key];
    }
  }

  return (async () => {
    return fn();
  })().finally(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(baseline)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });
}

test("loadConfig applies defaults for missing environment variables", async () => {
  await withEnv({}, () => {
    const config = loadConfig();
    const expectedCacheDir = resolve(homedir(), ".cache/minecraft-modding-mcp");
    const expectedSqlitePath = resolve(expectedCacheDir, "source-cache.db");

    assert.equal(config.cacheDir, expectedCacheDir);
    assert.equal(config.sqlitePath, expectedSqlitePath);
    assert.equal(config.localM2Path, resolve(homedir(), ".m2/repository"));
    assert.deepEqual(config.sourceRepos, DEFAULTS.sourceRepos);
    assert.equal(config.maxContentBytes, DEFAULTS.maxContentBytes);
    assert.equal(config.maxSearchHits, DEFAULTS.maxSearchHits);
    assert.equal(config.maxArtifacts, DEFAULTS.maxArtifacts);
    assert.equal(config.maxCacheBytes, DEFAULTS.maxCacheBytes);
    assert.equal(config.fetchTimeoutMs, DEFAULTS.fetchTimeoutMs);
    assert.equal(config.fetchRetries, DEFAULTS.fetchRetries);
    assert.equal(config.searchScanPageSize, DEFAULTS.searchScanPageSize);
    assert.equal(config.searchScanMaxBytes, DEFAULTS.searchScanMaxBytes);
    assert.equal(config.indexInsertChunkSize, DEFAULTS.indexInsertChunkSize);
    assert.equal(config.maxMappingGraphCache, DEFAULTS.maxMappingGraphCache);
    assert.equal(config.maxSignatureCache, DEFAULTS.maxSignatureCache);
    assert.equal(config.maxVersionDetailCache, DEFAULTS.maxVersionDetailCache);
    assert.equal(config.maxNbtInputBytes, 4 * 1024 * 1024);
    assert.equal(config.maxNbtInflatedBytes, 16 * 1024 * 1024);
    assert.equal(config.maxNbtResponseBytes, 8 * 1024 * 1024);
    assert.equal(config.vineflowerJarPath, undefined);
    assert.equal(config.indexedSearchEnabled, true);
    assert.equal(config.mappingSourcePriority, "loom-first");
  });
});

test("loadConfig defaults are independent from cwd for cache paths", async () => {
  const tempCwd = await mkdtemp(join(tmpdir(), "mcp-config-cwd-"));
  const originalCwd = process.cwd();
  process.chdir(tempCwd);
  try {
    await withEnv({}, () => {
      const config = loadConfig();
      const expectedCacheDir = resolve(homedir(), ".cache/minecraft-modding-mcp");
      const expectedSqlitePath = resolve(expectedCacheDir, "source-cache.db");
      const cwdDerivedCacheDir = resolve(tempCwd, ".cache/minecraft-modding-mcp");
      const cwdDerivedSqlitePath = resolve(cwdDerivedCacheDir, "source-cache.db");

      assert.equal(config.cacheDir, expectedCacheDir);
      assert.equal(config.sqlitePath, expectedSqlitePath);
      assert.notEqual(config.cacheDir, cwdDerivedCacheDir);
      assert.notEqual(config.sqlitePath, cwdDerivedSqlitePath);
    });
  } finally {
    process.chdir(originalCwd);
  }
});

test("loadConfig normalizes and expands paths", async () => {
  await withEnv({
    MCP_CACHE_DIR: "~/cache-root",
    MCP_LOCAL_M2: "~/m2-local",
    MCP_SQLITE_PATH: "./relative/path.sqlite",
    MCP_VINEFLOWER_JAR_PATH: " ./tools/vf.jar "
  }, async () => {
    const expectedCache = resolve(homedir(), "cache-root");
    const expectedLocalM2 = resolve(homedir(), "m2-local");
    const expectedSqlite = resolve(process.cwd(), "./relative/path.sqlite");
    const expectedVineflower = resolve(process.cwd(), "./tools/vf.jar");

    const config = loadConfig();
    assert.equal(config.cacheDir, expectedCache);
    assert.equal(config.localM2Path, expectedLocalM2);
    assert.equal(config.sqlitePath, expectedSqlite);
    assert.equal(config.vineflowerJarPath, expectedVineflower);
  });
});

test("loadConfig treats blank, undefined, and null path env values as unset", async () => {
  await withEnv({
    MCP_CACHE_DIR: "undefined",
    MCP_LOCAL_M2: "   ",
    MCP_SQLITE_PATH: "null",
    MCP_VINEFLOWER_JAR_PATH: " null ",
    MCP_TINY_REMAPPER_JAR_PATH: "\t"
  }, () => {
    const config = loadConfig();
    const expectedCacheDir = resolve(homedir(), ".cache/minecraft-modding-mcp");
    const expectedSqlitePath = resolve(expectedCacheDir, "source-cache.db");

    assert.equal(config.cacheDir, expectedCacheDir);
    assert.equal(config.sqlitePath, expectedSqlitePath);
    assert.equal(config.localM2Path, resolve(homedir(), ".m2/repository"));
    assert.equal(config.vineflowerJarPath, undefined);
    assert.equal(config.tinyRemapperJarPath, undefined);
    assert.notEqual(config.cacheDir, resolve(process.cwd(), "undefined"));
    assert.notEqual(config.sqlitePath, resolve(process.cwd(), "null"));
  });
});

test("loadConfig falls back for malformed numeric values", async () => {
  await withEnv({
    MCP_MAX_CONTENT_BYTES: "0",
    MCP_MAX_SEARCH_HITS: "20000",
    MCP_MAX_ARTIFACTS: "0",
    MCP_MAX_CACHE_BYTES: "0",
    MCP_FETCH_TIMEOUT_MS: "100",
    MCP_FETCH_RETRIES: "99",
    MCP_SEARCH_SCAN_PAGE_SIZE: "0",
    MCP_INDEX_INSERT_CHUNK_SIZE: "0",
    MCP_CACHE_GRAPH_MAX: "0",
    MCP_CACHE_SIGNATURE_MAX: "0",
    MCP_CACHE_VERSION_DETAIL_MAX: "0",
    MCP_MAX_NBT_INPUT_BYTES: "0",
    MCP_MAX_NBT_INFLATED_BYTES: "0",
    MCP_MAX_NBT_RESPONSE_BYTES: "0"
  }, () => {
    const config = loadConfig();
    assert.equal(config.maxContentBytes, DEFAULTS.maxContentBytes);
    assert.equal(config.maxSearchHits, DEFAULTS.maxSearchHits);
    assert.equal(config.maxArtifacts, DEFAULTS.maxArtifacts);
    assert.equal(config.maxCacheBytes, DEFAULTS.maxCacheBytes);
    assert.equal(config.fetchTimeoutMs, DEFAULTS.fetchTimeoutMs);
    assert.equal(config.fetchRetries, DEFAULTS.fetchRetries);
    assert.equal(config.searchScanPageSize, DEFAULTS.searchScanPageSize);
    assert.equal(config.searchScanMaxBytes, DEFAULTS.searchScanMaxBytes);
    assert.equal(config.indexInsertChunkSize, DEFAULTS.indexInsertChunkSize);
    assert.equal(config.maxMappingGraphCache, DEFAULTS.maxMappingGraphCache);
    assert.equal(config.maxSignatureCache, DEFAULTS.maxSignatureCache);
    assert.equal(config.maxVersionDetailCache, DEFAULTS.maxVersionDetailCache);
    assert.equal(config.maxNbtInputBytes, 4 * 1024 * 1024);
    assert.equal(config.maxNbtInflatedBytes, 16 * 1024 * 1024);
    assert.equal(config.maxNbtResponseBytes, 8 * 1024 * 1024);
  });
});

test("loadConfig parses NBT size limit environment variables", async () => {
  await withEnv(
    {
      MCP_MAX_NBT_INPUT_BYTES: "1234",
      MCP_MAX_NBT_INFLATED_BYTES: "2345",
      MCP_MAX_NBT_RESPONSE_BYTES: "3456"
    },
    () => {
      const config = loadConfig();
      assert.equal(config.maxNbtInputBytes, 1234);
      assert.equal(config.maxNbtInflatedBytes, 2345);
      assert.equal(config.maxNbtResponseBytes, 3456);
    }
  );
});

test("loadConfig validates source repo urls", async () => {
  await withEnv({
    MCP_SOURCE_REPOS: "https://repo1.maven.org/maven2,   ,http://repo.example.net,ftp://bad.example.com,not-a-url"
  }, () => {
    const config = loadConfig();
    assert.deepEqual(config.sourceRepos, [
      "https://repo1.maven.org/maven2",
      "http://repo.example.net"
    ]);
  });
});

test("loadConfig falls back to default repos when none are valid", async () => {
  await withEnv({
    MCP_SOURCE_REPOS: "ftp://bad.example.com,not-a-url,,http://"
  }, () => {
    const config = loadConfig();
    assert.deepEqual(config.sourceRepos, DEFAULTS.sourceRepos);
  });
});

test("loadConfig rejects malformed path values with structured error", async () => {
  await withEnv({
    MCP_CACHE_DIR: "C:bad-cache-dir"
  }, () => {
    assert.throws(
      () => loadConfig(),
      (error: unknown) => {
        return (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
        );
      }
    );
  });
});

test("loadConfig parses indexed search flag values", async () => {
  await withEnv(
    {
      MCP_ENABLE_INDEXED_SEARCH: "off"
    },
    () => {
      const config = loadConfig();
      assert.equal(config.indexedSearchEnabled, false);
    }
  );

  await withEnv(
    {
      MCP_ENABLE_INDEXED_SEARCH: "yes"
    },
    () => {
      const config = loadConfig();
      assert.equal(config.indexedSearchEnabled, true);
    }
  );
});

test("buildArtifactAlias produces a deterministic, canonical alias for version targets", () => {
  const artifactId = stableArtifactId(["version-marker", "1.21.10", "client"]);
  const alias = buildArtifactAlias({
    artifactId,
    kind: "version",
    value: "1.21.10",
    resolvedVersion: "1.21.10"
  });

  // mapping/scope are intentionally absent from the readable tokens so the
  // alias stays canonical for the artifact row.
  assert.match(alias, /^mc-1-21-10-[0-9a-f]{12}$/);
  const repeat = buildArtifactAlias({
    artifactId,
    kind: "version",
    value: "1.21.10",
    resolvedVersion: "1.21.10"
  });
  assert.equal(alias, repeat);
});

test("buildArtifactAlias hash suffix differs for distinct artifactIds with identical readable tokens (cycle 1 F2 regression)", () => {
  const aliasA = buildArtifactAlias({
    artifactId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    kind: "version",
    value: "1.21.10",
    resolvedVersion: "1.21.10"
  });
  const aliasB = buildArtifactAlias({
    artifactId: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    kind: "version",
    value: "1.21.10",
    resolvedVersion: "1.21.10"
  });

  // Readable tokens are identical; uniqueness comes solely from the trailing
  // 12-hex-char suffix. A 6-char prefix would have left the alias collision
  // domain at ~16M values; 12 chars (48 bits) makes collisions astronomical.
  assert.notEqual(aliasA, aliasB);
  assert.equal(aliasA.endsWith("0123456789ab"), true);
  assert.equal(aliasB.endsWith("fedcba987654"), true);
});

test("buildArtifactAlias is canonical: different mapping/scope inputs produce the same alias when the artifactId is the same (cycle 2 F2 regression)", () => {
  const artifactId = stableArtifactId(["jar-canonical", "/tmp/foo.jar", "sigZ"]);
  const aliasA = buildArtifactAlias({
    artifactId,
    kind: "jar",
    value: "/tmp/foo.jar"
  });
  // A second resolveArtifact on the same row with a different mapping must NOT
  // rotate the alias — the artifactId identifies the row, so a 1:1 alias has
  // to depend only on the row identity.
  const aliasB = buildArtifactAlias({
    artifactId,
    kind: "jar",
    value: "/tmp/foo.jar"
  });
  assert.equal(aliasA, aliasB);
});

test("buildArtifactAlias differentiates mojang-remapped variant and other kinds", () => {
  const aliasPass = buildArtifactAlias({
    artifactId: stableArtifactId(["jar-marker", "/tmp/server.jar", "abcdef"]),
    kind: "jar",
    value: "/tmp/server.jar"
  });
  const aliasRemapped = buildArtifactAlias({
    artifactId: stableArtifactId(["jar-marker", "/tmp/server.jar", "abcdef", "mojang-remapped"]),
    kind: "jar",
    value: "/tmp/server.jar",
    mappingVariant: "mojang-remapped"
  });
  const aliasCoord = buildArtifactAlias({
    artifactId: stableArtifactId(["coord", "net.fabricmc:fabric-loader:0.16.10", "release", "abcdef"]),
    kind: "coordinate",
    value: "net.fabricmc:fabric-loader:0.16.10",
    coordinate: "net.fabricmc:fabric-loader:0.16.10"
  });

  assert.match(aliasPass, /^jar-server-[0-9a-f]{12}$/);
  assert.match(aliasRemapped, /^jar-server-remapped-[0-9a-f]{12}$/);
  assert.match(aliasCoord, /^coord-net-fabricmc-fabric-loader-0-16-10-[0-9a-f]{12}$/);
  assert.notEqual(aliasPass, aliasRemapped);
});

test("loadConfig parses mapping source priority with fallback", async () => {
  await withEnv(
    {
      MCP_MAPPING_SOURCE_PRIORITY: "maven-first"
    },
    () => {
      const config = loadConfig();
      assert.equal(config.mappingSourcePriority, "maven-first");
    }
  );

  await withEnv(
    {
      MCP_MAPPING_SOURCE_PRIORITY: "unexpected-value"
    },
    () => {
      const config = loadConfig();
      assert.equal(config.mappingSourcePriority, "loom-first");
    }
  );
});
