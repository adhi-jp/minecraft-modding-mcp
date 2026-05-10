import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { ingestIfNeeded } from "../src/source/indexer.ts";
import { SourceServiceState } from "../src/source/state.ts";
import type { SourceService } from "../src/source-service.ts";
import type { ResolvedSourceArtifact } from "../src/types.ts";
import { withTempDir } from "./helpers/temp-dir.ts";
import { createJar } from "./helpers/zip.ts";

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
