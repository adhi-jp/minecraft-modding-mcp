import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import {
  describeServedRuntimeJar,
  hasExactVersionToken,
  inferRuntimeJarMinecraftVersion
} from "../../src/source/artifact-resolver.ts";
import { withVersionApproximationFixture } from "../helpers/source-service-fixtures.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * Regression: a pre-release id EXTENDS the release it is named after
 * (`26.1-pre-1` is not `26.1`, `1.21-rc1` is not `1.21`), but the version-token
 * lookahead only blocked a following alphanumeric or `.digit`. A hyphen walked
 * straight through it, so a release-candidate jar was served as an exact match:
 * strictVersion was satisfied silently and nothing was ever flagged as
 * approximated.
 */

test("hasExactVersionToken refuses a pre-release path for the release id it extends", () => {
  assert.equal(
    hasExactVersionToken("/home/u/.gradle/caches/fabric-loom/1.21-rc1/minecraft-merged.jar", "1.21"),
    false
  );
  assert.equal(hasExactVersionToken("/cache/26.1-pre-1/minecraft-merged.jar", "26.1"), false);
  assert.equal(hasExactVersionToken("/cache/26.1-rc-1/minecraft-merged.jar", "26.1"), false);
  assert.equal(hasExactVersionToken("/cache/26.1-snapshot-1/minecraft-merged.jar", "26.1"), false);
  assert.equal(hasExactVersionToken("/cache/1.14.4-pre7/minecraft-merged.jar", "1.14.4"), false);
});

test("hasExactVersionToken still matches a full pre-release id and ordinary path decoration", () => {
  // A pre-release id must still match its OWN path.
  assert.equal(hasExactVersionToken("/cache/26.1-pre-1/minecraft-merged.jar", "26.1-pre-1"), true);
  assert.equal(hasExactVersionToken("/cache/1.21-rc1/minecraft-merged.jar", "1.21-rc1"), true);
  // A hyphen that does NOT open a version suffix is ordinary path decoration.
  assert.equal(
    hasExactVersionToken("/cache/fabric-loom/1.21.1/minecraft-1.21.1-merged.jar", "1.21.1"),
    true
  );
  assert.equal(hasExactVersionToken("/cache/26.1/minecraft-26.1-merged-mojang.jar", "26.1"), true);
  // The prefix guard this predicate already carried stays in force.
  assert.equal(hasExactVersionToken("/cache/1.21.10/minecraft-merged.jar", "1.21.1"), false);
});

test("inferRuntimeJarMinecraftVersion reads the 26.1+ id families, not just 1.x", () => {
  assert.equal(
    inferRuntimeJarMinecraftVersion("/home/u/.gradle/caches/fabric-loom/26.1/minecraft-merged.jar"),
    "26.1"
  );
  assert.equal(
    inferRuntimeJarMinecraftVersion("/home/u/.gradle/caches/fabric-loom/26.2.1/minecraft-merged.jar"),
    "26.2.1"
  );
  assert.equal(
    inferRuntimeJarMinecraftVersion("/home/u/.gradle/caches/fabric-loom/26.2-pre-6/minecraft-merged.jar"),
    "26.2-pre-6"
  );
  assert.equal(
    inferRuntimeJarMinecraftVersion("/home/u/.gradle/caches/fabric-loom/26w01a/minecraft-merged.jar"),
    "26w01a"
  );
  // A legacy pre-release names itself too, never the release it precedes.
  assert.equal(
    inferRuntimeJarMinecraftVersion("/home/u/.gradle/caches/fabric-loom/1.21-rc1/minecraft-merged.jar"),
    "1.21-rc1"
  );
  // A loader version still must never be read as a Minecraft version.
  assert.equal(inferRuntimeJarMinecraftVersion("/x/neoforge-21.10.50-beta.jar"), undefined);
  assert.equal(inferRuntimeJarMinecraftVersion("/x/caches/modules-2/files-2.1/x.jar"), undefined);
});

test("describeServedRuntimeJar flags the approximation when a 26.1 jar serves a 26.2 request", () => {
  const served = describeServedRuntimeJar({
    jarPath: "/home/u/.gradle/caches/fabric-loom/26.1/minecraft-merged-mojang.jar",
    requestedVersion: "26.2"
  });

  assert.equal(served.version, "26.1");
  assert.equal(served.requestedVersion, "26.2");
  assert.equal(served.versionApproximated, true);
  assert.equal(served.notes.length, 1);
});

