import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { parseCoordinate } from "../../src/maven-resolver.ts";
import { SourceService } from "../../src/source-service.ts";
import { createWorkspaceContextCache } from "../../src/workspace-context-cache.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

type AnySourceService = SourceService & {
  synthesizeDependencyTarget: (
    input: Record<string, unknown>,
    dep: Record<string, unknown>
  ) => Promise<unknown>;
  workspaceContextCache: ReturnType<typeof createWorkspaceContextCache>;
};

async function makeHost(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dep-target-host-"));
  await mkdir(join(root, "cache"), { recursive: true });
  return root;
}

test("synthesizeDependencyTarget resolves explicit version directly", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeDependencyTarget(
    { target: { kind: "dependency" } },
    { kind: "dependency", group: "dev.architectury", name: "architectury", version: "13.0.0" }
  )) as {
    target: { kind: string; value: string };
    provenance: { resolvedVersion: string; source: string; cacheHit: boolean };
  };

  assert.equal(synthesized.target.kind, "coordinate");
  assert.equal(synthesized.target.value, "dev.architectury:architectury:13.0.0");
  assert.equal(synthesized.provenance.resolvedVersion, "13.0.0");
  assert.equal(synthesized.provenance.source, "explicit");
});

test("synthesizeDependencyTarget reads architectury_version from gradle.properties", async () => {
  const project = await mkdtemp(join(tmpdir(), "dep-target-arch-"));
  await writeFile(join(project, "gradle.properties"), "architectury_version=13.0.0\n", "utf8");
  const host = await makeHost();
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeDependencyTarget(
    { target: { kind: "dependency" }, projectPath: project },
    { kind: "dependency", group: "dev.architectury", name: "architectury" }
  )) as {
    target: { value: string };
    provenance: { resolvedVersion: string; source: string };
  };

  assert.equal(synthesized.target.value, "dev.architectury:architectury:13.0.0");
  assert.match(synthesized.provenance.source, /architectury_version/);
});

test("synthesizeDependencyTarget refuses to pick when modules-2 has multiple cached versions", async () => {
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-dep-"));
  const cacheDir = join(
    fakeGradleHome,
    "caches",
    "modules-2",
    "files-2.1",
    "dev.architectury",
    "architectury"
  );
  await mkdir(cacheDir, { recursive: true });
  for (const v of ["12.4.0", "13.0.0"]) {
    await mkdir(join(cacheDir, v), { recursive: true });
  }

  const project = await mkdtemp(join(tmpdir(), "dep-target-modules2-"));
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: createWorkspaceContextCache() }
    ) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" }, projectPath: project },
          { kind: "dependency", group: "dev.architectury", name: "architectury" }
        ),
      (err: Error & { code?: string; details?: { ambiguous?: boolean; candidatesSeen?: string[] } }) => {
        assert.equal(err.code, ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED);
        assert.equal(err.details?.ambiguous, true);
        assert.ok(err.details?.candidatesSeen?.includes("13.0.0"));
        assert.ok(err.details?.candidatesSeen?.includes("12.4.0"));
        return true;
      }
    );
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("synthesizeDependencyTarget throws ERR_DEPENDENCY_VERSION_UNRESOLVED when neither source has the dependency", async () => {
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-empty-dep-"));
  const project = await mkdtemp(join(tmpdir(), "dep-target-unresolved-"));
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: createWorkspaceContextCache() }
    ) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" }, projectPath: project },
          { kind: "dependency", group: "dev.architectury", name: "architectury" }
        ),
      (err: Error & {
        code?: string;
        details?: {
          suggestedCall?: unknown;
          exampleCalls?: Array<{ params?: { target?: { version?: string } } }>;
        };
      }) => {
        assert.equal(err.code, ERROR_CODES.DEPENDENCY_VERSION_UNRESOLVED);
        // The placeholder version is a fill-in template, not an executable call.
        assert.equal(err.details?.suggestedCall, undefined);
        assert.equal(err.details?.exampleCalls?.[0]?.params?.target?.version, "<your-version>");
        return true;
      }
    );
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("synthesizeDependencyTarget rejects unsafe explicit version tokens", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  for (const badVersion of ["../1.0", "1.0/etc", "1.0\\bad", "..", "1\\0bad"]) {
    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" } },
          { kind: "dependency", group: "g.example", name: "lib", version: badVersion }
        ),
      (err: Error & { code?: string; details?: { fieldErrors?: Array<{ path?: string }> } }) => {
        assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
        assert.equal(err.details?.fieldErrors?.[0]?.path, "target.version");
        return true;
      }
    );
  }
});

