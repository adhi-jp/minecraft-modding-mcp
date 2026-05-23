import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { resolveMojangTinyFile } from "../src/mojang-tiny-mapping-service.ts";
import type { Config } from "../src/types.ts";

interface FetchTable {
  [url: string]: { body: string; status?: number } | { failWith: "abort" };
}

function makeFetchStub(table: FetchTable): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const entry = table[url];
    if (!entry) {
      // Fail loudly on unexpected URLs. A silent 404 here can mask a SUT
      // change that introduces a new download/manifest hop, because the
      // existing warning paths would absorb the 404 and the test would still
      // appear to succeed.
      throw new Error(`makeFetchStub: unexpected URL "${url}" (not declared in the table)`);
    }
    if ("failWith" in entry) {
      const error = new Error("aborted");
      (error as any).name = "AbortError";
      throw error;
    }
    return new Response(entry.body, { status: entry.status ?? 200 });
  }) as typeof fetch;
}

function makeVersionStub(meta: {
  clientMappingsUrl?: string;
  serverMappingsUrl?: string;
  mappingsUrl?: string;
  versionDetailUrl?: string;
}) {
  return {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: meta.versionDetailUrl ?? "https://example.test/versions/1.21.10.json",
        clientMappingsUrl: meta.clientMappingsUrl,
        serverMappingsUrl: meta.serverMappingsUrl,
        mappingsUrl: meta.mappingsUrl
      };
    }
  };
}

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
  assert.match(tiny, /^tiny\t2\t0\tobfuscated\tmojang/m);
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

// --- New edge / coverage tests ----------------------------------------------

test("resolveMojangTinyFile warns when server URL is set but returns 404 and continues with client-only output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-server-404-"));
  const config = makeConfig(root);

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": { body: CLIENT_MAPPINGS, status: 200 },
    "https://example.test/server.txt": { body: "missing", status: 404 }
  });

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: makeVersionStub({
      clientMappingsUrl: "https://example.test/client.txt",
      serverMappingsUrl: "https://example.test/server.txt",
      mappingsUrl: "https://example.test/client.txt"
    })
  });

  assert.ok(
    result.warnings.some((w) => /Failed to download server mappings/.test(w) && /status: 404/.test(w)),
    `expected a server download warning, got: ${JSON.stringify(result.warnings)}`
  );
  const tiny = await readFile(result.path, "utf8");
  assert.match(tiny, /^c\ta\/b\/C\tcom\/example\/ClientClass$/m);
});

test("resolveMojangTinyFile throws MAPPING_UNAVAILABLE when every download fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-all-fail-"));
  const config = makeConfig(root);

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": { body: "server error", status: 500 },
    "https://example.test/server.txt": { body: "server error", status: 500 }
  });

  await assert.rejects(
    () =>
      resolveMojangTinyFile("1.21.10", config, {
        fetchFn: fetchStub,
        versionService: makeVersionStub({
          clientMappingsUrl: "https://example.test/client.txt",
          serverMappingsUrl: "https://example.test/server.txt",
          mappingsUrl: "https://example.test/client.txt"
        })
      }),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.MAPPING_UNAVAILABLE);
      assert.match(err.message ?? "", /Failed to retrieve Mojang mappings/);
      return true;
    }
  );
});

test("resolveMojangTinyFile preserves versionDetailUrl in details when no URLs are exposed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-no-urls-details-"));
  const config = makeConfig(root);

  await assert.rejects(
    () =>
      resolveMojangTinyFile("1.21.10", config, {
        versionService: makeVersionStub({
          versionDetailUrl: "https://example.test/versions/1.21.10.json"
        })
      }),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.MAPPING_UNAVAILABLE);
      assert.equal(err.details?.versionDetailUrl, "https://example.test/versions/1.21.10.json");
      assert.equal(err.details?.version, "1.21.10");
      return true;
    }
  );
});

test("resolveMojangTinyFile rejects when ProGuard input has no class entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-empty-classes-"));
  const config = makeConfig(root);

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": {
      body: ["# only comments", "# nothing real here"].join("\n"),
      status: 200
    }
  });

  await assert.rejects(
    () =>
      resolveMojangTinyFile("1.21.10", config, {
        fetchFn: fetchStub,
        versionService: makeVersionStub({
          clientMappingsUrl: "https://example.test/client.txt",
          mappingsUrl: "https://example.test/client.txt"
        })
      }),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.MAPPING_UNAVAILABLE);
      assert.match(err.message ?? "", /No class mappings could be parsed/);
      return true;
    }
  );
});

test("resolveMojangTinyFile records skip warnings for unsupported member syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-skip-member-"));
  const config = makeConfig(root);

  const mappings = [
    "com.example.A -> a.b.C:",
    // unrecognised left side (no spaces → neither method nor field pattern matches)
    "    weirdtoken -> q",
    // valid field
    "    int normalField -> n"
  ].join("\n");

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": { body: mappings, status: 200 }
  });

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: makeVersionStub({
      clientMappingsUrl: "https://example.test/client.txt",
      mappingsUrl: "https://example.test/client.txt"
    })
  });

  assert.ok(
    result.warnings.some((w) => /Skipping unsupported member mapping syntax/.test(w)),
    `expected unsupported-syntax warning, got: ${JSON.stringify(result.warnings)}`
  );
  const tiny = await readFile(result.path, "utf8");
  assert.match(tiny, /^\tf\tI\tn\tnormalField$/m);
});