test("discoverVersionSourceJar refuses a pre-release jar as the other half of a split-source pair", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "split-affinity-"));
  const projectPath = join(root, "workspace");
  const loomCache = join(projectPath, ".gradle", "loom-cache");
  await mkdir(loomCache, { recursive: true });

  await createJar(join(loomCache, "minecraft-common-1.21-sources.jar"), {
    "net/minecraft/world/level/block/Blocks.java":
      "package net.minecraft.world.level.block;\npublic class Blocks {}"
  });
  // A leftover from the release candidate: a different version, and splicing it
  // into 1.21's index mixes two runtimes' classes.
  await createJar(join(loomCache, "minecraft-clientonly-1.21-rc1-sources.jar"), {
    "net/minecraft/client/Minecraft.java":
      "package net.minecraft.client;\npublic class Minecraft {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const discovery = await service.discoverVersionSourceJar({ version: "1.21", projectPath });

  assert.match(String(discovery.selectedSourceJarPath), /minecraft-common-1\.21-sources\.jar$/);
  assert.equal(discovery.companionSourceJarPaths, undefined);
});

test("discoverAccessTransformerRuntimeCandidates drops a pre-release jar for lack of version evidence", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "at-evidence-"));
  const gradleUserHome = join(root, "gradle-home");
  const runtimeDir = join(gradleUserHome, "caches", "neoformruntime", "1.21-rc1");
  await mkdir(runtimeDir, { recursive: true });
  await createJar(join(runtimeDir, "minecraft-joined.jar"), {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const discovery = await service.discoverAccessTransformerRuntimeCandidates({
    version: "1.21",
    gradleUserHome,
    requestedScope: "loader",
    atNamespace: "mojang",
    loader: "unknown"
  });

  assert.equal(discovery.selected, undefined);
  assert.deepEqual(discovery.candidateArtifacts, []);
});

test("resolveAccessWidenerRuntimeArtifact reports a pre-release runtime jar as an approximation", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "aw-approx-"));
  const projectPath = join(root, "workspace");
  await mkdir(projectPath, { recursive: true });
  await writeFile(
    join(projectPath, "build.gradle"),
    ["plugins {", "  id 'fabric-loom' version '1.11-SNAPSHOT'", "}"].join("\n"),
    "utf8"
  );
  const gradleUserHome = join(root, "gradle-home");
  const loomDir = join(gradleUserHome, "caches", "fabric-loom", "1.21-rc1");
  await mkdir(loomDir, { recursive: true });
  await createJar(join(loomDir, "minecraft-merged-mojang.jar"), {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const provenance = await service.resolveAccessWidenerRuntimeArtifact({
    version: "1.21",
    awNamespace: "named",
    projectPath,
    gradleUserHome,
    scope: "merged"
  });

  // Pre-fix this answered version "1.21" with no approximation at all: the
  // token predicate called the release-candidate path an exact match and the
  // version reader could not tell the two ids apart.
  assert.equal(provenance.version, "1.21-rc1");
  assert.equal(provenance.requestedVersion, "1.21");
  assert.equal(provenance.versionApproximated, true);
  assert.ok(
    provenance.resolutionNotes?.some((note) => note.includes("1.21-rc1")),
    `Expected a served-version note, got: ${JSON.stringify(provenance.resolutionNotes)}`
  );
});

test("resolveArtifact strictVersion refuses a release-candidate source jar", async () => {
  await withVersionApproximationFixture(
    {
      rootPrefix: "strict-prerelease-",
      requestedVersion: "1.21",
      loomSourceVersion: "1.21-rc1"
    },
    async ({ service, projectPath }) => {
      await assert.rejects(
        () =>
          service.resolveArtifact({
            target: { kind: "version", value: "1.21" },
            mapping: "mojang",
            projectPath,
            strictVersion: true
          } as never),
        (error: Error & { code?: string; details?: Record<string, unknown> }) => {
          assert.equal(error.code, ERROR_CODES.VERSION_NOT_FOUND);
          assert.equal(error.details?.requestedVersion, "1.21");
          assert.match(String(error.details?.selectedSourceJar), /1\.21-rc1/);
          return true;
        }
      );
    }
  );
});

/**
 * The token boundary refused a following `.`, which is
 * what a file extension starts with. `minecraft-merged-26.1.jar` therefore
 * named no version at all, and `minecraft-merged-26.2-pre-6.jar` backtracked
 * off its own suffix and answered "26.2" — the release the jar is NOT.
 */
