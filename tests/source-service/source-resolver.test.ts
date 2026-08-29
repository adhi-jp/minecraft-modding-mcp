import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { defaultDownloadPath } from "../../src/repo-downloader.ts";
import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

test("resolveSourceTarget(targetKind=jar) ignores unrelated adjacent *-sources.jar and keeps decompile fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-jar-unrelated-"));
  const binaryJarPath = join(root, "a.jar");
  const unrelatedSourcesJarPath = join(root, "b-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(unrelatedSourcesJarPath, {
    "com/example/B.java": [
      "package com.example;",
      "public class B {}"
    ].join("\n")
  });

  const resolved = await resolveSourceTarget(
    { kind: "jar", value: binaryJarPath },
    { allowDecompile: true },
    buildTestConfig(root)
  );

  assert.equal(resolved.origin, "decompiled");
  assert.equal(resolved.isDecompiled, true);
  assert.equal(resolved.sourceJarPath, undefined);
  assert.deepEqual(resolved.adjacentSourceCandidates, [unrelatedSourcesJarPath]);
});

test("resolveSourceTarget(targetKind=jar) adopts exact <basename>-sources.jar when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-jar-exact-"));
  const binaryJarPath = join(root, "a.jar");
  const exactSourcesJarPath = join(root, "a-sources.jar");
  const unrelatedSourcesJarPath = join(root, "b-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/A.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(exactSourcesJarPath, {
    "com/example/A.java": [
      "package com.example;",
      "public class A {}"
    ].join("\n")
  });
  await createJar(unrelatedSourcesJarPath, {
    "com/example/B.java": [
      "package com.example;",
      "public class B {}"
    ].join("\n")
  });

  const resolved = await resolveSourceTarget(
    { kind: "jar", value: binaryJarPath },
    { allowDecompile: true },
    buildTestConfig(root)
  );

  assert.equal(resolved.origin, "local-jar");
  assert.equal(resolved.isDecompiled, false);
  assert.equal(resolved.sourceJarPath, exactSourcesJarPath);
  assert.deepEqual(resolved.adjacentSourceCandidates, [unrelatedSourcesJarPath]);
});

test("resolveSourceTarget(targetKind=jar) can bypass exact sibling sources when binary fallback is required", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-jar-binary-only-"));
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");
  const exactSourcesJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");

  await createJar(binaryJarPath, {
    "dhl.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(exactSourcesJarPath, {
    "net/neoforged/neoforge/capabilities/Capabilities.java": [
      "package net.neoforged.neoforge.capabilities;",
      "public class Capabilities {}"
    ].join("\n")
  });

  const resolved = await resolveSourceTarget(
    { kind: "jar", value: binaryJarPath },
    { allowDecompile: true, preferBinaryOnly: true },
    buildTestConfig(root)
  );

  assert.equal(resolved.origin, "decompiled");
  assert.equal(resolved.isDecompiled, true);
  assert.equal(resolved.binaryJarPath, binaryJarPath);
  assert.equal(resolved.sourceJarPath, undefined);
});

test("resolveSourceTarget(targetKind=jar) adopts sibling binary jar when input is a sources jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-jar-source-input-"));
  const sourceJarPath = join(root, "minecraft-merged-1.21.10-sources.jar");
  const binaryJarPath = join(root, "minecraft-merged-1.21.10.jar");

  await createJar(sourceJarPath, {
    "net/minecraft/world/item/Item.java": [
      "package net.minecraft.world.item;",
      "public class Item {}"
    ].join("\n")
  });
  await createJar(binaryJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const resolved = await resolveSourceTarget(
    { kind: "jar", value: sourceJarPath },
    { allowDecompile: true },
    buildTestConfig(root)
  );

  assert.equal(resolved.origin, "local-jar");
  assert.equal(resolved.isDecompiled, false);
  assert.equal(resolved.sourceJarPath, sourceJarPath);
  assert.equal(resolved.binaryJarPath, binaryJarPath);
});

test("resolveSourceTarget(targetKind=coordinate) resolves local classifier source jars without invalid fallback names", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-classifier-"));
  const versionDir = join(root, "m2", "net", "fabricmc", "fabric-loader", "0.16.10");
  const classifierSourcesJarPath = join(versionDir, "fabric-loader-0.16.10-client-sources.jar");

  await createJar(classifierSourcesJarPath, {
    "net/fabricmc/loader/impl/LoaderImpl.java": [
      "package net.fabricmc.loader.impl;",
      "public class LoaderImpl {}"
    ].join("\n")
  });

  const resolved = await resolveSourceTarget(
    { kind: "coordinate", value: "net.fabricmc:fabric-loader:0.16.10:client" },
    { allowDecompile: true },
    buildTestConfig(root)
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.isDecompiled, false);
  assert.equal(resolved.sourceJarPath, classifierSourcesJarPath);
});

