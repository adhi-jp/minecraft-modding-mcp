import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("WorkspaceMappingService detects mojang mapping from NeoForge ModDevGradle workspace", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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

test("WorkspaceMappingService uses async glob discovery on workspace hot paths", async () => {
  const source = await readFile("src/workspace-mapping-service.ts", "utf8");

  assert.doesNotMatch(source, /fastGlob\.sync\(/);
  assert.match(source, /mapWithConcurrencyLimit/);
});

test("detectDependencyVersion reads architectury_version from gradle.properties", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-arch-"));
  await writeFile(join(root, "gradle.properties"), "architectury_version=13.0.0\n", "utf8");

  const service = new WorkspaceMappingService();
  const result = await service.detectDependencyVersion(root, "dev.architectury", "architectury");

  assert.equal(result.resolved, true);
  if (result.resolved) {
    assert.equal(result.version, "13.0.0");
    assert.match(result.source, /gradle\.properties:architectury_version/);
    assert.ok(result.attempts.includes("gradle.properties:architectury_version"));
  }
});

test("detectDependencyVersion reads camelCase property fabricApiVersion", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-fabric-"));
  await writeFile(join(root, "gradle.properties"), "fabricApiVersion=0.131.0\n", "utf8");

  const service = new WorkspaceMappingService();
  const result = await service.detectDependencyVersion(root, "net.fabricmc.fabric-api", "fabric-api");

  assert.equal(result.resolved, true);
  if (result.resolved) {
    assert.equal(result.version, "0.131.0");
    assert.match(result.source, /fabricApiVersion/);
  }
});

test("detectDependencyVersion enumerates 4 dedup'd property keys in order", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-keys-"));
  await writeFile(join(root, "gradle.properties"), "# no version here\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-empty-keys-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(root, "dev.architectury", "architectury");

    assert.equal(result.resolved, false);
    const propsAttempts = result.attempts.filter((entry) => entry.startsWith("gradle.properties:"));
    assert.deepEqual(propsAttempts, [
      "gradle.properties:architectury_version",
      "gradle.properties:architecturyVersion",
      "gradle.properties:architectury_architectury_version",
      "gradle.properties:architecturyArchitecturyVersion"
    ]);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion picks semver-newest from modules-2 cache and excludes snapshots", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-home-"));
  const cacheDir = join(fakeGradleHome, "caches", "modules-2", "files-2.1", "dev.architectury", "architectury");
  await mkdir(cacheDir, { recursive: true });
  for (const version of ["12.4.0", "13.0.0", "13.0.0-snapshot", "13.0.1-dev"]) {
    await mkdir(join(cacheDir, version), { recursive: true });
  }

  const project = await mkdtemp(join(tmpdir(), "dep-version-modules2-"));
  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(project, "dev.architectury", "architectury");

    assert.equal(result.resolved, true);
    if (result.resolved) {
      assert.equal(result.version, "13.0.0");
      assert.match(result.source, /modules-2:/);
      assert.ok(result.candidatesSeen.includes("13.0.0"));
      assert.ok(result.candidatesSeen.includes("12.4.0"));
      assert.ok(!result.candidatesSeen.includes("13.0.0-snapshot"));
      assert.ok(!result.candidatesSeen.includes("13.0.1-dev"));
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion returns unresolved when neither gradle.properties nor modules-2 has the dependency", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-empty-"));
  const project = await mkdtemp(join(tmpdir(), "dep-version-empty-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(project, "dev.architectury", "architectury");

    assert.equal(result.resolved, false);
    assert.ok(result.attempts.length >= 5);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion includes snapshots when opts.includeSnapshots is true", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-snap-"));
  const cacheDir = join(fakeGradleHome, "caches", "modules-2", "files-2.1", "g.example", "lib");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(cacheDir, "1.0.0-snapshot"), { recursive: true });

  const project = await mkdtemp(join(tmpdir(), "dep-version-snap-"));
  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(project, "g.example", "lib", {
      includeSnapshots: true
    });

    assert.equal(result.resolved, true);
    if (result.resolved) {
      assert.equal(result.version, "1.0.0-snapshot");
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion rejects path traversal in group/name", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const project = await mkdtemp(join(tmpdir(), "dep-version-traversal-"));

  const service = new WorkspaceMappingService();
  await assert.rejects(
    () => service.detectDependencyVersion(project, "../etc", "passwd"),
    (err: Error & { code?: string }) => err.code === "ERR_INVALID_INPUT"
  );
  await assert.rejects(
    () => service.detectDependencyVersion(project, "g.example", "lib/etc"),
    (err: Error & { code?: string }) => err.code === "ERR_INVALID_INPUT"
  );
});
