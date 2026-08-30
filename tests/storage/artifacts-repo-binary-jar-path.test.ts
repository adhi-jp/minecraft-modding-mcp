import assert from "node:assert/strict";
import test from "node:test";

import { createRepos } from "../helpers/repos.ts";

const TIMESTAMP = "2026-08-30T00:00:00.000Z";

test("ArtifactsRepo.updateBinaryJarPath backfills a NULL binary_jar_path on a sources-only row", async () => {
  const { artifacts } = await createRepos();
  artifacts.upsertArtifact({
    artifactId: "sources-only",
    origin: "local-m2",
    coordinate: "com.example:demo:1.0.0",
    sourceJarPath: "/m2/com/example/demo/1.0.0/demo-1.0.0-sources.jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });
  assert.equal(artifacts.getArtifact("sources-only")?.binaryJarPath, undefined);

  artifacts.updateBinaryJarPath("sources-only", "/m2/com/example/demo/1.0.0/demo-1.0.0.jar");

  assert.equal(
    artifacts.getArtifact("sources-only")?.binaryJarPath,
    "/m2/com/example/demo/1.0.0/demo-1.0.0.jar"
  );
});

test("ArtifactsRepo.updateBinaryJarPath is idempotent and repoints an existing path", async () => {
  const { artifacts } = await createRepos();
  artifacts.upsertArtifact({
    artifactId: "repoint",
    origin: "local-jar",
    binaryJarPath: "/cache/downloads/client.jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  // calling with the same path is a no-op
  artifacts.updateBinaryJarPath("repoint", "/cache/downloads/client.jar");
  assert.equal(artifacts.getArtifact("repoint")?.binaryJarPath, "/cache/downloads/client.jar");

  // a different path wins: the row must name the jar a binary consumer should
  // open right now, which is the remapped jar once a remap has happened.
  artifacts.updateBinaryJarPath("repoint", "/cache/remapped/repoint.jar");
  assert.equal(artifacts.getArtifact("repoint")?.binaryJarPath, "/cache/remapped/repoint.jar");
});

test("ArtifactsRepo.updateBinaryJarPath leaves updated_at to touchArtifact", async () => {
  const { artifacts } = await createRepos();
  artifacts.upsertArtifact({
    artifactId: "lru-untouched",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  artifacts.updateBinaryJarPath("lru-untouched", "/cache/downloads/client.jar");

  // LRU ordering is owned by touchArtifact; this setter must not bump it on its
  // own, or a warm resolve would write updated_at twice for one cache hit.
  assert.equal(artifacts.getArtifact("lru-untouched")?.updatedAt, TIMESTAMP);
});

test("ArtifactsRepo.updateBinaryJarPath ignores an unknown artifactId", async () => {
  const { artifacts } = await createRepos();
  artifacts.updateBinaryJarPath("no-such-artifact", "/cache/downloads/client.jar");
  assert.equal(artifacts.getArtifact("no-such-artifact"), undefined);
});

test("ArtifactsRepo.updateBinaryJarPath touches only the named row", async () => {
  const { artifacts } = await createRepos();
  artifacts.upsertArtifact({
    artifactId: "target-row",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });
  artifacts.upsertArtifact({
    artifactId: "bystander-row",
    origin: "local-jar",
    binaryJarPath: "/cache/downloads/bystander.jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  artifacts.updateBinaryJarPath("target-row", "/cache/downloads/target.jar");

  assert.equal(artifacts.getArtifact("target-row")?.binaryJarPath, "/cache/downloads/target.jar");
  assert.equal(
    artifacts.getArtifact("bystander-row")?.binaryJarPath,
    "/cache/downloads/bystander.jar"
  );
});