test("resolveSourceTarget(targetKind=coordinate) resolves Gradle modules cache artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-gradle-cache-"));
  const gradleUserHome = join(root, "gradle-home");
  const sourceJarPath = join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    "dev.architectury",
    "architectury",
    "18.0.6",
    "sources-hash",
    "architectury-18.0.6-sources.jar"
  );
  const binaryJarPath = join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    "dev.architectury",
    "architectury",
    "18.0.6",
    "binary-hash",
    "architectury-18.0.6.jar"
  );

  await createJar(sourceJarPath, {
    "dev/architectury/platform/Platform.java": [
      "package dev.architectury.platform;",
      "public class Platform {}"
    ].join("\n")
  });
  await createJar(binaryJarPath, {
    "dev/architectury/platform/Platform.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const previousGradleUserHome = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = gradleUserHome;

  try {
    const resolved = await resolveSourceTarget(
      { kind: "coordinate", value: "dev.architectury:architectury:18.0.6" },
      { allowDecompile: true },
      buildTestConfig(root)
    );

    assert.equal(resolved.origin, "local-m2");
    assert.equal(resolved.isDecompiled, false);
    assert.equal(resolved.coordinate, "dev.architectury:architectury:18.0.6");
    assert.equal(resolved.sourceJarPath, sourceJarPath);
    assert.equal(resolved.binaryJarPath, binaryJarPath);
  } finally {
    if (previousGradleUserHome === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previousGradleUserHome;
    }
  }
});

test("resolveLocalCoordinateCandidates avoids nested readdirSync scans of Gradle cache directories", async () => {
  const source = await readFile("src/source-resolver.ts", "utf8");
  const block =
    source.match(/function resolveLocalCoordinateCandidates\([\s\S]*?discoveredFiles = discoveredFiles\.filter/)?.[0] ?? "";

  assert.doesNotMatch(block, /for \(const entry of readdirSync\(fullDir\)\)/);
});

test("source-resolver uses async discovery for sibling jars and Gradle cache candidates", async () => {
  const source = await readFile("src/source-resolver.ts", "utf8");

  assert.doesNotMatch(source, /readdirSync\(/);
  assert.doesNotMatch(source, /fastGlob\.sync\(/);
});

test("resolveSourceTarget(targetKind=coordinate) keeps the Gradle cache binary jar when the module ships no sources jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-gradle-binary-only-"));
  const gradleUserHome = join(root, "gradle-home");
  const binaryJarPath = join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-gametest-api-v1",
    "4.0.21",
    "binary-hash",
    "fabric-gametest-api-v1-4.0.21.jar"
  );

  await createJar(binaryJarPath, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const remoteSourcesFixture = join(root, "remote-sources.jar");
  await createJar(remoteSourcesFixture, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.java": [
      "package net.fabricmc.fabric.api.gametest.v1;",
      "public interface FabricGameTest {}"
    ].join("\n")
  });
  const remoteSourcesBytes = await readFile(remoteSourcesFixture);

  const previousGradleUserHome = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = gradleUserHome;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/fabric-gametest-api-v1-4.0.21-sources.jar")) {
      return new Response(remoteSourcesBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const resolved = await resolveSourceTarget(
      { kind: "coordinate", value: "net.fabricmc.fabric-api:fabric-gametest-api-v1:4.0.21" },
      { allowDecompile: true },
      buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
    );

    assert.equal(resolved.origin, "remote-repo");
    assert.equal(resolved.isDecompiled, false);
    assert.ok(resolved.sourceJarPath);
    assert.equal(resolved.binaryJarPath, binaryJarPath);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousGradleUserHome === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previousGradleUserHome;
    }
  }
});

test("resolveSourceTarget(targetKind=coordinate) reuses the cached binary jar instead of downloading it again", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-binary-cache-"));
  const binaryFixture = join(root, "remote-binary.jar");
  await createJar(binaryFixture, {
    "com/example/Cached.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const binaryBytes = await readFile(binaryFixture);

  let binaryFetches = 0;
  const previousGradleUserHome = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = join(root, "gradle-home");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/cached-module-1.2.3.jar")) {
      binaryFetches += 1;
      return new Response(binaryBytes, {
        status: 200,
        headers: { etag: "binary-etag-1" }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });
    const target = { kind: "coordinate", value: "com.example:cached-module:1.2.3" } as const;

    const first = await resolveSourceTarget(target, { allowDecompile: true }, config);
    const second = await resolveSourceTarget(target, { allowDecompile: true }, config);

    assert.equal(binaryFetches, 1);
    assert.equal(first.origin, "decompiled");
    assert.equal(second.binaryJarPath, first.binaryJarPath);
    assert.equal(second.artifactSignature, first.artifactSignature);
    assert.equal(second.artifactId, first.artifactId);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousGradleUserHome === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previousGradleUserHome;
    }
  }
});

