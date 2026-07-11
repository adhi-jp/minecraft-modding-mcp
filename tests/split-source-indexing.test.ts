import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceService } from "../src/source-service.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

const CLIENT_CLASS_SOURCE = [
  "package net.minecraft.client.renderer.block.model;",
  "public class ItemTransform {",
  "  public static final String MARKER = \"client-only-marker\";",
  "}"
].join("\n");

const COMMON_CLASS_SOURCE = [
  "package net.minecraft.world.level.block;",
  "public class Block {",
  "  public static final String MARKER = \"common-marker\";",
  "}"
].join("\n");

// Real Loom split-source layout (no merged jar):
// .gradle/loom-cache/minecraftMaven/net/minecraft/minecraft-<half>-<hash>/<version>/...-sources.jar
async function buildSplitSourceWorkspace(): Promise<{
  service: SourceService;
  projectPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "split-source-"));
  const projectPath = join(root, "proj");
  const mavenRoot = join(projectPath, ".gradle", "loom-cache", "minecraftMaven", "net", "minecraft");

  const commonDir = join(mavenRoot, "minecraft-common-0724c4a43a", "1.21.9");
  await mkdir(commonDir, { recursive: true });
  await createJar(join(commonDir, "minecraft-common-0724c4a43a-1.21.9-sources.jar"), {
    "net/minecraft/world/level/block/Block.java": COMMON_CLASS_SOURCE
  });

  const clientDir = join(mavenRoot, "minecraft-clientOnly-043a8b3edf", "1.21.9");
  await mkdir(clientDir, { recursive: true });
  await createJar(join(clientDir, "minecraft-clientOnly-043a8b3edf-1.21.9-sources.jar"), {
    "net/minecraft/client/renderer/block/model/ItemTransform.java": CLIENT_CLASS_SOURCE
  });

  const binaryJarPath = join(root, "minecraft-1.21.9-client.jar");
  await createJar(binaryJarPath, {
    "net/minecraft/world/level/block/Block.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  (service as unknown as {
    versionService: {
      resolveVersionJar: (version: string) => Promise<{ version: string; jarPath: string; clientJarUrl: string }>;
    };
  }).versionService.resolveVersionJar = async () => ({
    version: "1.21.9",
    jarPath: binaryJarPath,
    clientJarUrl: "https://example.invalid/client.jar"
  });
  return { service, projectPath };
}

test("split-source workspaces index both the common and the client-only sources jars", async () => {
  const { service, projectPath } = await buildSplitSourceWorkspace();

  const resolved = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });

  assert.ok(
    resolved.provenance.companionSourceJars && resolved.provenance.companionSourceJars.length === 1,
    `expected one companion sources jar, got: ${JSON.stringify(resolved.provenance.companionSourceJars)}`
  );

  const clientSource = await service.getClassSource({
    className: "net.minecraft.client.renderer.block.model.ItemTransform",
    artifactId: resolved.artifactId,
    mode: "full"
  });
  assert.match(clientSource.sourceText, /client-only-marker/);

  const commonSource = await service.getClassSource({
    className: "net.minecraft.world.level.block.Block",
    artifactId: resolved.artifactId,
    mode: "full"
  });
  assert.match(commonSource.sourceText, /common-marker/);
});

test("client-only classes are findable via symbol search on split-source artifacts", async () => {
  const { service, projectPath } = await buildSplitSourceWorkspace();

  const resolved = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });

  const hits = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "ItemTransform",
    intent: "symbol",
    limit: 10
  });
  assert.ok(
    hits.hits.some((hit) => hit.filePath.includes("client/renderer/block/model/ItemTransform")),
    `expected a symbol hit for ItemTransform, got: ${JSON.stringify(hits.hits)}`
  );
});

test("split-source resolution keeps a deterministic artifact identity", async () => {
  const { service, projectPath } = await buildSplitSourceWorkspace();

  const first = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });
  const second = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });

  assert.equal(second.artifactId, first.artifactId);
});

test("a class absent from a version-target artifact suggests a vanilla-scope retry with existing enum values", async () => {
  const { service, projectPath } = await buildSplitSourceWorkspace();

  const resolved = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });

  await assert.rejects(
    () =>
      service.getClassSource({
        className: "net.minecraft.world.entity.NotInEitherJar",
        target: { kind: "version", value: "1.21.9" },
        mapping: "mojang",
        projectPath,
        mode: "full"
      }),
    (error: Error & {
      code?: string;
      details?: { exampleCalls?: Array<{ params?: { scope?: string } }> };
    }) => {
      assert.equal(error.code, "ERR_CLASS_NOT_FOUND");
      assert.ok(
        error.details?.exampleCalls?.some((example) => example.params?.scope === "vanilla"),
        `expected a vanilla-scope retry example, got: ${JSON.stringify(error.details?.exampleCalls)}`
      );
      return true;
    }
  );
  void resolved;
});

