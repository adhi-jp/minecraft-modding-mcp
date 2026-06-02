import assert from "node:assert/strict";
import test from "node:test";

import Database from "../src/storage/sqlite.ts";

async function createRepos() {
  const { ArtifactsRepo } = await import("../src/storage/artifacts-repo.ts");
  const { FilesRepo } = await import("../src/storage/files-repo.ts");
  const { runMigrations } = await import("../src/storage/migrations.ts");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return {
    artifacts: new ArtifactsRepo(db),
    files: new FilesRepo(db)
  };
}

function seedArtifact(artifacts: { upsertArtifact: (...args: unknown[]) => void }, artifactId: string): void {
  artifacts.upsertArtifact({
    artifactId,
    origin: "local-jar",
    artifactSignature: "sig",
    isDecompiled: false,
    timestamp: new Date().toISOString()
  });
}

const CORPUS: Array<{ filePath: string; content: string }> = [
  { filePath: "a/Percent.java", content: "progress is 100% complete" },
  { filePath: "a/Underscore.java", content: "identifier a_b_c lives here" },
  { filePath: "a/Upper.java", content: "TICK loudly" },
  { filePath: "a/Lower.java", content: "tick quietly" },
  { filePath: "a/None.java", content: "nothing relevant at all" }
];

function jsContainsMatches(needle: string): Set<string> {
  const lowered = needle.toLocaleLowerCase();
  return new Set(
    CORPUS.filter((file) => file.content.toLocaleLowerCase().includes(lowered)).map((f) => f.filePath)
  );
}

test("filesRepo.searchContentLikeCandidatePaths returns an ASCII case-insensitive superset of JS contains", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-like-prefilter";
  seedArtifact(artifacts, artifactId);
  files.replaceFilesForArtifact(
    artifactId,
    CORPUS.map((file, index) => ({
      filePath: file.filePath,
      content: file.content,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      contentHash: `h${index}`
    }))
  );

  const repo = files as unknown as {
    searchContentLikeCandidatePaths: (
      artifactId: string,
      needle: string,
      limit: number
    ) => { filePaths: string[]; scannedRows: number };
  };

  for (const needle of ["tick", "TICK", "100%", "a_b"]) {
    const result = repo.searchContentLikeCandidatePaths(artifactId, needle, 500);

    // Shape: only filePaths + scannedRows, never content.
    assert.ok(Array.isArray(result.filePaths), `filePaths array for "${needle}"`);
    assert.equal(typeof result.scannedRows, "number");
    assert.equal((result as Record<string, unknown>).content, undefined);

    // The candidate set must be a SUPERSET of the JS case-insensitive contains set
    // (the JS post-verify in search.ts then removes any over-included extras).
    const candidates = new Set(result.filePaths);
    for (const expected of jsContainsMatches(needle)) {
      assert.ok(candidates.has(expected), `"${needle}" candidates must include ${expected}`);
    }
  }
});

test("filesRepo.searchContentLikeCandidatePaths matches both cases of an ASCII needle", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-like-prefilter-case";
  seedArtifact(artifacts, artifactId);
  files.replaceFilesForArtifact(
    artifactId,
    CORPUS.map((file, index) => ({
      filePath: file.filePath,
      content: file.content,
      contentBytes: Buffer.byteLength(file.content, "utf8"),
      contentHash: `h${index}`
    }))
  );

  const repo = files as unknown as {
    searchContentLikeCandidatePaths: (
      artifactId: string,
      needle: string,
      limit: number
    ) => { filePaths: string[]; scannedRows: number };
  };

  // SQLite default LIKE is ASCII-case-insensitive, so "tick" must surface BOTH
  // the "TICK" and "tick" files — this is why the slow JS scan can be skipped.
  const result = repo.searchContentLikeCandidatePaths(artifactId, "tick", 500);
  const candidates = new Set(result.filePaths);
  assert.ok(candidates.has("a/Upper.java"));
  assert.ok(candidates.has("a/Lower.java"));
});
