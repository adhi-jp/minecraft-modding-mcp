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

function seedDupSymbols(repos: TestRepos, artifactId: string): void {
  seedFiles(repos, artifactId, ["a/A.java", "a/B.java", "a/C.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "Dup", qualifiedName: "a.A.Dup", line: 10 },
    { filePath: "a/B.java", symbolKind: "method", symbolName: "Dup", qualifiedName: "a.B.Dup", line: 11 },
    { filePath: "a/C.java", symbolKind: "method", symbolName: "Dup", qualifiedName: "a.C.Dup", line: 12 }
  ]);
}

test("findScopedSymbols returns an empty page for a whitespace-only query", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-blank";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tick", qualifiedName: "a.A.tick", line: 2 }
  ]);

  const result = repos.symbols.findScopedSymbols({ artifactId, query: "   ", match: "contains", limit: 10 });
  assert.deepEqual(result, { items: [], nextCursor: undefined });
});

test("findScopedSymbols treats an empty symbolKinds array as no kind filter", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-kinds";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/Main.java", "b/Other.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/Main.java", symbolKind: "class", symbolName: "Main", qualifiedName: "a.Main", line: 1 },
    { filePath: "b/Other.java", symbolKind: "method", symbolName: "Main", qualifiedName: "b.Other.Main", line: 1 }
  ]);

  const unfiltered = repos.symbols.findScopedSymbols({
    artifactId,
    query: "Main",
    match: "exact",
    symbolKinds: [],
    limit: 10
  });
  assert.deepEqual(
    unfiltered.items.map((row) => `${row.symbolKind}@${row.filePath}`),
    ["class@a/Main.java", "method@b/Other.java"]
  );

  const methodsOnly = repos.symbols.findScopedSymbols({
    artifactId,
    query: "Main",
    match: "exact",
    symbolKinds: ["method"],
    limit: 10
  });
  assert.deepEqual(
    methodsOnly.items.map((row) => `${row.symbolKind}@${row.filePath}`),
    ["method@b/Other.java"]
  );
});

test("findScopedSymbols filters file paths with a caller-supplied LIKE pattern", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-pathlike";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["net/mc/A.java", "com/other/B.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "net/mc/A.java", symbolKind: "method", symbolName: "tick", qualifiedName: "net.mc.A.tick", line: 2 },
    { filePath: "com/other/B.java", symbolKind: "method", symbolName: "tick", qualifiedName: "com.other.B.tick", line: 3 }
  ]);

  const result = repos.symbols.findScopedSymbols({
    artifactId,
    query: "tick",
    match: "exact",
    filePathLike: "net/%",
    limit: 10
  });

  assert.deepEqual(
    result.items.map((row) => row.filePath),
    ["net/mc/A.java"]
  );
});

test("findScopedSymbols cursor returns only rows strictly after the name/path/line tuple", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-cursor";
  seedArtifact(repos.artifacts, artifactId);
  seedDupSymbols(repos, artifactId);

  const result = repos.symbols.findScopedSymbols({
    artifactId,
    query: "Dup",
    match: "exact",
    limit: 10,
    cursor: { symbolName: "Dup", filePath: "a/A.java", line: 10 }
  });

  assert.deepEqual(
    result.items.map((row) => `${row.filePath}:${row.line}`),
    ["a/B.java:11", "a/C.java:12"]
  );
  assert.equal(result.nextCursor, undefined);
});

test("findScopedSymbols paginates via its base64 next cursor without duplicates", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-paging";
  seedArtifact(repos.artifacts, artifactId);
  seedDupSymbols(repos, artifactId);

  const collected: string[] = [];
  let cursor: { symbolName: string; filePath: string; line: number } | undefined = undefined;
  let pages = 0;
  for (let i = 0; i < 5; i += 1) {
    const page = repos.symbols.findScopedSymbols({ artifactId, query: "Dup", match: "exact", limit: 1, cursor });
    if (page.items.length === 0) break;
    pages += 1;
    for (const row of page.items) {
      collected.push(`${row.symbolName}:${row.filePath}:${row.line}`);
    }
    if (!page.nextCursor) {
      cursor = undefined;
      break;
    }
    // The repo emits an encoded base64 cursor but accepts a decoded tuple object.
    assert.equal(typeof page.nextCursor, "string");
    cursor = JSON.parse(Buffer.from(page.nextCursor, "base64").toString("utf8")) as {
      symbolName: string;
      filePath: string;
      line: number;
    };
  }

  assert.equal(pages, 3);
  assert.deepEqual(collected, ["Dup:a/A.java:10", "Dup:a/B.java:11", "Dup:a/C.java:12"]);
  assert.equal(cursor, undefined, "final page carries no cursor");
});

