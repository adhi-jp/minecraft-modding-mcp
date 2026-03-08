import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { defaultDownloadPath } from "../src/repo-downloader.ts";
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

const DEFAULT_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

type FetchRoute = () => Response | Promise<Response>;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createFetchStub(routes: Record<string, FetchRoute>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (!route) {
      return new Response("", { status: 404 });
    }
    return route();
  }) as typeof fetch & { calls: string[] };

  fetchFn.calls = calls;
  return fetchFn;
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

test("listVersions includes snapshots, clamps limit, and returns sorted unique cached versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-list-versions-"));
  const config = buildTestConfig(root);
  const cacheIndexPath = join(config.cacheDir, "versions", "index.json");

  await mkdir(dirname(cacheIndexPath), { recursive: true });
  await writeFile(
    cacheIndexPath,
    JSON.stringify({
      entries: [
        { version: "1.21.4", jarPath: "/tmp/a.jar", downloadedAt: "2026-03-01T00:00:00.000Z" },
        { version: "1.20.1", jarPath: "/tmp/b.jar", downloadedAt: "2026-03-02T00:00:00.000Z" },
        { version: "1.21.4", jarPath: "/tmp/c.jar", downloadedAt: "2026-03-03T00:00:00.000Z" },
        { version: 123 }
      ]
    }),
    "utf8"
  );

  const fetchFn = createFetchStub({
    [DEFAULT_MANIFEST_URL]: () =>
      jsonResponse({
        latest: { release: "26.1", snapshot: "26w10a" },
        versions: [
          { id: "26.1", type: "release", url: "https://example.invalid/release.json" },
          { id: "1.21.4", type: "release", url: "https://example.invalid/release-legacy.json" },
          { id: "26w10a", type: "snapshot", url: "https://example.invalid/snapshot.json" },
          { id: "25w05a", type: "snapshot", url: "https://example.invalid/old-snapshot.json" }
        ]
      })
  });

  const svc = new VersionService(config, fetchFn);
  const result = await svc.listVersions({ includeSnapshots: true, limit: 0 });

  assert.deepEqual(result, {
    latest: { release: "26.1", snapshot: "26w10a" },
    releases: [{ id: "26.1", unobfuscated: true }],
    snapshots: [{ id: "26w10a", unobfuscated: true }],
    cached: ["1.20.1", "1.21.4"],
    totalAvailable: 4
  });
});

test("version manifest fetch is cached across list operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-manifest-cache-"));
  const fetchFn = createFetchStub({
    [DEFAULT_MANIFEST_URL]: () =>
      jsonResponse({
        latest: { release: "1.21.4" },
        versions: [{ id: "1.21.4", type: "release", url: "https://example.invalid/detail.json" }]
      })
  });
  const svc = new VersionService(buildTestConfig(root), fetchFn);

  const versionIds = await svc.listVersionIds();
  const versions = await svc.listVersions();

  assert.deepEqual(versionIds, ["1.21.4"]);
  assert.deepEqual(versions.releases, [{ id: "1.21.4", unobfuscated: false }]);
  assert.equal(fetchFn.calls.filter((url) => url === DEFAULT_MANIFEST_URL).length, 1);
});

test("VersionService trims version detail cache without iterative single-entry eviction", async () => {
  const source = await readFile("src/version-service.ts", "utf8");
  const block =
    source.match(/private trimVersionDetailCache\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? "";

  assert.match(block, /const overflow = this\.versionDetailCache\.size - maxEntries/);
  assert.doesNotMatch(block, /while \(this\.versionDetailCache\.size > maxEntries\)/);
});

test("resolveVersionMappings returns mapping URLs and reuses cached version details", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-mappings-"));
  const detailUrl = "https://example.invalid/detail.json";
  const fetchFn = createFetchStub({
    [DEFAULT_MANIFEST_URL]: () =>
      jsonResponse({
        latest: { release: "1.21.4" },
        versions: [{ id: "1.21.4", type: "release", url: detailUrl }]
      }),
    [detailUrl]: () =>
      jsonResponse({
        downloads: {
          client_mappings: { url: "https://example.invalid/client.txt" },
          server_mappings: { url: "https://example.invalid/server.txt" }
        }
      })
  });
  const svc = new VersionService(buildTestConfig(root), fetchFn);

  const first = await svc.resolveVersionMappings("1.21.4");
  const second = await svc.resolveVersionMappings("1.21.4");

  assert.deepEqual(first, {
    version: "1.21.4",
    versionManifestUrl: DEFAULT_MANIFEST_URL,
    versionDetailUrl: detailUrl,
    clientMappingsUrl: "https://example.invalid/client.txt",
    serverMappingsUrl: "https://example.invalid/server.txt",
    mappingsUrl: "https://example.invalid/client.txt"
  });
  assert.deepEqual(second, first);
  assert.equal(fetchFn.calls.filter((url) => url === detailUrl).length, 1);
});

