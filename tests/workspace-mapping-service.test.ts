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

test("detectDependencyVersion resolves a fabric-api submodule via the umbrella property (B5)", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-fabric-submodule-"));
  // Only the umbrella version is declared, as is conventional for Fabric API submodules.
  await writeFile(join(root, "gradle.properties"), "fabricApiVersion=0.131.0\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-fabric-submodule-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(
      root,
      "net.fabricmc.fabric-api",
      "fabric-screen-handler-api-v1"
    );

    assert.equal(result.resolved, true);
    if (result.resolved) {
      assert.equal(result.version, "0.131.0");
      assert.match(result.source, /fabricApiVersion/);
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
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

test("detectDependencyVersion resolves a single non-snapshot modules-2 entry", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-single-"));
  const cacheDir = join(fakeGradleHome, "caches", "modules-2", "files-2.1", "dev.architectury", "architectury");
  await mkdir(cacheDir, { recursive: true });
  for (const version of ["13.0.0", "13.0.0-snapshot", "13.0.1-dev"]) {
    await mkdir(join(cacheDir, version), { recursive: true });
  }

  const project = await mkdtemp(join(tmpdir(), "dep-version-modules2-single-"));
  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(project, "dev.architectury", "architectury");

    assert.equal(result.resolved, true);
    if (result.resolved) {
      assert.equal(result.version, "13.0.0");
      assert.match(result.source, /modules-2:/);
      assert.ok(!result.candidatesSeen.includes("13.0.0-snapshot"));
      assert.ok(!result.candidatesSeen.includes("13.0.1-dev"));
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion refuses to pick when modules-2 has multiple non-snapshot entries", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-multi-"));
  const cacheDir = join(fakeGradleHome, "caches", "modules-2", "files-2.1", "dev.architectury", "architectury");
  await mkdir(cacheDir, { recursive: true });
  for (const version of ["12.4.0", "13.0.0", "13.0.0-snapshot", "13.0.1-dev"]) {
    await mkdir(join(cacheDir, version), { recursive: true });
  }

  const project = await mkdtemp(join(tmpdir(), "dep-version-modules2-multi-"));
  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(project, "dev.architectury", "architectury");

    assert.equal(result.resolved, false);
    assert.ok(result.candidatesSeen.includes("13.0.0"));
    assert.ok(result.candidatesSeen.includes("12.4.0"));
    assert.ok(!result.candidatesSeen.includes("13.0.0-snapshot"));
    assert.ok(!result.candidatesSeen.includes("13.0.1-dev"));
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

test("detectDependencyVersion rejects unsafe version tokens from gradle.properties (path traversal guard)", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-traversal-"));
  const project = await mkdtemp(join(tmpdir(), "dep-version-traversal-prop-"));
  await writeFile(
    join(project, "gradle.properties"),
    [
      "architectury_version=../../../etc/passwd",
      "fabricApiVersion=v\\0bad",
      "architectury_architectury_version=valid_one"
    ].join("\n"),
    "utf8"
  );

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(project, "dev.architectury", "architectury");
    assert.equal(result.resolved, true);
    if (result.resolved) {
      assert.equal(result.version, "valid_one");
      assert.match(result.source, /architectury_architectury_version/);
      assert.ok(result.attempts.some((entry) => /rejected-unsafe-version/.test(entry)));
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion rejects unsafe modules-2 directory entries", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-modules-traversal-"));
  const cacheDir = join(fakeGradleHome, "caches", "modules-2", "files-2.1", "g.example", "lib");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(cacheDir, "1.0.0"), { recursive: true });
  await mkdir(join(cacheDir, "weird name"), { recursive: true });

  const project = await mkdtemp(join(tmpdir(), "dep-version-modules-traversal-"));
  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(project, "g.example", "lib");

    assert.equal(result.resolved, true);
    if (result.resolved) {
      assert.equal(result.version, "1.0.0");
      assert.ok(!result.candidatesSeen.includes("weird name"));
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

// --- detectProjectLoader -----------------------------------------------------

test("detectProjectLoader resolves fabric loader from fabric.mod.json alone", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-fabric-mod-json-"));
  await writeFile(join(root, "fabric.mod.json"), "{}", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "fabric");
  assert.ok(result.evidence.some((e) => e.reason === "fabric.mod.json"));
});

test("detectProjectLoader resolves quilt loader from quilt.mod.json", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-quilt-"));
  await writeFile(join(root, "quilt.mod.json"), "{}", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "quilt");
});

