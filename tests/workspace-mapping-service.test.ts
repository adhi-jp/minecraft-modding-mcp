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

// Builds a synthetic modules-2 umbrella POM the way gradle caches it:
// <home>/caches/modules-2/files-2.1/<group>/<umbrella>/<version>/<hash>/<umbrella>-<version>.pom
// Real Fabric API umbrella POMs list submodule versions as direct
// <dependencies> entries (not <dependencyManagement>).
async function writeUmbrellaPom(
  gradleHome: string,
  group: string,
  umbrellaName: string,
  umbrellaVersion: string,
  entries: Array<{ group: string; name: string; version: string }>
): Promise<string> {
  const pomDir = join(
    gradleHome,
    "caches",
    "modules-2",
    "files-2.1",
    group,
    umbrellaName,
    umbrellaVersion,
    "0f148680b920d01cbdca21114170eea7a4fc8356"
  );
  await mkdir(pomDir, { recursive: true });
  const deps = entries
    .map(
      (entry) =>
        [
          "    <dependency>",
          `      <groupId>${entry.group}</groupId>`,
          `      <artifactId>${entry.name}</artifactId>`,
          `      <version>${entry.version}</version>`,
          "      <scope>compile</scope>",
          "    </dependency>"
        ].join("\n")
    )
    .join("\n");
  const pom = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<project>",
    `  <groupId>${group}</groupId>`,
    `  <artifactId>${umbrellaName}</artifactId>`,
    `  <version>${umbrellaVersion}</version>`,
    "  <dependencies>",
    deps,
    "  </dependencies>",
    "</project>",
    ""
  ].join("\n");
  const pomPath = join(pomDir, `${umbrellaName}-${umbrellaVersion}.pom`);
  await writeFile(pomPath, pom, "utf8");
  return pomPath;
}

async function writeSubmoduleVersions(
  gradleHome: string,
  group: string,
  name: string,
  versions: string[]
): Promise<void> {
  for (const version of versions) {
    await mkdir(
      join(gradleHome, "caches", "modules-2", "files-2.1", group, name, version),
      { recursive: true }
    );
  }
}