test("resolveSourceTarget(targetKind=coordinate) reuses the cached source jar instead of downloading it again", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-source-cache-"));
  const sourcesFixture = join(root, "remote-sources.jar");
  await createJar(sourcesFixture, {
    "com/example/Cached.java": [
      "package com.example;",
      "public class Cached {}"
    ].join("\n")
  });
  const sourcesBytes = await readFile(sourcesFixture);

  let sourceFetches = 0;
  const previousGradleUserHome = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = join(root, "gradle-home");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/cached-module-1.2.3-sources.jar")) {
      sourceFetches += 1;
      return new Response(sourcesBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });
    const target = { kind: "coordinate", value: "com.example:cached-module:1.2.3" } as const;

    const first = await resolveSourceTarget(target, { allowDecompile: true }, config);
    const second = await resolveSourceTarget(target, { allowDecompile: true }, config);

    assert.equal(sourceFetches, 1);
    assert.equal(first.origin, "remote-repo");
    assert.equal(second.sourceJarPath, first.sourceJarPath);
    assert.equal(second.artifactSignature, first.artifactSignature);
    assert.equal(second.artifactId, first.artifactId);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousGradleUserHome === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previousGradleUserHome;
    }
  }
});

/** Run `body` with GRADLE_USER_HOME pinned so no real user cache leaks into the test. */
async function withGradleHome<T>(gradleUserHome: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.GRADLE_USER_HOME;
  process.env.GRADLE_USER_HOME = gradleUserHome;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previous;
    }
  }
}

/** Install a global fetch stub for the duration of `body`. */
async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function requestUrlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

test("resolveSourceTarget(targetKind=coordinate) keeps a stable artifactId when a validator-bearing sources jar comes back from the download cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-etag-stable-"));
  const sourcesFixture = join(root, "remote-sources.jar");
  await createJar(sourcesFixture, {
    "com/example/EtagStable.java": ["package com.example;", "public class EtagStable {}"].join("\n")
  });
  const sourcesBytes = await readFile(sourcesFixture);

  let sourceFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/etag-module-1.2.3-sources.jar")) {
      sourceFetches += 1;
      return new Response(sourcesBytes, {
        status: 200,
        headers: {
          etag: "\"sources-etag-1\"",
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT"
        }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });
  const target = { kind: "coordinate", value: "com.example:etag-module:1.2.3" } as const;

  const [first, second] = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, async () => [
      await resolveSourceTarget(target, { allowDecompile: true }, config),
      await resolveSourceTarget(target, { allowDecompile: true }, config)
    ])
  );

  assert.equal(sourceFetches, 1, "the second resolve must be served from the download cache");
  assert.equal(first.origin, "remote-repo");
  // The cache-hit leg used to fabricate a validator-free DownloadResult, which
  // rotated the artifact id on every warm resolve of an ETag-serving repo.
  assert.equal(second.artifactSignature, first.artifactSignature);
  assert.equal(second.artifactId, first.artifactId);
});

test("resolveSourceTarget(targetKind=coordinate) derives the same artifactId from identical bytes served with different ETags", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "resolver-coordinate-etag-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "resolver-coordinate-etag-b-"));
  const sourcesFixture = join(rootA, "remote-sources.jar");
  await createJar(sourcesFixture, {
    "com/example/SameBytes.java": ["package com.example;", "public class SameBytes {}"].join("\n")
  });
  const sourcesBytes = await readFile(sourcesFixture);

  const target = { kind: "coordinate", value: "com.example:same-bytes:4.5.6" } as const;
  const stubServing = (etag: string): typeof fetch =>
    (async (input: string | URL | Request) => {
      if (requestUrlOf(input).endsWith("/same-bytes-4.5.6-sources.jar")) {
        return new Response(sourcesBytes, { status: 200, headers: { etag } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

  const resolveWith = async (root: string, etag: string) =>
    withGradleHome(join(root, "gradle-home"), () =>
      withFetch(stubServing(etag), () =>
        resolveSourceTarget(
          target,
          { allowDecompile: true },
          buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
        )
      )
    );

  const viaCdnA = await resolveWith(rootA, "\"cdn-a-etag\"");
  const viaCdnB = await resolveWith(rootB, "\"cdn-b-etag\"");

  // A CDN or repository migration rotates the validator while the bytes stay
  // byte-identical: artifact identity must follow the bytes, not the validator.
  assert.equal(viaCdnA.artifactSignature, viaCdnB.artifactSignature);
  assert.equal(viaCdnA.artifactId, viaCdnB.artifactId);
});

test("resolveSourceTarget(targetKind=coordinate) revalidates a -SNAPSHOT sources jar but never re-checks a release", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-snapshot-revalidate-"));
  const sourcesFixture = join(root, "remote-sources.jar");
  await createJar(sourcesFixture, {
    "com/example/Mutable.java": ["package com.example;", "public class Mutable {}"].join("\n")
  });
  const sourcesBytes = await readFile(sourcesFixture);

  const snapshotRequests: Array<Record<string, string>> = [];
  let releaseFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrlOf(input);
    if (url.endsWith("/mutable-module-9.0.0-SNAPSHOT-sources.jar")) {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      snapshotRequests.push(headers);
      if (headers["If-None-Match"] === "\"snapshot-etag-1\"") {
        return new Response(null, { status: 304 });
      }
      return new Response(sourcesBytes, {
        status: 200,
        headers: { etag: "\"snapshot-etag-1\"" }
      });
    }
    if (url.endsWith("/release-module-9.0.0-sources.jar")) {
      releaseFetches += 1;
      return new Response(sourcesBytes, { status: 200, headers: { etag: "\"release-etag-1\"" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });
  const snapshotTarget = { kind: "coordinate", value: "com.example:mutable-module:9.0.0-SNAPSHOT" } as const;
  const releaseTarget = { kind: "coordinate", value: "com.example:release-module:9.0.0" } as const;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, async () => ({
      snapshotFirst: await resolveSourceTarget(snapshotTarget, { allowDecompile: true }, config),
      snapshotSecond: await resolveSourceTarget(snapshotTarget, { allowDecompile: true }, config),
      releaseFirst: await resolveSourceTarget(releaseTarget, { allowDecompile: true }, config),
      releaseSecond: await resolveSourceTarget(releaseTarget, { allowDecompile: true }, config)
    }))
  );

  // A SNAPSHOT is mutable by Maven's definition, so the warm resolve must ask.
  assert.equal(snapshotRequests.length, 2, "the second SNAPSHOT resolve must revalidate");
  assert.equal(snapshotRequests[1]["If-None-Match"], "\"snapshot-etag-1\"");
  assert.equal(resolved.snapshotSecond.artifactId, resolved.snapshotFirst.artifactId);

  // A release version is immutable, so the warm resolve must stay off the network.
  assert.equal(releaseFetches, 1, "a release coordinate must not be revalidated");
  assert.equal(resolved.releaseSecond.artifactId, resolved.releaseFirst.artifactId);
});

test("resolveSourceTarget(targetKind=coordinate) decompiles the local Gradle cache binary instead of refetching it from a repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-"));
  const gradleUserHome = join(root, "gradle-home");
  const binaryJarPath = join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    "com.example",
    "binary-only",
    "3.2.1",
    "binary-hash",
    "binary-only-3.2.1.jar"
  );
  await createJar(binaryJarPath, {
    "com/example/BinaryOnly.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  let remoteBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/binary-only-3.2.1.jar")) {
      remoteBinaryFetches += 1;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:binary-only:3.2.1" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(remoteBinaryFetches, 0, "a jar already on local disk must not be downloaded again");
  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.isDecompiled, true);
  assert.equal(resolved.binaryJarPath, binaryJarPath);
  assert.equal(resolved.coordinate, "com.example:binary-only:3.2.1");
});

