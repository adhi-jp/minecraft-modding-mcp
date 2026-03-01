import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024
  };
}

test("getArtifactFile applies maxBytes truncation", async () => {
  const { SourceService } = await import("../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "snippet-main-"));
  const binaryJarPath = join(root, "snippet.jar");
  const sourcesJarPath = join(root, "snippet-sources.jar");

  await createJar(binaryJarPath, {
    "a/Snippet.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "a/Snippet.java": "line1\nline2\nline3"
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath }
  });

  const file = await service.getArtifactFile({
    artifactId: resolved.artifactId,
    filePath: "a/Snippet.java",
    maxBytes: 8
  });

  assert.equal(file.filePath, "a/Snippet.java");
  assert.equal(file.truncated, true);
  assert.equal(file.contentBytes, Buffer.byteLength("line1\nline2\nline3", "utf8"));
  assert.equal(Buffer.byteLength(file.content, "utf8"), 8);
});
