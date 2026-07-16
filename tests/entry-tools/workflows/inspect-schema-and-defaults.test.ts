import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

test("inspectMinecraftSchema applies defaults while keeping non-version includeSnapshots validation precise", () => {
  const parsedArtifact = inspectMinecraftSchema.parse({
    task: "artifact",
    subject: {
      kind: "version",
      version: "1.21.10"
    }
  });
  assert.equal(parsedArtifact.includeSnapshots, false);

  const parsedSearch = inspectMinecraftSchema.parse({
    task: "search",
    subject: {
      kind: "search",
      query: "tickServer"
    }
  });
  if (parsedSearch.subject?.kind !== "search") {
    throw new Error("Expected search subject");
  }
  assert.equal(parsedSearch.subject.queryMode, "auto");

  const parsedWorkspaceSearch = inspectMinecraftSchema.parse({
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      focus: {
        kind: "search",
        query: "tickServer"
      }
    }
  });
  if (parsedWorkspaceSearch.subject?.kind !== "workspace" || parsedWorkspaceSearch.subject.focus?.kind !== "search") {
    throw new Error("Expected workspace search focus");
  }
  assert.equal(parsedWorkspaceSearch.subject.focus.queryMode, "auto");

  assert.throws(
    () => inspectMinecraftSchema.parse({
      task: "artifact",
      includeSnapshots: true,
      subject: {
        kind: "version",
        version: "1.21.10"
      }
    }),
    /includeSnapshots is only supported for task=versions/
  );
});

test("InspectMinecraftService preserves gradleUserHome through schema parsing and artifact resolution", async () => {
  let seenGradleUserHome: string | undefined;
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async (input: { gradleUserHome?: string }) => {
      seenGradleUserHome = input.gradleUserHome;
      return {
        artifactId: "minecraft-1.21.10",
        artifactAlias: "minecraft-1.21.10",
        origin: "local-jar",
        isDecompiled: false,
        version: "1.21.10",
        requestedMapping: "mojang",
        mappingApplied: "mojang",
        provenance: {
          target: { kind: "version", value: "1.21.10" },
          resolvedAt: new Date().toISOString(),
          resolvedFrom: { origin: "local-jar", version: "1.21.10" },
          transformChain: []
        },
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar",
          indexedContentKinds: ["java"],
          resourcesIncluded: false,
          sourceCoverage: "full"
        },
        warnings: []
      } as any;
    }
  }));

  const parsed = inspectMinecraftSchema.parse({
    task: "artifact",
    subject: {
      kind: "version",
      version: "1.21.10",
      mapping: "mojang",
      scope: "merged",
      gradleUserHome: "/tmp/explicit-gradle-home"
    }
  });

  await service.execute(parsed as any);

  assert.equal(seenGradleUserHome, "/tmp/explicit-gradle-home");
});

test("InspectMinecraftService task=versions surfaces the listVersions clamp warning", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    listVersions: async () => ({
      latest: { release: "1.21.10" },
      releases: [{ id: "1.21.10", unobfuscated: true }],
      cached: [],
      totalAvailable: 1,
      warnings: ["limit was clamped to 200 from 100000."]
    })
  }));

  const result = (await service.execute({
    task: "versions",
    detail: "summary",
    limit: 100000
  } as any)) as { warnings?: string[] };

  assert.ok(
    (result.warnings ?? []).some((w) => /limit was clamped to 200 from 100000\./.test(w)),
    "inspect-minecraft task=versions must surface the listVersions clamp warning"
  );
});

test("InspectMinecraftService omits includeSnapshots=false from versions summary subject", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    listVersions: async () => ({
      latest: {
        release: "1.21.10",
        snapshot: "25w10a"
      },
      releases: [{ id: "1.21.10", unobfuscated: true }],
      snapshots: [],
      cached: ["1.21.10"],
      totalAvailable: 1
    })
  }));

  const result = await service.execute({
    task: "versions",
    detail: "summary"
  });

  assert.deepEqual(result.summary.subject, {
    task: "versions",
    kind: "versions"
  });
});
