import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __getZipOpenCount, __resetZipOpenCount } from "../../src/source-jar-reader.ts";
import { SourceService } from "../../src/source-service.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { buildInnerJarBytes, createShellJar } from "../helpers/nested-jar.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createCraftedJar } from "../helpers/zip-crafted.ts";
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

// Extraction materializes a whole nested entry in the server process, so a
// shell jar declaring a huge inner jar used to be an unbounded allocation the
// caller could trigger by naming that jar.
test("extractNestedJar refuses an oversized nested entry with ERR_LIMIT_EXCEEDED and writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-entry-cap-"));
  const { extractNestedJar, NESTED_JAR_CACHE_DIRNAME } = await import(
    "../../src/source/nested-jars.ts"
  );
  const shellPath = join(root, "oversized-shell.jar");
  // A few hundred bytes on disk; the headers declare 100 MiB.
  await createCraftedJar(shellPath, [
    {
      name: "fabric.mod.json",
      data: JSON.stringify({ schemaVersion: 1, id: "oversized", version: "1.0.0" })
    },
    {
      name: "META-INF/jars/huge.jar",
      data: Buffer.alloc(1024, 0x41),
      method: "deflate",
      declaredUncompressedSize: 100 * 1024 * 1024
    }
  ]);
  const cacheDir = join(root, "cache");

  const rejection = await extractNestedJar(
    cacheDir,
    shellPath,
    "test-signature",
    "META-INF/jars/huge.jar"
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  const failure = rejection as Error & {
    code?: string;
    details?: {
      entryName?: string;
      actual?: number;
      limit?: number;
      sizeSource?: string;
      nextAction?: string;
    };
  };
  assert.equal(failure.code, "ERR_LIMIT_EXCEEDED");
  assert.equal(failure.details?.entryName, "META-INF/jars/huge.jar");
  assert.equal(failure.details?.actual, 100 * 1024 * 1024);
  assert.equal(failure.details?.limit, 64 * 1024 * 1024);
  assert.equal(failure.details?.sizeSource, "declared");
  assert.match(failure.message, /META-INF\/jars\/huge\.jar/);
  assert.match(failure.message, /104857600 uncompressed bytes/);
  assert.match(failure.message, /67108864-byte extraction limit/);
  assert.match(String(failure.details?.nextAction), /MCP_MAX_NESTED_JAR_ENTRY_BYTES/);

  // Refusal leaves no partial extraction behind.
  await assert.rejects(
    () => stat(join(cacheDir, NESTED_JAR_CACHE_DIRNAME)),
    /ENOENT/,
    "a refused extraction must not create the nested-jar cache directory"
  );
});

test("extractNestedJar honors a caller-supplied ceiling below the default", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-entry-cap-injected-"));
  const { extractNestedJar } = await import("../../src/source/nested-jars.ts");
  const inner = await buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" })
  });
  const shellPath = join(root, "shell.jar");
  await createShellJar(shellPath, { "META-INF/jars/api.jar": inner });
  const cacheDir = join(root, "cache");

  // The same entry extracts fine under the default ceiling.
  const extracted = await extractNestedJar(
    cacheDir,
    shellPath,
    "test-signature",
    "META-INF/jars/api.jar"
  );
  assert.match(extracted, /\.jar$/);

  const rejection = await extractNestedJar(
    join(root, "cache-capped"),
    shellPath,
    "test-signature",
    "META-INF/jars/api.jar",
    16
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  const failure = rejection as Error & { code?: string; details?: { limit?: number } };
  assert.equal(failure.code, "ERR_LIMIT_EXCEEDED");
  assert.equal(failure.details?.limit, 16);
});

// The per-entry cap must not become a denial of service of its own: one
// oversized inner jar is skipped, and every other nested jar in the shell's
// inventory still answers.
test("a shell jar with one oversized nested jar still resolves classes from its other nested jars", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-degrade-"));
  const inner = await buildInnerJarBytes({
    "com/example/inner/Api.class": buildClassFile({ internalName: "com/example/inner/Api" }),
    "com/example/inner/Api.java": [
      "package com.example.inner;",
      "public class Api {",
      "  public static final String MARKER = \"nested-jar-marker\";",
      "}"
    ].join("\n")
  });
  const shellPath = join(root, "mixed-shell.jar");
  // "aaa-oversized" sorts ahead of "api" in the inventory, so the refusal
  // happens BEFORE the usable nested jar is reached.
  await createCraftedJar(shellPath, [
    {
      name: "fabric.mod.json",
      data: JSON.stringify({
        schemaVersion: 1,
        id: "mixed-shell",
        version: "1.0.0",
        jars: [{ file: "META-INF/jars/aaa-oversized.jar" }, { file: "META-INF/jars/api.jar" }]
      })
    },
    {
      name: "META-INF/jars/aaa-oversized.jar",
      data: Buffer.alloc(1024, 0x41),
      method: "deflate",
      declaredUncompressedSize: 100 * 1024 * 1024
    },
    { name: "META-INF/jars/api.jar", data: inner }
  ]);

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated"
  });
  assert.ok(resolved.qualityFlags.includes("shell-jar"));
  // The oversized entry stays in the published inventory: only its extraction
  // is refused, and the caller can still target it as its own artifact.
  assert.deepEqual(resolved.provenance.nestedJars, [
    "META-INF/jars/aaa-oversized.jar",
    "META-INF/jars/api.jar"
  ]);

  const result = await service.getClassSource({
    className: "com.example.inner.Api",
    target: { kind: "jar", value: shellPath },
    mapping: "obfuscated",
    mode: "full"
  });
  assert.match(result.sourceText, /nested-jar-marker/);
  assert.equal(result.provenance?.nestedJar?.entryName, "META-INF/jars/api.jar");
});

test("loadMaxNestedJarEntryBytes takes ASCII-decimal overrides, floors them, and ignores junk", async () => {
  const { loadMaxNestedJarEntryBytes } = await import("../../src/source/nested-jars.ts");
  const defaultBytes = 64 * 1024 * 1024;

  assert.equal(loadMaxNestedJarEntryBytes("134217728"), 134217728);
  // Below the 1 MiB floor an override would start refusing real nested jars.
  assert.equal(loadMaxNestedJarEntryBytes("500"), 1024 * 1024);
  assert.equal(loadMaxNestedJarEntryBytes("0"), 1024 * 1024);

  for (const junk of [undefined, "", " 1024 ", "1e9", "12.5", "-5", "0x10", "9".repeat(30)]) {
    assert.equal(
      loadMaxNestedJarEntryBytes(junk),
      defaultBytes,
      `expected the default for ${JSON.stringify(junk)}`
    );
  }
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
