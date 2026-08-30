import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../../src/errors.ts";
import type { MavenCoordinate } from "../../src/maven-resolver.ts";
import { defaultDownloadPath, downloadSidecarPath } from "../../src/repo-downloader.ts";
import {
  localM2CoordinateCandidatePaths,
  resolveSourceTarget
} from "../../src/source-resolver.ts";
import { mapErrorToProblem } from "../../src/tool-guidance.ts";
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

/**
 * Stage the concurrent-resolve race deterministically: replace `jarPath` at the
 * moment the archive check has opened it, and before the check gets its file
 * descriptor back.
 *
 * The window the eviction above lives in is real. A poisoned body is only ever
 * found unusable by *opening* it as an archive - a file open plus a read of the
 * zip's central directory, all of it I/O against a shared cache slot that
 * another resolve of the same immutable url may be finishing a perfectly good
 * jar into. Racing two real resolves would pin nothing, because whichever
 * happened to finish first would decide the run; hooking the reader's own
 * `fs.open` puts the replacement inside the window every time.
 *
 * Which open, though, matters: the transfer opens the same path first, to digest
 * the bytes it just wrote, and a replacement staged there would be overwritten
 * by the record that transfer goes on to write. The identity record is exactly
 * what separates the two - it does not exist until the transfer has finished
 * with the file - so the hook stays disarmed until one is there.
 *
 * The swap is a rename, which is how the downloader installs bytes as well, so
 * the descriptor the reader already holds keeps pointing at the poison: it still
 * parses, and still rejects, the body this call downloaded, while the path now
 * holds somebody else's good jar. That is exactly the state the eviction has to
 * recognise.
 *
 * `installed` is reported back so a caller can refuse to pass on a run where the
 * hook never fired - a reader that stopped going through `fs.open`, or a
 * transfer that stopped recording what it wrote, would otherwise quietly turn
 * this into a test of nothing.
 */
async function withWinnerInstalledDuringArchiveCheck<T>(
  jarPath: string,
  installWinner: () => void,
  body: () => Promise<T>
): Promise<{ result: T; installed: number }> {
  // yauzl reads `open` off the CommonJS `fs` module object at call time, so this
  // is the reader's own open rather than a copy of it.
  const fsModule = createRequire(import.meta.url)("fs") as typeof import("node:fs");
  const realOpen = fsModule.open as unknown as (...args: unknown[]) => unknown;
  let installed = 0;

  (fsModule as unknown as Record<string, unknown>).open = function patchedOpen(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const callback = args[args.length - 1];
    const armed =
      args[0] === jarPath && installed === 0 && existsSync(downloadSidecarPath(jarPath));
    if (!armed || typeof callback !== "function") {
      return realOpen.apply(this, args);
    }
    return realOpen.call(this, ...args.slice(0, -1), (...openResult: unknown[]) => {
      installed += 1;
      installWinner();
      (callback as (...cbArgs: unknown[]) => void)(...openResult);
    });
  };

  try {
    return { result: await body(), installed };
  } finally {
    (fsModule as unknown as Record<string, unknown>).open = realOpen;
  }
}

