import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import type { Config } from "../src/types.ts";
import { isUnobfuscatedVersion, VersionService } from "../src/version-service.ts";

function buildTestConfig(root: string, overrides: Partial<Config> = {}): Config {
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
    fetchTimeoutMs: 2_000,
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
    maxNbtResponseBytes: 8 * 1024 * 1024,
    ...overrides
  };
}

test("isUnobfuscatedVersion returns true for new YY.N format (>= 26)", () => {
  assert.equal(isUnobfuscatedVersion("26.1"), true);
  assert.equal(isUnobfuscatedVersion("26.1.2"), true);
  assert.equal(isUnobfuscatedVersion("27.3"), true);
});

test("isUnobfuscatedVersion returns false for legacy 1.x.y versions", () => {
  assert.equal(isUnobfuscatedVersion("1.21.4"), false);
  assert.equal(isUnobfuscatedVersion("1.20.1"), false);
});

test("isUnobfuscatedVersion handles snapshots by year prefix", () => {
  assert.equal(isUnobfuscatedVersion("26w01a"), true);
  assert.equal(isUnobfuscatedVersion("24w33a"), false);
  assert.equal(isUnobfuscatedVersion("25w50a"), false);
});

test("isUnobfuscatedVersion handles pre-release and rc tags in new format", () => {
  assert.equal(isUnobfuscatedVersion("26.1-pre1"), true);
  assert.equal(isUnobfuscatedVersion("26.1-rc1"), true);
  assert.equal(isUnobfuscatedVersion("25.9-pre1"), false);
  assert.equal(isUnobfuscatedVersion("25.9-rc1"), false);
});

test("isUnobfuscatedVersion returns false for empty or unknown formats", () => {
  assert.equal(isUnobfuscatedVersion(""), false);
  assert.equal(isUnobfuscatedVersion("foo"), false);
});

// --- SHA-1 verification tests ---

function makeManifestFetchFn(
  jarBytes: Buffer,
  sha1: string | undefined
): typeof fetch {
  const jarUrl = "https://piston-data.mojang.com/v1/objects/client.jar";
  const versionDetailUrl = "https://piston-meta.mojang.com/v1/packages/detail.json";
  const manifest = {
    latest: { release: "1.21.4" },
    versions: [{ id: "1.21.4", type: "release", url: versionDetailUrl }]
  };
  const detail = {
    id: "1.21.4",
    downloads: {
      client: { url: jarUrl, ...(sha1 != null ? { sha1 } : {}) }
    }
  };

  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("version_manifest")) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    if (url === versionDetailUrl) {
      return new Response(JSON.stringify(detail), { status: 200 });
    }
    if (url === jarUrl) {
      return new Response(jarBytes, { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

test("resolveVersionJar succeeds when SHA-1 matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-sha1-ok-"));
  const jarBytes = Buffer.from("fake-jar-content");
  const sha1 = createHash("sha1").update(jarBytes).digest("hex");
  const config = buildTestConfig(root);
  const svc = new VersionService(config, makeManifestFetchFn(jarBytes, sha1));

  const result = await svc.resolveVersionJar("1.21.4");
  assert.equal(result.version, "1.21.4");
  assert.equal(result.source, "downloaded");
  assert.ok(existsSync(result.jarPath));
});

test("resolveVersionJar throws on SHA-1 mismatch and deletes file", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-sha1-bad-"));
  const jarBytes = Buffer.from("fake-jar-content");
  const config = buildTestConfig(root);
  const svc = new VersionService(config, makeManifestFetchFn(jarBytes, "0000000000000000000000000000000000000000"));

  try {
    await svc.resolveVersionJar("1.21.4");
    assert.fail("Expected error");
  } catch (err: any) {
    assert.equal(err.code, ERROR_CODES.REPO_FETCH_FAILED);
    assert.match(err.message, /SHA-1 mismatch/);
    assert.ok(err.details?.expected);
    assert.ok(err.details?.actual);
  }
});

test("resolveVersionJar skips SHA-1 check when sha1 is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-sha1-skip-"));
  const jarBytes = Buffer.from("fake-jar-no-hash");
  const config = buildTestConfig(root);
  const svc = new VersionService(config, makeManifestFetchFn(jarBytes, undefined));

  const result = await svc.resolveVersionJar("1.21.4");
  assert.equal(result.version, "1.21.4");
  assert.ok(existsSync(result.jarPath));
});
