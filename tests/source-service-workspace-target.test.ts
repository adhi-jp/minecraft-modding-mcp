import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import { SourceService } from "../src/source-service.ts";
import { createWorkspaceContextCache } from "../src/workspace-context-cache.ts";
import { buildTestConfig } from "./helpers/test-config.ts";

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
      (err: Error & { code?: string; details?: { strict?: boolean } }) => {
        assert.equal(err.code, ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED);
        assert.equal(err.details?.strict, strict);
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
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("src/source/class-source.ts", "utf8");

  const getClassSourceMatch = source.match(/export async function getClassSource\(svc: SourceService, input: GetClassSourceInput\)[\s\S]*?await svc\.resolveArtifact\(\{([\s\S]*?)\}\);/);
  const getClassMembersMatch = source.match(/export async function getClassMembers\(svc: SourceService, input: GetClassMembersInput\)[\s\S]*?await svc\.resolveArtifact\(\{([\s\S]*?)\}\);/);

  assert.ok(getClassSourceMatch, "Could not locate getClassSource resolveArtifact call");
  assert.ok(getClassMembersMatch, "Could not locate getClassMembers resolveArtifact call");

  const sourceMappingArg = getClassSourceMatch![1]!.match(/mapping:\s*([^,]+),/)?.[1]?.trim();
  const membersMappingArg = getClassMembersMatch![1]!.match(/mapping:\s*([^,]+),/)?.[1]?.trim();

  assert.equal(sourceMappingArg, "input.mapping");
  assert.equal(
    membersMappingArg,
    "input.mapping",
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
  process.env.WORKSPACE_TARGET_OFF = "1";
  try {
    const sourceServiceModule = await import(
      `../src/source-service.ts?toggle=ws-${Date.now()}`
    );
    const root = await mkdtemp(join(tmpdir(), "ws-target-toggle-"));
    await mkdir(join(root, "cache"), { recursive: true });
    const service = new sourceServiceModule.SourceService(buildTestConfig(root)) as unknown as AnySourceService;

    await assert.rejects(
      () =>
        service.synthesizeWorkspaceTarget(
          { target: { kind: "workspace" }, projectPath: root },
          { kind: "workspace" }
        ),
      (err: Error & { code?: string }) => err.code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    delete process.env.WORKSPACE_TARGET_OFF;
  }
});
