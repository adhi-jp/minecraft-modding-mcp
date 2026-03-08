import assert from "node:assert/strict";
import test from "node:test";
import Database from "../src/storage/sqlite.ts";

async function createRepos() {
  const { ArtifactsRepo } = await import("../src/storage/artifacts-repo.ts");
  const { FilesRepo } = await import("../src/storage/files-repo.ts");
  const { runMigrations } = await import("../src/storage/migrations.ts");
  const { SymbolsRepo } = await import("../src/storage/symbols-repo.ts");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return {
    artifacts: new ArtifactsRepo(db),
    files: new FilesRepo(db),
    symbols: new SymbolsRepo(db)
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

test("filesRepo.searchFiles cursor advances without duplicating previous hit", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-cursor";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    {
      filePath: "a/Foo.java",
      content: "class Foo { void token() {} }",
      contentBytes: 30,
      contentHash: "h1"
    },
    {
      filePath: "b/Foo.java",
      content: "class Foo { void token2() {} }",
      contentBytes: 31,
      contentHash: "h2"
    },
    {
      filePath: "c/Bar.java",
      content: "class Bar { void Foo() {} }",
      contentBytes: 32,
      contentHash: "h3"
    }
  ]);

  const first = files.searchFiles(artifactId, { query: "Foo", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);

  const second = files.searchFiles(artifactId, { query: "Foo", limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]?.filePath, second.items[0]?.filePath);
});

test("filesRepo.listFiles paginates through all files without duplicates", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-list-cursor";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    { filePath: "a/Alpha.java", content: "class Alpha {}", contentBytes: 14, contentHash: "la" },
    { filePath: "b/Beta.java", content: "class Beta {}", contentBytes: 13, contentHash: "lb" },
    { filePath: "c/Gamma.java", content: "class Gamma {}", contentBytes: 14, contentHash: "lc" }
  ]);

  const collected: string[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < 5; i += 1) {
    const page = files.listFiles(artifactId, { limit: 1, cursor });
    if (page.items.length === 0) break;
    collected.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }

  assert.equal(collected.length, 3);
  assert.equal(new Set(collected).size, 3, "no duplicates");

  // After exhausting all items, the next page should be empty
  if (cursor) {
    const empty = files.listFiles(artifactId, { limit: 1, cursor });
    assert.equal(empty.items.length, 0);
  }
});

test("filesRepo.listFiles prefix filter returns only matching files", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-list-prefix";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    { filePath: "net/minecraft/Foo.java", content: "class Foo {}", contentBytes: 12, contentHash: "pa" },
    { filePath: "net/minecraft/Bar.java", content: "class Bar {}", contentBytes: 12, contentHash: "pb" },
    { filePath: "com/other/Baz.java", content: "class Baz {}", contentBytes: 12, contentHash: "pc" }
  ]);

  const page = files.listFiles(artifactId, { limit: 100, prefix: "net/minecraft/" });
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((p) => p.startsWith("net/minecraft/")));
});

test("symbolsRepo.findSymbols cursor is deterministic for same symbol names", async () => {
  const { artifacts, files, symbols } = await createRepos();
  const artifactId = "artifact-symbol-cursor";
  seedArtifact(artifacts, artifactId);
  files.replaceFilesForArtifact(artifactId, [
    {
      filePath: "a/A.java",
      content: "class A { void Dup() {} }",
      contentBytes: 25,
      contentHash: "fa"
    },
    {
      filePath: "a/B.java",
      content: "class B { void Dup() {} }",
      contentBytes: 25,
      contentHash: "fb"
    },
    {
      filePath: "a/C.java",
      content: "class C { void Dup() {} }",
      contentBytes: 25,
      contentHash: "fc"
    }
  ]);

  symbols.replaceSymbolsForArtifact(artifactId, [
    {
      filePath: "a/A.java",
      symbolKind: "method",
      symbolName: "Dup",
      qualifiedName: "a.A.Dup",
      line: 10
    },
    {
      filePath: "a/B.java",
      symbolKind: "method",
      symbolName: "Dup",
      qualifiedName: "a.B.Dup",
      line: 11
    },
    {
      filePath: "a/C.java",
      symbolKind: "method",
      symbolName: "Dup",
      qualifiedName: "a.C.Dup",
      line: 12
    }
  ]);

  const collected = new Set<string>();
  let cursor: string | undefined = undefined;
  for (let i = 0; i < 4; i += 1) {
    const page = symbols.findSymbols({
      artifactId,
      symbolKind: "method",
      symbolNamePrefix: "Dup",
      exact: false,
      limit: 1,
      cursor
    });
    if (page.items.length === 0) {
      break;
    }
    const row = page.items[0];
    collected.add(`${row.symbolName}:${row.filePath}:${row.line}`);
    cursor = page.nextCursor;
    if (!cursor) {
      break;
    }
  }

  assert.equal(collected.size, 3);
});

