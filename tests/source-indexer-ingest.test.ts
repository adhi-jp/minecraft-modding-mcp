import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES, isAppError } from "../src/errors.ts";
import {
  buildBinaryRemapTempPath,
  ingestIfNeeded,
  maybeRemapBinaryForMojang,
  runBinaryRemapWithDeps,
  type BinaryRemapDeps
} from "../src/source/indexer.ts";
import { SourceServiceState } from "../src/source/state.ts";
import type { SourceService } from "../src/source-service.ts";
import type { ResolvedSourceArtifact } from "../src/types.ts";
import { withTempDir } from "./helpers/temp-dir.ts";
import { createJar } from "./helpers/zip.ts";

function createMinimalSourceService(cacheDir: string): SourceService {
  return {
    config: {
      cacheDir,
      remapTimeoutMs: 10_000,
      remapMaxMemoryMb: 512
    },
    state: new SourceServiceState(),
    metrics: {
      recordDuration() {},
      setCacheEntries() {},
      setCacheTotalContentBytes() {},
      setCacheArtifactByteAccountingRef() {}
    }
  } as unknown as SourceService;
}

function createFakeRemapDeps(
  remapJar: BinaryRemapDeps["remapJar"]
): BinaryRemapDeps {
  return {
    resolveTinyRemapperJar: async () => "/tmp/tiny-remapper.jar",
    resolveMojangTinyFile: async () => ({ path: "/tmp/mojang.tiny", warnings: [] }),
    remapJar,
    now: () => 1234567890,
    randomSuffix: () => "abcdef"
  };
}

test("ingestIfNeeded shares an in-flight rebuild for the same artifact", async () => {
  await withTempDir("source-ingest-inflight-", async (root) => {
    const sourceJarPath = join(root, "example-sources.jar");
    await createJar(sourceJarPath, {
      "com/example/A.java": [
        "package com.example;",
        "public class A {",
        "  public void tick() {}",
        "}"
      ].join("\n")
    });

    const storedFiles: unknown[] = [];
    const storedMeta = new Map<string, unknown>();
    let rebuildWrites = 0;

    const service = {
      config: {
        cacheDir: root,
        maxArtifacts: 100,
        maxCacheBytes: Number.MAX_SAFE_INTEGER,
        maxContentBytes: 1_000_000,
        indexInsertChunkSize: 200
      },
      state: new SourceServiceState(),
      db: {
        transaction(fn: () => void) {
          return fn;
        }
      },
      artifactsRepo: {
        getArtifact() {
          return undefined;
        },
        upsertArtifact() {
          rebuildWrites += 1;
        },
        touchArtifact() {},
        setAlias() {},
        deleteArtifact() {},
        countArtifacts() {
          return 0;
        },
        totalContentBytes() {
          return 0;
        },
        listArtifactsByLruWithContentBytes() {
          return [];
        }
      },
      filesRepo: {
        listFiles() {
          return { items: storedFiles.slice(0, 1) };
        },
        clearFilesForArtifact() {
          storedFiles.length = 0;
        },
        insertFilesForArtifact(_artifactId: string, files: unknown[]) {
          storedFiles.push(...files);
        },
        deleteFilesForArtifact() {}
      },
      symbolsRepo: {
        clearSymbolsForArtifact() {},
        insertSymbolsForArtifact() {}
      },
      indexMetaRepo: {
        get(artifactId: string) {
          return storedMeta.get(artifactId);
        },
        upsert(meta: { artifactId: string }) {
          storedMeta.set(meta.artifactId, meta);
        }
      },
      metrics: {
        recordArtifactCacheHit() {},
        recordArtifactCacheMiss() {},
        recordReindex() {},
        recordReindexSkip() {},
        recordCacheEviction() {},
        setCacheEntries() {},
        setCacheTotalContentBytes() {},
        setCacheArtifactByteAccountingRef() {}
      }
    } as unknown as SourceService;

    const artifact: ResolvedSourceArtifact = {
      artifactId: "artifact-inflight",
      artifactSignature: "sig-inflight",
      origin: "local-jar",
      sourceJarPath,
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: [],
      isDecompiled: false,
      resolvedAt: new Date().toISOString()
    };

    await Promise.all([
      ingestIfNeeded(service, artifact),
      ingestIfNeeded(service, artifact)
    ]);

    assert.equal(rebuildWrites, 1);
  });
});