test("resolveSourceTarget(targetKind=coordinate) still refuses a local binary-only Gradle cache hit when decompile is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-no-decompile-"));
  const gradleUserHome = join(root, "gradle-home");
  const binaryJarPath = join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    "com.example",
    "binary-only",
    "3.2.1",
    "binary-hash",
    "binary-only-3.2.1.jar"
  );
  await createJar(binaryJarPath, {
    "com/example/BinaryOnly.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, async () => {
      await assert.rejects(
        () =>
          resolveSourceTarget(
            { kind: "coordinate", value: "com.example:binary-only:3.2.1" },
            { allowDecompile: false },
            buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
          ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, ERROR_CODES.SOURCE_NOT_FOUND);
          return true;
        }
      );
    })
  );
});

/** Gradle's cache layout for one coordinate: <group>/<artifact>/<version>/<hash>/<file>. */
function gradleCacheJarPath(
  gradleUserHome: string,
  groupId: string,
  artifactId: string,
  version: string,
  fileName: string
): string {
  return join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    groupId,
    artifactId,
    version,
    "binary-hash",
    fileName
  );
}

/** Write a file that passes an existence check but is not a readable archive. */
async function writeUnreadableJar(jarPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(jarPath), { recursive: true });
  await writeFile(jarPath, bytes);
}

