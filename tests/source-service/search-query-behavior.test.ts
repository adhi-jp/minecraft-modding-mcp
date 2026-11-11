import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../../src/types.ts";
import {
  readSearchModeMetrics,
  readSearchPathMetrics
} from "../helpers/source-service-metrics.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

test("SourceService text search respects exact (case-sensitive) and prefix (case-insensitive) match semantics", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-text-match-semantics-"));
  const binaryJarPath = join(root, "server-text-match.jar");
  const sourcesJarPath = join(root, "server-text-match-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      '  String marker = "UniqueTestMarker";',
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // exact match with correct case → hit
  const exactHit = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "UniqueTestMarker",
    intent: "text",
    match: "exact",
    limit: 10
  });
  assert.ok(exactHit.hits.some((h) => h.filePath === "net/minecraft/server/Main.java"));

  // exact match with wrong case → no hit (case-sensitive)
  const exactMiss = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "uniquetestmarker",
    intent: "text",
    match: "exact",
    limit: 10
  });
  assert.equal(
    exactMiss.hits.filter((h) => h.filePath === "net/minecraft/server/Main.java").length,
    0
  );

  // prefix match with wrong case → hit (case-insensitive)
  const prefixHit = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "uniquetestmarker",
    intent: "text",
    match: "prefix",
    limit: 10
  });
  assert.ok(prefixHit.hits.some((h) => h.filePath === "net/minecraft/server/Main.java"));
});

test("SourceService searchClassSource with ** glob pattern does not crash", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-glob-doublestar-"));
  const binaryJarPath = join(root, "glob-test.jar");
  const sourcesJarPath = join(root, "glob-test-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/world/level/block/Blocks.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "com/example/Other.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/world/level/block/Blocks.java": [
      "package net.minecraft.world.level.block;",
      "public class Blocks {",
      "  public static final int STONE = 1;",
      "}"
    ].join("\n"),
    "net/minecraft/server/Main.java": [
      "package net.minecraft.server;",
      "public class Main {",
      "  void start() {}",
      "}"
    ].join("\n"),
    "com/example/Other.java": [
      "package com.example;",
      "public class Other {",
      "  void run() {}",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // ** glob should not throw (previously caused SyntaxError: Nothing to repeat)
  const result = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "class",
    intent: "text",
    match: "contains",
    scope: {
      fileGlob: "net/minecraft/**/*.java"
    },
    limit: 10
  });

  // Should only return files matching the glob (net/minecraft/...), not com/example/
  assert.ok(result.hits.length >= 1);
  for (const hit of result.hits) {
    assert.ok(
      hit.filePath.startsWith("net/minecraft/"),
      `Expected hit in net/minecraft/ but got ${hit.filePath}`
    );
  }
});