test("binary remap temp output paths keep a jar suffix without the legacy jar.tmp shape", () => {
  const tempPath = buildBinaryRemapTempPath("/cache/remapped/alpha.jar", {
    pid: 42,
    now: 1234567890,
    randomSuffix: "abcdef"
  });

  assert.equal(tempPath, "/cache/remapped/alpha.tmp.42.1234567890.abcdef.jar");
  assert.equal(tempPath.endsWith(".jar"), true);
  assert.equal(tempPath.includes(".jar.tmp."), false);
});

test("runBinaryRemapWithDeps rejects directory temp output and removes it recursively", async () => {
  await withTempDir("source-remap-temp-dir-", async (root) => {
    const service = createMinimalSourceService(root);
    const inputJar = join(root, "client.jar");
    const remappedDir = join(root, "remapped");
    const remappedJarPath = join(remappedDir, "artifact.jar");
    await writeFile(inputJar, "input");

    let observedTempPath = "";
    const deps = createFakeRemapDeps(async (_tinyRemapperJarPath, options) => {
      observedTempPath = options.outputJar;
      await mkdir(join(options.outputJar, "nested"), { recursive: true });
      await writeFile(join(options.outputJar, "nested", "leftover.txt"), "not a jar");
      return { outputJar: options.outputJar, durationMs: 1 };
    });

    await assert.rejects(
      () =>
        runBinaryRemapWithDeps(service, {
          version: "1.21.10",
          inputJar,
          remappedDir,
          remappedJarPath
        }, deps),
      (error) => isAppError(error) && error.code === ERROR_CODES.REMAP_FAILED
    );

    assert.equal(observedTempPath, join(remappedDir, `artifact.tmp.${process.pid}.1234567890.abcdef.jar`));
    assert.equal(existsSync(observedTempPath), false);
    assert.equal(existsSync(remappedJarPath), false);
  });
});

test("runBinaryRemapWithDeps maps final-path rename races to ERR_REMAP_FAILED and cleans temp", async () => {
  await withTempDir("source-remap-final-race-", async (root) => {
    const service = createMinimalSourceService(root);
    const inputJar = join(root, "client.jar");
    const remappedDir = join(root, "remapped");
    const remappedJarPath = join(remappedDir, "artifact.jar");
    await writeFile(inputJar, "input");

    let observedTempPath = "";
    const deps = createFakeRemapDeps(async (_tinyRemapperJarPath, options) => {
      observedTempPath = options.outputJar;
      await createJar(options.outputJar, {
        "net/minecraft/client/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
      });
      await mkdir(join(remappedJarPath, "nested"), { recursive: true });
      await writeFile(join(remappedJarPath, "nested", "poison.txt"), "late final directory");
      return { outputJar: options.outputJar, durationMs: 1 };
    });

    await assert.rejects(
      () =>
        runBinaryRemapWithDeps(service, {
          version: "1.21.10",
          inputJar,
          remappedDir,
          remappedJarPath
        }, deps),
      (error) => isAppError(error) && error.code === ERROR_CODES.REMAP_FAILED
    );

    assert.equal(existsSync(observedTempPath), false);
  });
});

test("maybeRemapBinaryForMojang removes a corrupt final directory before shared remap retry", async () => {
  await withTempDir("source-remap-final-dir-", async (root) => {
    const service = createMinimalSourceService(root);
    const inputJar = join(root, "client.jar");
    const remappedDir = join(root, "remapped");
    const remappedJarPath = join(remappedDir, "artifact.jar");
    await writeFile(inputJar, "input");
    await mkdir(join(remappedJarPath, "nested"), { recursive: true });
    await writeFile(join(remappedJarPath, "nested", "poison.txt"), "directory cache poison");

    const deps = createFakeRemapDeps(async (_tinyRemapperJarPath, options) => {
      await createJar(options.outputJar, {
        "net/minecraft/client/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
      });
      return { outputJar: options.outputJar, durationMs: 1 };
    });

    const resolved: ResolvedSourceArtifact = {
      artifactId: "artifact",
      artifactSignature: "sig-artifact",
      origin: "local-jar",
      binaryJarPath: inputJar,
      version: "1.21.10",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      provenance: {
        transformChain: ["binary-remap:obf->mojang"]
      },
      qualityFlags: ["binary-remapped"],
      isDecompiled: true,
      resolvedAt: new Date().toISOString()
    };

    const outputPath = await maybeRemapBinaryForMojang(service, resolved, deps);

    assert.equal(outputPath, remappedJarPath);
    assert.equal((await stat(remappedJarPath)).isFile(), true);
    assert.deepEqual([...((await readFile(remappedJarPath)).subarray(0, 4))], [0x50, 0x4b, 0x03, 0x04]);
    assert.equal(service.state.remappedJarBytes.get("artifact"), (await stat(remappedJarPath)).size);
  });
});
