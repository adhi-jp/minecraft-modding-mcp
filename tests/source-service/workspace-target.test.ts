import assert from "node:assert/strict";
import { expectAppErrorCode } from "../helpers/expect-app-error.ts";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { SourceService } from "../../src/source-service.ts";
import { createWorkspaceContextCache } from "../../src/workspace-context-cache.ts";
import { withEnv } from "../helpers/env.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

type AnySourceService = SourceService & {
  synthesizeWorkspaceTarget: (
    input: Record<string, unknown>,
    workspace: Record<string, unknown>
  ) => Promise<unknown>;
  loadOrDetectWorkspaceContext: (projectPath: string) => Promise<unknown>;
  workspaceMappingService: { detectProjectMinecraftVersion: (path: string) => Promise<string | undefined> };
  workspaceContextCache: ReturnType<typeof createWorkspaceContextCache>;
};

async function makeProject(props: Record<string, string> = {}, build = ""): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ws-target-"));
  if (Object.keys(props).length > 0) {
    const lines = Object.entries(props)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    await writeFile(join(root, "gradle.properties"), `${lines}\n`, "utf8");
  }
  if (build) {
    await writeFile(join(root, "build.gradle"), build, "utf8");
  }
  return root;
}

test("synthesizeWorkspaceTarget throws ERR_INVALID_INPUT when projectPath is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(buildTestConfig(root)) as unknown as AnySourceService;

  await assert.rejects(
    () => service.synthesizeWorkspaceTarget({ target: { kind: "workspace" } }, { kind: "workspace" }),
    (err: Error & { code?: string; details?: { fieldErrors?: Array<{ path?: string }> } }) => {
      assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
      assert.equal(err.details?.fieldErrors?.[0]?.path, "projectPath");
      return true;
    }
  );
});

test("synthesizeWorkspaceTarget detects MC version + compile mapping + loader from project", async () => {
  const projectPath = await makeProject(
    { minecraft_version: "1.21.10" },
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n")
  );
  const root = await mkdtemp(join(tmpdir(), "ws-target-host2-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  )) as {
    target: { kind: string; value: string };
    mapping: string;
    scope: string;
    provenance: { detected: { minecraftVersion?: string; compileMapping?: string; loader?: string }; cacheHit: boolean };
  };

  assert.equal(synthesized.target.kind, "version");
  assert.equal(synthesized.target.value, "1.21.10");
  assert.equal(synthesized.mapping, "mojang");
  assert.equal(synthesized.scope, "merged");
  assert.equal(synthesized.provenance.detected.minecraftVersion, "1.21.10");
  assert.equal(synthesized.provenance.detected.compileMapping, "mojang");
  assert.equal(synthesized.provenance.detected.loader, "fabric");
  assert.equal(synthesized.provenance.cacheHit, false);
});

test("synthesizeWorkspaceTarget defaults to obfuscated mapping and vanilla scope when no loader is detected", async () => {
  // A project with a detectable minecraft_version but no loader plugin (no
  // build.gradle) resolves the version yet leaves loader/compileMapping
  // undetected, so the defaults must fall back to obfuscated + vanilla.
  const projectPath = await makeProject({ minecraft_version: "1.21.10" }, "");
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-noloader-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  )) as {
    target: { kind: string; value: string };
    mapping: string;
    scope: string;
    provenance: { detected: { loader?: string; compileMapping?: string } };
  };

  assert.equal(synthesized.target.kind, "version");
  assert.equal(synthesized.target.value, "1.21.10");
  assert.equal(synthesized.mapping, "obfuscated");
  assert.equal(synthesized.scope, "vanilla");
  assert.equal(synthesized.provenance.detected.loader, undefined);
  assert.equal(synthesized.provenance.detected.compileMapping, undefined);
});

test("synthesizeWorkspaceTarget throws ERR_WORKSPACE_VERSION_UNRESOLVED when version is undetected, regardless of strict flag", async () => {
  const projectPath = await makeProject({}, "");
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-strict-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  for (const strict of [true, false]) {
    await assert.rejects(
      () =>
        service.synthesizeWorkspaceTarget(
          { target: { kind: "workspace", strict }, projectPath },
          { kind: "workspace", strict }
        ),
      (err: Error & {
        code?: string;
        details?: {
          strict?: boolean;
          suggestedCall?: unknown;
          exampleCalls?: Array<{ tool: string; params: { target?: { value?: string } } }>;
        };
      }) => {
        assert.equal(err.code, ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED);
        assert.equal(err.details?.strict, strict);
        // The `<your-mc-version>` placeholder cannot be a runnable suggestedCall,
        // so the retry is carried as an `exampleCalls` template, as for
        // ERR_DEPENDENCY_VERSION_UNRESOLVED.
        assert.equal(err.details?.suggestedCall, undefined);
        assert.ok(Array.isArray(err.details?.exampleCalls) && err.details.exampleCalls.length > 0);
        assert.equal(err.details?.exampleCalls?.[0]?.tool, "resolve-artifact");
        assert.equal(err.details?.exampleCalls?.[0]?.params.target?.value, "<your-mc-version>");
        return true;
      }
    );
  }
});

