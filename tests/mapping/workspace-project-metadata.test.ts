import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("detectProjectLoader resolves fabric loader from fabric.mod.json alone", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-fabric-mod-json-"));
  await writeFile(join(root, "fabric.mod.json"), "{}", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "fabric");
  assert.ok(result.evidence.some((e) => e.reason === "fabric.mod.json"));
});

test("detectProjectLoader resolves quilt loader from quilt.mod.json", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-quilt-"));
  await writeFile(join(root, "quilt.mod.json"), "{}", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "quilt");
});

test("detectProjectLoader resolves neoforge loader from META-INF/neoforge.mods.toml", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-neoforge-toml-"));
  await mkdir(join(root, "META-INF"), { recursive: true });
  await writeFile(join(root, "META-INF", "neoforge.mods.toml"), "", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "neoforge");
});

test("detectProjectLoader resolves forge loader from META-INF/mods.toml", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-forge-toml-"));
  await mkdir(join(root, "META-INF"), { recursive: true });
  await writeFile(join(root, "META-INF", "mods.toml"), "", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "forge");
});

test("detectProjectLoader resolves fabric loader from fabric-loom plugin id", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-fabric-plugin-"));
  await writeFile(
    join(root, "build.gradle"),
    ["plugins {", "  id 'fabric-loom' version '1.9'", "}"].join("\n"),
    "utf8"
  );
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "fabric");
});

test("detectProjectLoader resolves fabric loader from architectury loom alias", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-architectury-loom-"));
  await writeFile(
    join(root, "build.gradle.kts"),
    ["plugins {", "  id(\"dev.architectury.loom\") version \"1.9\"", "}"].join("\n"),
    "utf8"
  );
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "fabric");
});

test("detectProjectLoader resolves forge loader from minecraft.accessTransformer block", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-forge-at-"));
  await writeFile(
    join(root, "build.gradle"),
    ["minecraft {", "  accessTransformer = file('src/main/resources/META-INF/at.cfg')", "}"].join("\n"),
    "utf8"
  );
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "forge");
});

test("detectProjectLoader resolves neoforge loader from neoForge.accessTransformers block", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-neoforge-at-"));
  await writeFile(
    join(root, "build.gradle"),
    ["neoForge {", "  accessTransformers.add(\"src/main/resources/META-INF/at.cfg\")", "}"].join("\n"),
    "utf8"
  );
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "neoforge");
});

test("detectProjectLoader reports unresolved with descriptive warning when both fabric.mod.json and META-INF/mods.toml coexist", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-multi-"));
  await writeFile(join(root, "fabric.mod.json"), "{}", "utf8");
  await mkdir(join(root, "META-INF"), { recursive: true });
  await writeFile(join(root, "META-INF", "mods.toml"), "", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, false);
  assert.ok(
    result.warnings.some((w) => /Multiple or ambiguous workspace loaders/.test(w)),
    `expected ambiguous warning, got: ${JSON.stringify(result.warnings)}`
  );
});

test("detectProjectLoader reports unresolved when nothing in the workspace declares a loader", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-none-"));
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, false);
  assert.equal(result.evidence.length, 0);
  assert.ok(result.warnings.some((w) => /No workspace loader declaration/.test(w)));
});

// --- detectProjectMinecraftVersion -------------------------------------------

test("detectProjectMinecraftVersion returns minecraft_version when set", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-1-"));
  await writeFile(join(root, "gradle.properties"), "minecraft_version=1.21.10\n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), "1.21.10");
});

test("detectProjectMinecraftVersion accepts mc_version", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-2-"));
  await writeFile(join(root, "gradle.properties"), "mc_version=1.20.4\n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), "1.20.4");
});

test("detectProjectMinecraftVersion accepts minecraftVersion (camel)", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-3-"));
  await writeFile(join(root, "gradle.properties"), "minecraftVersion=1.21\n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), "1.21");
});

test("detectProjectMinecraftVersion prefers minecraft_version over mc_version when both are present", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-pri-"));
  await writeFile(
    join(root, "gradle.properties"),
    ["minecraft_version=1.21.10", "mc_version=1.20.4", "minecraftVersion=1.21"].join("\n"),
    "utf8"
  );
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), "1.21.10");
});

test("detectProjectMinecraftVersion returns undefined when gradle.properties is missing", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-missing-"));
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), undefined);
});

test("detectProjectMinecraftVersion returns undefined for whitespace-only values", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-blank-"));
  await writeFile(join(root, "gradle.properties"), "minecraft_version=   \n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), undefined);
});

// --- isSafeMavenVersionToken -------------------------------------------------