test("resolveVersionMappings rejects invalid detail payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-invalid-detail-"));
  const detailUrl = "https://example.invalid/detail.json";
  const fetchFn = createFetchStub({
    [DEFAULT_MANIFEST_URL]: () =>
      jsonResponse({
        latest: { release: "1.21.4" },
        versions: [{ id: "1.21.4", type: "release", url: detailUrl }]
      }),
    [detailUrl]: () => jsonResponse(null)
  });
  const svc = new VersionService(buildTestConfig(root), fetchFn);

  await assert.rejects(
    () => svc.resolveVersionMappings("1.21.4"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.VERSION_NOT_FOUND);
      return true;
    }
  );
});

test("listVersions wraps invalid JSON manifest responses as repository fetch errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-invalid-json-"));
  const fetchFn = createFetchStub({
    [DEFAULT_MANIFEST_URL]: () =>
      new Response("{not-valid-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });
  const svc = new VersionService(buildTestConfig(root), fetchFn);

  await assert.rejects(
    () => svc.listVersions(),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.REPO_FETCH_FAILED);
      assert.match((error as { message?: string }).message ?? "", /not valid JSON/);
      return true;
    }
  );
});

test("resolveServerJar reuses an existing cached download without fetching the jar again", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-server-cache-"));
  const detailUrl = "https://example.invalid/server-detail.json";
  const serverJarUrl = "https://example.invalid/server.jar";
  const config = buildTestConfig(root);
  const destinationPath = defaultDownloadPath(config.cacheDir, serverJarUrl);

  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, "cached-server-jar", "utf8");

  const fetchFn = createFetchStub({
    [DEFAULT_MANIFEST_URL]: () =>
      jsonResponse({
        latest: { release: "1.21.4" },
        versions: [{ id: "1.21.4", type: "release", url: detailUrl }]
      }),
    [detailUrl]: () =>
      jsonResponse({
        downloads: {
          server: { url: serverJarUrl }
        }
      }),
    [serverJarUrl]: () => new Response("unexpected", { status: 200 })
  });
  const svc = new VersionService(config, fetchFn);

  const result = await svc.resolveServerJar("1.21.4");

  assert.deepEqual(result, {
    version: "1.21.4",
    jarPath: destinationPath,
    source: "downloaded",
    serverJarUrl
  });
  assert.equal(fetchFn.calls.filter((url) => url === serverJarUrl).length, 0);
});

test("resolveServerJar rejects versions without a server download URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "vs-server-missing-"));
  const detailUrl = "https://example.invalid/server-detail.json";
  const fetchFn = createFetchStub({
    [DEFAULT_MANIFEST_URL]: () =>
      jsonResponse({
        latest: { release: "1.21.4" },
        versions: [{ id: "1.21.4", type: "release", url: detailUrl }]
      }),
    [detailUrl]: () =>
      jsonResponse({
        downloads: {}
      })
  });
  const svc = new VersionService(buildTestConfig(root), fetchFn);

  await assert.rejects(
    () => svc.resolveServerJar("1.21.4"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.VERSION_NOT_FOUND);
      assert.match((error as { message?: string }).message ?? "", /does not expose a server download URL/);
      return true;
    }
  );
});
