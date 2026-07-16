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

test("listSymbolsForArtifact returns every symbol ordered by name, file path, then line", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-list-all";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["b/B.java", "a/A.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "a.A.zeta", line: 5 },
    { filePath: "b/B.java", symbolKind: "class", symbolName: "Alpha", qualifiedName: undefined, line: 1 },
    { filePath: "b/B.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "b.B.zeta", line: 3 }
  ]);

  const rows = repos.symbols.listSymbolsForArtifact(artifactId);

  assert.deepEqual(rows, [
    { artifactId, filePath: "b/B.java", symbolKind: "class", symbolName: "Alpha", qualifiedName: undefined, line: 1 },
    { artifactId, filePath: "a/A.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "a.A.zeta", line: 5 },
    { artifactId, filePath: "b/B.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "b.B.zeta", line: 3 }
  ]);
});

test("listSymbolsForArtifact with a kind filter returns only symbols of that kind", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-list-kind";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "b/B.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "a.A.zeta", line: 5 },
    { filePath: "b/B.java", symbolKind: "class", symbolName: "Alpha", qualifiedName: undefined, line: 1 },
    { filePath: "b/B.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "b.B.zeta", line: 3 }
  ]);

  const classes = repos.symbols.listSymbolsForArtifact(artifactId, "class");
  assert.equal(classes.length, 1);
  assert.equal(classes[0].symbolKind, "class");
  assert.equal(classes[0].symbolName, "Alpha");

  const methods = repos.symbols.listSymbolsForArtifact(artifactId, "method");
  assert.equal(methods.length, 2);
  assert.ok(methods.every((row) => row.symbolKind === "method" && row.symbolName === "zeta"));
});

test("iterateSymbolsForArtifact yields ordered rows lazily and closing early keeps the connection usable", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-iterate";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "b/B.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "a.A.zeta", line: 5 },
    { filePath: "b/B.java", symbolKind: "class", symbolName: "Alpha", qualifiedName: undefined, line: 1 },
    { filePath: "b/B.java", symbolKind: "method", symbolName: "zeta", qualifiedName: "b.B.zeta", line: 3 }
  ]);

  const iterator = repos.symbols.iterateSymbolsForArtifact(artifactId);
  const first = iterator.next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value, {
    artifactId,
    filePath: "b/B.java",
    symbolKind: "class",
    symbolName: "Alpha",
    qualifiedName: undefined,
    line: 1
  });

  // Release the underlying statement before touching the connection again.
  iterator.return?.(undefined);

  const followUp = repos.symbols.listSymbolsForFile(artifactId, "a/A.java");
  assert.equal(followUp.length, 1);
  assert.equal(followUp[0].symbolName, "zeta");
});

test("listSymbolsForFile returns only that file's symbols ordered by line then name", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-file-lookup";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "a/B.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "beta", qualifiedName: "a.A.beta", line: 5 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "alpha", qualifiedName: "a.A.alpha", line: 5 },
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: "a.A", line: 1 },
    { filePath: "a/B.java", symbolKind: "method", symbolName: "gamma", qualifiedName: "a.B.gamma", line: 2 }
  ]);

  const rows = repos.symbols.listSymbolsForFile(artifactId, "a/A.java");

  assert.deepEqual(
    rows.map((row) => `${row.symbolName}@${row.line}`),
    ["A@1", "alpha@5", "beta@5"]
  );
  assert.ok(rows.every((row) => row.filePath === "a/A.java"));
});

test("listSymbolsForFile returns an empty array for a file with no indexed symbols", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-file-empty";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: "a.A", line: 1 }
  ]);

  assert.deepEqual(repos.symbols.listSymbolsForFile(artifactId, "a/Missing.java"), []);
});

test("listSymbolsForFiles returns an empty map for an empty path list", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-files-empty-input";
  seedArtifact(repos.artifacts, artifactId);

  const result = repos.symbols.listSymbolsForFiles(artifactId, []);
  assert.equal(result.size, 0);
});

