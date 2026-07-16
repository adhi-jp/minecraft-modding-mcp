import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

test("InspectMinecraftService auto routes workspace search focus through project-aware artifact resolution", async () => {
  const resolveArtifactCalls: Array<{
    target: { kind: "version" | "jar" | "coordinate"; value: string };
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
        version: input.target.value,
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
      target: { kind: "version", value: "1.21.10" },
      mapping: "mojang",
      scope: "merged",
      projectPath: "/workspace/demo-mod",
      preferProjectVersion: true,
      strictVersion: undefined
    }
  ]);
});
