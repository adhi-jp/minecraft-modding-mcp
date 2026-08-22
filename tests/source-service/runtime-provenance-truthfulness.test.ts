import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  describeServedRuntimeJar,
  inferRuntimeJarLoader,
  inferRuntimeJarMinecraftVersion
} from "../../src/source/artifact-resolver.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * Regression: a `scope:"merged"` fallback could serve a NeoForge 1.21.10
 * AT-patched jar to a Fabric 1.21.11 workspace while provenance still reported
 * version 1.21.11 and no loader at all — and validate-access-widener then
 * answered `valid: true`. A verdict computed against another loader's bytecode
 * is not evidence, and provenance must never name a version or loader that was
 * not served.
 */

const NEOFORGE_LOOM_JAR =
  "/home/u/.gradle/caches/fabric-loom/1.21.10/neoforge/21.10.50-beta/minecraft-merged-mojang-at-patched.jar";
const FABRIC_LOOM_JAR =
  "/home/u/.gradle/caches/fabric-loom/1.21.11/minecraft-merged-mojang.jar";

test("inferRuntimeJarMinecraftVersion reads the version a Loom cache path encodes", () => {
  assert.equal(inferRuntimeJarMinecraftVersion(NEOFORGE_LOOM_JAR), "1.21.10");
  assert.equal(inferRuntimeJarMinecraftVersion(FABRIC_LOOM_JAR), "1.21.11");
  // The loader version 21.10.50 must never be mistaken for a Minecraft version.
  assert.equal(inferRuntimeJarMinecraftVersion("/x/neoforge-21.10.50-beta.jar"), undefined);
  assert.equal(inferRuntimeJarMinecraftVersion("/x/no-version-here.jar"), undefined);
});

test("inferRuntimeJarLoader distinguishes a NeoForge jar inside the Loom cache", () => {
  assert.equal(inferRuntimeJarLoader(NEOFORGE_LOOM_JAR), "neoforge");
  assert.equal(inferRuntimeJarLoader(FABRIC_LOOM_JAR), "fabric");
  assert.equal(inferRuntimeJarLoader("/x/build/moddev/artifacts/neoforge-21.11.38-beta.jar"), "neoforge");
  assert.equal(inferRuntimeJarLoader("/x/plain.jar"), "unknown");
});

test("describeServedRuntimeJar reports the served version and flags a loader substitution", () => {
  const served = describeServedRuntimeJar({
    jarPath: NEOFORGE_LOOM_JAR,
    requestedVersion: "1.21.11",
    expectedLoader: "fabric"
  });

  // Pre-fix provenance echoed the REQUESTED version here.
  assert.equal(served.version, "1.21.10");
  assert.equal(served.requestedVersion, "1.21.11");
  assert.equal(served.versionApproximated, true);
  assert.equal(served.servedLoader, "neoforge");
  assert.equal(served.loaderMismatch, true);
  assert.equal(served.notes.length, 2);
});

test("describeServedRuntimeJar asserts no mismatch when the expected loader is unknown", () => {
  const served = describeServedRuntimeJar({
    jarPath: NEOFORGE_LOOM_JAR,
    requestedVersion: "1.21.10",
    expectedLoader: "unknown"
  });

  assert.equal(served.version, "1.21.10");
  assert.equal(served.versionApproximated, undefined);
  assert.equal(served.loaderMismatch, undefined);
  assert.deepEqual(served.notes, []);
});

/** A Fabric workspace whose only reachable runtime jar is a NeoForge one. */
async function buildCrossLoaderWorkspace(): Promise<{ root: string; gradleUserHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "aw-cross-loader-"));
  await writeFile(
    join(root, "build.gradle"),
    [
      "plugins {",
      "  id 'fabric-loom' version '1.11-SNAPSHOT'",
      "}",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "  modImplementation 'net.fabricmc:fabric-loader:0.18.2'",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(join(root, "gradle.properties"), "minecraft_version=1.21.11\n", "utf8");

  const gradleUserHome = join(root, "gradle-home");
  const loomDir = join(gradleUserHome, "caches", "fabric-loom", "1.21.10", "neoforge", "21.10.50-beta");
  await mkdir(loomDir, { recursive: true });
  await createJar(join(loomDir, "minecraft-merged-mojang-at-patched.jar"), {
    "net/minecraft/world/item/Item.class": buildClassFile({
      internalName: "net/minecraft/world/item/Item",
      accessFlags: 0x0001,
      fields: [],
      methods: [
        { name: "<init>", descriptor: "()V", accessFlags: 0x0001 },
        { name: "getDescriptionId", descriptor: "()Ljava/lang/String;", accessFlags: 0x0001 }
      ]
    })
  });
  return { root, gradleUserHome };
}

const AW_CONTENT = [
  "accessWidener\tv2\tnamed",
  "accessible\tmethod\tnet/minecraft/world/item/Item\tgetDescriptionId\t()Ljava/lang/String;",
  ""
].join("\n");

test("validateAccessWidener refuses to certify a Fabric widener against a NeoForge runtime jar", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { root, gradleUserHome } = await buildCrossLoaderWorkspace();
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      (
        service as unknown as {
          validateAccessWidener: (input: Record<string, unknown>) => Promise<Record<string, any>>;
        }
      ).validateAccessWidener({
        content: AW_CONTENT,
        version: "1.21.11",
        mapping: "mojang",
        projectPath: root,
        gradleUserHome
      }),
    (error: Error & { code?: string; details?: Record<string, unknown> }) => {
      // Pre-fix this returned { valid: true } with provenance claiming 1.21.11.
      assert.equal(error.code, "ERR_CONTEXT_UNRESOLVED");
      assert.equal(error.details?.servedLoader, "neoforge");
      assert.equal(error.details?.expectedLoader, "fabric");
      assert.equal(error.details?.version, "1.21.10");
      assert.equal(error.details?.requestedVersion, "1.21.11");
      return true;
    }
  );
});