test("synthesizeDependencyTarget rejects path traversal characters in group/name", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  await assert.rejects(
    () =>
      service.synthesizeDependencyTarget(
        { target: { kind: "dependency" } },
        { kind: "dependency", group: "../etc", name: "passwd", version: "1.0.0" }
      ),
    (err: Error & { code?: string }) => err.code === ERROR_CODES.INVALID_INPUT
  );
});

test("synthesizeDependencyTarget rejects empty group or name with INVALID_INPUT", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  // group/name emptiness is checked before the version safety check, so a valid
  // version still surfaces the missing-coordinate field error.
  const cases: Array<{ group: string; name: string; expectedPath: string }> = [
    { group: "", name: "architectury", expectedPath: "target.group" },
    { group: "   ", name: "architectury", expectedPath: "target.group" },
    { group: "dev.architectury", name: "", expectedPath: "target.name" }
  ];

  for (const { group, name, expectedPath } of cases) {
    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" } },
          { kind: "dependency", group, name, version: "1.0.0" }
        ),
      (err: Error & { code?: string; details?: { fieldErrors?: Array<{ path?: string }> } }) => {
        assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
        assert.equal(err.details?.fieldErrors?.[0]?.path, expectedPath);
        return true;
      }
    );
  }
});

test("synthesizeDependencyTarget rejects when versionFromProject=false and no version is given", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  await assert.rejects(
    () =>
      service.synthesizeDependencyTarget(
        { target: { kind: "dependency" } },
        {
          kind: "dependency",
          group: "dev.architectury",
          name: "architectury",
          versionFromProject: false
        }
      ),
    (err: Error & { code?: string; details?: { fieldErrors?: Array<{ path?: string }> } }) => {
      assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(err.details?.fieldErrors?.[0]?.path, "target.version");
      return true;
    }
  );
});

test("synthesizeDependencyTarget reuses WorkspaceContextCache on subsequent calls", async () => {
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-cached-"));
  const cacheDir = join(
    fakeGradleHome,
    "caches",
    "modules-2",
    "files-2.1",
    "g.example",
    "lib"
  );
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(cacheDir, "1.0.0"), { recursive: true });

  const project = await mkdtemp(join(tmpdir(), "dep-target-cache-"));
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const cache = createWorkspaceContextCache();
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: cache }
    ) as unknown as AnySourceService;

    const first = (await service.synthesizeDependencyTarget(
      { target: { kind: "dependency" }, projectPath: project },
      { kind: "dependency", group: "g.example", name: "lib" }
    )) as { provenance: { cacheHit: boolean } };
    const second = (await service.synthesizeDependencyTarget(
      { target: { kind: "dependency" }, projectPath: project },
      { kind: "dependency", group: "g.example", name: "lib" }
    )) as { provenance: { cacheHit: boolean } };

    assert.equal(first.provenance.cacheHit, false);
    assert.equal(second.provenance.cacheHit, true);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("synthesizeDependencyTarget rejects target.kind=dependency when DEPENDENCY_TARGET_OFF is set", async () => {
  process.env.DEPENDENCY_TARGET_OFF = "1";
  try {
    const sourceServiceModule = await import(
      `../../src/source-service.ts?toggle=dep-${Date.now()}`
    );
    const host = await makeHost();
    const service = new sourceServiceModule.SourceService(buildTestConfig(host)) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" } },
          { kind: "dependency", group: "g", name: "n", version: "1.0.0" }
        ),
      (err: Error & { code?: string }) => err.code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    delete process.env.DEPENDENCY_TARGET_OFF;
  }
});

