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

  // A jar target names the exact jar, so its lack of a binary companion is the
  // caller's own input to change. It is the ONLY subject shape that does: the
  // resolved-id arm that used to sit beside it here now belongs to the "tool"
  // test below.
  await new InspectMinecraftService(deps()).execute({
    task: "class-members",
    detail: "full",
    subject: {
      kind: "class" as const,
      className: "com.example.Widget",
      artifact: { type: "resolve-target" as const, target: { kind: "jar" as const, value: "/tmp/named-by-caller.jar" } }
    }
  });

  assert.deepEqual(seen, ["caller"]);
});

// A `resolved-id` subject is written by the caller, which is why it first read
// as their choice - but writing an id down is not the same as choosing the
// artifact behind it. The id is an opaque handle from an earlier resolve: it
// carries no signal about a binary jar and cannot be re-resolved into one that
// has it, so the caller has nothing to fix. `get-class-members` reaches the same
// verdict for the wire-level twin of this subject, `target: { kind: "artifact",
// artifactId }`; the two differ only in wrapper syntax, and answering the same
// question two ways would be the real defect.
test("InspectMinecraftService forwards artifactSelectedBy:\"tool\" for a resolved-id subject it cannot vet", async () => {
  const seen: Array<string | undefined> = [];
  const deps = buildInspectDeps({
    resolveArtifact: resolvedArtifactStub,
    getClassMembers: membersStub(seen)
  });

  await new InspectMinecraftService(deps).execute({
    task: "class-members",
    detail: "full",
    subject: {
      kind: "class" as const,
      className: "com.example.Widget",
      artifact: { type: "resolved-id" as const, artifactId: "artifact-selected-by" }
    }
  });

  assert.deepEqual(seen, ["tool"]);
});

// The two tests above pin the forwarded FLAG. The two below follow it all the
// way to the wire: the per-task call is the real get-class-members against a
// real artifact that has sources but no binary jar, so the `issueOrigin` they
// assert is the one a calling agent actually receives.
async function buildNoBinaryInspectDeps(): Promise<{
  deps: ReturnType<typeof buildInspectDeps>;
  artifactId: string;
}> {
  const { SourceService } = await import("../../../src/source-service.ts");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildTestConfig } = await import("../../helpers/test-config.ts");
  const { seedIndexedArtifact } = await import("../../helpers/seed-artifact.ts");
  const { createJar } = await import("../../helpers/zip.ts");

  const root = await mkdtemp(join(tmpdir(), "inspect-members-no-binary-"));
  const sourceJarPath = join(root, "source-only.jar");
  await createJar(sourceJarPath, {
    "com/example/Demo.java": "package com.example;\npublic class Demo {}"
  });

  const artifactId = "inspect-source-only-artifact";
  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    sourceJarPath,
    files: [{ filePath: "com/example/Demo.java", content: "package com.example;\npublic class Demo {}" }],
    symbols: []
  });

  return {
    artifactId,
    deps: buildInspectDeps({
      // Whatever the subject asks to resolve, resolution lands on that
      // binary-jar-less artifact; only the SUBJECT SHAPE differs between the
      // two tests, which is exactly the variable under test.
      resolveArtifact: async () => ({
        artifactId,
        origin: "local-m2" as const,
        isDecompiled: false,
        mappingApplied: "obfuscated" as const,
        version: "1.21.10",
        provenance: {},
        qualityFlags: [],
        artifactContents: {
          sourceKind: "source-jar" as const,
          indexedContentKinds: ["sources"],
          resourcesIncluded: false,
          sourceCoverage: "full" as const
        },
        warnings: []
      }),
      getClassMembers: (input: unknown) =>
        (service as unknown as { getClassMembers: (value: unknown) => Promise<unknown> })
          .getClassMembers(input)
    })
  };
}

async function inspectClassMembersProblem(
  deps: ReturnType<typeof buildInspectDeps>,
  artifact: { type: "resolved-id"; artifactId: string } | { type: "resolve-target"; target: { kind: "jar"; value: string } },
  instance: string
): Promise<{ code?: string; issueOrigin?: string }> {
  const { mapErrorToProblem } = await import("../../../src/tool-guidance.ts");
  const caught = await new InspectMinecraftService(deps)
    .execute({
      task: "class-members",
      detail: "full",
      subject: { kind: "class" as const, className: "com.example.Demo", artifact }
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );
  assert.notEqual(caught, undefined, "the lookup must fail: the artifact has no binary jar");
  return mapErrorToProblem(caught, instance) as { code?: string; issueOrigin?: string };
}

test("inspect-minecraft class-members reports a tool issue for a resolved-id subject with no binary jar", async () => {
  const { ERROR_CODES } = await import("../../../src/errors.ts");
  const { issueOriginForErrorCode } = await import("../../../src/error-mapping.ts");
  const { deps, artifactId } = await buildNoBinaryInspectDeps();

  const problem = await inspectClassMembersProblem(
    deps,
    { type: "resolved-id", artifactId },
    "inspect-members-resolved-id-req"
  );

  assert.equal(problem.code, ERROR_CODES.CONTEXT_UNRESOLVED);
  assert.equal(
    problem.issueOrigin,
    "tool_issue",
    "a resolved-id subject hands over an opaque handle the caller cannot vet, so the missing binary jar is not their input to fix"
  );
  // Guard against passing for the wrong reason: the verdict must come from this
  // throw site's override, not from the code-keyed default having drifted.
  assert.equal(
    issueOriginForErrorCode(ERROR_CODES.CONTEXT_UNRESOLVED),
    "code_issue",
    "the code-keyed default must stay code_issue so the override is what is being observed"
  );
});

test("inspect-minecraft class-members keeps a code issue for a jar-target subject with no binary jar", async () => {
  const { ERROR_CODES } = await import("../../../src/errors.ts");
  const { deps } = await buildNoBinaryInspectDeps();

  const problem = await inspectClassMembersProblem(
    deps,
    { type: "resolve-target", target: { kind: "jar", value: "/nonexistent/named-by-caller.jar" } },
    "inspect-members-jar-target-req"
  );

  assert.equal(problem.code, ERROR_CODES.CONTEXT_UNRESOLVED);
  assert.equal(
    problem.issueOrigin,
    "code_issue",
    "the caller named this jar themselves, so its lack of a binary companion is their input to fix"
  );
});
