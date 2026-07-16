import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withGradleUserHome } from "../helpers/env.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "../helpers/source-service-metrics.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";
import {
  type CacheAccountingRepo,
  type CacheFixtureArtifact,
  type CacheFixtureArtifactInput,
  type SourceServiceFixture,
  computeSourceEntriesBytes,
  createCacheAccountingFixture,
  defaultBinaryEntriesFor,
  instrumentCacheAccountingRepo
} from "../helpers/source-service-fixtures.ts";

test("SourceService backfills alias on warm-cache resolveArtifact", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-alias-backfill-"));
  const binaryJarPath = join(root, "warm-cache.jar");
  const sourcesJarPath = join(root, "warm-cache-sources.jar");

  await createJar(binaryJarPath, {
    "pkg/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "pkg/Main.java": "package pkg;\npublic class Main {}"
  });

  const service = new SourceService(buildTestConfig(root));
  const first = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });

  // Simulate a schema-v4 migrated row whose alias was never written.
  const repo = (service as unknown as {
    artifactsRepo: {
      getArtifact: (id: string) => { alias?: string } | undefined;
      setAlias: (id: string, alias: string) => void;
    };
    db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
  });
  repo.db.prepare(`UPDATE artifacts SET alias = NULL WHERE artifact_id = ?`).run([first.artifactId]);
  assert.equal(repo.artifactsRepo.getArtifact(first.artifactId)?.alias, undefined);

  // The warm-cache resolveArtifact must rewrite the alias so the returned
  // artifactAlias resolves back via getArtifact(alias).
  const second = await service.resolveArtifact({ target: { kind: "jar", value: binaryJarPath } });
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.artifactAlias, first.artifactAlias);
  assert.equal(repo.artifactsRepo.getArtifact(first.artifactId)?.alias, second.artifactAlias);

  // Caller can use the alias for follow-up lookups even after a migration.
  const file = await service.getArtifactFile({
    artifactId: second.artifactAlias,
    filePath: "pkg/Main.java"
  });
  assert.match(file.content, /class Main/);
});

test("SourceService evicts oldest artifacts when maxArtifacts is exceeded", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-evict-"));
  const config = buildTestConfig(root, { maxArtifacts: 1, maxCacheBytes: 2_147_483_648 });
  const service = new SourceService(config);

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");

  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const first = await service.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await service.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: first.artifactId,
        className: "a.A"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
      );
    }
  );
});

test("SourceService LRU eviction unlinks the artifact's `<cacheDir>/remapped/<id>.jar`", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "service-evict-remapped-"));
  const config = buildTestConfig(root, { maxArtifacts: 1, maxCacheBytes: 2_147_483_648 });
  const service = new SourceService(config);

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const first = await service.resolveArtifact({ target: { kind: "jar", value: jar1 } });

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const orphanedRemapped = join(remappedDir, `${first.artifactId}.jar`);
  await writeFile(orphanedRemapped, "remapped-bytes");
  assert.equal(existsSync(orphanedRemapped), true);

  await service.resolveArtifact({ target: { kind: "jar", value: jar2 } });

  assert.equal(
    existsSync(orphanedRemapped),
    false,
    "expected LRU eviction to unlink the remapped jar paired with the evicted artifact"
  );
});

test("SourceService init scans `<cacheDir>/remapped/` and includes only live-artifact bytes in `cache_total_content_bytes`", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-remapped-init-"));

  const config = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });

  const bootstrapService = new SourceService(config);
  const live = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const liveRemappedSize = 64 * 1024;
  const orphanedRemappedSize = 16 * 1024;
  await writeFile(join(remappedDir, `${live.artifactId}.jar`), Buffer.alloc(liveRemappedSize));
  await writeFile(join(remappedDir, "orphan-with-no-artifact.jar"), Buffer.alloc(orphanedRemappedSize));

  const service = new SourceService(config);

  const metrics = readCacheAccountingMetrics(service);
  assert.ok(
    metrics.totalContentBytes >= liveRemappedSize,
    `expected the live artifact's remapped jar bytes to be counted (got ${metrics.totalContentBytes})`
  );
  assert.ok(
    metrics.totalContentBytes < liveRemappedSize + orphanedRemappedSize,
    `expected orphaned remapped jar bytes (${orphanedRemappedSize}) to be excluded from accounting (got ${metrics.totalContentBytes})`
  );
});