test("search-class-source handles representative queryMode behavior for separator queries", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  type SearchQueryModeFixture = {
    service: InstanceType<typeof SourceService>;
    artifactId: string;
  };

  const separatorQueryFixtureContent = [
    "package net.minecraft.commands;",
    "public class CommandDispatcher {",
    "  public void register() {",
    '    dispatcher.register(literal("test"));',
    "  }",
    "}"
  ].join("\n");

  async function createSearchQueryModeFixture(
    rootPrefix: string,
    configOverrides: Partial<Config> = {}
  ): Promise<SearchQueryModeFixture> {
    const root = await mkdtemp(join(tmpdir(), rootPrefix));
    const service = new SourceService(buildTestConfig(root, configOverrides));
    const jarPath = join(root, "test-sources.jar");

    await createJar(jarPath, {
      "net/minecraft/commands/CommandDispatcher.java": separatorQueryFixtureContent
    });

    const resolved = await service.resolveArtifact({
      target: { kind: "jar", value: jarPath }
    } as any);

    return {
      service,
      artifactId: resolved.artifactId
    };
  }

  const cases: Array<{
    name: string;
    rootPrefix: string;
    configOverrides?: Partial<Config>;
    run: (fixture: SearchQueryModeFixture) => Promise<void>;
  }> = [
    {
      name: "queryMode=auto keeps separator queries on the indexed path",
      rootPrefix: "service-f03-auto-",
      run: async ({ service, artifactId }) => {
        const beforePathMetrics = readSearchPathMetrics(service);
        const beforeModeMetrics = readSearchModeMetrics(service);

        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "auto"
        });

        const afterPathMetrics = readSearchPathMetrics(service);
        const afterModeMetrics = readSearchModeMetrics(service);

        assert.ok(result.hits.length > 0, "auto mode should find separator-containing query through indexed search");
        assert.equal("totalApprox" in result, false);
        assert.equal(afterPathMetrics.fallbackHits - beforePathMetrics.fallbackHits, 0);
        assert.ok(afterPathMetrics.indexedHits - beforePathMetrics.indexedHits >= 1);
        assert.equal(afterModeMetrics.autoCount - beforeModeMetrics.autoCount, 1);
        assert.equal(afterModeMetrics.explicitLiteralCount - beforeModeMetrics.explicitLiteralCount, 0);
      }
    },
    {
      name: "queryMode=token resolves separator query through normalized indexed lookup",
      rootPrefix: "service-f03-token-",
      run: async ({ service, artifactId }) => {
        const beforePathMetrics = readSearchPathMetrics(service);
        const beforeModeMetrics = readSearchModeMetrics(service);

        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "token"
        });

        const afterPathMetrics = readSearchPathMetrics(service);
        const afterModeMetrics = readSearchModeMetrics(service);

        assert.ok(result.hits.length > 0, "token mode should find separator-containing query through the indexed path");
        assert.equal(afterPathMetrics.fallbackHits - beforePathMetrics.fallbackHits, 0);
        assert.ok(afterPathMetrics.indexedHits - beforePathMetrics.indexedHits >= 1);
        assert.equal(afterModeMetrics.tokenCount - beforeModeMetrics.tokenCount, 1);
        assert.equal(afterModeMetrics.explicitLiteralCount - beforeModeMetrics.explicitLiteralCount, 0);
      }
    },
    {
      name: "queryMode=token does not fallback when indexed search is disabled",
      rootPrefix: "service-f03-token-no-index-",
      configOverrides: { indexedSearchEnabled: false },
      run: async ({ service, artifactId }) => {
        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "token"
        });
        assert.equal(result.hits.length, 0, "token mode should not fallback to literal scan when indexed search is disabled");
      }
    },
    {
      name: "queryMode=literal forces substring scan",
      rootPrefix: "service-f03-literal-",
      run: async ({ service, artifactId }) => {
        const beforePathMetrics = readSearchPathMetrics(service);
        const beforeModeMetrics = readSearchModeMetrics(service);

        const result = await service.searchClassSource({
          artifactId,
          query: "dispatcher.register",
          intent: "text",
          match: "contains",
          queryMode: "literal"
        });

        const afterPathMetrics = readSearchPathMetrics(service);
        const afterModeMetrics = readSearchModeMetrics(service);

        assert.ok(result.hits.length > 0, "literal mode should find via substring scan");
        assert.ok(afterPathMetrics.fallbackHits - beforePathMetrics.fallbackHits >= 1);
        assert.equal(afterModeMetrics.literalCount - beforeModeMetrics.literalCount, 1);
        assert.equal(afterModeMetrics.explicitLiteralCount - beforeModeMetrics.explicitLiteralCount, 1);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await createSearchQueryModeFixture(testCase.rootPrefix, testCase.configOverrides);
      await testCase.run(fixture);
    });
  }
});

// A word that starts inside an identifier: `Barriers` is part of the single
// token `removeBarriers`, so the indexed token search cannot find it.
const MID_TOKEN_SOURCES: Record<string, string> = {
  "com/example/tool/BarrierTool.java": [
    "package com.example.tool;",
    "public class BarrierTool {",
    "  void removeBarriers() {}",
    "}"
  ].join("\n"),
  "com/other/Unrelated.java": [
    "package com.other;",
    "public class Unrelated {",
    "  int pagedtoken;",
    "}"
  ].join("\n"),
  "com/other/Unrelated2.java": [
    "package com.other;",
    "public class Unrelated2 {",
    "  int pagedtoken;",
    "  int padding;",
    "}"
  ].join("\n")
};