test("resolveSourceTarget(targetKind=coordinate) leaves a concurrent winner's jar alone when evicting the body it rejected", {
  // Renaming over a file the archive check still holds open is what POSIX
  // guarantees, and POSIX is what CI runs on. Whether the same interleaving is
  // reachable on Windows is not a question anything here can answer: this
  // project's CI is Ubuntu-only, so nobody would ever see this fixture stage
  // the race there, stage a different one, or fail to stage one at all.
  // Skipped as unverified on that platform - no claim either way.
  skip:
    process.platform === "win32"
      ? "unverified on Windows: this project's CI does not run there"
      : false
}, async () => {
  // Regression: eviction deleted the destination path unconditionally. Between
  // the download and the verdict on it sits an archive open, and the downloads
  // cache is keyed by url and shared, so the bytes being deleted were
  // not necessarily the bytes being rejected - a concurrent resolve that won the
  // slot lost its good jar to somebody else's failed check, and the caller that
  // was about to hand that jar back found nothing there.
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-binary-evict-winner-"));
  const coordinate = "com.example:evict-winner:4.0.0";
  const binaryPath = "/com/example/evict-winner/4.0.0/evict-winner-4.0.0.jar";
  const binaryUrlA = `${REPO_A}${binaryPath}`;
  const binaryUrlB = `${REPO_B}${binaryPath}`;

  const winnerFixture = join(root, "winner-binary.jar");
  await createJar(winnerFixture, {
    "com/example/EvictWinner.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const winnerBytes = await readFile(winnerFixture);
  const repoBFixture = join(root, "repo-b-binary.jar");
  await createJar(repoBFixture, {
    "com/example/EvictWinnerFromB.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const repoBBytes = await readFile(repoBFixture);

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
      return new Response(repoBBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: [REPO_A, REPO_B] });
  const poisonedSlot = defaultDownloadPath(config.cacheDir, binaryUrlA);
  const winnerStaging = join(root, "winner-staged.jar");
  await writeFile(winnerStaging, winnerBytes);

  // What the winning resolve leaves behind: its bytes, then the record
  // describing them, in that order - see writeDownloadSidecar.
  const installWinner = (): void => {
    renameSync(winnerStaging, poisonedSlot);
    const stats = statSync(poisonedSlot);
    writeFileSync(
      downloadSidecarPath(poisonedSlot),
      JSON.stringify({
        version: 2,
        url: binaryUrlA,
        contentSha256: createHash("sha256").update(winnerBytes).digest("hex"),
        contentLength: stats.size,
        contentMtimeMs: stats.mtimeMs
      })
    );
  };

  const { result: resolved, installed } = await withWinnerInstalledDuringArchiveCheck(
    poisonedSlot,
    installWinner,
    () =>
      withGradleHome(join(root, "gradle-home"), () =>
        withFetch(fetchStub, () =>
          resolveSourceTarget(
            { kind: "coordinate", value: coordinate },
            { allowDecompile: true },
            config
          )
        )
      )
  );

  assert.equal(installed, 1, "the race this pins never happened - the assertions below prove nothing");
  assert.equal(
    existsSync(poisonedSlot),
    true,
    "the winner's jar was deleted by a verdict passed on the bytes it replaced"
  );
  assert.deepEqual(
    await readFile(poisonedSlot),
    winnerBytes,
    "the slot must still hold the winner's bytes, untouched"
  );
  // The rejecting call still fails over, exactly as before: it is only the
  // *deletion* that the winner's record calls off, not the verdict.
  assert.equal(resolved.origin, "decompiled");
  assert.equal(resolved.binaryJarPath, defaultDownloadPath(config.cacheDir, binaryUrlB));
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

test("resolveSourceTarget publishes the download size cap to the CALLER, even behind a later unrelated failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-download-cap-"));
  const gradleUserHome = join(root, "gradle-home");
  await mkdir(gradleUserHome, { recursive: true });

  // The floor loadMaxDownloadBytes clamps to, so the declared length below only
  // has to clear 1 MiB - no multi-hundred-megabyte fixture required.
  const previousMaxDownloadBytes = process.env.MCP_MAX_DOWNLOAD_BYTES;
  process.env.MCP_MAX_DOWNLOAD_BYTES = "1048576";

  // A MIXED cascade, which is what makes this a test rather than a tautology.
  // The sources leg trips the ceiling - the actionable failure, the only one
  // that names a setting the user can change - and the binary leg that runs
  // after it fails differently and blandly. Under plain "keep the last
  // failure", that 503 erased the cap and the caller was told only that
  // repositories were unstable.
  const sourceUrl = "https://repo.example.test/com/example/oversized/1.0/oversized-1.0-sources.jar";
  const binaryUrl = "https://repo.example.test/com/example/oversized/1.0/oversized-1.0.jar";
  const requested: string[] = [];
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    const url = requestUrlOf(input);
    requested.push(url);
    if (url === sourceUrl) {
      // A declared size above the ceiling. The body is never read - the
      // Content-Length pre-check refuses the transfer first - so it stays tiny.
      return new Response(Buffer.from("x"), {
        status: 200,
        headers: { "content-length": "2097152" }
      });
    }
    return new Response("upstream unavailable", { status: 503 });
  }) as typeof fetch;

  try {
    const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });

    const caught = await withGradleHome(gradleUserHome, () =>
      withFetch(fetchStub, async () => {
        try {
          await resolveSourceTarget(
            { kind: "coordinate", value: "com.example:oversized:1.0" },
            { allowDecompile: true },
            config
          );
          return undefined;
        } catch (error) {
          return error;
        }
      })
    );

    assert.ok(caught, "an artifact that cannot be downloaded must not resolve");
    assert.ok(isAppError(caught));
    // The failover behaviour is unchanged on purpose: one oversized mirror must
    // not break resolution, so every repository is still tried and the terminal
    // code is still the transient one.
    assert.equal(caught.code, ERROR_CODES.REPO_FETCH_FAILED);
    assert.deepEqual(
      requested,
      [sourceUrl, binaryUrl],
      "both legs must have run, in order, for the overwrite this guards against to be possible at all"
    );

    // The message alone has always said "unstable", which is exactly the dead
    // end this test exists to close: a configurable ceiling is not instability,
    // and a user told their repositories are unstable has no route to the knob.
    assert.match(caught.message, /unstable repository responses/);

    // THROUGH THE PUBLIC MAPPING, NOT THE AppError. `ProblemDetails` has no
    // `details` passthrough and the envelope serialises only selected fields,
    // so an assertion on `caught.details` proves nothing about what a caller
    // receives - which is precisely how the earlier version of this feature
    // passed its tests while shipping an unreachable reason.
    const problem = mapErrorToProblem(caught, "req-download-cap");

    assert.equal(problem.code, ERROR_CODES.REPO_FETCH_FAILED);
    assert.ok(problem.hints, "the terminal error must publish hints at all");
    assert.ok(
      problem.hints.some((hint) => hint.includes("MCP_MAX_DOWNLOAD_BYTES")),
      `the variable that lifts the ceiling must reach the caller; hints were ${JSON.stringify(problem.hints)}`
    );
    assert.equal(
      problem.context?.repoFailureCode,
      ERROR_CODES.LIMIT_EXCEEDED,
      "the machine-readable half: a caller branching on the cause must not have to parse the hint"
    );

    // And the internal record is exactly that - internal. Asserting its absence
    // from the published envelope keeps the next reader from re-adding an
    // assertion on it and re-declaring victory.
    assert.equal(
      (problem as Record<string, unknown>).lastRepoFailure,
      undefined,
      "lastRepoFailure is an internal object; nothing serialises it"
    );
    assert.ok(
      !JSON.stringify(problem).includes("lastRepoFailure"),
      "no part of the published envelope may claim to carry the internal failure record"
    );

    // The internal record still exists for logs, and still describes the leg
    // that actually earned the hint rather than the 503 that followed it.
    const lastRepoFailure = (caught.details as Record<string, unknown> | undefined)
      ?.lastRepoFailure as Record<string, unknown> | undefined;
    assert.ok(lastRepoFailure, "the kept repository failure must survive into the terminal error");
    assert.equal(lastRepoFailure.code, ERROR_CODES.LIMIT_EXCEEDED);
    assert.equal(
      lastRepoFailure.repoUrl,
      sourceUrl,
      "the actionable failure is kept; the later 503 must not overwrite it"
    );
  } finally {
    if (previousMaxDownloadBytes === undefined) {
      delete process.env.MCP_MAX_DOWNLOAD_BYTES;
    } else {
      process.env.MCP_MAX_DOWNLOAD_BYTES = previousMaxDownloadBytes;
    }
  }
});