test("synthesizeWorkspaceTarget warns when caller mapping mismatches workspace compile mapping", async () => {
  const projectPath = await makeProject(
    { minecraft_version: "1.21.10" },
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n")
  );
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-mismatch-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath, mapping: "yarn" },
    { kind: "workspace" }
  )) as { mapping: string; warnings: string[] };

  assert.equal(synthesized.mapping, "yarn");
  assert.ok(synthesized.warnings.some((w) => w.includes("Compile mapping mismatch")));
});

test("synthesizeWorkspaceTarget reuses the WorkspaceContextCache on the second call", async () => {
  const projectPath = await makeProject(
    { minecraft_version: "1.21.10" },
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n")
  );
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-cache-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const cache = createWorkspaceContextCache();
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const original = service.workspaceMappingService.detectProjectMinecraftVersion.bind(
    service.workspaceMappingService
  );
  let calls = 0;
  service.workspaceMappingService.detectProjectMinecraftVersion = async (path: string) => {
    calls += 1;
    return original(path);
  };

  await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  );
  const second = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  )) as { provenance: { cacheHit: boolean } };

  assert.equal(calls, 1);
  assert.equal(second.provenance.cacheHit, true);
});

test("synthesizeWorkspaceTarget re-detects after gradle.properties changes within the TTL instead of serving a stale cache hit", async () => {
  const projectPath = await makeProject({ minecraft_version: "1.21.10" });
  const root = await mkdtemp(join(tmpdir(), "ws-target-fingerprint-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const cache = createWorkspaceContextCache();
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const original = service.workspaceMappingService.detectProjectMinecraftVersion.bind(
    service.workspaceMappingService
  );
  let calls = 0;
  service.workspaceMappingService.detectProjectMinecraftVersion = async (path: string) => {
    calls += 1;
    return original(path);
  };

  const first = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  )) as { target: { value: string } };
  assert.equal(first.target.value, "1.21.10");

  // Edit the file this detection read, well within the cache's default TTL.
  const propsPath = join(projectPath, "gradle.properties");
  const before = await stat(propsPath);
  await writeFile(propsPath, "minecraft_version=1.21.20\n", "utf8");
  await utimes(propsPath, before.atime, new Date(before.mtimeMs + 2000));

  const second = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  )) as { target: { value: string }; provenance: { cacheHit: boolean } };

  assert.equal(calls, 2, "an edited gradle.properties must force re-detection instead of reusing the cached run");
  assert.equal(second.provenance.cacheHit, false);
  assert.equal(second.target.value, "1.21.20");
});

test("synthesizeWorkspaceTarget re-detects after a root build.gradle that first declared nothing gains a loader declaration within the TTL", async () => {
  // Regression coverage for the fixed-file fingerprint: build.gradle exists
  // from the very first detection but produces no mapping/loader evidence
  // (so loadOrDetectWorkspaceContext never learns its path from `evidence`),
  // yet it must still be fingerprinted - editing it afterward to newly
  // declare a loader has to invalidate the cache within the TTL, the same as
  // a gradle.properties edit does.
  const projectPath = await makeProject({ minecraft_version: "1.21.10" }, "// no loader or mapping declared yet\n");
  const root = await mkdtemp(join(tmpdir(), "ws-target-buildgradle-fingerprint-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const cache = createWorkspaceContextCache();
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const first = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  )) as { scope?: string };
  assert.equal(first.scope, "vanilla", "no loader detected yet: defaults to vanilla scope");

  // Edit the previously-empty build.gradle to declare a loader, well within
  // the cache's default TTL.
  await writeFile(
    join(projectPath, "build.gradle"),
    ["plugins {", "  id 'fabric-loom' version '1.9-SNAPSHOT'", "}"].join("\n"),
    "utf8"
  );

  const second = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath },
    { kind: "workspace" }
  )) as { scope?: string; provenance: { cacheHit: boolean } };

  assert.equal(second.provenance.cacheHit, false, "editing build.gradle must force re-detection, not a cache hit");
  assert.equal(second.scope, "merged", "the newly-declared loader must be picked up on re-detection");
});

