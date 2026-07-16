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

test("listDistinctFilePathsByKind returns each matching file once in ascending path order", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-distinct-paths";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["b/B.java", "a/A.java", "c/C.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "b/B.java", symbolKind: "class", symbolName: "B", qualifiedName: "b.B", line: 1 },
    { filePath: "b/B.java", symbolKind: "class", symbolName: "BInner", qualifiedName: "b.B.BInner", line: 5 },
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: "a.A", line: 1 },
    { filePath: "c/C.java", symbolKind: "method", symbolName: "run", qualifiedName: "c.C.run", line: 2 }
  ]);

  const paths = repos.symbols.listDistinctFilePathsByKind(artifactId, "class");
  assert.deepEqual(paths, ["a/A.java", "b/B.java"]);
});

test("listDistinctFilePathsByKind returns an empty array for a kind with no rows", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-distinct-empty";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "class", symbolName: "A", qualifiedName: "a.A", line: 1 }
  ]);

  assert.deepEqual(repos.symbols.listDistinctFilePathsByKind(artifactId, "record"), []);
});

test("findBestClassFilePath returns undefined when the class or simple name is blank", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-best-blank";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/Target.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/Target.java", symbolKind: "class", symbolName: "Target", qualifiedName: "com.pkg.Target", line: 1 }
  ]);

  assert.equal(repos.symbols.findBestClassFilePath(artifactId, "   ", "Target"), undefined);
  assert.equal(repos.symbols.findBestClassFilePath(artifactId, "com.pkg.Target", ""), undefined);
});

test("findBestClassFilePath prefers an exact qualified name over a simple-name match", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-best-qualified";
  seedArtifact(repos.artifacts, artifactId);
  // a/ sorts before q/, so a path tiebreak alone would wrongly pick a/Simple.java.
  seedFiles(repos, artifactId, ["a/Simple.java", "q/Exact.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/Simple.java", symbolKind: "class", symbolName: "Target", qualifiedName: "other.pkg.Target2", line: 1 },
    { filePath: "q/Exact.java", symbolKind: "class", symbolName: "Target", qualifiedName: "com.pkg.Target", line: 1 }
  ]);

  assert.equal(repos.symbols.findBestClassFilePath(artifactId, "com.pkg.Target", "Target"), "q/Exact.java");
});

test("findBestClassFilePath falls back to a simple-name match, then to a dotted-suffix qualified name", async () => {
  const repos = await createRepos();

  const simpleArtifact = "artifact-best-simple";
  seedArtifact(repos.artifacts, simpleArtifact);
  seedFiles(repos, simpleArtifact, ["a/Simple.java", "b/Suffix.java"]);
  repos.symbols.replaceSymbolsForArtifact(simpleArtifact, [
    { filePath: "a/Simple.java", symbolKind: "class", symbolName: "Target", qualifiedName: "x.Target2", line: 1 },
    { filePath: "b/Suffix.java", symbolKind: "class", symbolName: "Alias", qualifiedName: "legacy.Target", line: 1 }
  ]);
  assert.equal(
    repos.symbols.findBestClassFilePath(simpleArtifact, "com.pkg.Target", "Target"),
    "a/Simple.java",
    "simple-name tier beats the dotted-suffix tier"
  );

  const suffixArtifact = "artifact-best-suffix";
  seedArtifact(repos.artifacts, suffixArtifact);
  seedFiles(repos, suffixArtifact, ["b/Suffix.java"]);
  repos.symbols.replaceSymbolsForArtifact(suffixArtifact, [
    { filePath: "b/Suffix.java", symbolKind: "class", symbolName: "Alias", qualifiedName: "legacy.Target", line: 1 }
  ]);
  assert.equal(
    repos.symbols.findBestClassFilePath(suffixArtifact, "com.pkg.Target", "Target"),
    "b/Suffix.java",
    "dotted-suffix qualified-name match is the last resort"
  );
});

test("findBestClassFilePath breaks ties within a tier by ascending file path", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-best-tiebreak";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["b/Target.java", "a/Target.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "b/Target.java", symbolKind: "class", symbolName: "Target", qualifiedName: "n.Two", line: 1 },
    { filePath: "a/Target.java", symbolKind: "class", symbolName: "Target", qualifiedName: "n.One", line: 1 }
  ]);

  assert.equal(repos.symbols.findBestClassFilePath(artifactId, "com.none.Target9", "Target"), "a/Target.java");
});

test("findBestClassFilePath ignores non-class symbols and returns undefined when nothing matches", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-best-nonclass";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "Target", qualifiedName: "a.A.Target", line: 3 }
  ]);

  assert.equal(repos.symbols.findBestClassFilePath(artifactId, "a.A.Target", "Target"), undefined);
});