test("resolveSourceTarget keeps the most recent failure when none of them is actionable", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-download-recency-"));
  const gradleUserHome = join(root, "gradle-home");
  await mkdir(gradleUserHome, { recursive: true });

  // The other half of the retention rule. "First actionable wins" must not
  // become "first wins": with no `nextAction` anywhere in the cascade, the
  // record is still the most recent failure, so the terminal error describes
  // where the search actually gave up.
  const sourceUrl = "https://repo.example.test/com/example/plain/1.0/plain-1.0-sources.jar";
  const binaryUrl = "https://repo.example.test/com/example/plain/1.0/plain-1.0.jar";
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    const url = requestUrlOf(input);
    return new Response("upstream unavailable", { status: url === sourceUrl ? 500 : 503 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });

  const caught = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, async () => {
      try {
        await resolveSourceTarget(
          { kind: "coordinate", value: "com.example:plain:1.0" },
          { allowDecompile: true },
          config
        );
        return undefined;
      } catch (error) {
        return error;
      }
    })
  );

  assert.ok(caught);
  assert.ok(isAppError(caught));
  assert.equal(caught.code, ERROR_CODES.REPO_FETCH_FAILED);

  const lastRepoFailure = (caught.details as Record<string, unknown> | undefined)
    ?.lastRepoFailure as Record<string, unknown> | undefined;
  assert.ok(lastRepoFailure);
  assert.equal(lastRepoFailure.repoUrl, binaryUrl, "the last leg tried is the one reported");
  assert.equal(lastRepoFailure.statusCode, 503);

  // Nothing actionable happened, so nothing is invented: no hint, no cause code.
  const problem = mapErrorToProblem(caught, "req-download-recency");
  assert.equal(problem.hints, undefined);
  assert.equal(problem.context?.repoFailureCode, undefined);
});

