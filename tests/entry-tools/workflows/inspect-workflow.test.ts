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

// class-members always collapses its subject to a single artifactId before
// calling get-class-members, so the bare presence of an artifactId there says
// nothing about who chose the artifact. Left to infer, get-class-members read it
// as the caller's own choice and reported a missing binary jar as their mistake,
// even for an artifact this tool picked out of the workspace. `artifactSelectedBy`
// carries the answer explicitly; the two tests below pin both directions of it.
const membersStub = (seen: Array<string | undefined>) => async (input: { artifactSelectedBy?: string }) => {
  seen.push(input.artifactSelectedBy);
  return {
    className: "com.example.Widget",
    artifactId: "artifact-selected-by",
    counts: { total: 0, constructors: 0, methods: 0, fields: 0 },
    truncated: false,
    members: { constructors: [], fields: [], methods: [] },
    returnedNamespace: "obfuscated",
    warnings: []
  };
};

const resolvedArtifactStub = async () => ({
  artifactId: "artifact-selected-by",
  origin: "local-jar" as const,
  isDecompiled: false,
  mappingApplied: "obfuscated" as const,
  version: "1.21.10",
  provenance: {},
  qualityFlags: [],
  artifactContents: { sourceKind: "source-jar" as const, indexedContentKinds: ["sources"], resourcesIncluded: false, sourceCoverage: "full" as const },
  warnings: []
});

test("InspectMinecraftService forwards artifactSelectedBy:\"tool\" when it resolved the artifact itself", async () => {
  const seen: Array<string | undefined> = [];
  const deps = () => buildInspectDeps({
    resolveArtifact: resolvedArtifactStub,
    getClassMembers: membersStub(seen),
    listWorkspaceContexts: () => [{ projectPath: "/ws", minecraftVersion: "1.21.10" }]
  });

  // A resolve-target subject: the caller named a version or a coordinate, and the
  // artifact behind it is whatever resolution produced.
  await new InspectMinecraftService(deps()).execute({
    task: "class-members",
    detail: "full",
    subject: {
      kind: "class" as const,
      className: "com.example.Widget",
      artifact: { type: "resolve-target" as const, target: { kind: "version" as const, value: "1.21.10" } }
    }
  });
  await new InspectMinecraftService(deps()).execute({
    task: "class-members",
    detail: "full",
    subject: {
      kind: "class" as const,
      className: "com.example.Widget",
      artifact: { type: "resolve-target" as const, target: { kind: "coordinate" as const, value: "net.minecraft:client:1.21.10" } }
    }
  });
  // No artifact reference at all: the workspace auto-resolution picks one, which
  // is the case the caller has the least say in.
  await new InspectMinecraftService(deps()).execute({
    task: "class-members",
    detail: "full",
    subject: { kind: "class" as const, className: "com.example.Widget" }
  });

  assert.deepEqual(seen, ["tool", "tool", "tool"]);
});

test("InspectMinecraftService forwards artifactSelectedBy:\"caller\" when the subject names the artifact", async () => {
  const seen: Array<string | undefined> = [];
  const deps = () => buildInspectDeps({
    resolveArtifact: resolvedArtifactStub,
    getClassMembers: membersStub(seen)
  });

  // A resolved-id names the artifact outright.
  await new InspectMinecraftService(deps()).execute({
    task: "class-members",
    detail: "full",
    subject: {
      kind: "class" as const,
      className: "com.example.Widget",
      artifact: { type: "resolved-id" as const, artifactId: "artifact-selected-by" }
    }
  });
  // A jar target names the exact jar, so its lack of a binary companion is the
  // caller's own input to change.
  await new InspectMinecraftService(deps()).execute({
    task: "class-members",
    detail: "full",
    subject: {
      kind: "class" as const,
      className: "com.example.Widget",
      artifact: { type: "resolve-target" as const, target: { kind: "jar" as const, value: "/tmp/named-by-caller.jar" } }
    }
  });

  assert.deepEqual(seen, ["caller", "caller"]);
});