test("inferRuntimeJarMinecraftVersion reads a version that ends at a file extension", () => {
  assert.equal(
    inferRuntimeJarMinecraftVersion("/cache/minecraft-merged-26.2-pre-6.jar"),
    "26.2-pre-6"
  );
  assert.equal(inferRuntimeJarMinecraftVersion("/cache/minecraft-merged-26.1.jar"), "26.1");
  assert.equal(inferRuntimeJarMinecraftVersion("/cache/minecraft-merged-1.21.4.zip"), "1.21.4");
  // The longest token at a position wins, so a deeper component is never read
  // as a shorter version: 1.21.1 must not come out of 1.21.10.
  assert.equal(
    inferRuntimeJarMinecraftVersion("/cache/fabric-loom/1.21.10/minecraft-merged.jar"),
    "1.21.10"
  );
  // Four dotted components are not a Minecraft id at all.
  assert.equal(inferRuntimeJarMinecraftVersion("/cache/minecraft-merged-1.2.3.4.jar"), undefined);
});

test("describeServedRuntimeJar flags a pre-release jar named by its file name", () => {
  const served = describeServedRuntimeJar({
    jarPath: "/cache/minecraft-merged-26.2-pre-6.jar",
    requestedVersion: "26.2"
  });

  assert.equal(served.version, "26.2-pre-6");
  assert.equal(served.requestedVersion, "26.2");
  assert.equal(served.versionApproximated, true);
});

/**
 * `isUnobfuscatedVersion` accepts every new-format id
 * from year 26 up, so Forge's own `47.3.0` parsed as a Minecraft version — a
 * class of mistake the `1.x`-only reader could not make. A 26.1+ token is
 * Minecraft's only where its path position says so.
 */
test("inferRuntimeJarMinecraftVersion refuses a loader version that merely has the 26.1+ shape", () => {
  assert.equal(inferRuntimeJarMinecraftVersion("/p/build/forge-47.3.0-srg.jar"), undefined);
  assert.equal(inferRuntimeJarMinecraftVersion("/x/neoforge-21.10.50-beta/y.jar"), undefined);
  // An ancestor directory the user happened to name "minecraft" is not evidence
  // about the jar inside it.
  assert.equal(inferRuntimeJarMinecraftVersion("/home/u/minecraft/forge-47.3.0-srg.jar"), undefined);
});

test("inferRuntimeJarMinecraftVersion keeps the 26.1+ layouts that do name Minecraft", () => {
  // The jar itself names Minecraft.
  assert.equal(inferRuntimeJarMinecraftVersion("/cache/minecraft-merged-26.1.jar"), "26.1");
  // The version directory's own entry names Minecraft (neoformruntime's layout).
  assert.equal(
    inferRuntimeJarMinecraftVersion("/c/caches/neoformruntime/26.1/minecraft-joined.jar"),
    "26.1"
  );
  // The Loom cache layout names it, even when the artifact below does not.
  assert.equal(
    inferRuntimeJarMinecraftVersion(
      "/u/.gradle/caches/fabric-loom/26.1/neoforge/21.10.50-beta/at-patched.jar"
    ),
    "26.1"
  );
});

test("resolveAccessTransformerRuntimeArtifact does not report a Forge version as Minecraft's", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "at-forge-anchored-"));
  await writeFile(
    join(root, "build.gradle"),
    ["plugins {", "  id 'net.minecraftforge.gradle' version '[6.0,6.2)'", "}"].join("\n"),
    "utf8"
  );
  await writeFile(join(root, "gradle.properties"), "minecraft_version=26.1\n", "utf8");
  const buildDir = join(root, "build");
  await mkdir(buildDir, { recursive: true });
  // ForgeGradle names the artifact after the FORGE version. The jar is selected
  // on project-anchored evidence, so nothing else vouches for its version.
  await createJar(join(buildDir, "forge-47.3.0-srg.jar"), {
    "net/minecraft/server/MinecraftServer.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const service = new SourceService(buildTestConfig(root));
  const provenance = await service.resolveAccessTransformerRuntimeArtifact({
    version: "26.1",
    atNamespace: "srg",
    projectPath: root,
    scope: "loader"
  });

  assert.match(provenance.jarPath, /forge-47\.3\.0-srg\.jar$/);
  // Pre-fix this answered version "47.3.0" and flagged an approximation against
  // a Minecraft release that does not exist.
  assert.equal(provenance.version, "26.1");
  assert.equal(provenance.requestedVersion, undefined);
  assert.equal(provenance.versionApproximated, undefined);
  assert.equal(
    provenance.resolutionNotes?.some((note) => note.includes("47.3.0")),
    false,
    `Expected no 47.3.0 note, got: ${JSON.stringify(provenance.resolutionNotes)}`
  );
});