test("SourceService maxCacheBytes does not chase orphaned remapped jars by evicting unrelated live artifacts", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-orphan-no-overshoot-"));

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const bootstrapConfig = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const bootstrapService = new SourceService(bootstrapConfig);
  const live1 = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const live2 = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(live1.artifactId, live2.artifactId);

  const remappedDir = join(bootstrapConfig.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const orphanJar = Buffer.alloc(64 * 1024);
  await writeFile(join(remappedDir, "orphan-no-artifact-row.jar"), orphanJar);

  const tightConfig = buildTestConfig(root, {
    maxArtifacts: 10,
    maxCacheBytes: orphanJar.byteLength - 1
  });
  const tightService = new SourceService(tightConfig);

  // No new resolves: the ctor's enforceCacheLimits pass alone must not chase orphan bytes.
  const metrics = readCacheAccountingMetrics(tightService);
  const remainingIds = metrics.lru.map((entry) => entry.artifactId);
  assert.ok(
    remainingIds.includes(live1.artifactId),
    `expected live1 to remain after init (got [${remainingIds.join(", ")}])`
  );
  assert.ok(
    remainingIds.includes(live2.artifactId),
    `expected live2 to remain after init (got [${remainingIds.join(", ")}])`
  );
});

test("SourceService maxCacheBytes does not over-evict unrelated artifacts after a remapped-jar eviction", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "service-evict-no-overshoot-"));

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  const jar3 = join(root, "three.jar");
  const src3 = join(root, "three-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });
  await createJar(jar3, { "c/C.class": Buffer.from([7, 8, 9]) });
  await createJar(src3, { "c/C.java": "package c;\npublic class C {}" });

  const config = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const bootstrapService = new SourceService(config);
  const first = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const remappedFirst = join(remappedDir, `${first.artifactId}.jar`);
  const oversizedJar = Buffer.alloc(64 * 1024);
  await writeFile(remappedFirst, oversizedJar);

  const tightConfig = buildTestConfig(root, {
    maxArtifacts: 10,
    maxCacheBytes: oversizedJar.byteLength - 1
  });
  const tightService = new SourceService(tightConfig);

  await tightService.resolveArtifact({ target: { kind: "jar", value: jar3 } });

  assert.equal(
    existsSync(remappedFirst),
    false,
    "expected the oversized remapped jar paired with `first` to be evicted"
  );
  const metrics = readCacheAccountingMetrics(tightService);
  const remainingIds = metrics.lru.map((entry) => entry.artifactId);
  assert.ok(
    remainingIds.includes(second.artifactId),
    `expected the unrelated artifact \`second\` (${second.artifactId}) to remain cached after the remapped-jar eviction (got [${remainingIds.join(", ")}])`
  );
});

test("SourceService maxCacheBytes evicts when remapped jar bytes alone push over the limit", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { existsSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "service-evict-remapped-bytes-"));

  const jar1 = join(root, "one.jar");
  const src1 = join(root, "one-sources.jar");
  const jar2 = join(root, "two.jar");
  const src2 = join(root, "two-sources.jar");
  await createJar(jar1, { "a/A.class": Buffer.from([1, 2, 3]) });
  await createJar(src1, { "a/A.java": "package a;\npublic class A {}" });
  await createJar(jar2, { "b/B.class": Buffer.from([4, 5, 6]) });
  await createJar(src2, { "b/B.java": "package b;\npublic class B {}" });

  const config = buildTestConfig(root, { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 });
  const bootstrapService = new SourceService(config);
  const first = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar1 } });
  const second = await bootstrapService.resolveArtifact({ target: { kind: "jar", value: jar2 } });
  assert.notEqual(first.artifactId, second.artifactId);

  const remappedDir = join(config.cacheDir, "remapped");
  await mkdir(remappedDir, { recursive: true });
  const remappedFirst = join(remappedDir, `${first.artifactId}.jar`);
  const oversizedJar = Buffer.alloc(64 * 1024);
  await writeFile(remappedFirst, oversizedJar);

  const jar3 = join(root, "three.jar");
  const src3 = join(root, "three-sources.jar");
  await createJar(jar3, { "c/C.class": Buffer.from([7, 8, 9]) });
  await createJar(src3, { "c/C.java": "package c;\npublic class C {}" });

  const tightConfig = buildTestConfig(root, {
    maxArtifacts: 10,
    maxCacheBytes: oversizedJar.byteLength - 1
  });
  const tightService = new SourceService(tightConfig);

  const initMetrics = readCacheAccountingMetrics(tightService);
  assert.ok(
    initMetrics.totalContentBytes >= oversizedJar.byteLength,
    `expected refreshCacheMetrics to count the remapped jar bytes (got ${initMetrics.totalContentBytes})`
  );

  await tightService.resolveArtifact({ target: { kind: "jar", value: jar3 } });

  assert.equal(
    existsSync(remappedFirst),
    false,
    "expected the oversized remapped jar to push the byte total over `maxCacheBytes` and trigger eviction"
  );
});