test("localM2CoordinateCandidatePaths keeps every candidate under the local repository root", () => {
  // Driven with a hand-built coordinate, deliberately BYPASSING parseCoordinate:
  // the point is that the path builder is safe on its own, not that the input
  // filter in front of it happens to catch these shapes. A groupId of `.`, `..`
  // or `.a` converted the naive way (`replace(/\./g, "/")`) yields `/`, `//` and
  // `/a` - absolute paths, which `path.resolve` honours by throwing the
  // repository root away.
  //
  // `MavenCoordinate` is a structural type with no runtime brand, so being
  // exported makes this a deep-import surface that cannot assume its argument
  // was parsed. Every one of the four segments is therefore driven hostile
  // here, not just the group: the artifactId and version become directory
  // components, and all three of artifactId, version and classifier are
  // concatenated into the file name, so `../` in any of them is an escape.
  const localM2Path = resolvePath("/tmp/mcp-containment-fixture/m2");
  const escapes = ["..", "../..", "../../etc", "a/../..", "/etc", ".", ".a", "a..b", "a/b", "a\\b"];

  const hostileCoordinates: MavenCoordinate[] = [];
  for (const value of escapes) {
    hostileCoordinates.push(
      { groupId: value, artifactId: "art", version: "1.0" },
      { groupId: value, artifactId: "art", version: "1.0", classifier: "client" },
      { groupId: "g", artifactId: value, version: "1.0" },
      { groupId: "g", artifactId: value, version: "1.0", classifier: "client" },
      { groupId: "g", artifactId: "art", version: value },
      { groupId: "g", artifactId: "art", version: value, classifier: "client" },
      { groupId: "g", artifactId: "art", version: "1.0", classifier: value }
    );
  }

  let contained = 0;
  let refused = 0;
  for (const parsed of hostileCoordinates) {
    const label = JSON.stringify(parsed);
    let built: ReturnType<typeof localM2CoordinateCandidatePaths>;
    try {
      built = localM2CoordinateCandidatePaths(localM2Path, parsed);
    } catch (error) {
      // Failing closed is the other acceptable answer: what must never happen
      // is a path outside the root coming BACK, because the caller would then
      // stat and open it.
      assert.equal((error as { code?: string }).code, ERROR_CODES.INVALID_INPUT, label);
      refused += 1;
      continue;
    }

    const produced = [
      ...built.sourceJarPaths,
      built.exactBinaryJarPath,
      ...built.fallbackBinaryJarPaths
    ];
    assert.ok(produced.length >= 3, `every leg must contribute a candidate to check: ${label}`);
    for (const candidate of produced) {
      assert.ok(
        candidate.startsWith(`${localM2Path}${sep}`),
        `${label} escaped the repository root: ${candidate}`
      );
    }
    contained += 1;
  }

  // Both outcomes must actually occur, or this test could pass by never
  // exercising one of the two branches.
  assert.ok(contained > 0, "some hostile shapes must still build contained paths");
  assert.ok(refused > 0, "some hostile shapes must be refused outright");

  // A sibling directory whose name merely starts with the root's is not a
  // child, and the containment check must not be fooled into calling it one.
  assert.throws(
    () =>
      localM2CoordinateCandidatePaths(localM2Path, {
        groupId: "g",
        artifactId: "..",
        version: `..${sep}m2-evil`
      }),
    (error: any) => {
      assert.equal(error.code, ERROR_CODES.INVALID_INPUT);
      return true;
    }
  );

  // The well-formed case is unaffected: it still lands exactly where the ~/.m2
  // layout says it should.
  const ok = localM2CoordinateCandidatePaths(localM2Path, {
    groupId: "net.fabricmc",
    artifactId: "yarn",
    version: "1.14 Pre-Release 1+build.10",
    classifier: "v2"
  });
  assert.equal(
    ok.sourceJarPaths[0],
    resolvePath(
      localM2Path,
      "net/fabricmc/yarn/1.14 Pre-Release 1+build.10",
      "yarn-1.14 Pre-Release 1+build.10-v2-sources.jar"
    )
  );
});

test("resolveSourceTarget(targetKind=coordinate) skips a corrupt ~/.m2 sources jar for the readable Gradle cache one", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-m2-sources-corrupt-"));
  const gradleUserHome = join(root, "gradle-home");

  // ~/.m2 is consulted first. Before the candidate sites were guarded, the throw
  // from opening this file escaped resolveSourceTarget entirely, so the Gradle
  // cache, the remote legs and the decompile branch were never reached.
  const corruptM2SourcesJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "rescued",
    "1.0",
    "rescued-1.0-sources.jar"
  );
  await writeUnreadableJar(corruptM2SourcesJarPath, Buffer.from("this is not a zip archive", "utf8"));

  const gradleSourcesJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "rescued",
    "1.0",
    "rescued-1.0-sources.jar"
  );
  await createJar(gradleSourcesJarPath, {
    "com/example/Rescued.java": ["package com.example;", "public class Rescued {}"].join("\n")
  });

  let remoteFetches = 0;
  const fetchStub: typeof fetch = (async () => {
    remoteFetches += 1;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:rescued:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.isDecompiled, false);
  assert.equal(
    resolved.sourceJarPath,
    gradleSourcesJarPath,
    "a corrupt ~/.m2 sources jar must not veto the Gradle cache candidate behind it"
  );
  assert.equal(remoteFetches, 0, "a good local candidate makes the remote legs unnecessary");
});