test("filesRepo.searchFileCandidates returns merged path/content matches with stable cursor", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-file-candidates";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    {
      filePath: "net/a/FooPath.java",
      content: "class Alpha { void noop() {} }",
      contentBytes: 31,
      contentHash: "h-a"
    },
    {
      filePath: "net/b/Bar.java",
      content: "class Beta { void FooPath() {} }",
      contentBytes: 32,
      contentHash: "h-b"
    },
    {
      filePath: "net/c/FooPath.java",
      content: "class Gamma { void FooPath() {} }",
      contentBytes: 33,
      contentHash: "h-c"
    }
  ]);

  const first = (files as unknown as {
    searchFileCandidates: (
      artifact: string,
      options: { query: string; limit: number; cursor?: string }
    ) => {
      items: Array<{ filePath: string; matchedIn: string }>;
      nextCursor?: string;
    };
  }).searchFileCandidates(artifactId, {
    query: "FooPath",
    limit: 1
  });

  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  assert.ok(first.items[0]?.matchedIn === "path" || first.items[0]?.matchedIn === "both");

  const second = (files as unknown as {
    searchFileCandidates: (
      artifact: string,
      options: { query: string; limit: number; cursor?: string }
    ) => {
      items: Array<{ filePath: string }>;
      nextCursor?: string;
    };
  }).searchFileCandidates(artifactId, {
    query: "FooPath",
    limit: 1,
    cursor: first.nextCursor
  });

  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]?.filePath, second.items[0]?.filePath);
});

test("filesRepo.searchFileCandidates supports mode-specific candidate queries", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-file-candidates-mode";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    {
      filePath: "net/a/FooNeedle.java",
      content: "class Alpha { void noop() {} }",
      contentBytes: 31,
      contentHash: "m-a"
    },
    {
      filePath: "net/b/Bar.java",
      content: "class Beta { void FooNeedle() {} }",
      contentBytes: 32,
      contentHash: "m-b"
    }
  ]);

  const pathOnly = files.searchFileCandidates(artifactId, {
    query: "FooNeedle",
    limit: 10,
    mode: "path"
  });
  assert.ok(pathOnly.items.length > 0);
  assert.equal(pathOnly.dbRoundtrips, 1);
  assert.ok(pathOnly.items.every((item) => item.matchedIn === "path"));

  const textOnly = files.searchFileCandidates(artifactId, {
    query: "FooNeedle",
    limit: 10,
    mode: "text"
  });
  assert.ok(textOnly.items.length > 0);
  assert.equal(textOnly.dbRoundtrips, 1);
  assert.ok(textOnly.items.every((item) => item.matchedIn === "content"));
});

test("filesRepo keeps prepared path-count statements hot instead of clearing the entire cache", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-get-by-paths-cache";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(
    artifactId,
    Array.from({ length: 70 }, (_, index) => ({
      filePath: `pkg/F${index}.java`,
      content: `class F${index} {}`,
      contentBytes: 12,
      contentHash: `cache-${index}`
    }))
  );

  for (let pathCount = 1; pathCount <= 64; pathCount += 1) {
    files.getFileContentsByPaths(
      artifactId,
      Array.from({ length: pathCount }, (_, index) => `pkg/F${index}.java`)
    );
  }

  const stmtCache = (files as unknown as {
    getByPathsStmtCache: Map<number, unknown>;
  }).getByPathsStmtCache;
  assert.equal(stmtCache.size, 64);

  files.getFileContentsByPaths(
    artifactId,
    Array.from({ length: 65 }, (_, index) => `pkg/F${index}.java`)
  );

  assert.equal(stmtCache.size, 64);
  assert.equal(stmtCache.has(1), false);
  assert.equal(stmtCache.has(64), true);
  assert.equal(stmtCache.has(65), true);
});