test("detectDependencyVersion fails closed on several submodule versions when no umbrella property is declared", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-no-umbrella-prop-"));
  await writeFile(join(root, "gradle.properties"), "# no version here\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-no-umbrella-prop-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);
  await writeUmbrellaPom(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-api", "0.131.0", [
    { group: "net.fabricmc.fabric-api", name: "fabric-screen-handler-api-v1", version: "2.0.5+06488ac19e" }
  ]);

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(
      root,
      "net.fabricmc.fabric-api",
      "fabric-screen-handler-api-v1"
    );

    // Without a declared umbrella version there is no project evidence for
    // which POM applies, so the POM on disk must not be consulted.
    assert.equal(result.resolved, false);
    assert.ok(!result.attempts.some((entry) => entry.startsWith("umbrella-pom:")));
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion rejects an unsafe umbrella property value before touching the cache path", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-unsafe-umbrella-"));
  await writeFile(join(root, "gradle.properties"), "fabric_api_version=../../../etc\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-unsafe-umbrella-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(
      root,
      "net.fabricmc.fabric-api",
      "fabric-screen-handler-api-v1"
    );

    assert.equal(result.resolved, false);
    assert.ok(!result.attempts.some((entry) => entry.startsWith("umbrella-pom:")));
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion fails closed when the umbrella POM content is not parseable", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-garbage-pom-"));
  await writeFile(join(root, "gradle.properties"), "fabric_api_version=0.131.0\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-garbage-pom-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);
  const pomDir = join(
    fakeGradleHome,
    "caches",
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-api",
    "0.131.0",
    "0f148680b920d01cbdca2111"
  );
  await mkdir(pomDir, { recursive: true });
  await writeFile(join(pomDir, "fabric-api-0.131.0.pom"), "not xml at all  ", "utf8");

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(
      root,
      "net.fabricmc.fabric-api",
      "fabric-screen-handler-api-v1"
    );

    assert.equal(result.resolved, false);
    assert.deepEqual([...result.candidatesSeen].sort(), ["2.0.5+06488ac19c", "2.0.5+06488ac19e"]);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion does not adopt the umbrella property as a submodule version when nothing is cached", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-fabric-submodule-"));
  // Only the umbrella version is declared, as is conventional for Fabric API
  // submodules. The umbrella version is not the submodule's own version, so
  // with no cached submodule evidence the resolution must fail closed instead
  // of synthesizing a nonexistent coordinate like
  // net.fabricmc.fabric-api:fabric-screen-handler-api-v1:0.131.0.
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

    assert.equal(result.resolved, false);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion adopts the umbrella POM version when modules-2 has several submodule versions", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-pom-adopt-"));
  await writeFile(join(root, "gradle.properties"), "fabric_api_version=0.131.0\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-pom-adopt-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);
  await writeUmbrellaPom(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-api", "0.131.0", [
    { group: "net.fabricmc.fabric-api", name: "fabric-api-base", version: "1.0.0+aaaa" },
    { group: "net.fabricmc.fabric-api", name: "fabric-screen-handler-api-v1", version: "2.0.5+06488ac19e" }
  ]);

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
      assert.equal(result.version, "2.0.5+06488ac19e");
      assert.match(result.source, /^umbrella-pom:/);
      assert.equal(result.submoduleVersionSource, "umbrella-pom");
      assert.deepEqual([...result.candidatesSeen].sort(), ["2.0.5+06488ac19c", "2.0.5+06488ac19e"]);
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion fails closed on several submodule versions without an umbrella POM", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-pom-missing-"));
  await writeFile(join(root, "gradle.properties"), "fabric_api_version=0.131.0\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-pom-missing-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(
      root,
      "net.fabricmc.fabric-api",
      "fabric-screen-handler-api-v1"
    );

    assert.equal(result.resolved, false);
    assert.deepEqual([...result.candidatesSeen].sort(), ["2.0.5+06488ac19c", "2.0.5+06488ac19e"]);
    assert.ok(result.attempts.some((entry) => entry.startsWith("umbrella-pom:")));
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion skips a version-less POM dependency block and adopts a later concrete one", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-pom-versionless-"));
  await writeFile(join(root, "gradle.properties"), "fabric_api_version=0.131.0\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-pom-versionless-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);
  // Hand-write a POM whose first matching block is a managed entry without a
  // literal <version>; the concrete <dependencies> entry follows it.
  const pomDir = join(
    fakeGradleHome,
    "caches",
    "modules-2",
    "files-2.1",
    "net.fabricmc.fabric-api",
    "fabric-api",
    "0.131.0",
    "0f148680b920d01cbdca21114170eea7a4fc8356"
  );
  await mkdir(pomDir, { recursive: true });
  await writeFile(
    join(pomDir, "fabric-api-0.131.0.pom"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<project>",
      "  <dependencyManagement>",
      "    <dependencies>",
      "      <dependency>",
      "        <groupId>net.fabricmc.fabric-api</groupId>",
      "        <artifactId>fabric-screen-handler-api-v1</artifactId>",
      "      </dependency>",
      "    </dependencies>",
      "  </dependencyManagement>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>net.fabricmc.fabric-api</groupId>",
      "      <artifactId>fabric-screen-handler-api-v1</artifactId>",
      "      <version>2.0.5+06488ac19c</version>",
      "    </dependency>",
      "  </dependencies>",
      "</project>",
      ""
    ].join("\n"),
    "utf8"
  );

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
      assert.equal(result.version, "2.0.5+06488ac19c");
      assert.equal(result.submoduleVersionSource, "umbrella-pom");
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion fails closed when the umbrella POM names a version that is not cached", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-pom-stale-"));
  await writeFile(join(root, "gradle.properties"), "fabric_api_version=0.131.0\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-pom-stale-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);
  // The POM names a version whose jar is not in the cache; adopting it would
  // synthesize an unresolvable coordinate, so the lookup must fail closed.
  await writeUmbrellaPom(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-api", "0.131.0", [
    { group: "net.fabricmc.fabric-api", name: "fabric-screen-handler-api-v1", version: "3.0.0+ffffffffff" }
  ]);

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(
      root,
      "net.fabricmc.fabric-api",
      "fabric-screen-handler-api-v1"
    );

    assert.equal(result.resolved, false);
    assert.deepEqual([...result.candidatesSeen].sort(), ["2.0.5+06488ac19c", "2.0.5+06488ac19e"]);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion prefers the submodule's own property key over cache and POM evidence", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-own-key-"));
  await writeFile(
    join(root, "gradle.properties"),
    ["fabric_screen_handler_api_v1_version=9.9.9", "fabric_api_version=0.131.0"].join("\n"),
    "utf8"
  );
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-own-key-"));
  await writeSubmoduleVersions(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-screen-handler-api-v1", [
    "2.0.5+06488ac19c",
    "2.0.5+06488ac19e"
  ]);
  await writeUmbrellaPom(fakeGradleHome, "net.fabricmc.fabric-api", "fabric-api", "0.131.0", [
    { group: "net.fabricmc.fabric-api", name: "fabric-screen-handler-api-v1", version: "2.0.5+06488ac19e" }
  ]);

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
      assert.equal(result.version, "9.9.9");
      assert.equal(result.source, "gradle.properties:fabric_screen_handler_api_v1_version");
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
    // Hyphen-less names dedupe their snake_case transforms into the raw keys,
    // so the enumeration stays at 4 entries.
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

