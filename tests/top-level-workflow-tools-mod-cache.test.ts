import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { AnalyzeModService } from "../src/entry-tools/analyze-mod-service.ts";
import { ManageCacheService } from "../src/entry-tools/manage-cache-service.ts";

test("top-level workflow tool schemas expose explicit defaults on safe public parameters", async () => {
  const inspectMinecraftSource = await readFile("src/entry-tools/inspect-minecraft-service.ts", "utf8");
  const inspectMinecraftInternalSource = await readFile("src/entry-tools/inspect-minecraft/internal.ts", "utf8");
  const validateProjectSource = await readFile("src/entry-tools/validate-project-service.ts", "utf8");
  const analyzeSymbolSource = await readFile("src/entry-tools/analyze-symbol-service.ts", "utf8");
  const compareMinecraftSource = await readFile("src/entry-tools/compare-minecraft-service.ts", "utf8");
  const analyzeModSource = await readFile("src/entry-tools/analyze-mod-service.ts", "utf8");
  const manageCacheSource = await readFile("src/entry-tools/manage-cache-service.ts", "utf8");

  assert.match(validateProjectSource, /preferProjectMapping:\s*z\.boolean\(\)\.default\(false\)/);
  assert.match(validateProjectSource, /minSeverity:\s*z\.enum\(\["error", "warning", "all"\]\)\.default\("all"\)/);
  assert.match(validateProjectSource, /hideUncertain:\s*z\.boolean\(\)\.default\(false\)/);
  assert.match(validateProjectSource, /explain:\s*z\.boolean\(\)\.default\(false\)/);
  assert.match(validateProjectSource, /treatInfoAsWarning:\s*z\.boolean\(\)\.default\(true\)/);
  assert.match(validateProjectSource, /includeIssues:\s*z\.boolean\(\)\.default\(true\)/);
  assert.match(analyzeSymbolSource, /signatureMode:\s*z\.enum\(\["exact", "name-only"\]\)\.default\("exact"\)/);
  assert.match(analyzeSymbolSource, /nameMode:\s*z\.enum\(\["fqcn", "auto"\]\)\.default\("auto"\)/);
  assert.match(analyzeSymbolSource, /maxCandidates:\s*positiveIntSchema\.default\(5\)/);
  // subject.kind documents the 'symbol' auto-detect contract via .describe().
  assert.match(analyzeSymbolSource, /\.enum\(\["class", "method", "field", "symbol"\]\)\s*\.describe\(/);
  assert.match(compareMinecraftSource, /maxClassResults:\s*positiveIntSchema\.default\(500\)/);
  assert.match(compareMinecraftSource, /includeFullDiff:\s*z\.boolean\(\)\.default\(true\)/);
  assert.match(inspectMinecraftSource, /includeSnapshots:\s*z\.boolean\(\)\.default\(false\)/);
  assert.equal(
    inspectMinecraftInternalSource.match(/queryMode:\s*z\.enum\(\["auto", "token", "literal"\]\)\.default\("auto"\)/g)?.length ?? 0,
    2
  );
  assert.match(analyzeModSource, /searchType:\s*z\.enum\(\["class", "method", "field", "content", "all"\]\)\.default\("all"\)/);
  assert.match(analyzeModSource, /limit:\s*positiveIntSchema\.default\(50\)/);
  assert.match(analyzeModSource, /includeFiles:\s*z\.boolean\(\)\.default\(true\)/);
  assert.match(analyzeModSource, /executionMode:\s*executionModeSchema\.default\("preview"\)/);
  assert.match(manageCacheSource, /limit:\s*positiveIntSchema\.default\(50\)/);
  assert.match(manageCacheSource, /executionMode:\s*executionModeSchema\.default\("preview"\)/);
});

test("AnalyzeModService omits default search/decompile controls from summary.subject", async () => {
  const service = new AnalyzeModService({
    analyzeModJar: async () => ({
      loader: "fabric",
      jarKind: "binary",
      modId: "example",
      modName: "Example",
      modVersion: "1.0.0",
      classCount: 1,
      dependencies: []
    }),
    decompileModJar: async () => ({
      fileCount: 1,
      returnedFileCount: 1,
      warnings: []
    }),
    getModClassSource: async () => {
      throw new Error("not used");
    },
    searchModSource: async () => ({
      query: "tick",
      searchType: "all",
      hits: [],
      totalHits: 0,
      truncated: false,
      warnings: []
    }),
    remapModJar: async () => {
      throw new Error("not used");
    }
  });

  const decompileResult = await service.execute({
    task: "decompile",
    detail: "summary",
    subject: {
      kind: "jar",
      jarPath: "/tmp/example.jar"
    }
  });
  assert.deepEqual(decompileResult.summary.subject, {
    task: "decompile",
    kind: "jar",
    jarPath: "/tmp/example.jar"
  });

  const searchResult = await service.execute({
    task: "search",
    detail: "summary",
    subject: {
      kind: "jar",
      jarPath: "/tmp/example.jar"
    },
    query: "tick"
  });
  assert.deepEqual(searchResult.summary.subject, {
    task: "search",
    kind: "jar",
    jarPath: "/tmp/example.jar",
    query: "tick"
  });
});

test("AnalyzeModService validates remap preview without mutating", async () => {
  let remapCalls = 0;
  const service = new AnalyzeModService({
    analyzeModJar: async () => ({
      loader: "fabric",
      jarKind: "binary",
      modId: "example",
      modName: "Example",
      modVersion: "1.0.0",
      classCount: 1,
      dependencies: [{ modId: "minecraft", versionRange: "1.21.10", kind: "required" }]
    }),
    decompileModJar: async () => {
      throw new Error("not used");
    },
    getModClassSource: async () => {
      throw new Error("not used");
    },
    searchModSource: async () => {
      throw new Error("not used");
    },
    remapModJar: async () => {
      remapCalls += 1;
      return {
        outputJar: "/tmp/example-mojang.jar",
        mcVersion: "1.21.10",
        fromMapping: "intermediary",
        targetMapping: "mojang",
        resolvedTargetNamespace: "mojang",
        durationMs: 25,
        warnings: []
      };
    }
  });

  const result = await service.execute({
    task: "remap",
    detail: "summary",
    subject: {
      kind: "jar",
      jarPath: "/tmp/example.jar"
    },
    executionMode: "preview",
    targetMapping: "mojang"
  });

  assert.equal(remapCalls, 0);
  assert.equal(result.summary.status, "unchanged");
  assert.equal(result.operation?.executionMode, "preview");
});

test("ManageCacheService normalizes read-only actions to preview mode and blocks broad delete apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "manage-cache-"));
  await mkdir(join(root, "downloads"), { recursive: true });
  await writeFile(join(root, "downloads", "client.jar"), "jar");

  const service = new ManageCacheService({
    registry: {
      summarize: async () => ({
        kinds: {
          downloads: {
            cacheKind: "downloads",
            entryCount: 1,
            totalBytes: 3,
            status: "healthy"
          }
        }
      }),
      listEntries: async () => ({ entries: [], nextCursor: undefined }),
      inspectEntries: async () => [],
      deleteEntries: async () => ({ deletedEntries: 0, deletedBytes: 0, warnings: [] }),
      pruneEntries: async () => ({ deletedEntries: 0, deletedBytes: 0, warnings: [] }),
      rebuildEntries: async () => ({ rebuiltEntries: 0, warnings: [] }),
      verifyEntries: async () => ({ checkedEntries: 1, unhealthyEntries: 0, warnings: [] })
    }
  });

  const summary = await service.execute({
    action: "summary",
    executionMode: "apply",
    cacheKinds: ["downloads"]
  });
  assert.equal(summary.operation?.executionMode, "preview");

  await assert.rejects(
    () =>
      service.execute({
        action: "delete",
        executionMode: "apply",
        cacheKinds: ["downloads"]
      }),
    (error: any) => error.code === ERROR_CODES.INVALID_INPUT
  );
});

