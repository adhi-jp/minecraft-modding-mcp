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

  const followUp = repos.symbols.findScopedSymbols({
    artifactId,
    query: "zeta",
    match: "exact",
    filePathLike: "a/A.java"
  }).items;
  assert.equal(followUp.length, 1);
  assert.equal(followUp[0].symbolName, "zeta");
});
