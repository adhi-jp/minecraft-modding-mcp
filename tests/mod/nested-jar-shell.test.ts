import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __getZipOpenCount, __resetZipOpenCount } from "../../src/source-jar-reader.ts";
import { SourceService } from "../../src/source-service.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildInnerJarBytes, createShellJar } from "../helpers/nested-jar.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

test("resolveArtifact surfaces a shell jar's nested-jar inventory instead of dead-ending in decompilation", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-resolve-"));
  const inner = await buildInnerJarBytes({
    "net/fabricmc/fabric/api/screenhandler/v1/ScreenHandlerRegistry.class": buildClassFile({
      internalName: "net/fabricmc/fabric/api/screenhandler/v1/ScreenHandlerRegistry"
    })
  });
  const shellPath = join(root, "fabric-api-0.131.0.jar");
  await createShellJar(shellPath, { "META-INF/jars/fabric-screen-handler-api-v1-2.0.5.jar": inner });

  // A nonexistent decompiler path makes any decompile attempt fail, so the
  // successful resolve below proves the shell path never invokes it.
  const service = new SourceService(
    buildTestConfig(root, { vineflowerJarPath: join(root, "vineflower-missing.jar") })
  );
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  assert.ok(resolved.qualityFlags.includes("shell-jar"));
  assert.deepEqual(resolved.provenance.nestedJars, [
    "META-INF/jars/fabric-screen-handler-api-v1-2.0.5.jar"
  ]);

  // Re-resolving the same shell jar yields the same deterministic artifact id
  // and the warm-cache response carries the same flag and inventory.
  const again = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });
  assert.equal(again.artifactId, resolved.artifactId);
  assert.ok(again.qualityFlags.includes("shell-jar"));
  assert.deepEqual(again.provenance.nestedJars, [
    "META-INF/jars/fabric-screen-handler-api-v1-2.0.5.jar"
  ]);
});

test("resolveArtifact detects a shell via the META-INF/jars scan even without a fabric.mod.json declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-scan-only-"));
  const inner = await buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
  });
  const shellPath = join(root, "scan-only-shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner }, { declareJars: false });

  const service = new SourceService(
    buildTestConfig(root, { vineflowerJarPath: join(root, "vineflower-missing.jar") })
  );
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  assert.ok(resolved.qualityFlags.includes("shell-jar"));
  assert.deepEqual(resolved.provenance.nestedJars, ["META-INF/jars/api.jar"]);
});

test("resolveArtifact still fails for a classless jar that is not a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-negative-"));
  const jarPath = join(root, "not-a-shell.jar");
  // No classes, no nested jars, no sources: the decompiler path stays the
  // only option and its unavailability/failure must surface unchanged.
  await createJar(jarPath, { "README.txt": "just text" });

  const service = new SourceService(
    buildTestConfig(root, { vineflowerJarPath: join(root, "vineflower-missing.jar") })
  );
  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: jarPath },
        mapping: "obfuscated"
      }),
    (error: Error & { code?: string }) =>
      error.code === "ERR_DECOMPILER_UNAVAILABLE" || error.code === "ERR_DECOMPILER_FAILED"
  );
});

test("resolveArtifact ignores jars above the shell class-count ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-classy-"));
  const inner = await buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
  });
  // A mod that carries both plenty of its own classes AND nested jars is a
  // regular mod jar, not a shell: it must keep the current decompile path.
  const ownClasses = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `com/example/own/Class${index}.class`,
      buildClassFile({ internalName: `com/example/own/Class${index}` })
    ])
  );
  const jarPath = join(root, "classy-mod.jar");
  await createShellJar(jarPath, { "META-INF/jars/api.jar": inner }, { extraEntries: ownClasses });

  // With a nonexistent decompiler path, taking the regular decompile path is
  // observable as a deterministic decompiler error — proving the jar was NOT
  // short-circuited as a shell despite its nested jars.
  const service = new SourceService(
    buildTestConfig(root, { vineflowerJarPath: join(root, "vineflower-missing.jar") })
  );
  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: jarPath },
        mapping: "obfuscated"
      }),
    (error: Error & { code?: string }) =>
      error.code === "ERR_DECOMPILER_UNAVAILABLE" || error.code === "ERR_DECOMPILER_FAILED"
  );
});

test("shell detection adds no zip opens to source-backed jar resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-cost-neutral-"));
  const binaryJarPath = join(root, "lib.jar");
  const sourcesJarPath = join(root, "lib-sources.jar");
  await createJar(binaryJarPath, {
    "com/example/Lib.class": buildClassFile({ internalName: "com/example/Lib" })
  });
  await createJar(sourcesJarPath, {
    "com/example/Lib.java": "package com.example;\npublic class Lib {}\n"
  });

  const service = new SourceService(buildTestConfig(root));
  __resetZipOpenCount();
  await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // Source-backed jars never reach the binary-branch shell detection, so the
  // resolution stays at its pre-nested-jar open count: source probe on the
  // binary jar, adjacent sources probe, and the indexing pass.
  assert.equal(__getZipOpenCount(), 3);
});

test("concurrent nested-jar extractions of the same entry all succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-concurrent-extract-"));
  const { extractNestedJar } = await import("../../src/source/nested-jars.ts");
  const { readFile } = await import("node:fs/promises");
  const inner = await buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
  });
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const cacheDir = join(root, "cache");
  const paths = await Promise.all(
    Array.from({ length: 8 }, () =>
      extractNestedJar(cacheDir, shellPath, "test-signature", "META-INF/jars/api.jar")
    )
  );

  assert.equal(new Set(paths).size, 1);
  const extracted = await readFile(paths[0] as string);
  assert.equal(extracted.length, inner.length);

  // A later sequential call reuses the content-addressed file instead of
  // re-extracting: the archive is not opened again.
  __resetZipOpenCount();
  const reused = await extractNestedJar(cacheDir, shellPath, "test-signature", "META-INF/jars/api.jar");
  assert.equal(reused, paths[0]);
  assert.equal(__getZipOpenCount(), 0);
});

test("reindexing a shell artifact without force reports it as already current", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-reindex-"));
  const inner = await buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
  });
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });

  const reindexed = await service.indexArtifact({ artifactId: resolved.artifactId });
  assert.equal(reindexed.reindexed, false);
  assert.equal(reindexed.reason, "already_current");
});

test("shell detection costs exactly two zip opens on the decompile-path probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-detect-cost-"));
  const { detectShellJarInventory } = await import("../../src/source/nested-jars.ts");
  // A regular Fabric mod jar (fabric.mod.json present, no nested jars): the
  // detection reads the entry list and the fabric.mod.json body, nothing else.
  // This bounds the overhead added before the (orders slower) decompile step.
  const jarPath = join(root, "plain-mod.jar");
  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "plain" }),
    "com/example/Plain.class": buildClassFile({ internalName: "com/example/Plain" })
  });

  __resetZipOpenCount();
  const inventory = await detectShellJarInventory(jarPath);
  assert.equal(inventory, undefined);
  assert.equal(__getZipOpenCount(), 2);
});
