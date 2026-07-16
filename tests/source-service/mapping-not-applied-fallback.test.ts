import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceService } from "../../src/source-service.ts";
import { createWorkspaceContextCache, type WorkspaceContext } from "../../src/workspace-context-cache.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

type AnySourceService = SourceService & {
  buildMappingFallbackSuggestedCall: (args: {
    input: Record<string, unknown>;
    kind: string;
    value: string;
    scope: string | undefined;
    effectiveMapping: string;
  }) => Promise<{
    suggestedCall: { tool: string; params: Record<string, unknown> };
    nextAction: string;
  }>;
  workspaceContextCache: ReturnType<typeof createWorkspaceContextCache>;
};

async function makeHost(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fallback-host-"));
  await mkdir(join(root, "cache"), { recursive: true });
  return root;
}

test("buildMappingFallbackSuggestedCall returns workspace retry when cache hit reports a non-obfuscated compile mapping AND matching MC version", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-cache-hit-"));
  const host = await makeHost();
  const cache = createWorkspaceContextCache();
  const ctx: WorkspaceContext = {
    projectPath: project,
    minecraftVersion: "1.21.10",
    compileMapping: "mojang",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  };
  cache.write(ctx);

  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "version", value: "1.21.10" }, projectPath: project, mapping: "mojang" },
    kind: "version",
    value: "1.21.10",
    scope: "vanilla",
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { target: { kind: string }; mapping: string };
  assert.equal(params.target.kind, "workspace");
  assert.equal(params.mapping, "mojang");
});

test("buildMappingFallbackSuggestedCall falls back to legacy obfuscated retry when projectPath is absent", async () => {
  const host = await makeHost();
  const service = new SourceService(buildTestConfig(host)) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "version", value: "1.21.10" } },
    kind: "version",
    value: "1.21.10",
    scope: "vanilla",
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { mapping: string };
  assert.equal(params.mapping, "obfuscated");
});

test("buildMappingFallbackSuggestedCall returns legacy retry when the cached compile mapping is obfuscated", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-cache-obf-"));
  const host = await makeHost();
  const cache = createWorkspaceContextCache();
  cache.write({
    projectPath: project,
    compileMapping: "obfuscated",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });

  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "version", value: "1.21.10" }, projectPath: project },
    kind: "version",
    value: "1.21.10",
    scope: "vanilla",
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { mapping: string };
  assert.equal(params.mapping, "mojang");
});

test("buildMappingFallbackSuggestedCall runs cold-cache bounded detection and returns workspace retry on success", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-cold-detect-"));
  await writeFile(join(project, "gradle.properties"), "minecraft_version=1.21.10\n", "utf8");
  await writeFile(
    join(project, "build.gradle"),
    [
      "plugins { id 'fabric-loom' version '1.9-SNAPSHOT' }",
      "dependencies { mappings loom.officialMojangMappings() }"
    ].join("\n"),
    "utf8"
  );
  const host = await makeHost();
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "version", value: "1.21.10" }, projectPath: project, mapping: "mojang" },
    kind: "version",
    value: "1.21.10",
    scope: "vanilla",
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { target: { kind: string }; mapping: string };
  assert.equal(params.target.kind, "workspace");
  assert.equal(params.mapping, "mojang");
});

test("buildMappingFallbackSuggestedCall does not redirect to workspace when MC version mismatches", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-mismatch-"));
  const host = await makeHost();
  const cache = createWorkspaceContextCache();
  cache.write({
    projectPath: project,
    minecraftVersion: "1.21.10",
    compileMapping: "mojang",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "version", value: "1.20.1" }, projectPath: project, mapping: "mojang" },
    kind: "version",
    value: "1.20.1",
    scope: "vanilla",
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { target?: { kind: string; value?: string } };
  assert.notEqual(params.target?.kind, "workspace");
  assert.equal(params.target?.value, "1.20.1");
});

test("buildMappingFallbackSuggestedCall does not redirect coordinate failures to the workspace target", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-coord-"));
  const host = await makeHost();
  const cache = createWorkspaceContextCache();
  cache.write({
    projectPath: project,
    compileMapping: "mojang",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "coordinate", value: "com.example:foo:1.0" }, projectPath: project, mapping: "mojang" },
    kind: "coordinate",
    value: "com.example:foo:1.0",
    scope: undefined,
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { target?: { kind?: string; value?: string } };
  assert.notEqual(params.target?.kind, "workspace");
  assert.equal(params.target?.kind, "coordinate");
  assert.equal(params.target?.value, "com.example:foo:1.0");
});

test("buildMappingFallbackSuggestedCall does not redirect jar failures to the workspace target", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-jar-"));
  const host = await makeHost();
  const cache = createWorkspaceContextCache();
  cache.write({
    projectPath: project,
    compileMapping: "mojang",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "jar", value: "/tmp/foo.jar" }, projectPath: project },
    kind: "jar",
    value: "/tmp/foo.jar",
    scope: undefined,
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { target?: { kind?: string } };
  assert.notEqual(params.target?.kind, "workspace");
  assert.equal(params.target?.kind, "jar");
});

test("buildMappingFallbackSuggestedCall returns the legacy obfuscated retry when WORKSPACE_FALLBACK_LEGACY is set", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-legacy-toggle-"));
  await writeFile(
    join(project, "build.gradle"),
    [
      "plugins { id 'fabric-loom' version '1.9-SNAPSHOT' }",
      "dependencies { mappings loom.officialMojangMappings() }"
    ].join("\n"),
    "utf8"
  );
  const host = await makeHost();
  const cache = createWorkspaceContextCache();
  cache.write({
    projectPath: project,
    compileMapping: "mojang",
    detectedAt: Date.now(),
    evidence: [],
    dependencyVersions: new Map<string, string>()
  });
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: cache }
  ) as unknown as AnySourceService;

  process.env.WORKSPACE_FALLBACK_LEGACY = "1";
  try {
    const result = await service.buildMappingFallbackSuggestedCall({
      input: { target: { kind: "version", value: "1.21.10" }, projectPath: project, mapping: "mojang" },
      kind: "version",
      value: "1.21.10",
      scope: "vanilla",
      effectiveMapping: "mojang"
    });

    const params = result.suggestedCall.params as { target?: { kind: string }; mapping: string };
    assert.notEqual(params.target?.kind, "workspace");
    assert.equal(params.mapping, "mojang"); // legacy isVanillaMojang+projectPath path
  } finally {
    delete process.env.WORKSPACE_FALLBACK_LEGACY;
  }
});

test("buildMappingFallbackSuggestedCall falls back to legacy retry when cold-cache detection finds nothing", async () => {
  const project = await mkdtemp(join(tmpdir(), "fallback-cold-empty-"));
  const host = await makeHost();
  const service = new SourceService(
    buildTestConfig(host),
    undefined,
    { workspaceContextCache: createWorkspaceContextCache() }
  ) as unknown as AnySourceService;

  const result = await service.buildMappingFallbackSuggestedCall({
    input: { target: { kind: "version", value: "1.21.10" }, projectPath: project },
    kind: "version",
    value: "1.21.10",
    scope: "vanilla",
    effectiveMapping: "mojang"
  });

  const params = result.suggestedCall.params as { mapping: string };
  assert.equal(params.mapping, "mojang");
  // legacy isVanillaMojang + projectPath path: scope flips to merged
  const params2 = result.suggestedCall.params as { scope: string };
  assert.equal(params2.scope, "merged");
});