test("resolveSourceTarget(targetKind=coordinate) redownloads the binary when the local Gradle cache jar is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-empty-"));
  const gradleUserHome = join(root, "gradle-home");
  const truncatedJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "truncated",
    "1.0",
    "truncated-1.0.jar"
  );
  // An interrupted Gradle copy leaves a 0-byte jar behind: it exists, and it
  // explodes the moment the decompiler tries to open it.
  await writeUnreadableJar(truncatedJarPath, Buffer.alloc(0));

  const remoteBinaryFixture = join(root, "remote-binary.jar");
  await createJar(remoteBinaryFixture, {
    "com/example/Truncated.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteBinaryBytes = await readFile(remoteBinaryFixture);

  let remoteBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/truncated-1.0.jar")) {
      remoteBinaryFetches += 1;
      return new Response(remoteBinaryBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:truncated:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(remoteBinaryFetches, 1, "a corrupt local jar must not suppress the remote binary fetch");
  assert.equal(resolved.origin, "decompiled");
  assert.equal(resolved.isDecompiled, true);
  assert.notEqual(resolved.binaryJarPath, truncatedJarPath);
  assert.equal(
    resolved.repoUrl,
    "https://repo.example.test/com/example/truncated/1.0/truncated-1.0.jar"
  );
});

test("resolveSourceTarget(targetKind=coordinate) redownloads the binary when the local m2 jar is not an archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-garbage-"));
  const garbageJarPath = join(root, "m2", "com", "example", "garbage", "1.0", "garbage-1.0.jar");
  await writeUnreadableJar(garbageJarPath, Buffer.from("this is not a zip archive", "utf8"));

  const remoteBinaryFixture = join(root, "remote-binary.jar");
  await createJar(remoteBinaryFixture, {
    "com/example/Garbage.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteBinaryBytes = await readFile(remoteBinaryFixture);

  let remoteBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/garbage-1.0.jar")) {
      remoteBinaryFetches += 1;
      return new Response(remoteBinaryBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:garbage:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(remoteBinaryFetches, 1, "a non-archive local jar must not suppress the remote binary fetch");
  assert.equal(resolved.origin, "decompiled");
  assert.equal(resolved.isDecompiled, true);
  assert.notEqual(resolved.binaryJarPath, garbageJarPath);
});

test("resolveSourceTarget(targetKind=coordinate) fetches the classified binary instead of adopting the classifier-less local jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-classifier-"));
  const unclassifiedJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "classified",
    "1.0",
    "classified-1.0.jar"
  );
  await createJar(unclassifiedJarPath, {
    "com/example/Common.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const remoteBinaryFixture = join(root, "remote-linux.jar");
  await createJar(remoteBinaryFixture, {
    "com/example/Linux.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteBinaryBytes = await readFile(remoteBinaryFixture);

  let classifiedBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/classified-1.0-linux.jar")) {
      classifiedBinaryFetches += 1;
      return new Response(remoteBinaryBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:classified:1.0:linux" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(classifiedBinaryFetches, 1, "the classified binary must still be fetched");
  assert.equal(resolved.origin, "decompiled");
  assert.notEqual(
    resolved.binaryJarPath,
    unclassifiedJarPath,
    "the classifier-less jar is a different artifact and must not stand in for it"
  );
  assert.equal(resolved.coordinate, "com.example:classified:1.0:linux");
});

test("resolveSourceTarget(targetKind=coordinate) decompiles a readable local m2 binary without any remote binary fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-m2-"));
  const binaryJarPath = join(root, "m2", "com", "example", "m2-binary", "2.0", "m2-binary-2.0.jar");
  await createJar(binaryJarPath, {
    "com/example/M2Binary.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  let remoteBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/m2-binary-2.0.jar")) {
      remoteBinaryFetches += 1;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:m2-binary:2.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(remoteBinaryFetches, 0, "a readable jar already on local disk must not be downloaded again");
  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.isDecompiled, true);
  assert.equal(resolved.binaryJarPath, binaryJarPath);
  assert.equal(resolved.sourceJarPath, undefined);
});

test("resolveSourceTarget(targetKind=coordinate) still refuses a readable local m2 binary when decompile is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-m2-no-decompile-"));
  const binaryJarPath = join(root, "m2", "com", "example", "m2-binary", "2.0", "m2-binary-2.0.jar");
  await createJar(binaryJarPath, {
    "com/example/M2Binary.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, async () => {
      await assert.rejects(
        () =>
          resolveSourceTarget(
            { kind: "coordinate", value: "com.example:m2-binary:2.0" },
            { allowDecompile: false },
            buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
          ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, ERROR_CODES.SOURCE_NOT_FOUND);
          return true;
        }
      );
    })
  );
});

test("resolveSourceTarget(targetKind=coordinate) reports not-found when the local binary is corrupt and the repository has nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-corrupt-miss-"));
  const corruptJarPath = join(root, "m2", "com", "example", "corrupt", "1.0", "corrupt-1.0.jar");
  await writeUnreadableJar(corruptJarPath, Buffer.alloc(0));

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, async () => {
      await assert.rejects(
        () =>
          resolveSourceTarget(
            { kind: "coordinate", value: "com.example:corrupt:1.0" },
            { allowDecompile: true },
            buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
          ),
        (error: unknown) => {
          // The caller must see the ordinary not-found failure, not a zip or
          // decompiler crash leaking out of the local-binary probe.
          assert.equal((error as { code?: string }).code, ERROR_CODES.SOURCE_NOT_FOUND);
          assert.match(String((error as { message?: string }).message), /com\.example:corrupt:1\.0/);
          return true;
        }
      );
    })
  );
});

// ---------------------------------------------------------------------------
// Repository failover.
//
// A cached download is a copy of what ONE repository handed out. When that
// repository stops serving the artifact - withdrawn, re-ACL'd, gone - the cached
// bytes must not stand in for it: they make the withdrawal invisible, and, far
// worse, the caller reads them as success and never asks the next repository,
// which may still publish the artifact.
//
// A 200 is not proof of an artifact either. A repository, a mirror, or the proxy
// in front of one can answer a jar request with an HTML error page; accepted
// unchecked it is written into the (immutable) download cache, returned as the
// artifact, and only explodes later, inside the decompiler.
// ---------------------------------------------------------------------------

interface RecordedFailover {
  stage: "source" | "binary";
  repoUrl: string;
  statusCode?: number;
  reason: string;
  attempt: number;
  totalAttempts: number;
}

const REPO_A = "https://repo-a.example.test";
const REPO_B = "https://repo-b.example.test";