test("a wrong-version other-half jar is never picked as companion", async () => {
  const root = await mkdtemp(join(tmpdir(), "split-source-mismatch-"));
  const projectPath = join(root, "proj");
  const mavenRoot = join(projectPath, ".gradle", "loom-cache", "minecraftMaven", "net", "minecraft");

  const clientDir = join(mavenRoot, "minecraft-clientOnly-043a8b3edf", "1.21.9");
  await mkdir(clientDir, { recursive: true });
  await createJar(join(clientDir, "minecraft-clientOnly-043a8b3edf-1.21.9-sources.jar"), {
    "net/minecraft/client/renderer/block/model/ItemTransform.java": CLIENT_CLASS_SOURCE
  });
  // The only common-half jar present is a leftover from another version.
  const staleCommonDir = join(mavenRoot, "minecraft-common-9999aaaa", "1.21.8");
  await mkdir(staleCommonDir, { recursive: true });
  await createJar(join(staleCommonDir, "minecraft-common-9999aaaa-1.21.8-sources.jar"), {
    "net/minecraft/world/level/block/Block.java": COMMON_CLASS_SOURCE
  });

  const binaryJarPath = join(root, "minecraft-1.21.9-client.jar");
  await createJar(binaryJarPath, {
    "net/minecraft/world/level/block/Block.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const service = new SourceService(buildTestConfig(root));
  (service as unknown as {
    versionService: {
      resolveVersionJar: (version: string) => Promise<{ version: string; jarPath: string; clientJarUrl: string }>;
    };
  }).versionService.resolveVersionJar = async () => ({
    version: "1.21.9",
    jarPath: binaryJarPath,
    clientJarUrl: "https://example.invalid/client.jar"
  });

  const resolved = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });

  assert.equal(resolved.provenance.companionSourceJars, undefined);
});

test("the primary sources jar wins on duplicate file paths", async () => {
  const { service, projectPath } = await buildSplitSourceWorkspace();
  // Overwrite the companion (common) jar so it ALSO carries the client file
  // path with different content; the primary (clientOnly) copy must win.
  const commonDir = join(
    projectPath,
    ".gradle",
    "loom-cache",
    "minecraftMaven",
    "net",
    "minecraft",
    "minecraft-common-0724c4a43a",
    "1.21.9"
  );
  await createJar(join(commonDir, "minecraft-common-0724c4a43a-1.21.9-sources.jar"), {
    "net/minecraft/world/level/block/Block.java": COMMON_CLASS_SOURCE,
    "net/minecraft/client/renderer/block/model/ItemTransform.java":
      "package net.minecraft.client.renderer.block.model;\npublic class ItemTransform { /* companion-copy */ }\n"
  });
  // Keep the clientOnly jar the higher-scored (primary) half by giving it
  // more entries than the overwritten common jar.
  const clientDir = join(
    projectPath,
    ".gradle",
    "loom-cache",
    "minecraftMaven",
    "net",
    "minecraft",
    "minecraft-clientOnly-043a8b3edf",
    "1.21.9"
  );
  await createJar(join(clientDir, "minecraft-clientOnly-043a8b3edf-1.21.9-sources.jar"), {
    "net/minecraft/client/renderer/block/model/ItemTransform.java": CLIENT_CLASS_SOURCE,
    "net/minecraft/client/gui/Gui.java":
      "package net.minecraft.client.gui;\npublic class Gui {}\n",
    "net/minecraft/client/Minecraft.java":
      "package net.minecraft.client;\npublic class Minecraft {}\n"
  });

  const resolved = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });

  const clientSource = await service.getClassSource({
    className: "net.minecraft.client.renderer.block.model.ItemTransform",
    artifactId: resolved.artifactId,
    mode: "full"
  });
  assert.match(clientSource.sourceText, /client-only-marker/);
  assert.ok(!clientSource.sourceText.includes("companion-copy"));
});

test("a deleted companion jar degrades to a primary-only index instead of failing the rebuild", async () => {
  const { service, projectPath } = await buildSplitSourceWorkspace();
  const { rm } = await import("node:fs/promises");

  const resolved = await service.resolveArtifact({
    target: { kind: "version", value: "1.21.9" },
    mapping: "mojang",
    projectPath
  });
  const companion = resolved.provenance.companionSourceJars?.[0];
  assert.ok(companion);
  await rm(companion as string);

  const reindexed = await service.indexArtifact({ artifactId: resolved.artifactId, force: true });
  assert.equal(reindexed.reindexed, true);

  // The primary half stays served; the deleted companion's class is gone.
  const clientSource = await service.getClassSource({
    className: "net.minecraft.client.renderer.block.model.ItemTransform",
    artifactId: resolved.artifactId,
    mode: "full"
  });
  assert.match(clientSource.sourceText, /client-only-marker/);
});
