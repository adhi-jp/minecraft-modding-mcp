import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { MinecraftExplorerService } from "../../src/minecraft-explorer-service.ts";
import {
  describeServedRuntimeJar,
  inferRuntimeJarLoader
} from "../../src/source/artifact-resolver.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

const ACC_PUBLIC = 0x0001;

/**
 * Path classification must read the layout a build tool wrote, never the
 * directory names the user happened to check the project out under. Each test
 * below pairs a path whose ANCESTORS lie about the artifact with the control
 * path whose own name still has to be believed.
 */

async function signatureVersionForJarPath(
  root: string,
  jarPath: string,
  internalName: string,
  overrides: Partial<Config> = {}
): Promise<string> {
  await mkdir(dirname(jarPath), { recursive: true });
  await createJar(jarPath, {
    [`${internalName}.class`]: buildClassFile({
      internalName,
      methods: [{ name: "<init>", descriptor: "()V", accessFlags: ACC_PUBLIC }]
    })
  });
  const service = new MinecraftExplorerService(buildTestConfig(root, overrides));
  const signature = await service.getSignature({
    jarPath,
    fqn: internalName.replace(/\//g, ".")
  });
  return signature.context.minecraftVersion;
}

test("inferRuntimeJarLoader ignores loader names in directories above the cache root", () => {
  // A Fabric mod checked out under a directory the user called `forge`. The jar
  // is a Loom cache jar and nothing about it is Forge's.
  assert.equal(
    inferRuntimeJarLoader(
      "/home/u/dev/forge/fabricmod/.gradle/caches/fabric-loom/1.21.10/minecraft-merged.jar"
    ),
    "fabric"
  );
  // `moddev-notes` is a notes directory, not ModDevGradle output.
  assert.equal(
    inferRuntimeJarLoader("/home/u/projects/moddev-notes/mc/minecraft-merged.jar"),
    "unknown"
  );
  // `srg-test` is a scratch directory, not an SRG-mapped Forge artifact.
  assert.equal(inferRuntimeJarLoader("/home/u/srg-test/minecraft-merged.jar"), "unknown");
});

test("inferRuntimeJarLoader still reads the loader a build tool's own layout names", () => {
  // The control for the test above: ancestors stop speaking, the tool-written
  // layout does not. A NeoForge workspace checked out under a `fabric` directory
  // still resolves to neoforge, and the shapes pinned elsewhere still hold.
  assert.equal(
    inferRuntimeJarLoader(
      "/home/u/fabric/myneomod/build/moddev/artifacts/neoforge-21.11.38-beta-merged.jar"
    ),
    "neoforge"
  );
  assert.equal(
    inferRuntimeJarLoader(
      "/home/u/.gradle/caches/fabric-loom/1.21.10/neoforge/21.10.50-beta/minecraft-merged-mojang-at-patched.jar"
    ),
    "neoforge"
  );
  assert.equal(
    inferRuntimeJarLoader("/home/u/.gradle/caches/fabric-loom/1.21.11/minecraft-merged-mojang.jar"),
    "fabric"
  );
  // A Loom cache reachable through a gradle user home that is not named
  // `.gradle`: the `loom-cache` segment is still the tool's own.
  assert.equal(
    inferRuntimeJarLoader(
      "/home/u/dev/.gradle-user-home/loom-cache/1.21.11/minecraft-merged-mojang.jar"
    ),
    "fabric"
  );
  assert.equal(
    inferRuntimeJarLoader("/home/u/.gradle/caches/forge_gradle/1.21.1/minecraft-srg.jar"),
    "forge"
  );
});

test("describeServedRuntimeJar does not invent a loader mismatch from a checkout directory's name", () => {
  // The user-visible consequence: `loaderMismatch` makes validate-access-widener
  // fail hard with ERR_CONTEXT_UNRESOLVED, so a Fabric workspace living under a
  // `forge` directory could not validate its own access widener at all.
  const served = describeServedRuntimeJar({
    jarPath: "/home/u/dev/forge/fabricmod/.gradle/caches/fabric-loom/1.21.10/minecraft-merged.jar",
    requestedVersion: "1.21.10",
    expectedLoader: "fabric"
  });

  assert.equal(served.servedLoader, "fabric");
  assert.equal(served.loaderMismatch, undefined);
  assert.deepEqual(served.notes, []);
});

test("MinecraftExplorerService reports unknown minecraftVersion for a store artifact that merely contains \"minecraft-\"", async () => {
  // `com.acme:my-minecraft-client-helper` is a third-party helper library. Read
  // as a substring, `minecraft-client` inside its name made the store path look
  // like the runtime and served the helper's own 9.9 as a Minecraft version.
  const root = await mkdtemp(join(tmpdir(), "review-a2-m2-contains-minecraft-"));
  const jarPath = join(
    root,
    ".m2",
    "repository",
    "com",
    "acme",
    "my-minecraft-client-helper",
    "9.9",
    "my-minecraft-client-helper-9.9.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "com/acme/helper/AcmeHelper");

  assert.equal(version, "unknown");
  assert.notEqual(version, "9.9", "the helper library's own release number is not a Minecraft version");
});

test("MinecraftExplorerService still reports a version for a store artifact whose own name starts with \"minecraft-\"", async () => {
  // The control: a path segment that STARTS with `minecraft-` is still read as
  // the runtime, so `minecraft-merged` and its siblings keep their version — and
  // so does the documented remaining misread, `minecraft-client-helper`.
  const root = await mkdtemp(join(tmpdir(), "review-a2-m2-starts-minecraft-"));
  const jarPath = join(
    root,
    ".m2",
    "repository",
    "com",
    "acme",
    "minecraft-client-helper",
    "9.9",
    "minecraft-client-helper-9.9.jar"
  );

  const version = await signatureVersionForJarPath(root, jarPath, "com/acme/helper/AcmeHelper");

  assert.equal(version, "9.9");
});

test("MinecraftExplorerService treats a relocated local Maven repository as a dependency store", async () => {
  // MCP_LOCAL_M2 moves the repository off `~/.m2`. Recognised only by the two
  // literal segments, a relocated root was not a store at all and a plain
  // dependency reported its own release number as a Minecraft version.
  const root = await mkdtemp(join(tmpdir(), "review-a2-relocated-m2-"));
  const storeRoot = join(root, "maven-repo");

  const dependencyVersion = await signatureVersionForJarPath(
    root,
    join(storeRoot, "org", "jetbrains", "annotations", "26.0.2", "annotations-26.0.2.jar"),
    "org/jetbrains/annotations/NotNull",
    { localM2Path: storeRoot }
  );
  assert.equal(dependencyVersion, "unknown");
  assert.notEqual(
    dependencyVersion,
    "26.0.2",
    "the library's own release number is not a Minecraft version"
  );

  // The control: the same relocated store still yields a real Minecraft version
  // for the runtime artifact itself.
  const minecraftVersion = await signatureVersionForJarPath(
    root,
    join(storeRoot, "net", "minecraft", "client", "1.21.10", "client-1.21.10.jar"),
    "net/minecraft/client/Minecraft",
    { localM2Path: storeRoot }
  );
  assert.equal(minecraftVersion, "1.21.10");
});

test("MinecraftExplorerService reports unknown minecraftVersion for a store artifact whose GROUP starts with \"minecraft-\"", async () => {
  // `com.minecraft-tools:annotations` is an ordinary third-party library whose
  // group happens to open with `minecraft-`. Asked of every path segment, the
  // name rule read that group directory as the runtime and served the library's
  // own 26.0.2 as a Minecraft version. Only the LAST segment can answer the
  // question, because that is the one both store layouts build from the
  // artifactId.
  const root = await mkdtemp(join(tmpdir(), "review-a2-minecraft-named-group-"));

  const m2Version = await signatureVersionForJarPath(
    root,
    join(
      root,
      ".m2",
      "repository",
      "com",
      "minecraft-tools",
      "annotations",
      "26.0.2",
      "annotations-26.0.2.jar"
    ),
    "com/minecrafttools/annotations/NotNull"
  );
  assert.equal(m2Version, "unknown");
  assert.notEqual(m2Version, "26.0.2", "the library's own release number is not a Minecraft version");

  // The same coordinate in the other store layout, where the group is one dotted
  // directory instead of nested ones.
  const gradleVersion = await signatureVersionForJarPath(
    root,
    join(
      root,
      "caches",
      "modules-2",
      "files-2.1",
      "com.minecraft-tools",
      "annotations",
      "26.0.2",
      "0123456789abcdef",
      "annotations-26.0.2.jar"
    ),
    "com/minecrafttools/annotations/NotNull"
  );
  assert.equal(gradleVersion, "unknown");

  // And the same group written without an organisation prefix, which is the one
  // shape where the group directory itself opens the path.
  const bareGroupVersion = await signatureVersionForJarPath(
    root,
    join(
      root,
      "caches",
      "modules-2",
      "files-2.1",
      "minecraft-tools",
      "annotations",
      "26.0.2",
      "0123456789abcdef",
      "annotations-26.0.2.jar"
    ),
    "com/minecrafttools/annotations/NotNull"
  );
  assert.equal(bareGroupVersion, "unknown");
});