test("resolveSourceTarget(targetKind=coordinate) fails over to the second repository when the first withdraws a cached sources jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-withdrawn-failover-"));
  // -SNAPSHOT, so the cached copy is revalidated rather than trusted blindly:
  // this is the only freshness policy under which the repository gets to say
  // "gone" about something we already hold.
  const coordinate = "com.example:withdrawn-module:1.0.0-SNAPSHOT";
  const sourcesPath =
    "/com/example/withdrawn-module/1.0.0-SNAPSHOT/withdrawn-module-1.0.0-SNAPSHOT-sources.jar";
  const sourcesUrlA = `${REPO_A}${sourcesPath}`;
  const sourcesUrlB = `${REPO_B}${sourcesPath}`;

  const fixtureA = join(root, "repo-a-sources.jar");
  await createJar(fixtureA, {
    "com/example/Withdrawn.java": ["package com.example;", "public class Withdrawn {}"].join("\n")
  });
  const fixtureB = join(root, "repo-b-sources.jar");
  await createJar(fixtureB, {
    "com/example/Withdrawn.java": [
      "package com.example;",
      "// served by the second repository",
      "public class Withdrawn {}"
    ].join("\n")
  });
  const bytesA = await readFile(fixtureA);
  const bytesB = await readFile(fixtureB);

  let repoAServes = true;
  let repoBServes = false;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    const url = requestUrlOf(input);
    if (url === sourcesUrlA && repoAServes) {
      return new Response(bytesA, { status: 200, headers: { etag: "\"repo-a-sources-1\"" } });
    }
    if (url === sourcesUrlB && repoBServes) {
      return new Response(bytesB, { status: 200, headers: { etag: "\"repo-b-sources-1\"" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: [REPO_A, REPO_B] });
  const target = { kind: "coordinate", value: coordinate } as const;
  const failovers: RecordedFailover[] = [];

  const { warm, cold } = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, async () => {
      const warmed = await resolveSourceTarget(target, { allowDecompile: true }, config);
      // The artifact is pulled from A and published by B instead.
      repoAServes = false;
      repoBServes = true;
      const afterWithdrawal = await resolveSourceTarget(
        target,
        {
          allowDecompile: true,
          onRepoFailover: (event) => failovers.push(event as RecordedFailover)
        },
        config
      );
      return { warm: warmed, cold: afterWithdrawal };
    })
  );

  assert.equal(warm.repoUrl, sourcesUrlA, "the first resolve must be the one that fills the cache");

  assert.equal(
    cold.repoUrl,
    sourcesUrlB,
    "a repository that answers 404 must not keep answering out of our cache"
  );
  assert.equal(cold.sourceJarPath, defaultDownloadPath(config.cacheDir, sourcesUrlB));
  assert.notEqual(
    cold.artifactSignature,
    warm.artifactSignature,
    "identity follows the bytes, and these are the second repository's bytes"
  );
  assert.deepEqual(
    failovers.map((event) => ({ stage: event.stage, repoUrl: event.repoUrl, statusCode: event.statusCode })),
    [{ stage: "source", repoUrl: sourcesUrlA, statusCode: 404 }],
    "moving off a repository is exactly what onRepoFailover reports"
  );
});

test("resolveSourceTarget(targetKind=coordinate) refuses a remote binary that is not a readable archive and fails over", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-binary-error-page-"));
  const coordinate = "com.example:error-page:2.0.0";
  const binaryPath = "/com/example/error-page/2.0.0/error-page-2.0.0.jar";
  const binaryUrlA = `${REPO_A}${binaryPath}`;
  const binaryUrlB = `${REPO_B}${binaryPath}`;

  const fixture = join(root, "real-binary.jar");
  await createJar(fixture, {
    "com/example/ErrorPage.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const realJarBytes = await readFile(fixture);

  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    const url = requestUrlOf(input);
    if (url === binaryUrlA) {
      // A 200 with a perfectly plausible body that is not a jar at all.
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url === binaryUrlB) {
      return new Response(realJarBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: [REPO_A, REPO_B] });
  const failovers: RecordedFailover[] = [];

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: coordinate },
        {
          allowDecompile: true,
          onRepoFailover: (event) => failovers.push(event as RecordedFailover)
        },
        config
      )
    )
  );

  assert.equal(resolved.origin, "decompiled");
  assert.equal(
    resolved.repoUrl,
    binaryUrlB,
    "an error page must never be handed to the decompiler as the artifact"
  );
  assert.equal(resolved.binaryJarPath, defaultDownloadPath(config.cacheDir, binaryUrlB));
  assert.equal(
    existsSync(defaultDownloadPath(config.cacheDir, binaryUrlA)),
    false,
    "and the body must not stay in an immutable cache slot where every later run inherits it"
  );
  // The sources leg reports its own move off repository A first; what this pins
  // is that the binary leg reported one too, and said why.
  assert.deepEqual(
    failovers
      .filter((event) => event.stage === "binary")
      .map((event) => ({ repoUrl: event.repoUrl, reason: event.reason })),
    [{ repoUrl: binaryUrlA, reason: "downloaded-not-an-archive" }]
  );
});

