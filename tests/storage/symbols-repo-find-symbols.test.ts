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

function seedTickSymbols(repos: TestRepos, artifactId: string): void {
  seedFiles(repos, artifactId, ["a/A.java", "a/B.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tick", qualifiedName: "a.A.tick", line: 2 },
    { filePath: "a/B.java", symbolKind: "method", symbolName: "tick", qualifiedName: "a.B.tick", line: 3 }
  ]);
}

test("findSymbols ignores an undecodable cursor and serves the first page", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-bad-cursor";
  seedArtifact(repos.artifacts, artifactId);
  seedTickSymbols(repos, artifactId);

  const baseline = repos.symbols.findSymbols({
    artifactId,
    symbolNamePrefix: "tick",
    exact: false,
    limit: 10
  });
  assert.equal(baseline.items.length, 2);
  assert.deepEqual(
    baseline.items.map((row) => row.filePath),
    ["a/A.java", "a/B.java"]
  );
  assert.equal(baseline.nextCursor, undefined);

  const badCursors = [
    "%%%not-base64-json%%%",
    Buffer.from("this is not json", "utf8").toString("base64")
  ];
  for (const cursor of badCursors) {
    const result = repos.symbols.findSymbols({
      artifactId,
      symbolNamePrefix: "tick",
      exact: false,
      limit: 10,
      cursor
    });
    assert.deepEqual(result, baseline, `cursor ${cursor}`);
  }
});

test("findSymbols ignores a base64 cursor whose payload has wrong field types", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-typed-cursor";
  seedArtifact(repos.artifacts, artifactId);
  seedTickSymbols(repos, artifactId);

  const cursor = Buffer.from(
    JSON.stringify({ symbolName: 1, filePath: true, line: "x" }),
    "utf8"
  ).toString("base64");

  const result = repos.symbols.findSymbols({
    artifactId,
    symbolNamePrefix: "tick",
    exact: false,
    limit: 10,
    cursor
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((row) => row.filePath),
    ["a/A.java", "a/B.java"]
  );
  assert.equal(result.nextCursor, undefined);
});

test("findSymbols with exact match returns only symbols whose name equals the query", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-exact-match";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "a/B.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tick", qualifiedName: "a.A.tick", line: 2 },
    { filePath: "a/B.java", symbolKind: "method", symbolName: "tickUpdate", qualifiedName: "a.B.tickUpdate", line: 2 }
  ]);

  const exact = repos.symbols.findSymbols({ artifactId, symbolNamePrefix: "tick", exact: true, limit: 10 });
  assert.deepEqual(
    exact.items.map((row) => row.symbolName),
    ["tick"]
  );

  const prefix = repos.symbols.findSymbols({ artifactId, symbolNamePrefix: "tick", exact: false, limit: 10 });
  assert.deepEqual(
    prefix.items.map((row) => row.symbolName),
    ["tick", "tickUpdate"]
  );
});

test("findSymbols exact-match pagination visits each duplicate-name row exactly once", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-exact-paging";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "a/B.java", "a/C.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "Dup", qualifiedName: "a.A.Dup", line: 10 },
    { filePath: "a/B.java", symbolKind: "method", symbolName: "Dup", qualifiedName: "a.B.Dup", line: 11 },
    { filePath: "a/C.java", symbolKind: "method", symbolName: "Dup", qualifiedName: "a.C.Dup", line: 12 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "DupOther", qualifiedName: "a.A.DupOther", line: 20 }
  ]);

  const collected: string[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < 5; i += 1) {
    const page = repos.symbols.findSymbols({
      artifactId,
      symbolNamePrefix: "Dup",
      exact: true,
      limit: 1,
      cursor
    });
    if (page.items.length === 0) break;
    for (const row of page.items) {
      collected.push(`${row.symbolName}:${row.filePath}:${row.line}`);
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }

  assert.deepEqual(collected, ["Dup:a/A.java:10", "Dup:a/B.java:11", "Dup:a/C.java:12"]);
  assert.equal(new Set(collected).size, 3, "no duplicates across pages");
  assert.equal(cursor, undefined, "final page carries no cursor");
});

test("findSymbols returns an empty page without a next cursor when limit is 0", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-limit-zero";
  seedArtifact(repos.artifacts, artifactId);
  seedTickSymbols(repos, artifactId);

  const result = repos.symbols.findSymbols({
    artifactId,
    symbolNamePrefix: "tick",
    exact: false,
    limit: 0
  });

  assert.deepEqual(result.items, []);
  assert.equal(result.nextCursor, undefined);
});

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

  const rows = repos.symbols.listSymbolsForArtifact(artifactId);
  assert.deepEqual(
    rows.map((row) => row.symbolName),
    ["newSym"]
  );
});

test("repeated dynamic queries reuse a single cached prepared statement", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-stmt-reuse";
  seedArtifact(repos.artifacts, artifactId);

  const first = repos.symbols.listSymbolsForFiles(artifactId, ["a/A.java"]);
  const second = repos.symbols.listSymbolsForFiles(artifactId, ["a/A.java"]);
  assert.equal(first.size, 0);
  assert.equal(second.size, 0);

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

  const pathsOfLength = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `pkg/F${index}.java`);

  // 64 distinct placeholder counts -> 64 distinct SQL shapes fill the cache.
  for (let pathCount = 1; pathCount <= 64; pathCount += 1) {
    repos.symbols.listSymbolsForFiles(artifactId, pathsOfLength(pathCount));
  }
  const cache = (repos.symbols as unknown as { dynamicStmtCache: Map<string, unknown> }).dynamicStmtCache;
  assert.equal(cache.size, 64);

  // Re-touch the 1-placeholder shape so it is no longer the eviction candidate.
  repos.symbols.listSymbolsForFiles(artifactId, pathsOfLength(1));
  assert.equal(cache.size, 64);

  // A 65th shape evicts the least recently used entry: the 2-placeholder shape.
  repos.symbols.listSymbolsForFiles(artifactId, pathsOfLength(65));
  const keys = [...cache.keys()];
  assert.equal(cache.size, 64);
  assert.ok(keys.some((sql) => sql.includes("IN (?)")), "re-touched 1-placeholder shape survives");
  assert.ok(!keys.some((sql) => sql.includes("IN (?, ?)")), "2-placeholder shape was evicted");

  // The evicted shape is transparently re-prepared and still returns correct rows.
  const reprepared = repos.symbols.listSymbolsForFiles(artifactId, ["a/A.java", "zz/None.java"]);
  assert.deepEqual([...reprepared.keys()], ["a/A.java"]);
  assert.deepEqual(
    reprepared.get("a/A.java")?.map((row) => row.symbolName),
    ["run"]
  );
});

test("findSymbols without a name prefix returns every symbol and maps a missing qualified name to undefined", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-no-prefix";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tick", qualifiedName: "a.A.tick", line: 2 },
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: undefined, line: 1 }
  ]);

  const result = repos.symbols.findSymbols({ artifactId, exact: false, limit: 10 });

  assert.deepEqual(
    result.items.map((row) => [row.symbolName, row.qualifiedName]),
    [
      ["A", undefined],
      ["tick", "a.A.tick"]
    ]
  );
  assert.equal(result.nextCursor, undefined);
});