async function createMidTokenFixture(rootPrefix: string, configOverrides: Partial<Config> = {}) {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), rootPrefix));
  const jarPath = join(root, "mid-token-sources.jar");
  await createJar(jarPath, MID_TOKEN_SOURCES);
  const service = new SourceService(buildTestConfig(root, configOverrides));
  const resolved = await service.resolveArtifact({ target: { kind: "jar", value: jarPath } } as any);
  return { service, artifactId: resolved.artifactId };
}

const TOKEN_START_WARNING_RE = /^indexed text search: no file in the searched scope has index tokens matching "Barriers"\./;

function assertTokenStartWarning(warnings: string[] | undefined): void {
  assert.equal(warnings?.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
  const [warning] = warnings!;
  assert.match(warning!, TOKEN_START_WARNING_RE);
  assert.match(warning!, /A possible cause:/);
  assert.match(warning!, /compares each query word with whole tokens/);
  assert.match(warning!, /removeBarriers/);
  assert.match(warning!, /queryMode: "literal"/);
}

test("SourceService text search warns when the indexed token search finds no token starting with the query", async (t) => {
  const { service, artifactId } = await createMidTokenFixture("service-mid-token-");

  await t.test("queryMode omitted", async () => {
    const result = await service.searchClassSource({ artifactId, query: "Barriers", intent: "text" });
    assert.deepEqual(result.hits, []);
    assertTokenStartWarning(result.warnings);
  });

  await t.test("queryMode auto", async () => {
    const result = await service.searchClassSource({ artifactId, query: "Barriers", intent: "text", queryMode: "auto" });
    assert.deepEqual(result.hits, []);
    assertTokenStartWarning(result.warnings);
  });

  await t.test("a stale cursor still gets the warning", async () => {
    const result = await service.searchClassSource({
      artifactId, query: "Barriers", intent: "text", cursor: "not-a-search-cursor"
    });
    assert.equal(result.cursorIgnored, true);
    assert.deepEqual(result.hits, []);
    assertTokenStartWarning(result.warnings);
  });

  await t.test("a token that fails only the case-exact substring check adds no warning", async () => {
    // The index ignores case, so removebarriers is a candidate; the exact check is case-sensitive.
    const result = await service.searchClassSource({ artifactId, query: "removebarriers", intent: "text", match: "exact" });
    assert.deepEqual(result.hits, []);
    assert.equal(result.warnings, undefined);
  });

  await t.test("queryMode literal finds the word and adds no warning", async () => {
    const result = await service.searchClassSource({ artifactId, query: "Barriers", intent: "text", queryMode: "literal" });
    assert.deepEqual(result.hits.map((hit) => hit.filePath), ["com/example/tool/BarrierTool.java"]);
    assert.equal(result.warnings, undefined);
  });

  await t.test("queryMode token adds no warning", async () => {
    const result = await service.searchClassSource({ artifactId, query: "Barriers", intent: "text", queryMode: "token" });
    assert.deepEqual(result.hits, []);
    assert.equal(result.warnings, undefined);
  });

  await t.test("match regex adds no warning", async () => {
    const result = await service.searchClassSource({ artifactId, query: "NoSuchWord\\d", intent: "text", match: "regex" });
    assert.deepEqual(result.hits, []);
    assert.equal(result.warnings, undefined);
  });

  await t.test("an index failure that falls back to a scan adds no warning", async () => {
    const repo = service.filesRepo;
    const original = repo.searchFileCandidates;
    repo.searchFileCandidates = () => {
      throw new Error("simulated index failure");
    };
    try {
      const result = await service.searchClassSource({ artifactId, query: "NoSuchWord", intent: "text" });
      assert.deepEqual(result.hits, []);
      assert.equal(result.warnings, undefined);
    } finally {
      repo.searchFileCandidates = original;
    }
  });

  await t.test("a query with hits adds no warning on its last page or past it", async () => {
    const { encodeSearchCursor, decodeSearchCursor } = await import("../../src/search-hit-accumulator.ts");
    const first = await service.searchClassSource({ artifactId, query: "pagedtoken", intent: "text", limit: 1 });
    assert.equal(first.hits.length, 1);
    assert.ok(first.nextCursor);
    assert.equal(first.warnings, undefined);

    const last = await service.searchClassSource({
      artifactId, query: "pagedtoken", intent: "text", limit: 1, cursor: first.nextCursor
    });
    assert.equal(last.hits.length, 1);
    assert.equal(last.nextCursor, undefined);
    assert.equal(last.warnings, undefined);

    // A cursor that points at the last hit continues past every match.
    const contextKey = decodeSearchCursor(first.nextCursor)!.contextKey;
    const past = await service.searchClassSource({
      artifactId, query: "pagedtoken", intent: "text", limit: 1, cursor: encodeSearchCursor(last.hits[0]!, contextKey)
    });
    assert.notEqual(past.cursorIgnored, true);
    assert.deepEqual(past.hits, []);
    assert.equal(past.warnings, undefined);
  });
});

test("SourceService text search adds no token warning when indexed search is disabled", async () => {
  const { service, artifactId } = await createMidTokenFixture("service-mid-token-no-index-", { indexedSearchEnabled: false });
  const result = await service.searchClassSource({ artifactId, query: "NoSuchWord", intent: "text" });
  assert.deepEqual(result.hits, []);
  assert.equal(result.warnings, undefined);
});

const PATH_PREFIX_WARNING_RE = /^the indexed paths this search examined in scope contain "BarrierTool" but none starts with it;/;

test("SourceService path search warns when in-scope paths contain the query but none starts with it", async (t) => {
  const { service, artifactId } = await createMidTokenFixture("service-path-prefix-");

  for (const match of [undefined, "prefix"] as const) {
    await t.test(`match ${match ?? "omitted"}`, async () => {
      const result = await service.searchClassSource({
        artifactId, query: "BarrierTool", intent: "path", ...(match ? { match } : {})
      });
      assert.deepEqual(result.hits, []);
      assert.equal(result.warnings?.length, 1, `expected one warning, got ${JSON.stringify(result.warnings)}`);
      const [warning] = result.warnings!;
      assert.match(warning!, PATH_PREFIX_WARNING_RE);
      assert.match(warning!, /from the start of the full file path/);
      assert.match(warning!, /match: "contains"/);
      assert.match(warning!, /find-class/);
    });
  }

  await t.test("match contains finds the path and adds no warning", async () => {
    const result = await service.searchClassSource({ artifactId, query: "BarrierTool", intent: "path", match: "contains" });
    assert.deepEqual(result.hits.map((hit) => hit.filePath), ["com/example/tool/BarrierTool.java"]);
    assert.equal(result.warnings, undefined);
  });

  await t.test("a path in scope that starts with the query adds no warning", async () => {
    const result = await service.searchClassSource({ artifactId, query: "com/example", intent: "path" });
    assert.deepEqual(result.hits.map((hit) => hit.filePath), ["com/example/tool/BarrierTool.java"]);
    assert.equal(result.warnings, undefined);
  });

  for (const scope of [{ packagePrefix: "com.other" }, { fileGlob: "**/Unrelated.java" }]) {
    await t.test(`a query only paths outside ${JSON.stringify(scope)} contain adds no warning`, async () => {
      const result = await service.searchClassSource({ artifactId, query: "BarrierTool", intent: "path", scope });
      assert.deepEqual(result.hits, []);
      assert.equal(result.warnings, undefined);
    });
  }
});

test("SourceService path search reports in-scope paths without a prefix match beside a full candidate window", async () => {
  // More paths contain the query than the 500-candidate prefix window holds.
  const entries: Record<string, string> = {};
  for (let i = 0; i < 520; i += 1) {
    const n = String(i).padStart(4, "0");
    entries[`com/many/BarrierTool${n}.java`] = `package com.many;\npublic class BarrierTool${n} {}`;
  }
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-path-prefix-window-"));
  const jarPath = join(root, "path-window-sources.jar");
  await createJar(jarPath, entries);
  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({ target: { kind: "jar", value: jarPath } } as any);

  const result = await service.searchClassSource({ artifactId: resolved.artifactId, query: "BarrierTool", intent: "path" });
  assert.deepEqual(result.hits, []);
  assert.equal(result.warnings?.length, 2, `expected two warnings, got ${JSON.stringify(result.warnings)}`);
  assert.ok(result.warnings!.some((warning) => PATH_PREFIX_WARNING_RE.test(warning)), JSON.stringify(result.warnings));
  assert.ok(result.warnings!.some((warning) => /candidate window/.test(warning)), JSON.stringify(result.warnings));
});