test("resolveMojangTinyFile emits Conflicting class mapping warning and keeps first side", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-conflict-"));
  const config = makeConfig(root);

  const clientMaps = ["com.example.A -> a.b.C:", "    int x -> y"].join("\n");
  const serverMaps = ["com.example.A -> x.y.Z:", "    int x -> y"].join("\n");

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": { body: clientMaps, status: 200 },
    "https://example.test/server.txt": { body: serverMaps, status: 200 }
  });

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: makeVersionStub({
      clientMappingsUrl: "https://example.test/client.txt",
      serverMappingsUrl: "https://example.test/server.txt",
      mappingsUrl: "https://example.test/client.txt"
    })
  });

  assert.ok(
    result.warnings.some((w) => /Conflicting class mapping for "com\.example\.A"/.test(w)),
    `expected conflict warning, got: ${JSON.stringify(result.warnings)}`
  );
  const tiny = await readFile(result.path, "utf8");
  // first side (client → a/b/C) wins; the loser (x/y/Z) must not appear as the
  // obfuscated name for A
  assert.match(tiny, /^c\ta\/b\/C\tcom\/example\/A$/m);
  assert.ok(!/^c\tx\/y\/Z\tcom\/example\/A$/m.test(tiny));
});

test("resolveMojangTinyFile dedups identical members shared between client and server", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-dedupe-"));
  const config = makeConfig(root);

  const sharedMember = "    int dup -> q";
  const clientMaps = ["com.example.A -> a.b.C:", sharedMember].join("\n");
  const serverMaps = ["com.example.A -> a.b.C:", sharedMember].join("\n");

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": { body: clientMaps, status: 200 },
    "https://example.test/server.txt": { body: serverMaps, status: 200 }
  });

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: makeVersionStub({
      clientMappingsUrl: "https://example.test/client.txt",
      serverMappingsUrl: "https://example.test/server.txt",
      mappingsUrl: "https://example.test/client.txt"
    })
  });

  const tiny = await readFile(result.path, "utf8");
  const dupRows = tiny.split("\n").filter((line) => /^\tf\tI\tq\tdup$/.test(line));
  assert.equal(dupRows.length, 1, `expected single dup row, got: ${dupRows.length}`);
});

test("resolveMojangTinyFile converts varargs and generic types in method descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-varargs-"));
  const config = makeConfig(root);

  const maps = [
    "com.example.A -> a.b.C:",
    "    void varargs(java.lang.String...) -> v",
    "    void genericArgs(java.util.Map<java.lang.String,java.lang.Integer>) -> g",
    "    java.util.List<java.lang.String> getList() -> l"
  ].join("\n");

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": { body: maps, status: 200 }
  });

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: makeVersionStub({
      clientMappingsUrl: "https://example.test/client.txt",
      mappingsUrl: "https://example.test/client.txt"
    })
  });

  const tiny = await readFile(result.path, "utf8");
  assert.match(tiny, /^\tm\t\(\[Ljava\/lang\/String;\)V\tv\tvarargs$/m);
  assert.match(tiny, /^\tm\t\(Ljava\/util\/Map;\)V\tg\tgenericArgs$/m);
  assert.match(tiny, /^\tm\t\(\)Ljava\/util\/List;\tl\tgetList$/m);
});

test("resolveMojangTinyFile falls back to mappingsUrl when clientMappingsUrl is undefined", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-legacy-url-"));
  const config = makeConfig(root);

  const fetchStub = makeFetchStub({
    "https://example.test/legacy.txt": { body: CLIENT_MAPPINGS, status: 200 }
  });

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: makeVersionStub({
      clientMappingsUrl: undefined,
      mappingsUrl: "https://example.test/legacy.txt"
    })
  });

  const tiny = await readFile(result.path, "utf8");
  assert.match(tiny, /^c\ta\/b\/C\tcom\/example\/ClientClass$/m);
});

test("resolveMojangTinyFile strips multiple line-info prefixes when parsing methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "mojang-tiny-lineinfo-"));
  const config = makeConfig(root);

  const maps = [
    "com.example.A -> a.b.C:",
    "    5:10:8:12:void overload(int) -> o"
  ].join("\n");

  const fetchStub = makeFetchStub({
    "https://example.test/client.txt": { body: maps, status: 200 }
  });

  const result = await resolveMojangTinyFile("1.21.10", config, {
    fetchFn: fetchStub,
    versionService: makeVersionStub({
      clientMappingsUrl: "https://example.test/client.txt",
      mappingsUrl: "https://example.test/client.txt"
    })
  });

  const tiny = await readFile(result.path, "utf8");
  assert.match(tiny, /^\tm\t\(I\)V\to\toverload$/m);
});