test("resolveSourceTarget(targetKind=coordinate) reaches the remote sources leg when both local sources candidates are corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-both-sources-corrupt-"));
  const gradleUserHome = join(root, "gradle-home");

  const corruptM2SourcesJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "twice-broken",
    "1.0",
    "twice-broken-1.0-sources.jar"
  );
  await writeUnreadableJar(corruptM2SourcesJarPath, Buffer.alloc(0));

  const corruptGradleSourcesJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "twice-broken",
    "1.0",
    "twice-broken-1.0-sources.jar"
  );
  await writeUnreadableJar(
    corruptGradleSourcesJarPath,
    Buffer.from("this is not a zip archive either", "utf8")
  );

  const remoteSourcesFixture = join(root, "remote-sources.jar");
  await createJar(remoteSourcesFixture, {
    "com/example/TwiceBroken.java": ["package com.example;", "public class TwiceBroken {}"].join("\n")
  });
  const remoteSourcesBytes = await readFile(remoteSourcesFixture);

  const sourcesUrl = "https://repo.example.test/com/example/twice-broken/1.0/twice-broken-1.0-sources.jar";
  let remoteSourceFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input) === sourcesUrl) {
      remoteSourceFetches += 1;
      return new Response(remoteSourcesBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:twice-broken:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(remoteSourceFetches, 1, "two corrupt local candidates must not abort the cascade");
  assert.equal(resolved.origin, "remote-repo");
  assert.equal(resolved.repoUrl, sourcesUrl);
  assert.equal(resolved.isDecompiled, false);
});

test("resolveSourceTarget(targetKind=jar) propagates an unreadable SUBJECT jar instead of calling it source-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-jar-subject-unreadable-"));
  const subjectJarPath = join(root, "subject.jar");
  const siblingSourcesJarPath = join(root, "subject-sources.jar");

  // The subject jar is the one the caller named. The reader's refusal to open it
  // is the fail-closed verdict itself, so it must NOT be laundered into "this
  // archive has no sources" - which would hand back the perfectly readable
  // sibling below as if the request had been satisfied.
  await writeUnreadableJar(subjectJarPath, Buffer.from("this is not a zip archive", "utf8"));
  await createJar(siblingSourcesJarPath, {
    "com/example/Subject.java": ["package com.example;", "public class Subject {}"].join("\n")
  });

  await assert.rejects(
    () =>
      resolveSourceTarget(
        { kind: "jar", value: subjectJarPath },
        { allowDecompile: true },
        buildTestConfig(root)
      ),
    (error: unknown) => {
      assert.match(String((error as { message?: string }).message), /Failed to read jar/);
      assert.notEqual((error as { code?: string }).code, ERROR_CODES.SOURCE_NOT_FOUND);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// The shape of an accepted binary jar.
//
// ONE rule, and these tests exist to keep it one: a suspicious binary jar is
// DESCRIBED, never refused. A jar with no `.class` entries decompiles to
// nothing, and without the "binary-jar-no-classes" flag the caller has no way
// to tell that from a decompiler failure - so the flag is added and the
// artifact is still returned. Mapping jars (yarn/intermediary v2, carrying
// mappings/mappings.tiny and nothing else), resource-only mod jars, and a jar
// of nothing but directory entries (`jar --create --no-manifest <empty-dir>`
// publishes exactly that) are all this shape and all legitimate.
//
// Refusing any of them costs a caller a real artifact - locally it is skipped,
// and after a download it is discarded from an immutable cache slot - which is
// strictly worse than the empty decompile the flag already explains. The
// "still resolves" tests below exist to break anyone who later turns the flag,
// or any neighbouring shape check, back into a rejection.
//
// The bar for USABLE is unchanged and deliberately low: openable, with at
// least one entry the reader admits.
// ---------------------------------------------------------------------------

/** The `.class` bytes every fixture in this file uses as a stand-in for a class. */
const CLASS_FILE_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

const NO_CLASSES_FLAG = "binary-jar-no-classes";

test("resolveSourceTarget(targetKind=coordinate) flags a remote binary that carries no class entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-binary-no-classes-"));
  const classFreeFixture = join(root, "class-free.jar");
  // A readable, perfectly well-formed jar - it just has nothing to decompile.
  await createJar(classFreeFixture, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    "data/example/recipe.json": "{}"
  });
  const classFreeBytes = await readFile(classFreeFixture);

  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/no-classes-1.0.jar")) {
      return new Response(classFreeBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });
  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:no-classes:1.0" },
        { allowDecompile: true },
        config
      )
    )
  );

  assert.equal(resolved.origin, "decompiled", "a class-free jar is still a resolvable artifact");
  assert.equal(
    resolved.binaryJarPath,
    defaultDownloadPath(config.cacheDir, "https://repo.example.test/com/example/no-classes/1.0/no-classes-1.0.jar")
  );
  assert.deepEqual(
    resolved.qualityFlags,
    [NO_CLASSES_FLAG],
    "an empty decompile must arrive with its reason attached, not as a mystery"
  );
});