test("synthesizeDependencyTarget tries the de-duplicated property keys for a hyphen-less name", async () => {
  const project = await mkdtemp(join(tmpdir(), "dep-target-keys-"));
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-keys-"));
  await writeFile(join(project, "gradle.properties"), "# none\n", "utf8");
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: createWorkspaceContextCache() }
    ) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" }, projectPath: project },
          { kind: "dependency", group: "dev.architectury", name: "architectury" }
        ),
      (err: Error & { details?: { attempts?: string[] } }) => {
        const props = (err.details?.attempts ?? []).filter((entry) => entry.startsWith("gradle.properties:"));
        assert.deepEqual(props, [
          "gradle.properties:architectury_version",
          "gradle.properties:architecturyVersion",
          "gradle.properties:architectury_architectury_version",
          "gradle.properties:architecturyArchitecturyVersion"
        ]);
        return true;
      }
    );
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("synthesizeDependencyTarget carries umbrella POM adoption provenance to the coordinate target", async () => {
  const project = await mkdtemp(join(tmpdir(), "dep-target-pom-adopt-"));
  await writeFile(join(project, "gradle.properties"), "fabric_api_version=0.131.0\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-target-pom-"));
  const modulesRoot = join(fakeGradleHome, "caches", "modules-2", "files-2.1", "net.fabricmc.fabric-api");
  for (const version of ["2.0.5+06488ac19c", "2.0.5+06488ac19e"]) {
    await mkdir(join(modulesRoot, "fabric-screen-handler-api-v1", version), { recursive: true });
  }
  const pomDir = join(modulesRoot, "fabric-api", "0.131.0", "0f148680b920d01cbdca2111");
  await mkdir(pomDir, { recursive: true });
  await writeFile(
    join(pomDir, "fabric-api-0.131.0.pom"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<project>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>net.fabricmc.fabric-api</groupId>",
      "      <artifactId>fabric-screen-handler-api-v1</artifactId>",
      "      <version>2.0.5+06488ac19e</version>",
      "    </dependency>",
      "  </dependencies>",
      "</project>",
      ""
    ].join("\n"),
    "utf8"
  );
  const host = await makeHost();

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new SourceService(
      buildTestConfig(host),
      undefined,
      { workspaceContextCache: createWorkspaceContextCache() }
    ) as unknown as AnySourceService;

    const synthesized = (await service.synthesizeDependencyTarget(
      { target: { kind: "dependency" }, projectPath: project },
      { kind: "dependency", group: "net.fabricmc.fabric-api", name: "fabric-screen-handler-api-v1" }
    )) as {
      target: { kind: string; value: string };
      provenance: {
        resolvedVersion: string;
        source: string;
        submoduleVersionSource?: string;
        candidatesSeen?: string[];
      };
    };

    assert.equal(synthesized.target.kind, "coordinate");
    assert.equal(
      synthesized.target.value,
      "net.fabricmc.fabric-api:fabric-screen-handler-api-v1:2.0.5+06488ac19e"
    );
    assert.equal(synthesized.provenance.submoduleVersionSource, "umbrella-pom");
    assert.match(synthesized.provenance.source, /^umbrella-pom:/);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("get-class-members accepts and dispatches a dependency target", async () => {
  // Schema-level: the source-lookup tools accept a dependency target verbatim.
  const { getClassMembersSchema } = await import("../../src/tool-schemas.ts");
  const parsed = getClassMembersSchema.parse({
    className: "net.fabricmc.fabric.api.event.player.UseEntityCallback",
    target: {
      kind: "dependency",
      group: "net.fabricmc.fabric-api",
      name: "fabric-api",
      versionFromProject: true
    }
  });
  assert.deepEqual(parsed.target, {
    kind: "dependency",
    group: "net.fabricmc.fabric-api",
    name: "fabric-api",
    versionFromProject: true
  });

  // Dispatch-level: getClassMembers forwards the dependency target to resolveArtifact.
  const root = await mkdtemp(join(tmpdir(), "dep-target-dispatch-"));
  const service = new SourceService(buildTestConfig(root));
  let seenTarget: unknown;
  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async (
    input: { target: unknown }
  ) => {
    seenTarget = input.target;
    throw new Error("stop-after-resolve");
  };

  await assert.rejects(
    service.getClassMembers({
      className: "net.fabricmc.fabric.api.event.player.UseEntityCallback",
      target: {
        kind: "dependency",
        group: "net.fabricmc.fabric-api",
        name: "fabric-api",
        versionFromProject: true
      }
    }),
    /stop-after-resolve/
  );
  assert.deepEqual(seenTarget, {
    kind: "dependency",
    group: "net.fabricmc.fabric-api",
    name: "fabric-api",
    versionFromProject: true
  });
});

test("get-class-members reports unknown minecraftVersion for a dependency artifact", async () => {
  // Regression: the response context used to carry a plausible-but-wrong
  // Minecraft version for dependency artifacts. Two independent sources were
  // wrong - the jar path heuristic (which greps the Gradle cache constant
  // "2.1" out of ".../files-2.1/...") and the resolver's `version` (which for
  // a dependency is the artifact's OWN coordinate version). Both must yield
  // the "unknown" sentinel instead.
  const root = await mkdtemp(join(tmpdir(), "dep-target-context-"));
  const cacheDir = join(
    root,
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-gametest-api-v1",
    "4.0.21+4a7fa0819e",
    "0123456789abcdef"
  );
  await mkdir(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, "fabric-gametest-api-v1-4.0.21+4a7fa0819e.jar");
  await createJar(jarPath, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.class": buildClassFile({
      internalName: "net/fabricmc/fabric/api/gametest/v1/FabricGameTest",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "invokeTestMethod", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "dep-artifact",
    artifactAlias: "fabric-gametest-api-v1",
    origin: "local-m2" as const,
    isDecompiled: false,
    binaryJarPath: jarPath,
    coordinate: "net.fabricmc.fabric-api:fabric-gametest-api-v1:4.0.21+4a7fa0819e",
    version: "4.0.21+4a7fa0819e",
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      dependencyResolution: {
        group: "net.fabricmc.fabric-api",
        name: "fabric-gametest-api-v1",
        resolvedVersion: "4.0.21+4a7fa0819e",
        source: "gradle-cache",
        cacheHit: true
      }
    },
    qualityFlags: [],
    artifactContents: { hasSources: false, hasBinary: true },
    warnings: []
  });

  const result = await service.getClassMembers({
    className: "net.fabricmc.fabric.api.gametest.v1.FabricGameTest",
    mapping: "obfuscated",
    target: {
      kind: "dependency",
      group: "net.fabricmc.fabric-api",
      name: "fabric-gametest-api-v1",
      versionFromProject: true
    }
  });

  assert.equal(result.context.minecraftVersion, "unknown");
  // The dependency's own coordinate version must not leak in as a substitute.
  assert.notEqual(result.context.minecraftVersion, "4.0.21+4a7fa0819e");
  assert.notEqual(result.context.minecraftVersion, "2.1");
  assert.ok(result.counts.total > 0, "expected members to be read from the dependency jar");
});

