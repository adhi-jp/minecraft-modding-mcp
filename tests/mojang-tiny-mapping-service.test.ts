import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { resolveMojangTinyFile } from "../src/mojang-tiny-mapping-service.ts";
import type { Config } from "../src/types.ts";

function makeConfig(cacheDir: string): Config {
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

const CLIENT_MAPPINGS = [
  "com.example.ClientClass -> a.b.C:",
  "    int namedField -> d",
  "    void namedMethod(int,java.lang.String[]) -> e"
].join("\n");

const SERVER_MAPPINGS = [
  "com.example.ServerClass -> x.y.Z:",
  "    com.example.ClientClass link -> f",
  "    void srv(com.example.ClientClass[][]) -> g"
].join("\n");

test("resolveMojangTinyFile builds merged tiny v2 from client+server mappings", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-"));
  const config = makeConfig(root);

  const fetchStub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/client.txt") {
      return new Response(CLIENT_MAPPINGS, { status: 200 });
    }
    if (url === "https://example.test/server.txt") {
      return new Response(SERVER_MAPPINGS, { status: 200 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const versionServiceStub = {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: "https://example.test/versions/1.21.10.json",
        clientMappingsUrl: "https://example.test/client.txt",
        serverMappingsUrl: "https://example.test/server.txt",
        mappingsUrl: "https://example.test/client.txt"
      };
    }
  };

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: versionServiceStub
  });

  assert.equal(result.warnings.length, 0);
  const tiny = await readFile(result.path, "utf8");
  assert.match(tiny, /^tiny\t2\t0\tofficial\tmojang/m);
  assert.match(tiny, /^c\ta\/b\/C\tcom\/example\/ClientClass$/m);
  assert.match(tiny, /^c\tx\/y\/Z\tcom\/example\/ServerClass$/m);
  assert.match(tiny, /^\tf\tI\td\tnamedField$/m);
  assert.match(tiny, /^\tm\t\(I\[Ljava\/lang\/String;\)V\te\tnamedMethod$/m);
  assert.match(tiny, /^\tf\tLa\/b\/C;\tf\tlink$/m);
  assert.match(tiny, /^\tm\t\(\[\[La\/b\/C;\)V\tg\tsrv$/m);
});

test("resolveMojangTinyFile works with client mappings only and emits warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-client-only-"));
  const config = makeConfig(root);

  const fetchStub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/client.txt") {
      return new Response(CLIENT_MAPPINGS, { status: 200 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const versionServiceStub = {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: "https://example.test/versions/1.21.10.json",
        clientMappingsUrl: "https://example.test/client.txt",
        serverMappingsUrl: undefined,
        mappingsUrl: "https://example.test/client.txt"
      };
    }
  };

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: versionServiceStub
  });

  assert.ok(result.warnings.some((warning) => warning.toLowerCase().includes("server")));
  const tiny = await readFile(result.path, "utf8");
  assert.match(tiny, /^c\ta\/b\/C\tcom\/example\/ClientClass$/m);
});

test("resolveMojangTinyFile throws MAPPING_UNAVAILABLE when version has no Mojang mappings URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-no-urls-"));
  const config = makeConfig(root);

  const versionServiceStub = {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: "https://example.test/versions/1.21.10.json",
        clientMappingsUrl: undefined,
        serverMappingsUrl: undefined,
        mappingsUrl: undefined
      };
    }
  };

  await assert.rejects(
    () =>
      resolveMojangTinyFile("1.21.10", config, {
        versionService: versionServiceStub
      }),
    (error: unknown) => {
      const appError = error as { code?: string };
      return appError.code === ERROR_CODES.MAPPING_UNAVAILABLE;
    }
  );
});

test("resolveMojangTinyFile reuses cached tiny output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-cache-"));
  const config = makeConfig(root);
  let fetchCount = 0;

  const fetchStub = (async (input: string | URL | Request) => {
    fetchCount += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://example.test/client.txt") {
      return new Response(CLIENT_MAPPINGS, { status: 200 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const versionServiceStub = {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: "https://example.test/versions/1.21.10.json",
        clientMappingsUrl: "https://example.test/client.txt",
        serverMappingsUrl: undefined,
        mappingsUrl: "https://example.test/client.txt"
      };
    }
  };

  await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: versionServiceStub
  });
  await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: versionServiceStub
  });

  assert.equal(fetchCount, 1);
});
