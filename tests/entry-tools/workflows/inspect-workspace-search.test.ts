import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

test("InspectMinecraftService auto routes workspace search focus through project-aware artifact resolution", async () => {
  const resolveArtifactCalls: Array<{
    target:
      | { kind: "version" | "jar" | "coordinate"; value: string }
      | { kind: "workspace"; scope?: "vanilla" | "merged" | "loader" };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }> = [];
  let searchCalls = 0;
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input) => {
      resolveArtifactCalls.push(input);
      return {
        artifactId: "artifact-search",
        origin: "local-jar",
        isDecompiled: false,
        requestedMapping: input.mapping,
        mappingApplied: input.mapping ?? "obfuscated",
        version: input.target.kind === "workspace" ? "1.21.10" : input.target.value,
        provenance: { requestedTarget: input.target },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    searchClassSource: async (input) => {
      searchCalls += 1;
      assert.equal(input.artifactId, "artifact-search");
      assert.equal(input.query, "tickServer");
      assert.equal(input.queryMode, "auto");
      return {
        artifactId: input.artifactId,
        query: input.query,
        hits: [{ filePath: "net/minecraft/server/MinecraftServer.java", score: 120, matchedIn: "content", preview: "tickServer" }],
        nextCursor: "cursor-next-1",
        cursorIgnored: true,
        mappingApplied: "mojang",
        returnedNamespace: "mojang",
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      };
    },
    detectProjectMinecraftVersion: async () => "1.21.10"
  }));

  const result = await service.execute({
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      mapping: "mojang",
      scope: "merged",
      preferProjectVersion: true,
      focus: {
        kind: "search",
        query: "tickServer"
      }
    }
  });

  assert.equal(result.task, "search");
  assert.equal(result.summary.status, "ok");
  assert.equal(searchCalls, 1);
  // Summary mode omits the `search` block, so continuation state must surface in
  // meta.pagination or the caller would stop after the first page.
  assert.equal((result as { search?: unknown }).search, undefined);
  const pagination = (result as { meta?: { pagination?: Record<string, unknown> } }).meta?.pagination;
  assert.equal(pagination?.nextCursor, "cursor-next-1");
  assert.equal(pagination?.hasMore, true);
  assert.equal(pagination?.returnedCount, 1);
  assert.equal(pagination?.cursorIgnored, true);
  assert.deepEqual(result.summary.subject, {
    task: "search",
    query: "tickServer",
    artifactId: "artifact-search"
  });
  // The raw requested subject survives exactly once, in the always-on subject block.
  assert.deepEqual((result as { subject?: { requested?: unknown } }).subject?.requested, {
    kind: "workspace",
    projectPath: "/workspace/demo-mod",
    mapping: "mojang",
    scope: "merged",
    preferProjectVersion: true,
    focus: {
      kind: "search",
      query: "tickServer"
    }
  });
  assert.deepEqual(resolveArtifactCalls, [
    {
      target: { kind: "workspace" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});

for (const subjectKind of ["workspace", "search"] as const) {
  for (const page of [
    { hitCount: 0, nextCursor: undefined },
    { hitCount: 3, nextCursor: undefined },
    { hitCount: 7, nextCursor: undefined },
    { hitCount: 7, nextCursor: "cursor-after-fetched-page" }
  ]) {
    test(`inspect-minecraft ${subjectKind} summary samples retain ${Math.min(page.hitCount, 5)} of ${page.hitCount} hits and the original ${page.nextCursor ? "continuation" : "page end"}`, async () => {
      const hits = ["Zulu", "Alpha", "Echo", "Bravo", "Delta", "Foxtrot", "Charlie"]
        .slice(0, page.hitCount)
        .map((name, index) => ({
          filePath: `net/minecraft/${name}.java`,
          score: 100 - index,
          matchedIn: "content" as const,
          preview: "sampleQuery"
        }));
      const artifactContents = {
        sourceKind: "source-jar" as const,
        indexedContentKinds: ["sources"],
        resourcesIncluded: false,
        sourceCoverage: "full" as const
      };
      const service = new InspectMinecraftService(buildInspectDeps({
        resolveArtifact: async () => ({
          artifactId: "artifact-samples",
          origin: "local-jar",
          isDecompiled: false,
          requestedMapping: "mojang",
          mappingApplied: "mojang",
          version: "1.21.10",
          provenance: { requestedTarget: { kind: "workspace" } },
          qualityFlags: [],
          artifactContents,
          warnings: []
        }),
        searchClassSource: async (input) => {
          assert.equal(input.artifactId, "artifact-samples");
          assert.equal(input.query, "sampleQuery");
          assert.equal(input.limit, 10);
          assert.equal(input.cursor, "cursor-requested-page");
          return {
            artifactId: input.artifactId,
            query: input.query,
            hits,
            nextCursor: page.nextCursor,
            mappingApplied: "mojang",
            returnedNamespace: "mojang",
            artifactContents,
            warnings: []
          };
        }
      }));
      const subject = subjectKind === "workspace"
        ? {
            kind: "workspace" as const,
            projectPath: "/workspace/sample-mod",
            mapping: "mojang" as const,
            focus: { kind: "search" as const, query: "sampleQuery" }
          }
        : {
            kind: "search" as const,
            query: "sampleQuery",
            artifact: { type: "resolved-id" as const, artifactId: "artifact-samples" }
          };
      const request = { task: "search" as const, subject, limit: 10, cursor: "cursor-requested-page" };
      const sampled = await service.execute({ ...request, detail: "summary", include: ["samples"] });
      const sampledSearch = sampled.search as { hits: typeof hits; nextCursor?: string } | undefined;

      assert.ok(sampledSearch, "summary with samples must expose the existing search block, including on a miss");
      const expectedPaths = page.hitCount === 0 ? [] : page.hitCount === 3
        ? ["net/minecraft/Zulu.java", "net/minecraft/Alpha.java", "net/minecraft/Echo.java"]
        : ["net/minecraft/Zulu.java", "net/minecraft/Alpha.java", "net/minecraft/Echo.java", "net/minecraft/Bravo.java", "net/minecraft/Delta.java"];
      assert.deepEqual(sampledSearch.hits.map((hit) => hit.filePath), expectedPaths);
      assert.equal(sampled.summary.counts?.hits, page.hitCount);
      assert.equal(sampled.summary.status, page.hitCount === 0 ? "not_found" : "ok");
      assert.equal(sampledSearch.nextCursor, page.nextCursor);
      assert.deepEqual(sampled.meta?.pagination, {
        returnedCount: expectedPaths.length,
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      });

      const summary = await service.execute({ ...request, detail: "summary" });
      assert.equal(summary.search, undefined);
      assert.deepEqual(summary.summary, sampled.summary);
      assert.deepEqual(summary.meta?.pagination, sampled.meta?.pagination);
      for (const detail of ["standard", "full"] as const) {
        for (const include of [undefined, ["samples"]]) {
          const complete = await service.execute({ ...request, detail, include });
          assert.deepEqual(complete.search, { query: "sampleQuery", hits, nextCursor: page.nextCursor });
          assert.equal((complete.meta?.pagination as { returnedCount: number }).returnedCount, page.hitCount);
        }
      }
    });
  }
}