test("findScopedSymbols without an explicit limit returns all matches and no next cursor", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-nolimit";
  seedArtifact(repos.artifacts, artifactId);
  seedDupSymbols(repos, artifactId);

  const result = repos.symbols.findScopedSymbols({ artifactId, query: "Dup", match: "exact" });
  assert.equal(result.items.length, 3);
  assert.equal(result.nextCursor, undefined);
});

test("findScopedSymbols normalizes package prefixes written with dots or trailing separators", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-package";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["net/minecraft/server/Main.java", "net/minecraft/client/MainClient.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    {
      filePath: "net/minecraft/server/Main.java",
      symbolKind: "method",
      symbolName: "tickServer",
      qualifiedName: "net.minecraft.server.Main.tickServer",
      line: 5
    },
    {
      filePath: "net/minecraft/client/MainClient.java",
      symbolKind: "method",
      symbolName: "tickClient",
      qualifiedName: "net.minecraft.client.MainClient.tickClient",
      line: 6
    }
  ]);

  for (const packagePrefix of ["net.minecraft.server.", "net/minecraft/server"]) {
    const result = repos.symbols.findScopedSymbols({
      artifactId,
      query: "tick",
      match: "contains",
      packagePrefix,
      limit: 10
    });
    assert.deepEqual(
      result.items.map((row) => row.symbolName),
      ["tickServer"],
      `packagePrefix ${packagePrefix}`
    );
  }
});

test("findScopedSymbols prefix and contains match case-insensitively while exact match is case-sensitive", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-case";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tickServer", qualifiedName: "a.A.tickServer", line: 2 }
  ]);

  const prefix = repos.symbols.findScopedSymbols({ artifactId, query: "TICKSER", match: "prefix", limit: 10 });
  assert.deepEqual(
    prefix.items.map((row) => row.symbolName),
    ["tickServer"]
  );

  const contains = repos.symbols.findScopedSymbols({ artifactId, query: "CKSERV", match: "contains", limit: 10 });
  assert.deepEqual(
    contains.items.map((row) => row.symbolName),
    ["tickServer"]
  );

  const exactWrongCase = repos.symbols.findScopedSymbols({
    artifactId,
    query: "tickserver",
    match: "exact",
    limit: 10
  });
  assert.deepEqual(exactWrongCase.items, []);

  const exactStoredCase = repos.symbols.findScopedSymbols({
    artifactId,
    query: "tickServer",
    match: "exact",
    limit: 10
  });
  assert.deepEqual(
    exactStoredCase.items.map((row) => row.symbolName),
    ["tickServer"]
  );
});

test("findScopedSymbols treats LIKE wildcards in the query as literal characters", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-scoped-escape";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java", "a/B.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tick_server", qualifiedName: "a.A.tick_server", line: 3 },
    { filePath: "a/B.java", symbolKind: "method", symbolName: "tickXserver", qualifiedName: "a.B.tickXserver", line: 4 }
  ]);

  // An unescaped "_" would match any single character and return both rows.
  const result = repos.symbols.findScopedSymbols({ artifactId, query: "k_s", match: "contains", limit: 10 });
  assert.deepEqual(
    result.items.map((row) => row.symbolName),
    ["tick_server"]
  );
});

test("countScopedSymbols returns 0 for a blank query", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-count-blank";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tick", qualifiedName: "a.A.tick", line: 2 }
  ]);

  assert.equal(repos.symbols.countScopedSymbols({ artifactId, query: "  ", match: "contains" }), 0);
});

test("countScopedSymbols restricts the count to the normalized package prefix", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-count-package";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["net/minecraft/server/Main.java", "net/minecraft/client/Client.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    {
      filePath: "net/minecraft/server/Main.java",
      symbolKind: "method",
      symbolName: "tick",
      qualifiedName: "net.minecraft.server.Main.tick",
      line: 2
    },
    {
      filePath: "net/minecraft/client/Client.java",
      symbolKind: "method",
      symbolName: "tick",
      qualifiedName: "net.minecraft.client.Client.tick",
      line: 3
    }
  ]);

  const scoped = repos.symbols.countScopedSymbols({
    artifactId,
    query: "tick",
    match: "exact",
    packagePrefix: "net.minecraft.server"
  });
  assert.equal(scoped, 1);

  const unscoped = repos.symbols.countScopedSymbols({ artifactId, query: "tick", match: "exact" });
  assert.equal(unscoped, 2);
});

test("findScopedSymbols maps a missing qualified name to undefined in returned rows", async () => {
  const repos = await createRepos();
  const artifactId = "artifact-null-qualified";
  seedArtifact(repos.artifacts, artifactId);
  seedFiles(repos, artifactId, ["a/A.java"]);
  repos.symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "class", symbolName: "Anon", qualifiedName: undefined, line: 1 }
  ]);

  const result = repos.symbols.findScopedSymbols({ artifactId, query: "Anon", match: "exact" });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.qualifiedName, undefined);
});
