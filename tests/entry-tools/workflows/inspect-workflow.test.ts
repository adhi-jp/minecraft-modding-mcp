import assert from "node:assert/strict";
import test from "node:test";

import {
  InspectMinecraftService,
  inspectMinecraftSchema
} from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { buildInspectDeps } from "../../helpers/inspect-deps.ts";

test("InspectMinecraftService forwards include:[\"descriptors\"] to getClassMembers as includeDescriptors", async () => {
  const seen: Array<{ includeDescriptors?: boolean }> = [];
  const makeDeps = () => buildInspectDeps({
    resolveArtifact: async () => ({
      artifactId: "artifact-desc",
      origin: "local-jar" as const,
      isDecompiled: false,
      mappingApplied: "obfuscated" as const,
      version: "1.21.10",
      provenance: {},
      qualityFlags: [],
      artifactContents: { sourceKind: "source-jar" as const, indexedContentKinds: ["sources"], resourcesIncluded: false, sourceCoverage: "full" as const },
      warnings: []
    }),
    getClassMembers: async (input: { includeDescriptors?: boolean }) => {
      seen.push({ includeDescriptors: input.includeDescriptors });
      return {
        className: "com.example.Widget",
        artifactId: "artifact-desc",
        counts: { total: 0, constructors: 0, methods: 0, fields: 0 },
        truncated: false,
        members: { constructors: [], fields: [], methods: [] },
        returnedNamespace: "obfuscated",
        warnings: []
      };
    }
  });

  const subject = { kind: "class" as const, className: "com.example.Widget", artifact: { type: "resolved-id" as const, artifactId: "artifact-desc" } };

  await new InspectMinecraftService(makeDeps()).execute({ task: "class-members", detail: "full", subject });
  await new InspectMinecraftService(makeDeps()).execute({ task: "class-members", detail: "full", include: ["descriptors"], subject });

  assert.equal(seen[0]!.includeDescriptors, false, "default omits field descriptors");
  assert.equal(seen[1]!.includeDescriptors, true, "include:[descriptors] opts field descriptors back in");
});
