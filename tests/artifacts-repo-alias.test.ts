import assert from "node:assert/strict";
import test from "node:test";
import Database from "../src/storage/sqlite.ts";

async function createArtifactsRepo() {
  const { ArtifactsRepo } = await import("../src/storage/artifacts-repo.ts");
  const { runMigrations } = await import("../src/storage/migrations.ts");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return { db, artifacts: new ArtifactsRepo(db) };
}

const TIMESTAMP = "2026-04-18T00:00:00.000Z";

test("ArtifactsRepo round-trips alias and exposes it via getArtifact()", async () => {
  const { artifacts } = await createArtifactsRepo();
  artifacts.upsertArtifact({
    artifactId: "art-1",
    alias: "mc-1.21.10-mojang-merged-abc123",
    origin: "local-jar",
    version: "1.21.10",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  const byId = artifacts.getArtifact("art-1");
  assert.equal(byId?.alias, "mc-1.21.10-mojang-merged-abc123");
  assert.equal(byId?.artifactId, "art-1");
});

test("ArtifactsRepo.getArtifact resolves an artifact by its alias", async () => {
  const { artifacts } = await createArtifactsRepo();
  artifacts.upsertArtifact({
    artifactId: "art-2",
    alias: "mc-1.21.10-obfuscated-vanilla-abc123",
    origin: "local-jar",
    version: "1.21.10",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  const byAlias = artifacts.getArtifact("mc-1.21.10-obfuscated-vanilla-abc123");
  assert.equal(byAlias?.artifactId, "art-2");
  assert.equal(byAlias?.alias, "mc-1.21.10-obfuscated-vanilla-abc123");
});

test("ArtifactsRepo.getArtifact returns undefined for unknown id and unknown alias", async () => {
  const { artifacts } = await createArtifactsRepo();
  assert.equal(artifacts.getArtifact("missing-id"), undefined);
  assert.equal(artifacts.getArtifact("mc-no-such-alias-000000"), undefined);
});

test("ArtifactsRepo enforces alias UNIQUE across distinct artifact_ids", async () => {
  const { artifacts } = await createArtifactsRepo();
  artifacts.upsertArtifact({
    artifactId: "art-a",
    alias: "mc-1.21.10-mojang-merged-deadbe",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  assert.throws(
    () =>
      artifacts.upsertArtifact({
        artifactId: "art-b",
        alias: "mc-1.21.10-mojang-merged-deadbe",
        origin: "local-jar",
        isDecompiled: false,
        timestamp: TIMESTAMP
      }),
    /UNIQUE/i
  );
});

test("ArtifactsRepo allows multiple null aliases (legacy rows tolerated)", async () => {
  const { artifacts } = await createArtifactsRepo();
  artifacts.upsertArtifact({
    artifactId: "legacy-1",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });
  artifacts.upsertArtifact({
    artifactId: "legacy-2",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  assert.equal(artifacts.getArtifact("legacy-1")?.alias, undefined);
  assert.equal(artifacts.getArtifact("legacy-2")?.alias, undefined);
});

test("ArtifactsRepo.setAlias backfills a NULL alias on a legacy row", async () => {
  const { artifacts } = await createArtifactsRepo();
  artifacts.upsertArtifact({
    artifactId: "legacy-backfill",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });
  assert.equal(artifacts.getArtifact("legacy-backfill")?.alias, undefined);

  artifacts.setAlias("legacy-backfill", "mc-1.21.10-mojang-merged-deadbeefcafe");

  assert.equal(
    artifacts.getArtifact("mc-1.21.10-mojang-merged-deadbeefcafe")?.artifactId,
    "legacy-backfill"
  );
  assert.equal(
    artifacts.getArtifact("legacy-backfill")?.alias,
    "mc-1.21.10-mojang-merged-deadbeefcafe"
  );
});

test("ArtifactsRepo.setAlias is idempotent and rotates an existing alias", async () => {
  const { artifacts } = await createArtifactsRepo();
  artifacts.upsertArtifact({
    artifactId: "rotate-via-setalias",
    alias: "mc-1.21.10-mojang-merged-aaaaaaaaaaaa",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  // calling with the same alias is a no-op
  artifacts.setAlias("rotate-via-setalias", "mc-1.21.10-mojang-merged-aaaaaaaaaaaa");
  assert.equal(
    artifacts.getArtifact("rotate-via-setalias")?.alias,
    "mc-1.21.10-mojang-merged-aaaaaaaaaaaa"
  );

  artifacts.setAlias("rotate-via-setalias", "mc-1.21.10-mojang-merged-bbbbbbbbbbbb");
  assert.equal(
    artifacts.getArtifact("rotate-via-setalias")?.alias,
    "mc-1.21.10-mojang-merged-bbbbbbbbbbbb"
  );
  assert.equal(
    artifacts.getArtifact("mc-1.21.10-mojang-merged-aaaaaaaaaaaa"),
    undefined
  );
});

test("ArtifactsRepo.upsertArtifact updates alias on conflict for same artifact_id", async () => {
  const { artifacts } = await createArtifactsRepo();
  artifacts.upsertArtifact({
    artifactId: "art-rotate",
    alias: "mc-1.21.10-mojang-merged-aaaaaa",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });
  artifacts.upsertArtifact({
    artifactId: "art-rotate",
    alias: "mc-1.21.10-mojang-merged-bbbbbb",
    origin: "local-jar",
    isDecompiled: false,
    timestamp: TIMESTAMP
  });

  assert.equal(
    artifacts.getArtifact("art-rotate")?.alias,
    "mc-1.21.10-mojang-merged-bbbbbb"
  );
  assert.equal(
    artifacts.getArtifact("mc-1.21.10-mojang-merged-bbbbbb")?.artifactId,
    "art-rotate"
  );
  // The previous alias must no longer resolve to anything.
  assert.equal(artifacts.getArtifact("mc-1.21.10-mojang-merged-aaaaaa"), undefined);
});