// The three tests below pin the ROUTE-INVARIANCE of that "is this a dependency?"
// decision. The signal it originally used, `provenance.dependencyResolution`, is
// written only when the same resolveArtifact call handled a `kind:"dependency"`
// target -- yet synthesizeDependencyTarget rewrites such a target into a
// `kind:"coordinate"` one before provenance is built, so the artifact a dependency
// target persists is indistinguishable from one reached by naming the same Maven
// coordinate directly. Reaching the same jar by coordinate, or reusing an already
// resolved one by artifactId, therefore got the vanilla answer and the vanilla
// garbage version with it.
test("get-class-members reports unknown minecraftVersion for a dependency reached by a coordinate target", async () => {
  const root = await mkdtemp(join(tmpdir(), "dep-target-coordinate-context-"));
  const cacheDir = join(
    root,
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-gametest-api-v1",
    "4.0.21+4a7fa0819e",
    "0123456789abcdef"
  );
  await mkdir(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, "fabric-gametest-api-v1-4.0.21+4a7fa0819e.jar");
  const className = "net.fabricmc.fabric.api.gametest.v1.FabricGameTest";
  await createJar(jarPath, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.class": buildClassFile({
      internalName: "net/fabricmc/fabric/api/gametest/v1/FabricGameTest",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "invokeTestMethod", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));

  // The path read declines this Gradle-cache path outright, so the coordinate is
  // what the assertions below actually exercise: with no path-derived version to
  // report, the resolver's own `version` is substituted unless the artifact is
  // recognized as a dependency, and the response then carries the library's
  // release number.
  const unguarded = await service.explorerService.getSignature({ jarPath, fqn: className });
  assert.equal(unguarded.context.minecraftVersion, "unknown");

  const coordinate = "net.fabricmc.fabric-api:fabric-gametest-api-v1:4.0.21+4a7fa0819e";
  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "dep-artifact-by-coordinate",
    artifactAlias: "fabric-gametest-api-v1",
    origin: "local-m2" as const,
    isDecompiled: false,
    binaryJarPath: jarPath,
    coordinate,
    version: "4.0.21+4a7fa0819e",
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    // A coordinate target carries NO dependencyResolution -- this is exactly the
    // provenance a dependency target persists once its target has been rewritten.
    provenance: {
      target: { kind: "coordinate", value: coordinate },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2", binaryJarPath: jarPath, coordinate },
      transformChain: []
    },
    qualityFlags: [],
    artifactContents: { hasSources: false, hasBinary: true },
    warnings: []
  });

  const result = await service.getClassMembers({
    className,
    mapping: "obfuscated",
    target: { kind: "coordinate", value: coordinate }
  });

  assert.equal(result.context.minecraftVersion, "unknown");
  assert.notEqual(result.context.minecraftVersion, "2.1");
  assert.notEqual(result.context.minecraftVersion, "4.0.21+4a7fa0819e");
  assert.ok(result.counts.total > 0, "expected members to be read from the dependency jar");
});

