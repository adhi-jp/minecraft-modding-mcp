import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