test("loadOrDetectWorkspaceContext fingerprints the fixed root files before detection runs, so an edit racing the read still invalidates the entry it wrote", async () => {
  const projectPath = await makeProject({ minecraft_version: "1.21.10" });
  const root = await mkdtemp(join(tmpdir(), "ws-target-race-fingerprint-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const cache = createWorkspaceContextCache();
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const original = service.workspaceMappingService.detectProjectMinecraftVersion.bind(
    service.workspaceMappingService
  );
  service.workspaceMappingService.detectProjectMinecraftVersion = async (path: string) => {
    // Detection captures the old version, then the file changes before that
    // result is returned and cached.
    const oldVersion = await original(path);
    const propsPath = join(projectPath, "gradle.properties");
    const before = await stat(propsPath);
    await writeFile(propsPath, "minecraft_version=1.21.99\n", "utf8");
    await utimes(propsPath, before.atime, new Date(before.mtimeMs + 2000));
    service.workspaceMappingService.detectProjectMinecraftVersion = original;
    return oldVersion;
  };

  const ctx = (await service.loadOrDetectWorkspaceContext(projectPath)) as { minecraftVersion?: string };
  assert.equal(ctx.minecraftVersion, "1.21.10", "the first detection captured the old content");

  const refreshed = (await service.loadOrDetectWorkspaceContext(projectPath)) as { minecraftVersion?: string };
  assert.equal(refreshed.minecraftVersion, "1.21.99", "the next lookup must refresh the stale result");
});

test("loadOrDetectWorkspaceContext preserves dependency versions written during the detection window", async () => {
  const projectPath = await makeProject({ minecraft_version: "1.21.10" }, "");
  const root = await mkdtemp(join(tmpdir(), "ws-target-race-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const cache = createWorkspaceContextCache();
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const original = service.workspaceMappingService.detectProjectMinecraftVersion.bind(
    service.workspaceMappingService
  );
  service.workspaceMappingService.detectProjectMinecraftVersion = async (path: string) => {
    const existing = cache.read(path);
    cache.write({
      projectPath: path,
      detectedAt: Date.now(),
      evidence: [],
      dependencyVersions: new Map([["com.example:lib", "1.2.3"]]),
      partial: existing ? existing.partial : true
    });
    return original(path);
  };

  await service.loadOrDetectWorkspaceContext(projectPath);

  const stored = cache.read(projectPath);
  assert.equal(stored?.dependencyVersions.get("com.example:lib"), "1.2.3");
});

test("getClassMembers and getClassSource pass input.mapping (raw, possibly undefined) to resolveArtifact symmetrically", async () => {
  const projectPath = await makeProject(
    { minecraft_version: "1.21.10" },
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n")
  );
  const root = await mkdtemp(join(tmpdir(), "ws-target-raw-mapping-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  );

  // Record what each caller hands to resolveArtifact, then stop: only the
  // forwarded request matters here, not the resolution itself.
  const resolveCalls: Array<Record<string, unknown>> = [];
  const stopAfterRecording = new Error("stop after recording resolveArtifact input");
  (service as unknown as { resolveArtifact: (input: Record<string, unknown>) => Promise<never> }).resolveArtifact =
    async (input) => {
      resolveCalls.push(input);
      throw stopAfterRecording;
    };

  await assert.rejects(
    () => service.getClassSource({ className: "net.minecraft.world.item.Item", target: { kind: "workspace" }, projectPath }),
    (error) => error === stopAfterRecording
  );
  await assert.rejects(
    () => service.getClassMembers({ className: "net.minecraft.world.item.Item", target: { kind: "workspace" }, projectPath }),
    (error) => error === stopAfterRecording
  );

  assert.equal(resolveCalls.length, 2, "each caller resolves the workspace target exactly once");
  const [sourceCall, membersCall] = resolveCalls;
  assert.deepEqual(sourceCall?.target, { kind: "workspace" });
  assert.equal(sourceCall?.projectPath, projectPath);
  assert.ok(sourceCall && Object.hasOwn(sourceCall, "mapping"), "getClassSource forwards the mapping field");
  assert.equal(sourceCall?.mapping, undefined, "getClassSource must forward an omitted mapping raw, not normalized");
  assert.deepEqual(membersCall?.target, { kind: "workspace" });
  assert.equal(membersCall?.projectPath, projectPath);
  assert.ok(membersCall && Object.hasOwn(membersCall, "mapping"), "getClassMembers forwards the mapping field");
  assert.equal(
    membersCall?.mapping,
    undefined,
    "getClassMembers must pass input.mapping (raw) like getClassSource so workspace-detected mapping is preserved when caller omits mapping"
  );
});

test("synthesizeWorkspaceTarget honors top-level input.scope over the loader-derived default", async () => {
  const projectPath = await makeProject(
    { minecraft_version: "1.21.10" },
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n")
  );
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-scope-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace" }, projectPath, scope: "loader" },
    { kind: "workspace" }
  )) as { scope: string };

  assert.equal(synthesized.scope, "loader");
});

test("synthesizeWorkspaceTarget gives workspace.scope precedence over input.scope when both are supplied", async () => {
  const projectPath = await makeProject(
    { minecraft_version: "1.21.10" },
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n")
  );
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-scope-precedence-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const synthesized = (await service.synthesizeWorkspaceTarget(
    { target: { kind: "workspace", scope: "vanilla" }, projectPath, scope: "loader" },
    { kind: "workspace", scope: "vanilla" }
  )) as { scope: string };

  assert.equal(synthesized.scope, "vanilla");
});

test("synthesizeWorkspaceTarget rejects target.kind=workspace when WORKSPACE_TARGET_OFF is set", async () => {
  await withEnv({ WORKSPACE_TARGET_OFF: "1" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-target-toggle-"));
    await mkdir(join(root, "cache"), { recursive: true });
    const service = new SourceService(buildTestConfig(root)) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeWorkspaceTarget(
          { target: { kind: "workspace" }, projectPath: root },
          { kind: "workspace" }
        ),
      expectAppErrorCode(ERROR_CODES.INVALID_INPUT)
    );
  });
});