test("detectDependencyVersion enumerates snake_case probe keys for hyphenated umbrella names", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-umbrella-keys-"));
  await writeFile(join(root, "gradle.properties"), "# no version here\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-umbrella-keys-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(root, "net.fabricmc.fabric-api", "fabric-api");

    assert.equal(result.resolved, false);
    const propsAttempts = result.attempts.filter((entry) => entry.startsWith("gradle.properties:"));
    // The umbrella artifact itself (groupSegment === name) gets no umbrella
    // fallback keys, so the snake_case transforms of the artifact name and the
    // group/name compound must be part of the base enumeration.
    assert.deepEqual(propsAttempts, [
      "gradle.properties:fabric-api_version",
      "gradle.properties:fabric_api_version",
      "gradle.properties:fabricApiVersion",
      "gradle.properties:fabric-api_fabric-api_version",
      "gradle.properties:fabric_api_fabric_api_version",
      "gradle.properties:fabricApiFabricApiVersion"
    ]);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion resolves the umbrella via the snake_case fabric_api_version key", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-umbrella-snake-"));
  // Golden fixture: real-world Fabric templates declare the umbrella version
  // only as snake_case fabric_api_version.
  await writeFile(join(root, "gradle.properties"), "fabric_api_version=0.153.0+26.2\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-umbrella-snake-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(root, "net.fabricmc.fabric-api", "fabric-api");

    assert.equal(result.resolved, true);
    if (result.resolved) {
      assert.equal(result.version, "0.153.0+26.2");
      assert.match(result.source, /gradle\.properties:fabric_api_version/);
      assert.ok(result.attempts.includes("gradle.properties:fabric_api_version"));
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion prefers fabric_api_version over fabricApiVersion when both are present", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-umbrella-precedence-"));
  await writeFile(
    join(root, "gradle.properties"),
    ["fabricApiVersion=0.130.0", "fabric_api_version=0.153.0+26.2"].join("\n"),
    "utf8"
  );
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-umbrella-precedence-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(root, "net.fabricmc.fabric-api", "fabric-api");

    assert.equal(result.resolved, true);
    if (result.resolved) {
      // The snake_case key precedes the camelCase key in the probe order.
      assert.equal(result.version, "0.153.0+26.2");
      assert.equal(result.source, "gradle.properties:fabric_api_version");
    }
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion enumerates probe keys for a multi-hyphen submodule name", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-submodule-keys-"));
  await writeFile(join(root, "gradle.properties"), "# no version here\n", "utf8");
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-submodule-keys-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(
      root,
      "net.fabricmc.fabric-api",
      "fabric-screen-handler-api-v1"
    );

    assert.equal(result.resolved, false);
    const propsAttempts = result.attempts.filter((entry) => entry.startsWith("gradle.properties:"));
    // Six base keys: the snake_case transforms of the name and the group/name
    // compound differ from both the raw and camelCase forms. Umbrella
    // properties (fabric_api_version / fabricApiVersion) are not probed as
    // direct version sources for submodules — they only locate the umbrella
    // POM when modules-2 has several cached submodule versions.
    assert.deepEqual(propsAttempts, [
      "gradle.properties:fabric-screen-handler-api-v1_version",
      "gradle.properties:fabric_screen_handler_api_v1_version",
      "gradle.properties:fabricScreenHandlerApiV1Version",
      "gradle.properties:fabric-api_fabric-screen-handler-api-v1_version",
      "gradle.properties:fabric_api_fabric_screen_handler_api_v1_version",
      "gradle.properties:fabricApiFabricScreenHandlerApiV1Version"
    ]);
  } finally {
    delete process.env.GRADLE_USER_HOME;
  }
});

test("detectDependencyVersion does not pick up unrelated *_version keys for the umbrella", async () => {
  const { WorkspaceMappingService } = await import("../src/workspace-mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "dep-version-umbrella-unrelated-"));
  await writeFile(
    join(root, "gradle.properties"),
    ["loader_version=0.16.9", "minecraft_version=26.2", "yarn_mappings_version=26.2+build.1"].join("\n"),
    "utf8"
  );
  const fakeGradleHome = await mkdtemp(join(tmpdir(), "fake-gradle-umbrella-unrelated-"));

  process.env.GRADLE_USER_HOME = fakeGradleHome;
  try {
    const service = new WorkspaceMappingService();
    const result = await service.detectDependencyVersion(root, "net.fabricmc.fabric-api", "fabric-api");

    assert.equal(result.resolved, false);
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