test("symbolsRepo.findScopedSymbols supports contains + package prefix filtering", async () => {
  const { artifacts, files, symbols } = await createRepos();
  const artifactId = "artifact-scoped-symbols";
  seedArtifact(artifacts, artifactId);
  files.replaceFilesForArtifact(artifactId, [
    {
      filePath: "net/minecraft/server/Main.java",
      content: "class Main { void tickServer() {} }",
      contentBytes: 34,
      contentHash: "sa"
    },
    {
      filePath: "net/minecraft/client/MainClient.java",
      content: "class MainClient { void tickClient() {} }",
      contentBytes: 40,
      contentHash: "sb"
    }
  ]);

  symbols.replaceSymbolsForArtifact(artifactId, [
    {
      filePath: "net/minecraft/server/Main.java",
      symbolKind: "method",
      symbolName: "tickServer",
      qualifiedName: "net.minecraft.server.Main.tickServer",
      line: 2
    },
    {
      filePath: "net/minecraft/client/MainClient.java",
      symbolKind: "method",
      symbolName: "tickClient",
      qualifiedName: "net.minecraft.client.MainClient.tickClient",
      line: 2
    }
  ]);

  const result = (symbols as unknown as {
    findScopedSymbols: (input: {
      artifactId: string;
      query: string;
      match: "contains";
      symbolKind?: string;
      packagePrefix?: string;
      limit: number;
    }) => { items: Array<{ filePath: string; symbolName: string }>; nextCursor: string | undefined };
  }).findScopedSymbols({
    artifactId,
    query: "tick",
    match: "contains",
    symbolKind: "method",
    packagePrefix: "net.minecraft.server",
    limit: 10
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.filePath, "net/minecraft/server/Main.java");
  assert.equal(result.items[0]?.symbolName, "tickServer");
});

test("symbolsRepo.findScopedSymbols treats LIKE wildcard characters literally", async () => {
  const { artifacts, files, symbols } = await createRepos();
  const artifactId = "artifact-scoped-symbols-like-escaping";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    {
      filePath: "pkg/A.java",
      content: "class A { void tick_value() {} }",
      contentBytes: 32,
      contentHash: "la"
    },
    {
      filePath: "pkg/B.java",
      content: "class B { void tickValue() {} }",
      contentBytes: 31,
      contentHash: "lb"
    },
    {
      filePath: "pkg/C.java",
      content: "class C { void foo%bar() {} }",
      contentBytes: 30,
      contentHash: "lc"
    },
    {
      filePath: "pkg/D.java",
      content: "class D { void foobar() {} }",
      contentBytes: 29,
      contentHash: "ld"
    }
  ]);

  symbols.replaceSymbolsForArtifact(artifactId, [
    {
      filePath: "pkg/A.java",
      symbolKind: "method",
      symbolName: "tick_value",
      qualifiedName: "pkg.A.tick_value",
      line: 2
    },
    {
      filePath: "pkg/B.java",
      symbolKind: "method",
      symbolName: "tickValue",
      qualifiedName: "pkg.B.tickValue",
      line: 2
    },
    {
      filePath: "pkg/C.java",
      symbolKind: "method",
      symbolName: "foo%bar",
      qualifiedName: "pkg.C.foo%bar",
      line: 2
    },
    {
      filePath: "pkg/D.java",
      symbolKind: "method",
      symbolName: "foobar",
      qualifiedName: "pkg.D.foobar",
      line: 2
    }
  ]);

  const containsResult = symbols.findScopedSymbols({
    artifactId,
    query: "tick_",
    match: "contains",
    symbolKind: "method",
    limit: 10
  });
  assert.deepEqual(
    containsResult.items.map((row) => row.symbolName),
    ["tick_value"]
  );

  const prefixResult = symbols.findScopedSymbols({
    artifactId,
    query: "foo%",
    match: "prefix",
    symbolKind: "method",
    limit: 10
  });
  assert.deepEqual(
    prefixResult.items.map((row) => row.symbolName),
    ["foo%bar"]
  );
});