test("resolveSourceTarget(targetKind=coordinate) flags a local binary that carries no class entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-no-classes-"));
  const binaryJarPath = join(root, "m2", "com", "example", "local-no-classes", "1.0", "local-no-classes-1.0.jar");
  await createJar(binaryJarPath, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    "assets/example/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47])
  });

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:local-no-classes:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.origin, "local-m2");
  assert.equal(resolved.binaryJarPath, binaryJarPath);
  assert.deepEqual(resolved.qualityFlags, [NO_CLASSES_FLAG]);
});

test("resolveSourceTarget(targetKind=coordinate) leaves an ordinary binary jar unflagged", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-binary-with-classes-"));
  const binaryJarPath = join(root, "m2", "com", "example", "with-classes", "1.0", "with-classes-1.0.jar");
  await createJar(binaryJarPath, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    "com/example/WithClasses.class": CLASS_FILE_MAGIC
  });

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:with-classes:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.binaryJarPath, binaryJarPath);
  assert.deepEqual(
    resolved.qualityFlags ?? [],
    [],
    "a jar with classes has nothing to report, and must not be given a flag to explain"
  );
});

test("resolveSourceTarget(targetKind=coordinate) still resolves a class-free MAPPING jar - yarn and intermediary v2 must never be rejected", async () => {
  // Both artifacts the flag's rationale names, spelled the way a caller
  // actually asks for them: with the ":v2" classifier, which is a different
  // candidate path (`<artifact>-<version>-v2.jar`) from the classifier-less
  // one. Their real shape is a tiny mappings file, a manifest, and not one
  // class. Refusing that shape would break mapping resolution for every Fabric
  // workspace, which is why the check only ever OBSERVES it.
  const mappingArtifacts = [
    {
      label: "intermediary v2",
      coordinate: "net.fabricmc:intermediary:1.21.4:v2",
      segments: ["net", "fabricmc", "intermediary", "1.21.4"],
      fileName: "intermediary-1.21.4-v2.jar",
      namespaces: "official\tintermediary"
    },
    {
      label: "yarn v2",
      coordinate: "net.fabricmc:yarn:1.21.4+build.8:v2",
      segments: ["net", "fabricmc", "yarn", "1.21.4+build.8"],
      fileName: "yarn-1.21.4+build.8-v2.jar",
      namespaces: "intermediary\tnamed"
    }
  ];

  for (const artifact of mappingArtifacts) {
    const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-mapping-jar-"));
    const mappingJarPath = join(root, "m2", ...artifact.segments, artifact.fileName);
    await createJar(mappingJarPath, {
      "META-INF/": "",
      "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
      "mappings/": "",
      "mappings/mappings.tiny": `tiny\t2\t0\t${artifact.namespaces}\n`
    });

    let remoteBinaryFetches = 0;
    const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
      if (requestUrlOf(input).endsWith(`/${artifact.fileName}`)) {
        remoteBinaryFetches += 1;
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const resolved = await withGradleHome(join(root, "gradle-home"), () =>
      withFetch(fetchStub, () =>
        resolveSourceTarget(
          { kind: "coordinate", value: artifact.coordinate },
          { allowDecompile: true },
          buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
        )
      )
    );

    assert.equal(resolved.origin, "local-m2", `${artifact.label} is a legitimate artifact`);
    assert.equal(resolved.binaryJarPath, mappingJarPath, artifact.label);
    assert.equal(
      remoteBinaryFetches,
      0,
      `${artifact.label}: there is nothing to go looking for a replacement of`
    );
    assert.deepEqual(
      resolved.qualityFlags,
      [NO_CLASSES_FLAG],
      `${artifact.label} is described, never refused`
    );
  }
});

test("resolveSourceTarget(targetKind=coordinate) still resolves a class-free RESOURCE-ONLY mod jar - data and asset packs must never be rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-resource-mod-"));
  // A shipped Fabric shape: fabric.mod.json plus assets, no code at all.
  const modJarPath = join(root, "m2", "com", "example", "resource-mod", "1.0", "resource-mod-1.0.jar");
  await createJar(modJarPath, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "resource_mod", version: "1.0" }),
    "assets/": "",
    "assets/resource_mod/lang/en_us.json": "{\"key\": \"value\"}",
    "assets/resource_mod/textures/block/example.png": Buffer.from([0x89, 0x50, 0x4e, 0x47])
  });

  let remoteBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/resource-mod-1.0.jar")) {
      remoteBinaryFetches += 1;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:resource-mod:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.origin, "local-m2", "a resource-only mod jar is a legitimate artifact");
  assert.equal(resolved.binaryJarPath, modJarPath);
  assert.equal(remoteBinaryFetches, 0);
  assert.deepEqual(resolved.qualityFlags, [NO_CLASSES_FLAG], "it is described, never refused");
});

