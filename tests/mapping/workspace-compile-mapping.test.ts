import assert from "node:assert/strict";
import { expectAppErrorCode } from "../helpers/expect-app-error.ts";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("WorkspaceMappingService detects mojang mapping from officialMojangMappings", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "workspace-mapping-mojang-"));
  await writeFile(
    join(root, "build.gradle"),
    [
      "plugins {",
      "  id 'fabric-loom' version '1.9-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true);
  assert.equal(result.mappingApplied, "mojang");
  assert.equal(result.evidence.length, 1);
});

test("WorkspaceMappingService detects yarn mapping from Fabric coordinates in Gradle Kotlin DSL", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "workspace-mapping-yarn-"));
  await writeFile(
    join(root, "build.gradle.kts"),
    [
      "plugins {",
      "  id(\"dev.architectury.loom\") version \"1.9-SNAPSHOT\"",
      "}",
      "dependencies {",
      "  mappings(\"net.fabricmc:yarn:1.21.10+build.1:v2\")",
      "}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true);
  assert.equal(result.mappingApplied, "yarn");
  assert.equal(result.evidence[0]?.mapping, "yarn");
});

test("WorkspaceMappingService reports unresolved when modules disagree on mapping", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "workspace-mapping-mixed-"));
  await writeFile(
    join(root, "build.gradle"),
    ["dependencies {", "  mappings loom.officialMojangMappings()", "}"].join("\n"),
    "utf8"
  );
  await mkdir(join(root, "common"), { recursive: true });
  await writeFile(
    join(root, "common", "build.gradle.kts"),
    ["dependencies {", "  mappings(\"net.fabricmc:yarn:1.21.10+build.1:v2\")", "}"].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, false);
  assert.equal(result.mappingApplied, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("Multiple compile mappings")));
});

test("WorkspaceMappingService detects mojang mapping from NeoForge ModDevGradle workspace", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "workspace-mapping-neoforge-"));
  await writeFile(
    join(root, "build.gradle"),
    [
      "plugins {",
      "  id 'java-library'",
      "  id 'net.neoforged.moddev' version '2.0.140'",
      "}",
      "",
      "neoForge {",
      "  version = project.neo_version",
      "  parchment {",
      "    mappingsVersion = project.parchment_mappings_version",
      "    minecraftVersion = project.parchment_minecraft_version",
      "  }",
      "}"
    ].join("\n"),
    "utf8"
  );

  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });

  assert.equal(result.resolved, true);
  assert.equal(result.mappingApplied, "mojang");
  assert.ok(result.evidence.some((entry) => entry.reason.includes("net.neoforged.moddev")));
});

test("detectCompileMapping rejects empty projectPath with INVALID_INPUT", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const service = new WorkspaceMappingService();
  await assert.rejects(
    () => service.detectCompileMapping({ projectPath: "" }),
    expectAppErrorCode("ERR_INVALID_INPUT")
  );
  await assert.rejects(
    () => service.detectCompileMapping({ projectPath: "   " }),
    expectAppErrorCode("ERR_INVALID_INPUT")
  );
});

test("detectCompileMapping reports unresolved with warning when no build.gradle exists", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-empty-"));
  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });
  assert.equal(result.resolved, false);
  assert.equal(result.evidence.length, 0);
  assert.ok(
    result.warnings.some((w) => /No compile-time mapping declaration/.test(w)),
    `expected no-mapping warning, got: ${JSON.stringify(result.warnings)}`
  );
});

test("detectCompileMapping resolves intermediary mapping from net.fabricmc:intermediary dependency", async () => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-intermediary-"));
  await writeFile(
    join(root, "build.gradle.kts"),
    ["dependencies {", "  mappings(\"net.fabricmc:intermediary:1.21.10\")", "}"].join("\n"),
    "utf8"
  );
  const service = new WorkspaceMappingService();
  const result = await service.detectCompileMapping({ projectPath: root });
  assert.equal(result.resolved, true);
  assert.equal(result.mappingApplied, "intermediary");
});

test("WorkspaceMappingService build-script discovery does not follow symbolic links back into the project", { timeout: 8000 }, async (t) => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "workspace-mapping-symlinks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "build.gradle"), "plugins {\n  id 'fabric-loom'\n}\ndependencies {\n  mappings loom.officialMojangMappings()\n}\n", "utf8");
  await symlink(root, join(root, "l1"));
  await symlink(root, join(root, "l2"));

  const service = new WorkspaceMappingService();
  const compile = await service.detectCompileMapping({ projectPath: root });
  assert.equal(compile.mappingApplied, "mojang");
  assert.equal(compile.evidence.length, 1);
  const loader = await service.detectProjectLoader(root);
  assert.ok(loader.evidence.length > 0);
  assert.ok(loader.evidence.every((entry) => !entry.filePath.includes("/l1/") && !entry.filePath.includes("/l2/")));
});

test("WorkspaceMappingService build-script discovery skips a directory it cannot read", { timeout: 8000, skip: process.getuid?.() === 0 }, async (t) => {
  const { WorkspaceMappingService } = await import("../../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "workspace-mapping-unreadable-"));
  const locked = join(root, "locked");
  t.after(async () => {
    await chmod(locked, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "build.gradle"), "plugins {\n  id 'fabric-loom'\n}\ndependencies {\n  mappings loom.officialMojangMappings()\n}\n", "utf8");
  await mkdir(locked);
  await chmod(locked, 0o000);

  const service = new WorkspaceMappingService();
  const compile = await service.detectCompileMapping({ projectPath: root });
  assert.equal(compile.mappingApplied, "mojang");
  const loader = await service.detectProjectLoader(root);
  assert.equal(loader.resolved, true);
});