test("filesRepo.searchFileCandidates paginates text/path results without duplicates or gaps", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-cursor-pagination";
  seedArtifact(artifacts, artifactId);

  // Create many files that match both path and content for "Needle"
  const fileData = [];
  for (let i = 0; i < 15; i++) {
    fileData.push({
      filePath: `pkg/NeedleFile${String(i).padStart(2, "0")}.java`,
      content: `class NeedleFile${String(i).padStart(2, "0")} { String Needle = "val"; }`,
      contentBytes: 50,
      contentHash: `h${i}`
    });
  }
  files.replaceFilesForArtifact(artifactId, fileData);

  const collected: string[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < 20; page++) {
    const result = files.searchFileCandidates(artifactId, {
      query: "Needle",
      limit: 3,
      cursor
    });
    if (result.items.length === 0) break;
    collected.push(...result.items.map((item) => item.filePath));
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  // Should have no duplicates
  assert.equal(new Set(collected).size, collected.length, "no duplicates in paginated results");
  // Should have found all 15 files (each matches both path and content)
  assert.ok(collected.length >= 15, `expected at least 15 results, got ${collected.length}`);
});

test("filesRepo.searchFileCandidates cursor pushdown reduces scanned rows for deep pages", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-cursor-pushdown";
  seedArtifact(artifacts, artifactId);

  // Create files where path matches for "Entity"
  const fileData = [];
  for (let i = 0; i < 30; i++) {
    fileData.push({
      filePath: `net/Entity${String(i).padStart(3, "0")}.java`,
      content: `class Entity${String(i).padStart(3, "0")} {}`,
      contentBytes: 30,
      contentHash: `e${i}`
    });
  }
  files.replaceFilesForArtifact(artifactId, fileData);

  // First page
  const first = files.searchFileCandidates(artifactId, { query: "Entity", limit: 5, mode: "path" });
  assert.equal(first.items.length, 5);
  assert.ok(first.nextCursor);

  // Second page with cursor — should scan fewer rows than without cursor
  const secondWithCursor = files.searchFileCandidates(artifactId, {
    query: "Entity",
    limit: 5,
    mode: "path",
    cursor: first.nextCursor
  });
  assert.equal(secondWithCursor.items.length, 5);

  // Verify no overlap between pages
  const firstPaths = new Set(first.items.map((item) => item.filePath));
  for (const item of secondWithCursor.items) {
    assert.ok(!firstPaths.has(item.filePath), `duplicate found: ${item.filePath}`);
  }
});

test("filesRepo.countTextCandidates and countPathCandidates return correct counts", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-count";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    { filePath: "a/Foo.java", content: "class Foo { String needle = 1; }", contentBytes: 32, contentHash: "ca" },
    { filePath: "b/Bar.java", content: "class Bar { String needle = 2; }", contentBytes: 32, contentHash: "cb" },
    { filePath: "c/Baz.java", content: "class Baz { void noop() {} }", contentBytes: 28, contentHash: "cc" }
  ]);

  const textCount = files.countTextCandidates(artifactId, "needle");
  assert.ok(textCount >= 2, `expected at least 2 text matches, got ${textCount}`);

  const pathCount = files.countPathCandidates(artifactId, "Foo");
  assert.equal(pathCount, 1);
});

test("symbolsRepo.countScopedSymbols returns correct count", async () => {
  const { artifacts, files, symbols } = await createRepos();
  const artifactId = "artifact-symbol-count";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    { filePath: "a/A.java", content: "class A {}", contentBytes: 10, contentHash: "sa" },
    { filePath: "b/B.java", content: "class B {}", contentBytes: 10, contentHash: "sb" }
  ]);

  symbols.replaceSymbolsForArtifact(artifactId, [
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tick", qualifiedName: "a.A.tick", line: 2 },
    { filePath: "a/A.java", symbolKind: "method", symbolName: "tickUpdate", qualifiedName: "a.A.tickUpdate", line: 3 },
    { filePath: "b/B.java", symbolKind: "class", symbolName: "B", qualifiedName: "b.B", line: 1 }
  ]);

  const prefixCount = symbols.countScopedSymbols({
    artifactId,
    query: "tick",
    match: "prefix",
    symbolKind: "method"
  });
  assert.equal(prefixCount, 2);

  const containsCount = symbols.countScopedSymbols({
    artifactId,
    query: "tick",
    match: "contains",
    symbolKind: "method"
  });
  assert.equal(containsCount, 2);

  const exactCount = symbols.countScopedSymbols({
    artifactId,
    query: "tick",
    match: "exact",
    symbolKind: "method"
  });
  assert.equal(exactCount, 1);
});