test("SourceService reports representative cache byte-accounting states", async (t) => {
  const cacheOneSource = "package a;\npublic class CacheOne { String token = \"one\"; }\n";
  const cacheTwoSource = "package b;\npublic class CacheTwo { String token = \"two\"; }\n";
  const alphaSource = "package a;\npublic class A { String payload = \"alpha-alpha-alpha\"; }\n";
  const betaSource = "package b;\npublic class B { String payload = \"beta-beta-beta\"; }\n";

  const cases: Array<{
    name: string;
    rootPrefix: string;
    configOverrides?: Partial<Config>;
    artifacts: CacheFixtureArtifactInput[];
    verify: (input: {
      service: SourceServiceFixture;
      artifacts: CacheFixtureArtifact[];
    }) => Promise<void>;
  }> = [
    {
      name: "tracks byte accounting across multiple artifacts",
      rootPrefix: "service-cache-accounting-",
      configOverrides: { maxArtifacts: 10, maxCacheBytes: 2_147_483_648 },
      artifacts: [
        {
          jarBaseName: "cache-one",
          sourceEntries: { "a/CacheOne.java": cacheOneSource }
        },
        {
          jarBaseName: "cache-two",
          sourceEntries: { "b/CacheTwo.java": cacheTwoSource },
          binaryEntries: { "b/CacheTwo.class": Buffer.from([4, 5, 6]) }
        }
      ],
      verify: async ({ service, artifacts }) => {
        const first = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[0]!.jarPath } });
        const second = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[1]!.jarPath } });
        assert.notEqual(first.artifactId, second.artifactId);

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 2);
        assert.equal(
          metrics.totalContentBytes,
          artifacts[0]!.expectedContentBytes + artifacts[1]!.expectedContentBytes
        );
        assert.equal(metrics.lru.length, 2);

        const firstRow = metrics.lru.find((entry) => entry.artifactId === first.artifactId);
        const secondRow = metrics.lru.find((entry) => entry.artifactId === second.artifactId);
        assert.equal(firstRow?.contentBytes, artifacts[0]!.expectedContentBytes);
        assert.equal(secondRow?.contentBytes, artifacts[1]!.expectedContentBytes);
      }
    },
    {
      name: "keeps byte accounting consistent after maxCacheBytes eviction",
      rootPrefix: "service-evict-bytes-",
      configOverrides: {
        maxArtifacts: 10,
        maxCacheBytes: Buffer.byteLength(alphaSource, "utf8") + 1
      },
      artifacts: [
        {
          jarBaseName: "bytes-one",
          sourceEntries: { "a/A.java": alphaSource },
          binaryEntries: { "a/A.class": Buffer.from([1, 2, 3]) }
        },
        {
          jarBaseName: "bytes-two",
          sourceEntries: { "b/B.java": betaSource },
          binaryEntries: { "b/B.class": Buffer.from([4, 5, 6]) }
        }
      ],
      verify: async ({ service, artifacts }) => {
        const first = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[0]!.jarPath } });
        const second = await service.resolveArtifact({ target: { kind: "jar", value: artifacts[1]!.jarPath } });
        assert.notEqual(first.artifactId, second.artifactId);

        await assert.rejects(
          () =>
            service.getClassSource({
              artifactId: first.artifactId,
              className: "a.A"
            }),
          (error: unknown) => {
            return (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              (error as { code: string }).code === ERROR_CODES.SOURCE_NOT_FOUND
            );
          }
        );

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 1);
        assert.equal(metrics.totalContentBytes, artifacts[1]!.expectedContentBytes);
        assert.equal(metrics.lru.length, 1);
        assert.equal(metrics.lru[0]?.artifactId, second.artifactId);
        assert.equal(metrics.lru[0]?.contentBytes, artifacts[1]!.expectedContentBytes);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await createCacheAccountingFixture({
        rootPrefix: testCase.rootPrefix,
        configOverrides: testCase.configOverrides,
        artifacts: testCase.artifacts
      });
      await testCase.verify(fixture);
    });
  }
});

