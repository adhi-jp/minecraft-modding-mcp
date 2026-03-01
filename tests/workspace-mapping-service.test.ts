import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("WorkspaceMappingService detects mojang mapping from officialMojangMappings", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