test("resolveSourceTarget(targetKind=coordinate) skips a corrupt exact m2 binary for the readable Gradle cache one", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-order-"));
  const gradleUserHome = join(root, "gradle-home");
  // Both spell the coordinate out in full, so both are eligible. ~/.m2 is
  // consulted first - and the copy sitting there is unreadable.
  const corruptM2JarPath = join(root, "m2", "com", "example", "shadowed", "1.0", "shadowed-1.0.jar");
  await writeUnreadableJar(corruptM2JarPath, Buffer.from("this is not a zip archive", "utf8"));
  const gradleJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "shadowed",
    "1.0",
    "shadowed-1.0.jar"
  );
  await createJar(gradleJarPath, {
    "com/example/Shadowed.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  let remoteBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/shadowed-1.0.jar")) {
      remoteBinaryFetches += 1;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:shadowed:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: [REPO_A] })
      )
    )
  );

  assert.equal(
    resolved.binaryJarPath,
    gradleJarPath,
    "a corrupt copy in the first location must not shadow a good copy in the second"
  );
  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.isDecompiled, true);
  assert.equal(
    remoteBinaryFetches,
    0,
    "and picking the readable local jar means there is nothing to download - offline or not"
  );
});

test("resolveSourceTarget(targetKind=coordinate) refuses a remote sources download that is not a readable archive and fails over", async () => {
  // Regression: the binary leg above evicts a poisoned download with
  // discardCachedDownload before failing over, so a future call re-fetches
  // instead of being served the same corrupt bytes forever (immutable urls
  // never ask again). The sources leg relied on hasJavaSources, which
  // deliberately propagates archive-open errors for its OTHER caller (the
  // local jar-target path) - and that propagation used to escape uncaught
  // here too, skipping the eviction this test pins.
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-sources-error-page-"));
  const coordinate = "com.example:sources-error-page:2.0.0";
  const sourcesPath = "/com/example/sources-error-page/2.0.0/sources-error-page-2.0.0-sources.jar";
  const sourcesUrlA = `${REPO_A}${sourcesPath}`;
  const sourcesUrlB = `${REPO_B}${sourcesPath}`;

  const fixture = join(root, "real-sources.jar");
  await createJar(fixture, {
    "com/example/SourcesErrorPage.java": ["package com.example;", "public class SourcesErrorPage {}"].join("\n")
  });
  const realJarBytes = await readFile(fixture);

  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    const url = requestUrlOf(input);
    if (url === sourcesUrlA) {
      // A 200 with a perfectly plausible body that is not a jar at all.
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url === sourcesUrlB) {
      return new Response(realJarBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: [REPO_A, REPO_B] });
  const failovers: RecordedFailover[] = [];

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: coordinate },
        {
          allowDecompile: true,
          onRepoFailover: (event) => failovers.push(event as RecordedFailover)
        },
        config
      )
    )
  );

  assert.equal(resolved.origin, "remote-repo");
  assert.equal(
    resolved.sourceJarPath,
    defaultDownloadPath(config.cacheDir, sourcesUrlB),
    "an error page must never be handed back as the resolved sources jar"
  );
  assert.equal(
    existsSync(defaultDownloadPath(config.cacheDir, sourcesUrlA)),
    false,
    "and the poisoned body must not stay in an immutable cache slot where every later run inherits it"
  );
  assert.deepEqual(
    failovers
      .filter((event) => event.stage === "source")
      .map((event) => ({ repoUrl: event.repoUrl, statusCode: event.statusCode })),
    [{ repoUrl: sourcesUrlA, statusCode: 200 }]
  );
});

test("resolveSourceTarget(targetKind=coordinate) skips a corrupt exact m2 binary companion for the readable Gradle cache one when a remote sources jar is found", async () => {
  // Sibling of the decompile-only case above: this is the *other* place a
  // local binary companion gets attached - alongside a remote sources jar
  // that WAS found - and it used to pick by existence alone (`??`) instead of
  // readability, so a corrupt ~/.m2 companion could shadow a perfectly good
  // Gradle-cache one.
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-remote-source-local-binary-order-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:shadowed-remote:1.0";
  const corruptM2JarPath = join(root, "m2", "com", "example", "shadowed-remote", "1.0", "shadowed-remote-1.0.jar");
  await writeUnreadableJar(corruptM2JarPath, Buffer.from("this is not a zip archive", "utf8"));
  const gradleJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "shadowed-remote",
    "1.0",
    "shadowed-remote-1.0.jar"
  );
  await createJar(gradleJarPath, {
    "com/example/ShadowedRemote.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const sourcesPath = "/com/example/shadowed-remote/1.0/shadowed-remote-1.0-sources.jar";
  const sourcesUrl = `${REPO_A}${sourcesPath}`;
  const fixture = join(root, "remote-sources.jar");
  await createJar(fixture, {
    "com/example/ShadowedRemote.java": ["package com.example;", "public class ShadowedRemote {}"].join("\n")
  });
  const sourcesBytes = await readFile(fixture);

  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    const url = requestUrlOf(input);
    if (url === sourcesUrl) {
      return new Response(sourcesBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: coordinate },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: [REPO_A] })
      )
    )
  );

  assert.equal(resolved.origin, "remote-repo");
  assert.equal(
    resolved.binaryJarPath,
    gradleJarPath,
    "a corrupt companion in the first location must not shadow a good companion in the second"
  );
});