test("get-class-members reports unknown minecraftVersion when a dependency artifact is reused by artifactId", async () => {
  const root = await mkdtemp(join(tmpdir(), "dep-target-reuse-context-"));
  const cacheDir = join(
    root,
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-gametest-api-v1",
    "4.0.21+4a7fa0819e",
    "0123456789abcdef"
  );
  await mkdir(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, "fabric-gametest-api-v1-4.0.21+4a7fa0819e.jar");
  const className = "net.fabricmc.fabric.api.gametest.v1.FabricGameTest";
  await createJar(jarPath, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.class": buildClassFile({
      internalName: "net/fabricmc/fabric/api/gametest/v1/FabricGameTest",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "invokeTestMethod", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));

  const unguarded = await service.explorerService.getSignature({ jarPath, fqn: className });
  assert.equal(unguarded.context.minecraftVersion, "unknown");

  const coordinate = "net.fabricmc.fabric-api:fabric-gametest-api-v1:4.0.21+4a7fa0819e";
  seedIndexedArtifact(service, {
    artifactId: "dep-artifact-reused",
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files: [],
    symbols: [],
    version: "4.0.21+4a7fa0819e",
    binaryJarPath: jarPath,
    provenance: {
      target: { kind: "coordinate", value: coordinate },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2", binaryJarPath: jarPath, coordinate },
      transformChain: []
    }
  });

  const result = await service.getClassMembers({
    className,
    mapping: "obfuscated",
    artifactId: "dep-artifact-reused"
  });

  assert.equal(result.context.minecraftVersion, "unknown");
  assert.notEqual(result.context.minecraftVersion, "2.1");
  assert.notEqual(result.context.minecraftVersion, "4.0.21+4a7fa0819e");
  assert.ok(result.counts.total > 0, "expected members to be read from the dependency jar");
});