test("resolveSourceTarget(targetKind=coordinate) accepts a LOCAL jar of nothing but directory entries and flags it", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-local-dirs-only-"));
  const gradleUserHome = join(root, "gradle-home");
  const dirsOnlyJarPath = gradleCacheJarPath(
    gradleUserHome,
    "com.example",
    "dirs-only",
    "1.0",
    "dirs-only-1.0.jar"
  );
  // `jar --create --no-manifest <empty-directory>` publishes exactly this, and
  // so does a jar carrying only META-INF/. Refusing it would skip a real local
  // artifact and send the caller to the network for a replacement that may not
  // exist - the flag says everything a refusal would have said, and costs
  // nobody their artifact.
  await createJar(dirsOnlyJarPath, {
    "META-INF/": "",
    "com/": "",
    "com/example/": ""
  });

  const remoteBinaryFixture = join(root, "remote-binary.jar");
  await createJar(remoteBinaryFixture, {
    "com/example/DirsOnly.class": CLASS_FILE_MAGIC
  });
  const remoteBinaryBytes = await readFile(remoteBinaryFixture);

  let remoteBinaryFetches = 0;
  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    if (requestUrlOf(input).endsWith("/dirs-only-1.0.jar")) {
      remoteBinaryFetches += 1;
      return new Response(remoteBinaryBytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });
  const resolved = await withGradleHome(gradleUserHome, () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:dirs-only:1.0" },
        { allowDecompile: true },
        config
      )
    )
  );

  assert.equal(resolved.binaryJarPath, dirsOnlyJarPath, "the local jar is the resolved artifact");
  assert.equal(resolved.origin, "local-m2");
  assert.equal(
    remoteBinaryFetches,
    0,
    "an accepted local jar suppresses the remote binary fetch, as it always has"
  );
  assert.deepEqual(
    resolved.qualityFlags,
    [NO_CLASSES_FLAG],
    "a directory-only jar has no classes, and the flag alone is the whole answer"
  );
});

test("resolveSourceTarget(targetKind=coordinate) accepts a DOWNLOADED binary of nothing but directory entries and flags it", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-remote-dirs-only-"));
  const coordinate = "com.example:remote-dirs-only:2.0.0";
  const binaryPath = "/com/example/remote-dirs-only/2.0.0/remote-dirs-only-2.0.0.jar";
  const binaryUrlA = `${REPO_A}${binaryPath}`;
  const binaryUrlB = `${REPO_B}${binaryPath}`;

  const dirsOnlyFixture = join(root, "dirs-only.jar");
  await createJar(dirsOnlyFixture, { "com/": "", "com/example/": "" });
  const dirsOnlyBytes = await readFile(dirsOnlyFixture);

  const realFixture = join(root, "real-binary.jar");
  await createJar(realFixture, { "com/example/RemoteDirsOnly.class": CLASS_FILE_MAGIC });
  const realJarBytes = await readFile(realFixture);

  const fetchStub: typeof fetch = (async (input: string | URL | Request) => {
    const url = requestUrlOf(input);
    if (url === binaryUrlA) {
      return new Response(dirsOnlyBytes, { status: 200 });
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

  // The download leg is where a refusal costs the most: the body is deleted
  // from an immutable cache slot and the repository behind it is blamed. A
  // publisher's placeholder jar must not trigger any of that.
  assert.equal(resolved.repoUrl, binaryUrlA, "the first repository's body is accepted");
  assert.equal(resolved.binaryJarPath, defaultDownloadPath(config.cacheDir, binaryUrlA));
  assert.equal(
    existsSync(defaultDownloadPath(config.cacheDir, binaryUrlA)),
    true,
    "and it stays in the cache instead of being discarded as poison"
  );
  assert.deepEqual(
    failovers.filter((event) => event.stage === "binary").map((event) => event.repoUrl),
    [],
    "no repository is failed over, and none is blamed"
  );
  assert.deepEqual(resolved.qualityFlags, [NO_CLASSES_FLAG]);
});

test("resolveSourceTarget(targetKind=coordinate) treats a ZERO-LENGTH entry as a file, never as a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-zero-length-"));
  // Size is not a directory signal. A zero-length `.class` entry is still a
  // class the decompiler will be handed, and a zero-length marker file
  // (META-INF/services entries, `.keep` files) is still a file - so an
  // implementation that read "empty" as "directory" would report this jar as
  // having nothing in it to decompile, which is a lie about a jar that has a
  // class in it.
  const binaryJarPath = join(root, "m2", "com", "example", "zero-length", "1.0", "zero-length-1.0.jar");
  await createJar(binaryJarPath, {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    "META-INF/services/com.example.Provider": "",
    "com/example/ZeroLength.class": ""
  });

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  const resolved = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:zero-length:1.0" },
        { allowDecompile: true },
        buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
      )
    )
  );

  assert.equal(resolved.binaryJarPath, binaryJarPath);
  assert.deepEqual(
    resolved.qualityFlags ?? [],
    [],
    "a zero-length .class entry is a class, so there is nothing to explain"
  );
});