test("SourceService updates cache accounting without rescanning repo tables", async (t) => {
  const cacheHitSource = 'package a;\npublic class CacheHit { String token = "hit"; }\n';
  const ingestSource = 'package a;\npublic class Ingest { String token = "ingest"; }\n';

  const cases: Array<{
    name: string;
    rootPrefix: string;
    artifact: CacheFixtureArtifactInput;
    verify: (input: {
      service: SourceServiceFixture;
      artifact: CacheFixtureArtifact;
    }) => Promise<void>;
  }> = [
    {
      name: "artifact cache hits avoid rescanning accounting tables",
      rootPrefix: "service-cache-hit-metrics-",
      artifact: {
        jarBaseName: "cache-hit",
        sourceEntries: { "a/CacheHit.java": cacheHitSource },
        binaryEntries: { "a/CacheHit.class": Buffer.from([1, 2, 3]) }
      },
      verify: async ({ service, artifact }) => {
        await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });
        const repoCounters = instrumentCacheAccountingRepo(service);

        await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });

        assert.deepEqual(repoCounters.counts(), {
          countCalls: 0,
          totalBytesCalls: 0,
          lruCalls: 0
        });
      }
    },
    {
      name: "artifact ingest updates accounting incrementally",
      rootPrefix: "service-ingest-metrics-",
      artifact: {
        jarBaseName: "ingest",
        sourceEntries: { "a/Ingest.java": ingestSource },
        binaryEntries: { "a/Ingest.class": Buffer.from([1, 2, 3]) }
      },
      verify: async ({ service, artifact }) => {
        const repoCounters = instrumentCacheAccountingRepo(service);
        const resolved = await service.resolveArtifact({ target: { kind: "jar", value: artifact.jarPath } });

        assert.deepEqual(repoCounters.counts(), {
          countCalls: 0,
          totalBytesCalls: 0,
          lruCalls: 0
        });

        const metrics = readCacheAccountingMetrics(service);
        assert.equal(metrics.cacheEntries, 1);
        assert.equal(metrics.totalContentBytes, artifact.expectedContentBytes);
        assert.equal(metrics.lru.length, 1);
        assert.equal(metrics.lru[0]?.artifactId, resolved.artifactId);
        assert.equal(metrics.lru[0]?.contentBytes, artifact.expectedContentBytes);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { service, artifacts } = await createCacheAccountingFixture({
        rootPrefix: testCase.rootPrefix,
        artifacts: [testCase.artifact]
      });
      await testCase.verify({ service, artifact: artifacts[0]! });
    });
  }
});

test("RuntimeMetrics snapshots copy artifact byte accounting rows on read", async () => {
  const { RuntimeMetrics } = await import("../../src/observability.ts");
  const metrics = new RuntimeMetrics();
  const lru = [
    {
      artifactId: "artifact-one",
      totalContentBytes: 12,
      updatedAt: "2026-03-14T00:00:00.000Z"
    }
  ];

  metrics.setCacheArtifactByteAccountingRef(lru);

  const first = metrics.snapshot();
  assert.deepEqual(first.cache_artifact_bytes_lru, [
    {
      artifact_id: "artifact-one",
      content_bytes: 12,
      updated_at: "2026-03-14T00:00:00.000Z"
    }
  ]);

  first.cache_artifact_bytes_lru[0]!.artifact_id = "mutated";
  first.cache_artifact_bytes_lru[0]!.content_bytes = 99;
  lru[0]!.artifactId = "artifact-two";
  lru[0]!.totalContentBytes = 18;
  lru[0]!.updatedAt = "2026-03-14T00:00:01.000Z";

  const second = metrics.snapshot();
  assert.deepEqual(second.cache_artifact_bytes_lru, [
    {
      artifact_id: "artifact-two",
      content_bytes: 18,
      updated_at: "2026-03-14T00:00:01.000Z"
    }
  ]);
});
