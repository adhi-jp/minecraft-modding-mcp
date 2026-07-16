import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

test("InspectMinecraftService returns ambiguous class overview with follow-up candidates", async () => {
  const service = new InspectMinecraftService(buildInspectDeps({
    resolveArtifact: async () => ({
      artifactId: "artifact-1",
      origin: "local-jar",
      isDecompiled: false,
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      provenance: { requestedTarget: { kind: "jar", value: "/tmp/test.jar" } },
      qualityFlags: [],
      artifactContents: {
        sourceKind: "source-jar",
        indexedContentKinds: ["sources"],
        resourcesIncluded: false,
        sourceCoverage: "full"
      },
      warnings: []
    }),
    findClass: async () => ({
      total: 2,
      warnings: [],
      matches: [
        {
          qualifiedName: "net.minecraft.Blocks",
          filePath: "net/minecraft/Blocks.java",
          line: 1,
          symbolKind: "class"
        },
        {
          qualifiedName: "com.example.Blocks",
          filePath: "com/example/Blocks.java",
          line: 1,
          symbolKind: "class"
        }
      ]
    }),
    detectProjectMinecraftVersion: async () => undefined
  }));

  const result = await service.execute({
    task: "class-overview",
    detail: "summary",
    include: ["candidates"],
    subject: {
      kind: "class",
      className: "Blocks",
      artifact: {
        type: "resolved-id",
        artifactId: "artifact-1"
      }
    }
  });

  assert.equal(result.summary.status, "ambiguous");
  assert.equal(result.summary.counts?.matches, 2);
  assert.equal(result.candidates?.length, 2);
});
