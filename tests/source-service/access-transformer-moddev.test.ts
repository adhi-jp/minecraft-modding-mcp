import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hasLoaderRuntimeVersionToken } from "../../src/source/artifact-resolver.ts";
import { dropSatisfiedParameterAsks } from "../../src/tool-guidance.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * Regression: validate-access-transformer was unusable on the canonical
 * NeoForge/ModDevGradle workspace.
 *
 * ModDevGradle names every runtime artifact after the LOADER version
 * (`build/moddev/artifacts/neoforge-21.11.38-beta-merged.jar`) and never after
 * Minecraft, so the discovery filter `hasExactVersionToken(path, "1.21.11")`
 * rejected all of them and the tool answered ERR_CONTEXT_UNRESOLVED — with a
 * hint asking for the very projectPath the caller had supplied.
 */

const MINECRAFT_SERVER_CLASS = buildClassFile({
  internalName: "net/minecraft/server/MinecraftServer",
  accessFlags: 0x0001,
  fields: [{ name: "tickRateManager", descriptor: "I", accessFlags: 0x0002 }],
  methods: [{ name: "<init>", descriptor: "()V", accessFlags: 0x0001 }]
});

const AT_CONTENT = "public net.minecraft.server.MinecraftServer tickRateManager\n";

/** A ModDevGradle workspace with the exact artifact layout NeoForge produces. */
async function buildModDevWorkspace(options: { withResourcesOnlyJar?: boolean } = {}): Promise<{
  root: string;
  mergedJar: string;
  loaderJar: string;
  resourcesJar: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "at-moddev-"));
  const artifacts = join(root, "build", "moddev", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(root, "build.gradle"),
    ["plugins {", "  id 'net.neoforged.moddev' version '2.0.140'", "}"].join("\n"),
    "utf8"
  );
  await writeFile(join(root, "gradle.properties"), "minecraft_version=1.21.11\n", "utf8");

  const mergedJar = join(artifacts, "neoforge-21.11.38-beta-merged.jar");
  const loaderJar = join(artifacts, "neoforge-21.11.38-beta.jar");
  const resourcesJar = join(artifacts, "neoforge-21.11.38-beta-client-extra-aka-minecraft-resources.jar");
  await createJar(mergedJar, { "net/minecraft/server/MinecraftServer.class": MINECRAFT_SERVER_CLASS });
  await createJar(loaderJar, { "net/minecraft/server/MinecraftServer.class": MINECRAFT_SERVER_CLASS });
  if (options.withResourcesOnlyJar !== false) {
    await createJar(resourcesJar, { "assets/minecraft/lang/en_us.json": "{}" });
  }
  return { root, mergedJar, loaderJar, resourcesJar };
}

test("hasLoaderRuntimeVersionToken maps NeoForge loader versions onto Minecraft versions", () => {
  assert.equal(
    hasLoaderRuntimeVersionToken("/p/build/moddev/artifacts/neoforge-21.11.38-beta-merged.jar", "1.21.11"),
    true
  );
  assert.equal(
    hasLoaderRuntimeVersionToken("/p/build/moddev/artifacts/neoforge-21.11.38-beta-merged.jar", "1.21.10"),
    false
  );
  // The trailing dot before the build number keeps 1.21.1 off a 21.10.x jar.
  assert.equal(hasLoaderRuntimeVersionToken("/p/neoforge-21.10.5.jar", "1.21.1"), false);
  assert.equal(hasLoaderRuntimeVersionToken("/p/neoforge-21.1.5.jar", "1.21.1"), true);
  assert.equal(hasLoaderRuntimeVersionToken("/p/neoforge-21.0.167.jar", "1.21"), true);
  assert.equal(hasLoaderRuntimeVersionToken("/p/neoforge-121.11.3.jar", "1.21.11"), false);
  assert.equal(hasLoaderRuntimeVersionToken("/p/anything.jar", "not-a-version"), false);
});

test("validateAccessTransformer resolves a ModDevGradle workspace runtime jar", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { root } = await buildModDevWorkspace();
  const service = new SourceService(buildTestConfig(root));

  const result = await (
    service as unknown as {
      validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, any>>;
    }
  ).validateAccessTransformer({
    content: AT_CONTENT,
    version: "1.21.11",
    projectPath: root
  });

  // Pre-fix: ERR_CONTEXT_UNRESOLVED, because no artifact filename carries "1.21.11".
  assert.equal(result.valid, true);
  assert.equal(result.provenance?.version, "1.21.11");
  assert.equal(result.provenance?.requestedMapping, "mojang");
  assert.match(String(result.provenance?.jarPath), /neoforge-21\.11\.38-beta/);
  assert.ok(
    (result.provenance?.resolutionNotes ?? []).some((note: string) => note.includes("loader version token")),
    `expected loader-token provenance note, got: ${JSON.stringify(result.provenance?.resolutionNotes)}`
  );
});

test("validateAccessTransformer never selects the resources-only client-extra jar over a classes jar", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { root } = await buildModDevWorkspace();
  const service = new SourceService(buildTestConfig(root));

  const result = await (
    service as unknown as {
      validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, any>>;
    }
  ).validateAccessTransformer({
    content: AT_CONTENT,
    version: "1.21.11",
    projectPath: root
  });

  assert.ok(
    !String(result.provenance?.jarPath).includes("client-extra"),
    `a resources-only jar cannot answer a class lookup: ${result.provenance?.jarPath}`
  );
});

test("validateAccessTransformer rejects a version the workspace does not build, naming what it declares", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { root } = await buildModDevWorkspace();
  const service = new SourceService(buildTestConfig(root));

  await assert.rejects(
    () =>
      (
        service as unknown as {
          validateAccessTransformer: (input: Record<string, unknown>) => Promise<Record<string, any>>;
        }
      ).validateAccessTransformer({
        content: AT_CONTENT,
        version: "1.20.4",
        projectPath: root,
        atNamespace: "mojang"
      }),
    (error: Error & { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, "ERR_CONTEXT_UNRESOLVED");
      const nextAction = String(error.details?.nextAction ?? "");
      // The old hint asked for the projectPath the caller had already supplied.
      assert.ok(!/Provide projectPath/i.test(nextAction), `self-contradicting hint: ${nextAction}`);
      assert.match(nextAction, /workspace declares 1\.21\.11/);
      return true;
    }
  );
});

test("dropSatisfiedParameterAsks removes an ask for a parameter the caller already sent", () => {
  const hint =
    "Provide projectPath for a Forge/NeoForge workspace with generated runtime jars, or run the Gradle tasks that populate transformed runtime artifacts before retrying.";

  assert.deepEqual(dropSatisfiedParameterAsks([hint], { projectPath: "/ws" }), [
    "Run the Gradle tasks that populate transformed runtime artifacts before retrying."
  ]);
  // Not supplied -> the ask is legitimate and survives verbatim.
  assert.deepEqual(dropSatisfiedParameterAsks([hint], { version: "1.21.11" }), [hint]);
  // An empty string is not "supplied".
  assert.deepEqual(dropSatisfiedParameterAsks([hint], { projectPath: "   " }), [hint]);
  // A satisfied ask with no alternative clause is dropped outright.
  assert.deepEqual(dropSatisfiedParameterAsks(["Provide projectPath."], { projectPath: "/ws" }), []);
  // Hints that ask for nothing are untouched.
  assert.deepEqual(dropSatisfiedParameterAsks(["Use find-class to resolve the name."], { projectPath: "/ws" }), [
    "Use find-class to resolve the name."
  ]);
});