/** The sha256 of a file's bytes, as an artifactSignature is now expected to be. */
async function sha256OfFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** Move a file's mtime without touching a single one of its bytes. */
async function touchWithoutRewriting(filePath: string): Promise<void> {
  const bumped = new Date(Date.now() + 60_000);
  await utimes(filePath, bumped, bumped);
}

test("resolveSourceTarget(targetKind=coordinate) keeps a stable artifactId when a local m2 sources jar is touched without a byte changing", async () => {
  // The instability the remote-download leg of this cascade was fixed for,
  // reaching the local leg by a different route: a cache eviction and re-fetch
  // of byte-identical bytes, a filesystem restore, or a plain `touch` all move
  // mtime while the jar stays the same artifact. A stat signature turned every
  // one of those into a new artifactId and a fresh decompile.
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-m2-touch-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:touched-module:4.5.6";
  const sourceJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "touched-module",
    "4.5.6",
    "touched-module-4.5.6-sources.jar"
  );
  await createJar(sourceJarPath, {
    "com/example/Touched.java": ["package com.example;", "public class Touched {}"].join("\n")
  });

  const config = buildTestConfig(root);
  const target = { kind: "coordinate", value: coordinate } as const;

  const first = await withGradleHome(gradleUserHome, () =>
    resolveSourceTarget(target, { allowDecompile: true }, config)
  );
  await touchWithoutRewriting(sourceJarPath);
  const second = await withGradleHome(gradleUserHome, () =>
    resolveSourceTarget(target, { allowDecompile: true }, config)
  );

  assert.equal(first.origin, "local-m2");
  assert.equal(second.origin, "local-m2");
  assert.equal(
    first.artifactSignature,
    await sha256OfFile(sourceJarPath),
    "a local m2 artifact is identified by the bytes of its jar"
  );
  assert.equal(second.artifactSignature, first.artifactSignature);
  assert.equal(second.artifactId, first.artifactId);
});

test("resolveSourceTarget(targetKind=coordinate) gives a local m2 sources jar a new artifactId once its bytes really change", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-m2-rewritten-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:rewritten-module:4.5.6";
  const sourceJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "rewritten-module",
    "4.5.6",
    "rewritten-module-4.5.6-sources.jar"
  );
  await createJar(sourceJarPath, {
    "com/example/Rewritten.java": ["package com.example;", "public class Rewritten {}"].join("\n")
  });

  const config = buildTestConfig(root);
  const target = { kind: "coordinate", value: coordinate } as const;

  const first = await withGradleHome(gradleUserHome, () =>
    resolveSourceTarget(target, { allowDecompile: true }, config)
  );

  // Republished under the same coordinate with different contents - the one
  // case where a new id is the correct answer, and the thing the memo must not
  // be allowed to hide.
  await createJar(sourceJarPath, {
    "com/example/Rewritten.java": [
      "package com.example;",
      "public class Rewritten {",
      "  public void addedInTheRepublish() {}",
      "}"
    ].join("\n")
  });

  const second = await withGradleHome(gradleUserHome, () =>
    resolveSourceTarget(target, { allowDecompile: true }, config)
  );

  assert.equal(second.origin, "local-m2");
  assert.equal(second.artifactSignature, await sha256OfFile(sourceJarPath));
  assert.notEqual(second.artifactSignature, first.artifactSignature);
  assert.notEqual(second.artifactId, first.artifactId);
});

test("resolveSourceTarget(targetKind=coordinate) keeps a stable artifactId when a local binary-only Gradle cache jar is touched", async () => {
  // The binary-only local hit takes its own branch and its own id space
  // ("local-binary"), so it needs its own proof that identity follows bytes.
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-binary-touch-"));
  const gradleUserHome = join(root, "gradle-home");
  const coordinate = "com.example:binary-only:3.2.1";
  const binaryJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "binary-only",
    "3.2.1",
    "binary-only-3.2.1.jar"
  );
  await createJar(binaryJarPath, {
    "com/example/BinaryOnly.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });
  const target = { kind: "coordinate", value: coordinate } as const;

  const { first, second } = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, async () => {
      const firstResolve = await resolveSourceTarget(target, { allowDecompile: true }, config);
      await touchWithoutRewriting(binaryJarPath);
      const secondResolve = await resolveSourceTarget(target, { allowDecompile: true }, config);
      return { first: firstResolve, second: secondResolve };
    })
  );

  assert.equal(first.origin, "local-m2");
  assert.equal(first.isDecompiled, true);
  assert.equal(
    first.artifactSignature,
    await sha256OfFile(binaryJarPath),
    "a local binary-only artifact is identified by the bytes of its jar"
  );
  assert.equal(second.artifactSignature, first.artifactSignature);
  assert.equal(second.artifactId, first.artifactId);
});