test("get-class-members still reports a Minecraft version for a vanilla artifact with no coordinate", async () => {
  // Negative control for the two tests above: a vanilla artifact carries no
  // coordinate at all, so the coordinate-based test must leave its path-derived
  // Minecraft version alone rather than blanking every artifact to "unknown".
  const root = await mkdtemp(join(tmpdir(), "dep-target-vanilla-context-"));
  const versionDir = join(root, "versions", "1.21.10");
  await mkdir(versionDir, { recursive: true });
  const jarPath = join(versionDir, "1.21.10.jar");
  const className = "net.minecraft.client.Minecraft";
  await createJar(jarPath, {
    "net/minecraft/client/Minecraft.class": buildClassFile({
      internalName: "net/minecraft/client/Minecraft",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "tick", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  seedIndexedArtifact(service, {
    artifactId: "vanilla-artifact",
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files: [],
    symbols: [],
    version: "1.21.10",
    binaryJarPath: jarPath,
    provenance: {
      target: { kind: "jar", value: jarPath },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar", binaryJarPath: jarPath, version: "1.21.10" },
      transformChain: []
    }
  });

  const result = await service.getClassMembers({
    className,
    mapping: "obfuscated",
    artifactId: "vanilla-artifact"
  });

  assert.equal(result.context.minecraftVersion, "1.21.10");
  assert.ok(result.counts.total > 0, "expected members to be read from the vanilla jar");
});

// `net.minecraft` is not a Minecraft-only group. Mojang publishes ordinary
// libraries under it - `net.minecraft:launchwrapper:1.12` has been on
// libraries.minecraft.net for years - so judging "is this the Minecraft runtime?"
// by the group alone read such a library as the runtime: its own release number
// was reported as a Minecraft version, and a class miss inside it was answered
// with a "retry with mapping=mojang" hint that could not help. The artifactId has
// to be read too, and by ONE shared rule: the same question is asked in opposite
// polarity by the dependency check and by the resolver's obfuscation gate, and
// answering it differently in the two places is how the two drifted apart.
test("coordinateNamesMinecraftRuntime accepts the runtime artifacts and rejects libraries sharing the group", async () => {
  const { coordinateNamesMinecraftRuntime } = await import("../../src/source/artifact-resolver.ts");

  // The published runtime jars, and the Loom-staged jars named elsewhere in the
  // resolver - all of the latter start with "minecraft".
  for (const coordinate of [
    "net.minecraft:client:1.21.10",
    "net.minecraft:server:1.21.10",
    "net.minecraft:minecraft-merged:1.21.10",
    "net.minecraft:minecraft-common:1.21.10",
    "net.minecraft:minecraft-clientonly:1.21.10",
    "net.minecraft:minecraft-client:1.21.10",
    "net.minecraft:minecraft-server:1.21.10"
  ]) {
    assert.equal(coordinateNamesMinecraftRuntime(coordinate), true, coordinate);
  }

  for (const coordinate of [
    // A real library Mojang publishes under Minecraft's own group.
    "net.minecraft:launchwrapper:1.12",
    // Right group, unrelated artifact.
    "net.minecraft:realms:1.10.22",
    // Right artifact name, different group.
    "com.example:client:1.21.10",
    "org.jetbrains:annotations:26.0.2",
    // Unparseable: cannot be SHOWN to name the runtime, so it does not.
    "not-a-coordinate",
    ""
  ]) {
    assert.equal(coordinateNamesMinecraftRuntime(coordinate), false, coordinate);
  }
});

test("get-class-members reports unknown minecraftVersion for a library published under the net.minecraft group", async () => {
  const root = await mkdtemp(join(tmpdir(), "dep-target-mc-group-library-"));
  // The launcher's own library layout, which is where this jar really lives -
  // deliberately NOT a dependency cache, so the coordinate is the only thing
  // that can tell this apart from the Minecraft runtime.
  const libDir = join(root, "libraries", "net", "minecraft", "launchwrapper", "1.12");
  await mkdir(libDir, { recursive: true });
  const jarPath = join(libDir, "launchwrapper-1.12.jar");
  const className = "net.minecraft.launchwrapper.Launch";
  await createJar(jarPath, {
    "net/minecraft/launchwrapper/Launch.class": buildClassFile({
      internalName: "net/minecraft/launchwrapper/Launch",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "launch", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const coordinate = "net.minecraft:launchwrapper:1.12";
  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "launchwrapper-artifact",
    artifactAlias: "launchwrapper",
    origin: "local-m2" as const,
    isDecompiled: false,
    binaryJarPath: jarPath,
    coordinate,
    version: "1.12",
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "coordinate", value: coordinate },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2", binaryJarPath: jarPath, coordinate },
      transformChain: []
    },
    qualityFlags: [],
    artifactContents: { hasSources: false, hasBinary: true },
    warnings: []
  });

  const result = await service.getClassMembers({
    className,
    mapping: "obfuscated",
    target: { kind: "coordinate", value: coordinate }
  });

  assert.equal(result.context.minecraftVersion, "unknown");
  assert.notEqual(result.context.minecraftVersion, "1.12", "1.12 is launchwrapper's release, not Minecraft's");
  assert.ok(result.counts.total > 0, "expected members to be read from the library jar");
});

test("get-class-members still reports a Minecraft version for the net.minecraft runtime coordinate", async () => {
  // The control that keeps the fix above from over-applying: net.minecraft:client
  // really is the Minecraft runtime, so its version segment really is Minecraft's
  // and the response must keep reporting it.
  const root = await mkdtemp(join(tmpdir(), "dep-target-mc-group-runtime-"));
  const versionDir = join(root, "versions", "1.21.10");
  await mkdir(versionDir, { recursive: true });
  const jarPath = join(versionDir, "client-1.21.10.jar");
  const className = "net.minecraft.client.Minecraft";
  await createJar(jarPath, {
    "net/minecraft/client/Minecraft.class": buildClassFile({
      internalName: "net/minecraft/client/Minecraft",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "tick", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const coordinate = "net.minecraft:client:1.21.10";
  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "minecraft-client-artifact",
    artifactAlias: "client",
    origin: "local-m2" as const,
    isDecompiled: false,
    binaryJarPath: jarPath,
    coordinate,
    version: "1.21.10",
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "coordinate", value: coordinate },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2", binaryJarPath: jarPath, coordinate },
      transformChain: []
    },
    qualityFlags: [],
    artifactContents: { hasSources: false, hasBinary: true },
    warnings: []
  });

  const result = await service.getClassMembers({
    className,
    mapping: "obfuscated",
    target: { kind: "coordinate", value: coordinate }
  });

  assert.equal(result.context.minecraftVersion, "1.21.10");
  assert.ok(result.counts.total > 0, "expected members to be read from the runtime jar");
});

test("resolveArtifact does not read a net.minecraft library's own version as an unobfuscated Minecraft runtime", async () => {
  // The other half of the same rule, on the resolver's obfuscation gate. The
  // version here is chosen to make the difference observable: only a version that
  // parses as a modern (unobfuscated) Minecraft release reaches the pass-through
  // this gate protects, and reading a library's release number as one reports
  // mappingApplied="mojang" for a remap that never happened.
  const root = await mkdtemp(join(tmpdir(), "dep-target-mc-group-unobf-"));
  const binaryJarPath = join(
    root,
    "m2",
    "net",
    "minecraft",
    "launchwrapper",
    "26.1",
    "launchwrapper-26.1.jar"
  );
  await createJar(binaryJarPath, {
    "net/minecraft/launchwrapper/Launch.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { ingestIfNeeded: (resolved: unknown) => Promise<void> }).ingestIfNeeded =
    async () => {};

  await assert.rejects(
    service.resolveArtifact({
      target: { kind: "coordinate", value: "net.minecraft:launchwrapper:26.1" },
      mapping: "mojang"
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ERROR_CODES.MAPPING_NOT_APPLIED);
      return true;
    }
  );
});

test("get-class-members reports unknown minecraftVersion for a dependency jar named directly by its cache path", async () => {
  // A jar target carries no coordinate and no dependency marker, so the path is
  // the only evidence there is - and a Gradle cache path's leading number belongs
  // to the cache layout ("files-2.1"), not to Minecraft.
  const root = await mkdtemp(join(tmpdir(), "dep-target-jar-path-"));
  const cacheDir = join(
    root,
    "caches",
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-gametest-api-v1",
    "4.0.21+4a7fa0819e",
    "0123456789abcdef"
  );
  await mkdir(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, "fabric-gametest-api-v1-4.0.21+4a7fa0819e.jar");
  const className = "net.fabricmc.fabric.api.gametest.v1.FabricGameTest";
  await createJar(jarPath, {
    "net/fabricmc/fabric/api/gametest/v1/FabricGameTest.class": buildClassFile({
      internalName: "net/fabricmc/fabric/api/gametest/v1/FabricGameTest",
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "invokeTestMethod", descriptor: "()V", accessFlags: 0x0001 }
      ]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  // Exactly what the jar branch of source resolution records for this target:
  // a binary jar path, and no coordinate, version or dependency marker to judge by.
  (service as unknown as { resolveArtifact: unknown }).resolveArtifact = async () => ({
    artifactId: "jar-target-artifact",
    origin: "local-jar" as const,
    isDecompiled: false,
    binaryJarPath: jarPath,
    requestedMapping: "obfuscated" as const,
    mappingApplied: "obfuscated" as const,
    provenance: {
      target: { kind: "jar", value: jarPath },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar", binaryJarPath: jarPath },
      transformChain: []
    },
    qualityFlags: [],
    artifactContents: { hasSources: false, hasBinary: true },
    warnings: []
  });

  const result = await service.getClassMembers({
    className,
    mapping: "obfuscated",
    target: { kind: "jar", value: jarPath }
  });

  assert.equal(result.context.minecraftVersion, "unknown");
  assert.notEqual(result.context.minecraftVersion, "2.1");
  assert.ok(result.counts.total > 0, "expected members to be read from the dependency jar");
});

// --- group/name validation runs before the version probe ---------------------

type ProbeSpyService = AnySourceService & {
  workspaceMappingService: {
    detectDependencyVersion: (projectPath: string, group: string, name: string) => Promise<unknown>;
  };
};

test("synthesizeDependencyTarget refuses an unsafe group/name BEFORE the version probe runs", async () => {
  // The finding this pins: a `dependency` target without an explicit version
  // reaches `detectDependencyVersion` - which builds
  // `<gradle-home>/caches/modules-2/files-2.1/<group>/<name>` and lists it -
  // BEFORE the coordinate it will synthesise is ever parsed. Rejecting the
  // coordinate afterwards cannot un-read a directory, and the entry names that
  // listing found travel back to the caller in `candidatesSeen`.
  //
  // So the assertion is not "an error was raised" but "the probe was never
  // called". The stub below is the only thing on this route that touches the
  // filesystem for the cache, so a call count of zero is the absence of the
  // read itself.
  const host = await makeHost();
  const project = await mkdtemp(join(tmpdir(), "dep-target-probe-order-"));
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as ProbeSpyService;

  let probes: Array<[string, string]> = [];
  service.workspaceMappingService = {
    detectDependencyVersion: async (_projectPath: string, group: string, name: string) => {
      probes.push([group, name]);
      return { resolved: true, version: "1.0.0", source: "stub", candidatesSeen: [], attempts: [] };
    }
  };

  // Control first: a well-formed dependency DOES reach the probe, so a count of
  // zero below means the guard stopped it and not that the route never probes.
  await service.synthesizeDependencyTarget(
    { target: { kind: "dependency" }, projectPath: project },
    { kind: "dependency", group: "dev.architectury", name: "architectury" }
  );
  assert.deepEqual(probes, [["dev.architectury", "architectury"]], "control: the probe must run for a valid dependency");

  probes = [];
  const hostile: ReadonlyArray<readonly [string, string]> = [
    // Neither of these carries '/', '\\', '..' or NUL - the exact characters
    // the old blocklist named - yet `path.resolve(root, ..., "D:", ".")` is
    // drive-relative on Windows and lands off the cache root.
    ["D:", "."],
    ["C:", "lib"],
    ["g.example", "."],
    [".hidden", "lib"],
    ["g.example", ".config"],
    // A colon would also break the `group:name:version` coordinate this route
    // synthesises, so it was never a usable input either way.
    ["g:x", "lib"],
    ["g example", "lib"],
    ["g.example", "lib name"],
    ["g x", "lib"],
    ["../etc", "passwd"]
  ];

  for (const [group, name] of hostile) {
    await assert.rejects(
      () =>
        service.synthesizeDependencyTarget(
          { target: { kind: "dependency" }, projectPath: project },
          { kind: "dependency", group, name }
        ),
      (err: Error & { code?: string; details?: { fieldErrors?: Array<{ path?: string }> } }) => {
        assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
        assert.ok(
          ["target.group", "target.name"].includes(err.details?.fieldErrors?.[0]?.path ?? ""),
          `the error must name the offending field for ${JSON.stringify([group, name])}`
        );
        return true;
      },
      `expected reject for ${JSON.stringify([group, name])}`
    );
  }

  assert.deepEqual(probes, [], "no filesystem probe may run on behalf of a rejected group/name");
});

test("synthesizeDependencyTarget trims an explicit version before validating it", async () => {
  // The routes disagreed here: `parseCoordinate` trims each segment and then
  // checks it, while this route checked first, so `" 1.0 "` named the same
  // artifact on one route and was an error on the other.
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  const padded = (await service.synthesizeDependencyTarget(
    { target: { kind: "dependency" } },
    { kind: "dependency", group: "dev.architectury", name: "architectury", version: "  13.0.0  " }
  )) as { target: { value: string }; provenance: { resolvedVersion: string } };

  assert.equal(padded.target.value, "dev.architectury:architectury:13.0.0");
  assert.equal(padded.provenance.resolvedVersion, "13.0.0");

  // And the space allowance is shared with the coordinate route, so a published
  // Yarn pre-release build resolves from either direction.
  const spaced = (await service.synthesizeDependencyTarget(
    { target: { kind: "dependency" } },
    { kind: "dependency", group: "net.fabricmc", name: "yarn", version: "1.14 Pre-Release 1+build.10" }
  )) as { target: { value: string } };

  assert.equal(spaced.target.value, "net.fabricmc:yarn:1.14 Pre-Release 1+build.10");
  assert.equal(
    parseCoordinate(spaced.target.value).version,
    "1.14 Pre-Release 1+build.10",
    "the coordinate this route synthesises must survive the parser it is handed to"
  );
});
