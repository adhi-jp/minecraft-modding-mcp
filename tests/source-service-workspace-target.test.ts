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

test("synthesizeWorkspaceTarget throws ERR_WORKSPACE_VERSION_UNRESOLVED when strict and version is missing", async () => {
  const projectPath = await makeProject({}, "");
  const root = await mkdtemp(join(tmpdir(), "ws-target-host-strict-"));
  await mkdir(join(root, "cache"), { recursive: true });
  const service = new SourceService(
    buildTestConfig(root),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  await assert.rejects(
    () =>
      service.synthesizeWorkspaceTarget(
        { target: { kind: "workspace", strict: true }, projectPath },
        { kind: "workspace", strict: true }
      ),
    (err: Error & { code?: string }) => err.code === ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED
  );
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

  // Spy on detectProjectMinecraftVersion to count calls
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