test("resolveSourceTarget(targetKind=coordinate) reads a directory record stored WITHOUT a trailing slash as a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-coordinate-slashless-dir-"));
  // The trailing slash is the only directory signal available at this layer -
  // the reader exposes a name and a size, not the external attributes some zip
  // writers use instead - so a directory record written without one is
  // indistinguishable from a file and is read as one. That is the fail-open
  // direction on both sides of the question, and both sides are pinned here:
  // such a record can never make a jar unusable, and a `.class`-named one is
  // counted as a class rather than silently discounted.
  const dirsOnlyJarPath = join(root, "m2", "com", "example", "slashless", "1.0", "slashless-1.0.jar");
  await createJar(dirsOnlyJarPath, {
    "META-INF": "",
    "com": "",
    "com/example": ""
  });
  const classRecordJarPath = join(root, "m2", "com", "example", "slashless-class", "1.0", "slashless-class-1.0.jar");
  await createJar(classRecordJarPath, {
    "META-INF": "",
    "com/example/Slashless.class": ""
  });

  const fetchStub: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  const config = buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] });

  const dirsOnly = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:slashless:1.0" },
        { allowDecompile: true },
        config
      )
    )
  );
  assert.equal(dirsOnly.binaryJarPath, dirsOnlyJarPath, "slashless records keep the jar usable");
  assert.deepEqual(dirsOnly.qualityFlags, [NO_CLASSES_FLAG]);

  const classRecord = await withGradleHome(join(root, "gradle-home"), () =>
    withFetch(fetchStub, () =>
      resolveSourceTarget(
        { kind: "coordinate", value: "com.example:slashless-class:1.0" },
        { allowDecompile: true },
        config
      )
    )
  );
  assert.equal(classRecord.binaryJarPath, classRecordJarPath);
  assert.deepEqual(
    classRecord.qualityFlags ?? [],
    [],
    "only the trailing slash decides, so a slashless .class record counts as a class"
  );
});

test("resolveSourceTarget(targetKind=jar) flags a caller-named jar that carries no class entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "resolver-jar-no-classes-"));
  // The decompile branch for a jar the caller NAMED - the same branch
  // target.kind="version" is rewritten into. It returned any source-free
  // readable zip without ever looking for class content, so the one target
  // shape a caller is most likely to name directly was the one shape that
  // never got the flag.
  const classFreeJarPath = join(root, "resource-only.jar");
  await createJar(classFreeJarPath, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "resource_only", version: "1.0" }),
    "assets/resource_only/lang/en_us.json": "{}"
  });

  const resolved = await resolveSourceTarget(
    { kind: "jar", value: classFreeJarPath },
    { allowDecompile: true },
    buildTestConfig(root)
  );

  assert.equal(resolved.origin, "decompiled");
  assert.equal(resolved.binaryJarPath, classFreeJarPath);
  assert.deepEqual(
    resolved.qualityFlags,
    [NO_CLASSES_FLAG],
    "an empty decompile of a named jar must arrive with its reason attached too"
  );

  const withClassesJarPath = join(root, "with-classes.jar");
  await createJar(withClassesJarPath, {
    "com/example/Named.class": CLASS_FILE_MAGIC
  });
  const withClasses = await resolveSourceTarget(
    { kind: "jar", value: withClassesJarPath },
    { allowDecompile: true },
    buildTestConfig(root)
  );
  assert.equal(withClasses.origin, "decompiled");
  assert.deepEqual(
    withClasses.qualityFlags ?? [],
    [],
    "and an ordinary jar on the same branch is still handed back unannotated"
  );
});