test("listSymbolsForFiles groups symbols per file and omits files without symbols", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-files-grouping";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "b/B.java", "c/Empty.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: "a.A", line: 1 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "run", qualifiedName: "a.A.run", line: 4 },
    { filePath: "b/B.java", symbolKind: "method", symbolName: "tick", qualifiedName: "b.B.tick", line: 2 }
  ]);

  const result = repos.symbols.listSymbolsForFiles(artifactId, [
    "a/A.java",
    "b/B.java",
    "c/Empty.java",
    "d/Unknown.java"
  ]);

  assert.deepEqual([...result.keys()].sort(), ["a/A.java", "b/B.java"]);
  assert.deepEqual(
    result.get("a/A.java")?.map((row) => `${row.symbolName}@${row.line}`),
    ["A@1", "run@4"]
  );
  assert.deepEqual(
    result.get("b/B.java")?.map((row) => `${row.symbolName}@${row.line}`),
    ["tick@2"]
  );
  assert.equal(result.has("c/Empty.java"), false);
  assert.equal(result.has("d/Unknown.java"), false);
});

test("listSymbolsForFiles deduplicates repeated input paths", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-files-dedupe";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: "a.A", line: 1 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "run", qualifiedName: "a.A.run", line: 4 }
  ]);

  const result = repos.symbols.listSymbolsForFiles(artifactId, ["a/A.java", "a/A.java", "a/A.java"]);

  assert.equal(result.size, 1);
  assert.deepEqual(
    result.get("a/A.java")?.map((row) => `${row.symbolName}@${row.line}`),
    ["A@1", "run@4"]
  );
});

test("listSymbolsForFiles applies the symbol kind filter to every requested file", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-files-kind";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "b/B.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: "a.A", line: 1 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "run", qualifiedName: "a.A.run", line: 4 },
    { filePath: "b/B.java", symbolKind: "class", symbolName: "B", qualifiedName: "b.B", line: 1 }
  ]);

  const result = repos.symbols.listSymbolsForFiles(artifactId, ["a/A.java", "b/B.java"], "method");

  assert.deepEqual([...result.keys()], ["a/A.java"]);
  assert.deepEqual(
    result.get("a/A.java")?.map((row) => row.symbolName),
    ["run"]
  );
});

test("findBySymbolNames matches stored names case-insensitively and preserves original casing", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-names-case";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "TickServer", qualifiedName: "a.A.TickServer", line: 3 }
  ]);

  for (const query of ["tickserver", "TICKSERVER"]) {
    const rows = repos.symbols.findBySymbolNames(artifactId, [query]);
    assert.equal(rows.length, 1, `query ${query}`);
    assert.equal(rows[0].symbolName, "TickServer");
    assert.equal(rows[0].filePath, "a/A.java");
    assert.equal(rows[0].line, 3);
  }
});

test("findBySymbolNames trims input names and drops blank entries", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-names-trim";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "TickServer", qualifiedName: "a.A.TickServer", line: 3 }
  ]);

  const rows = repos.symbols.findBySymbolNames(artifactId, ["  TickServer  ", "", "   "]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbolName, "TickServer");
});

test("findBySymbolNames returns an empty array when every name is blank", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-names-blank";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "TickServer", qualifiedName: "a.A.TickServer", line: 3 }
  ]);

  assert.deepEqual(repos.symbols.findBySymbolNames(artifactId, ["", "   "]), []);
});

test("findBySymbolNames matches case and whitespace variants of one name without duplicating rows and orders by name, path, then line", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-names-order";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "b/B.java"]);

  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "b/B.java", symbolKind: "method", symbolName: "alpha", qualifiedName: "b.B.alpha", line: 7 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "alpha", qualifiedName: "a.A.alpha", line: 9 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "Beta", qualifiedName: "a.A.Beta", line: 2 }
  ]);

  const rows = repos.symbols.findBySymbolNames(artifactId, ["beta", "ALPHA", "alpha "]);

  // BINARY collation orders uppercase before lowercase, so "Beta" sorts first.
  assert.deepEqual(
    rows.map((row) => `${row.symbolName}@${row.filePath}:${row.line}`),
    ["Beta@a/A.java:2", "alpha@a/A.java:9", "alpha@b/B.java:7"]
  );
});
