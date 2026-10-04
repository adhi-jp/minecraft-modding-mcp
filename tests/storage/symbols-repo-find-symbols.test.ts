import assert from "node:assert/strict";
import test from "node:test";

import { createRepos, seedArtifact } from "../helpers/repos.ts";

import type { TestRepos } from "../helpers/repos.ts";

function seedFiles(repos: TestRepos, artifactId: string, filePaths: string[]): void {
  repos.files.replaceFilesForArtifact(
    artifactId,
    filePaths.map((filePath) => ({
      filePath,
      content: `// ${filePath}`,
      contentBytes: 10,
      contentHash: `hash-${filePath}`
    }))
  );
}

test("replaceSymbolsForArtifact discards the previously indexed symbols for the artifact", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-replace";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "oldSym", qualifiedName: "a.A.oldSym", line: 1 }
  ]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "newSym", qualifiedName: "a.A.newSym", line: 2 }
  ]);

  const rows = [...repos.symbols.iterateSymbolsForArtifact(artifactId)];
  assert.deepEqual(
    rows.map((row) => row.symbolName),
    ["newSym"]
  );
});

test("repeated dynamic queries reuse a single cached prepared statement", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-stmt-reuse";
  seedArtifact(repos.artifacts, artifactId);

  const first = repos.symbols.findScopedSymbols({ artifactId, query: "run", match: "exact", symbolKinds: ["method"] });
  const second = repos.symbols.findScopedSymbols({ artifactId, query: "run", match: "exact", symbolKinds: ["method"] });
  assert.deepEqual(first.items, []);
  assert.deepEqual(second.items, []);

  const cache = (repos.symbols as unknown as { dynamicStmtCache: Map<string, unknown> }).dynamicStmtCache;
  assert.equal(cache.size, 1);
});

test("dynamic statement cache caps at 64 SQL shapes and evicts the least recently used one", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-stmt-lru";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "run", qualifiedName: "a.A.run", line: 4 }
  ]);

  const kindsOfLength = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `kind${index}`);
  const findWithKinds = (symbolKinds: string[]) =>
    repos.symbols.findScopedSymbols({ artifactId, query: "run", match: "exact", symbolKinds });

  // 64 distinct placeholder counts -> 64 distinct SQL shapes fill the cache.
  for (let kindCount = 1; kindCount <= 64; kindCount += 1) {
    findWithKinds(kindsOfLength(kindCount));
  }
  const cache = (repos.symbols as unknown as { dynamicStmtCache: Map<string, unknown> }).dynamicStmtCache;
  assert.equal(cache.size, 64);

  // Re-touch the 1-placeholder shape so it is no longer the eviction candidate.
  findWithKinds(kindsOfLength(1));
  assert.equal(cache.size, 64);

  // A 65th shape evicts the least recently used entry: the 2-placeholder shape.
  findWithKinds(kindsOfLength(65));
  const keys = [...cache.keys()];
  assert.equal(cache.size, 64);
  assert.ok(keys.some((sql) => sql.includes("IN (?)")), "re-touched 1-placeholder shape survives");
  assert.ok(!keys.some((sql) => sql.includes("IN (?, ?)")), "2-placeholder shape was evicted");

  // The evicted shape is transparently re-prepared and still returns correct rows.
  const reprepared = findWithKinds(["method", "zz-none"]);
  assert.deepEqual(
    reprepared.items.map((row) => `${row.filePath}:${row.symbolName}`),
    ["a/A.java:run"]
  );
});