test("detectProjectLoader resolves neoforge loader from META-INF/neoforge.mods.toml", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-neoforge-toml-"));
  await mkdir(join(root, "META-INF"), { recursive: true });
  await writeFile(join(root, "META-INF", "neoforge.mods.toml"), "", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "neoforge");
});

test("detectProjectLoader resolves forge loader from META-INF/mods.toml", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-forge-toml-"));
  await mkdir(join(root, "META-INF"), { recursive: true });
  await writeFile(join(root, "META-INF", "mods.toml"), "", "utf8");
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, true);
  assert.equal(result.loader, "forge");
});

test("detectProjectLoader resolves fabric loader from fabric-loom plugin id", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "loader-none-"));
  const service = new WorkspaceMappingService();
  const result = await service.detectProjectLoader(root);
  assert.equal(result.resolved, false);
  assert.equal(result.evidence.length, 0);
  assert.ok(result.warnings.some((w) => /No workspace loader declaration/.test(w)));
});

// --- detectProjectMinecraftVersion -------------------------------------------

test("detectProjectMinecraftVersion returns minecraft_version when set", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-1-"));
  await writeFile(join(root, "gradle.properties"), "minecraft_version=1.21.10\n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), "1.21.10");
});

test("detectProjectMinecraftVersion accepts mc_version", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-2-"));
  await writeFile(join(root, "gradle.properties"), "mc_version=1.20.4\n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), "1.20.4");
});

test("detectProjectMinecraftVersion accepts minecraftVersion (camel)", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-3-"));
  await writeFile(join(root, "gradle.properties"), "minecraftVersion=1.21\n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), "1.21");
});

test("detectProjectMinecraftVersion prefers minecraft_version over mc_version when both are present", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-missing-"));
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), undefined);
});

test("detectProjectMinecraftVersion returns undefined for whitespace-only values", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mc-ver-blank-"));
  await writeFile(join(root, "gradle.properties"), "minecraft_version=   \n", "utf8");
  const service = new WorkspaceMappingService();
  assert.equal(await service.detectProjectMinecraftVersion(root), undefined);
});

// --- isSafeMavenVersionToken -------------------------------------------------

test("isSafeMavenVersionToken accepts boundary lengths (1, 200) and the allowed character set", async () => {
  const { isSafeMavenVersionToken } = await import("../src/workspace-mapping-service.ts");
  assert.equal(isSafeMavenVersionToken("1"), true);
  assert.equal(isSafeMavenVersionToken("a".repeat(200)), true);
  assert.equal(isSafeMavenVersionToken("1.0.0+build-7"), true);
  assert.equal(isSafeMavenVersionToken("1.0.0-snapshot"), true);
});

test("isSafeMavenVersionToken rejects empty, oversize, traversal, and unsafe characters", async () => {
  const { isSafeMavenVersionToken } = await import("../src/workspace-mapping-service.ts");
  assert.equal(isSafeMavenVersionToken(""), false);
  assert.equal(isSafeMavenVersionToken("a".repeat(201)), false);
  assert.equal(isSafeMavenVersionToken(".1.0"), false);
  assert.equal(isSafeMavenVersionToken("1..0"), false);
  assert.equal(isSafeMavenVersionToken("a/b"), false);
  assert.equal(isSafeMavenVersionToken("a\\b"), false);
  assert.equal(isSafeMavenVersionToken("a\0b"), false);
  assert.equal(isSafeMavenVersionToken("ver 1"), false);
});

// --- detectCompileMapping input + empty workspace ----------------------------

test("detectCompileMapping rejects empty projectPath with INVALID_INPUT", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const service = new WorkspaceMappingService();
  await assert.rejects(
    () => service.detectCompileMapping({ projectPath: "" }),
    (err: any) => err.code === "ERR_INVALID_INPUT"
  );
  await assert.rejects(
    () => service.detectCompileMapping({ projectPath: "   " }),
    (err: any) => err.code === "ERR_INVALID_INPUT"
  );
});

test("detectCompileMapping reports unresolved with warning when no build.gradle exists", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
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