test("AnalyzeModService remap preview includes summary.subject and apply follow-up", async () => {
  const service = new AnalyzeModService({
    analyzeModJar: async () => ({
      loader: "fabric",
      jarKind: "binary",
      modId: "example",
      modName: "Example",
      modVersion: "1.0.0",
      classCount: 1,
      dependencies: []
    }),
    decompileModJar: async () => {
      throw new Error("not used");
    },
    getModClassSource: async () => {
      throw new Error("not used");
    },
    searchModSource: async () => {
      throw new Error("not used");
    },
    remapModJar: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "remap",
    detail: "summary",
    subject: {
      kind: "jar",
      jarPath: "/tmp/example.jar"
    },
    executionMode: "preview",
    targetMapping: "mojang"
  });

  assert.deepEqual(result.summary.subject, {
    task: "remap",
    kind: "jar",
    jarPath: "/tmp/example.jar",
    executionMode: "preview",
    targetMapping: "mojang"
  });
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "analyze-mod",
      params: {
        task: "remap",
        subject: {
          kind: "jar",
          jarPath: "/tmp/example.jar"
        },
        executionMode: "apply",
        targetMapping: "mojang"
      }
    }
  ]);
});

test("ManageCacheService preview delete includes summary.subject and apply follow-up", async () => {
  const service = new ManageCacheService({
    registry: {
      summarize: async () => {
        throw new Error("not used");
      },
      listEntries: async () => ({ entries: [], nextCursor: undefined }),
      inspectEntries: async () => [],
      deleteEntries: async () => ({ deletedEntries: 2, deletedBytes: 64, warnings: [] }),
      pruneEntries: async () => ({ deletedEntries: 0, deletedBytes: 0, warnings: [] }),
      rebuildEntries: async () => ({ rebuiltEntries: 0, warnings: [] }),
      verifyEntries: async () => ({ checkedEntries: 0, unhealthyEntries: 0, warnings: [] })
    }
  });

  const result = await service.execute({
    action: "delete",
    detail: "summary",
    executionMode: "preview",
    cacheKinds: ["downloads"],
    selector: {
      status: "stale"
    }
  });

  assert.deepEqual(result.summary.subject, {
    action: "delete",
    cacheKinds: ["downloads"],
    executionMode: "preview",
    selector: {
      status: "stale"
    }
  });
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "manage-cache",
      params: {
        action: "delete",
        cacheKinds: ["downloads"],
        executionMode: "apply",
        selector: {
          status: "stale"
        }
      }
    }
  ]);
});