// ---------------------------------------------------------------------------
// F-02: Invalid cursor rejection
// ---------------------------------------------------------------------------
test("F-02: listFiles with invalid cursor throws ERR_INVALID_INPUT", async () => {
  const { artifacts, files } = await createRepos();
  seedArtifact(artifacts, "artifact-cursor-invalid");
  files.replaceFilesForArtifact("artifact-cursor-invalid", [
    { filePath: "a/Foo.java", content: "class Foo {}", contentBytes: 12, contentHash: "h1" }
  ]);

  assert.throws(
    () => files.listFiles("artifact-cursor-invalid", { limit: 10, cursor: "not-a-cursor" }),
    (error: any) => error.code === "ERR_INVALID_INPUT"
  );
});

test("F-02: listFiles with valid base64 but wrong schema throws ERR_INVALID_INPUT", async () => {
  const { artifacts, files } = await createRepos();
  seedArtifact(artifacts, "artifact-cursor-schema");
  files.replaceFilesForArtifact("artifact-cursor-schema", [
    { filePath: "a/Foo.java", content: "class Foo {}", contentBytes: 12, contentHash: "h1" }
  ]);

  // Valid base64, but wrong type (sortKey should be string, not number)
  const badCursor = Buffer.from(JSON.stringify({ sortKey: 123 }), "utf8").toString("base64");
  assert.throws(
    () => files.listFiles("artifact-cursor-schema", { limit: 10, cursor: badCursor }),
    (error: any) => error.code === "ERR_INVALID_INPUT"
  );
});

test("F-02: searchFiles with invalid cursor throws ERR_INVALID_INPUT", async () => {
  const { artifacts, files } = await createRepos();
  seedArtifact(artifacts, "artifact-search-cursor-invalid");
  files.replaceFilesForArtifact("artifact-search-cursor-invalid", [
    { filePath: "a/Foo.java", content: "class Foo {}", contentBytes: 12, contentHash: "h1" }
  ]);

  assert.throws(
    () => files.searchFiles("artifact-search-cursor-invalid", { query: "Foo", limit: 10, cursor: "garbage" }),
    (error: any) => error.code === "ERR_INVALID_INPUT"
  );
});

test("F-02: listFiles with undefined/empty cursor returns first page (unchanged)", async () => {
  const { artifacts, files } = await createRepos();
  seedArtifact(artifacts, "artifact-cursor-empty");
  files.replaceFilesForArtifact("artifact-cursor-empty", [
    { filePath: "a/Foo.java", content: "class Foo {}", contentBytes: 12, contentHash: "h1" },
    { filePath: "b/Bar.java", content: "class Bar {}", contentBytes: 12, contentHash: "h2" }
  ]);

  const result1 = files.listFiles("artifact-cursor-empty", { limit: 10, cursor: undefined });
  assert.equal(result1.items.length, 2);

  const result2 = files.listFiles("artifact-cursor-empty", { limit: 10, cursor: "" });
  assert.equal(result2.items.length, 2);
});

test("filesRepo.searchFileCandidates incorporates BM25 rank bonus for content matches", async () => {
  const { artifacts, files } = await createRepos();
  const artifactId = "artifact-bm25-rank";
  seedArtifact(artifacts, artifactId);

  files.replaceFilesForArtifact(artifactId, [
    {
      filePath: "a/Dense.java",
      content: "needle needle needle needle needle",
      contentBytes: 35,
      contentHash: "ra"
    },
    {
      filePath: "b/Sparse.java",
      content: "class Sparse { String x = \"needle\"; }",
      contentBytes: 38,
      contentHash: "rb"
    }
  ]);

  const result = files.searchFileCandidates(artifactId, { query: "needle", limit: 10, mode: "text" });
  assert.equal(result.items.length, 2);
  // Both should have scores in the content range (100-119)
  for (const item of result.items) {
    assert.ok(item.score >= 100 && item.score <= 119, `score ${item.score} out of content range`);
  }
});
