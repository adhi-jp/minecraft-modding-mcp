import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DecompileModJarOutput } from "../src/mod-decompile-service.ts";
import { ModSearchService } from "../src/mod-search-service.ts";
import { createJar } from "./helpers/zip.ts";

test("searchModSource sets truncated at limit and preserves first decompile warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-search-"));
  const outputDir = join(root, "decompiled");
  const jarPath = join(root, "demo-mod.jar");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  await createJar(jarPath, {
    "com/example/Foo.class": Buffer.alloc(4)
  });
  await writeFile(
    join(outputDir, "com/example/Foo.java"),
    [
      "package com.example;",
      "public class Foo {",
      "  void a() {",
      '    String value = "needle";',
      "  }",
      "  void b() {",
      '    String value = "needle";',
      "  }",
      "}"
    ].join("\n"),
    "utf8"
  );

  let decompileCalls = 0;
  const decompileStub = {
    async decompileModJar(): Promise<DecompileModJarOutput> {
      decompileCalls += 1;
      return {
        modId: "demo",
        loader: "fabric",
        outputDir,
        fileCount: 1,
        files: ["com.example.Foo"],
        warnings: decompileCalls === 1 ? ["metadata unavailable"] : []
      };
    }
  };

  const service = new ModSearchService(decompileStub as any);
  const result = await service.searchModSource({
    jarPath,
    query: "needle",
    searchType: "content",
    limit: 1
  });

  assert.equal(result.hits.length, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.warnings, ["metadata unavailable"]);
  assert.equal(decompileCalls, 1);
});

test("searchModSource normalizes jarPath before decompile delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-search-normalize-"));
  const jarPath = join(root, "demo.jar");
  const symlinkPath = join(root, "demo-link.jar");
  await createJar(jarPath, {
    "com/example/Demo.class": Buffer.alloc(4)
  });
  await symlink(jarPath, symlinkPath);

  const delegatedJarPaths: string[] = [];
  const decompileStub = {
    async decompileModJar(input: { jarPath: string }): Promise<DecompileModJarOutput> {
      delegatedJarPaths.push(input.jarPath);
      return {
        modId: "demo",
        loader: "fabric",
        outputDir: root,
        fileCount: 0,
        files: [],
        warnings: []
      };
    }
  };

  const service = new ModSearchService(decompileStub as any);
  const result = await service.searchModSource({
    jarPath: symlinkPath,
    query: "Demo"
  });

  assert.equal(result.totalHits, 0);
  assert.deepEqual(delegatedJarPaths, [realpathSync(jarPath)]);
});

test("searchModSource rejects overly long queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-search-query-limit-"));
  const jarPath = join(root, "demo.jar");
  await createJar(jarPath, {
    "com/example/Demo.class": Buffer.alloc(4)
  });

  const decompileStub = {
    async decompileModJar(): Promise<DecompileModJarOutput> {
      return {
        modId: "demo",
        loader: "fabric",
        outputDir: root,
        fileCount: 0,
        files: [],
        warnings: []
      };
    }
  };

  const service = new ModSearchService(decompileStub as any);
  await assert.rejects(
    () =>
      service.searchModSource({
        jarPath,
        query: "a".repeat(201)
      }),
    /max length/
  );
});

test("searchModSource clamps limit to strict upper bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-search-limit-clamp-"));
  const outputDir = join(root, "decompiled");
  const jarPath = join(root, "demo-mod.jar");
  await mkdir(join(outputDir, "com/example"), { recursive: true });
  await createJar(jarPath, {
    "com/example/Foo.class": Buffer.alloc(4)
  });

  const repeatedLines = Array.from({ length: 260 }, (_, index) => `  void m${index}() { String value = "needle"; }`);
  await writeFile(
    join(outputDir, "com/example/Foo.java"),
    ["package com.example;", "public class Foo {", ...repeatedLines, "}"].join("\n"),
    "utf8"
  );

  const decompileStub = {
    async decompileModJar(): Promise<DecompileModJarOutput> {
      return {
        modId: "demo",
        loader: "fabric",
        outputDir,
        fileCount: 1,
        files: ["com.example.Foo"],
        warnings: []
      };
    }
  };

  const service = new ModSearchService(decompileStub as any);
  const result = await service.searchModSource({
    jarPath,
    query: "needle",
    searchType: "content",
    limit: 999
  });

  assert.equal(result.hits.length, 200);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some((warning) => warning.includes("clamped to 200")));
});

test("searchModSource searches source jars directly without decompile", async () => {
  const root = await mkdtemp(join(tmpdir(), "mod-search-source-jar-"));
  const jarPath = join(root, "demo-sources.jar");
  await createJar(jarPath, {
    "com/example/Foo.java": [
      "package com.example;",
      "public class Foo {",
      "  void run() {",
      '    String value = "needle";',
      "  }",
      "}"
    ].join("\n")
  });

  let decompileCalls = 0;
  const decompileStub = {
    async decompileModJar(): Promise<DecompileModJarOutput> {
      decompileCalls += 1;
      return {
        modId: "demo",
        loader: "unknown",
        outputDir: root,
        fileCount: 0,
        files: [],
        warnings: []
      };
    }
  };

  const service = new ModSearchService(decompileStub as any);
  const result = await service.searchModSource({
    jarPath,
    query: "needle",
    searchType: "content",
    limit: 10
  });

  assert.equal(decompileCalls, 0);
  assert.equal(result.totalHits, 1);
  assert.equal(result.hits[0]?.file, "com/example/Foo.java");
  assert.ok(result.warnings.some((warning) => warning.includes("source jar")));
});
