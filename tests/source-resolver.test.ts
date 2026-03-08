import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveSourceTarget } from "../src/source-resolver.ts";
import type { Config } from "../src/types.ts";
import { createJar } from "./helpers/zip.ts";

function buildTestConfig(root: string): Config {
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
    fetchTimeoutMs: 1_000,
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
    maxNbtResponseBytes: 8 * 1024 * 1024
  };
}

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
