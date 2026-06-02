import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { discoverWorkspaceAccessTransformers, discoverWorkspaceAccessWideners, discoverWorkspaceMixins } from "../../src/entry-tools/validate-project-service.ts";
import { ModSearchService } from "../../src/mod-search-service.ts";
import type { DecompileModJarOutput, ModDecompileService } from "../../src/mod-decompile-service.ts";
import { resolveSourceTarget } from "../../src/source-resolver.ts";
import type { Config } from "../../src/types.ts";
import { WorkspaceMappingService } from "../../src/workspace-mapping-service.ts";
import { createJar } from "../helpers/zip.ts";

const BASELINE_PATH = join(process.cwd(), "tests/resources/perf/io-optimization-baseline.json");
const SAMPLES = 15;
const WARMUP_SAMPLES = 3;
const WORKSPACE_MODULE_COUNT = 24;
const SOURCE_JAR_RESOURCE_PREFIX_COUNT = 300;
const SOURCE_JAR_JAVA_FILE_COUNT = 900;
const SEARCH_DECOMPILED_FILE_COUNT = 320;
const SEARCH_HIT_INTERVAL = 16;
const SEARCH_LIMIT = 40;
const P50_JITTER_MARGIN_MS = 1;
const P95_JITTER_MARGIN_MS = 2;

type BenchmarkName = "workspaceDiscovery" | "sourceJarDetection" | "searchModSourceDecompiled";

interface IoLatencyKpi {
  p50Ms: number;
  p95Ms: number;
}

interface IoOptimizationSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  samples: number;
  fixtures: {
    workspaceModules: number;
    sourceJarResourcesBeforeJava: number;
    sourceJarJavaFiles: number;
    decompiledJavaFiles: number;
  };
  kpis: Record<BenchmarkName, IoLatencyKpi>;
}

function buildTestConfig(root: string): Config {
  return {
    cacheDir: join(root, "cache"),
    sqlitePath: ":memory:",
    sourceRepos: [],
    localM2Path: join(root, "m2"),
    vineflowerJarPath: undefined,
    maxContentBytes: 1_000_000,
    maxSearchHits: 200,
    maxArtifacts: 200,
    maxCacheBytes: 2_147_483_648,
    fetchTimeoutMs: 1_000,
    fetchRetries: 0,
    indexedSearchEnabled: true,
    mappingSourcePriority: "loom-first",
    searchScanPageSize: 250,
    searchScanMaxBytes: 67_108_864,
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isTruthyEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function validateSnapshot(snapshot: unknown, source: string): asserts snapshot is IoOptimizationSnapshot {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new Error(`${source}: snapshot must be an object`);
  }

  const asRecord = snapshot as Record<string, unknown>;
  if (asRecord.schemaVersion !== 1) {
    throw new Error(`${source}: schemaVersion must be 1`);
  }
  if (typeof asRecord.capturedAt !== "string" || asRecord.capturedAt.trim() === "") {
    throw new Error(`${source}: capturedAt must be a non-empty string`);
  }
  if (typeof asRecord.samples !== "number" || !Number.isFinite(asRecord.samples) || asRecord.samples < 1) {
    throw new Error(`${source}: samples must be a positive finite number`);
  }
  if (typeof asRecord.runtime !== "object" || asRecord.runtime === null) {
    throw new Error(`${source}: runtime must be an object`);
  }
  if (typeof asRecord.fixtures !== "object" || asRecord.fixtures === null) {
    throw new Error(`${source}: fixtures must be an object`);
  }

  const fixtureRecord = asRecord.fixtures as Record<string, unknown>;
  for (const key of [
    "workspaceModules",
    "sourceJarResourcesBeforeJava",
    "sourceJarJavaFiles",
    "decompiledJavaFiles"
  ]) {
    const value = fixtureRecord[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      throw new Error(`${source}: fixtures.${key} must be a positive finite number`);
    }
  }

  if (typeof asRecord.kpis !== "object" || asRecord.kpis === null) {
    throw new Error(`${source}: kpis must be an object`);
  }

  const kpis = asRecord.kpis as Record<string, unknown>;
  for (const benchmark of [
    "workspaceDiscovery",
    "sourceJarDetection",
    "searchModSourceDecompiled"
  ] as const) {
    const row = kpis[benchmark];
    if (typeof row !== "object" || row === null) {
      throw new Error(`${source}: kpis.${benchmark} must be an object`);
    }
    const rowRecord = row as Record<string, unknown>;
    for (const key of ["p50Ms", "p95Ms"]) {
      const value = rowRecord[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${source}: kpis.${benchmark}.${key} must be a non-negative finite number`);
      }
    }
  }
}

async function loadBaselineSnapshot(): Promise<IoOptimizationSnapshot> {
  let raw: string;
  try {
    raw = await readFile(BASELINE_PATH, "utf8");
  } catch {
    assert.fail(
      [
        `Missing perf baseline at ${BASELINE_PATH}.`,
        "Generate it with: UPDATE_PERF_BASELINE=1 node --test --test-concurrency=1 --import tsx tests/perf/io-optimization.perf.ts"
      ].join("\n")
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    assert.fail(
      `Invalid JSON in ${BASELINE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    validateSnapshot(parsed, BASELINE_PATH);
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error));
  }

  return parsed as IoOptimizationSnapshot;
}

async function writeBaselineSnapshot(snapshot: IoOptimizationSnapshot): Promise<void> {
  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  const tmpPath = `${BASELINE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tmpPath, BASELINE_PATH);
}

function runtimesMatch(current: IoOptimizationSnapshot, baseline: IoOptimizationSnapshot): boolean {
  return (
    current.runtime.node === baseline.runtime.node &&
    current.runtime.platform === baseline.runtime.platform &&
    current.runtime.arch === baseline.runtime.arch
  );
}

function compareAgainstBaseline(
  current: IoOptimizationSnapshot,
  baseline: IoOptimizationSnapshot,
  strictGuardrails: boolean
): void {
  assert.deepEqual(
    current.fixtures,
    baseline.fixtures,
    "io optimization perf fixtures changed; regenerate tests/resources/perf/io-optimization-baseline.json"
  );

  const warnings: string[] = [];
  const runtimeMatchesBaseline = runtimesMatch(current, baseline);
  const enforceStrict = strictGuardrails && runtimeMatchesBaseline;
  if (!runtimeMatchesBaseline) {
    warnings.push(
      [
        "baseline runtime mismatch; baseline-dependent guardrails are warning-only",
        `current=${current.runtime.node}/${current.runtime.platform}/${current.runtime.arch}`,
        `baseline=${baseline.runtime.node}/${baseline.runtime.platform}/${baseline.runtime.arch}`
      ].join("; ")
    );
  }

  const multipliers: Record<BenchmarkName, { p50: number; p95: number }> = {
    workspaceDiscovery: { p50: 1.25, p95: 1.4 },
    sourceJarDetection: { p50: 1.25, p95: 1.5 },
    searchModSourceDecompiled: { p50: 1.2, p95: 1.35 }
  };

  for (const benchmark of Object.keys(multipliers) as BenchmarkName[]) {
    const currentRow = current.kpis[benchmark];
    const baselineRow = baseline.kpis[benchmark];
    const limits = multipliers[benchmark];
    const p50Limit = baselineRow.p50Ms * limits.p50 + P50_JITTER_MARGIN_MS;
    const p95Limit = baselineRow.p95Ms * limits.p95 + P95_JITTER_MARGIN_MS;
    const violations: string[] = [];

    if (currentRow.p50Ms > p50Limit) {
      violations.push(
        `${benchmark}.p50Ms=${roundMetric(currentRow.p50Ms)} exceeded ${roundMetric(p50Limit)} (baseline ${roundMetric(
          baselineRow.p50Ms
        )})`
      );
    }
    if (currentRow.p95Ms > p95Limit) {
      violations.push(
        `${benchmark}.p95Ms=${roundMetric(currentRow.p95Ms)} exceeded ${roundMetric(p95Limit)} (baseline ${roundMetric(
          baselineRow.p95Ms
        )})`
      );
    }

    for (const violation of violations) {
      if (enforceStrict) {
        assert.fail(violation);
      } else {
        warnings.push(violation);
      }
    }
  }

  if (warnings.length > 0) {
    console.warn(
      JSON.stringify({
        event: "perf.io_optimization.guardrail_warning",
        strictGuardrails,
        runtimeMatchesBaseline,
        warnings
      })
    );
  }
}

async function createWorkspaceFixture(root: string): Promise<string> {
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "gradle.properties"), "minecraft_version=1.21.10\n", "utf8");

  for (let index = 0; index < WORKSPACE_MODULE_COUNT; index += 1) {
    const moduleRoot = join(workspaceRoot, `module-${index}`);
    const resourcesDir = join(moduleRoot, "src/main/resources");
    const metaInfDir = join(resourcesDir, "META-INF");
    await mkdir(metaInfDir, { recursive: true });

    const buildScript = [
      "plugins {",
      '  id("fabric-loom") version "1.9-SNAPSHOT"',
      "}",
      "",
      "dependencies {",
      "  mappings loom.officialMojangMappings()",
      "}",
      "",
      `group = "perf.module.${index}"`,
      `version = "1.0.${index}"`,
      "",
      "// filler to keep workspace scans realistic",
      ...Array.from({ length: 25 }, (_, fillerIndex) => `// filler ${index}:${fillerIndex} ${"x".repeat(120)}`)
    ].join("\n");
    await writeFile(join(moduleRoot, "build.gradle.kts"), buildScript, "utf8");

    const fabricMod = JSON.stringify(
      {
        schemaVersion: 1,
        id: `perf-module-${index}`,
        version: "1.0.0",
        accessWidener: `src/main/resources/module-${index}.accesswidener`,
        mixins: [`module-${index}.mixins.json`]
      },
      null,
      2
    );
    await writeFile(join(moduleRoot, "fabric.mod.json"), `${fabricMod}\n`, "utf8");
    await writeFile(
      join(resourcesDir, `module-${index}.accesswidener`),
      ["accessWidener v2 named", "accessible class net/minecraft/world/item/Item"].join("\n"),
      "utf8"
    );
    await writeFile(
      join(resourcesDir, `module-${index}.mixins.json`),
      JSON.stringify(
        {
          required: true,
          package: `perf.mixin.module${index}`,
          mixins: [`Module${index}Mixin`]
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(metaInfDir, "accesstransformer.cfg"),
      "public net.minecraft.world.item.Item f_41370_ # maxStackSize\n",
      "utf8"
    );
  }

  return workspaceRoot;
}

async function createSourceJarFixture(root: string): Promise<string> {
  const binaryJarPath = join(root, "io-opt-binary.jar");
  const sourceJarPath = join(root, "io-opt-binary-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const sourceEntries: Record<string, string> = {};
  for (let index = 0; index < SOURCE_JAR_RESOURCE_PREFIX_COUNT; index += 1) {
    sourceEntries[`assets/test/lang/prefix-${index}.json`] = JSON.stringify({ id: index });
  }
  for (let index = 0; index < SOURCE_JAR_JAVA_FILE_COUNT; index += 1) {
    sourceEntries[`net/minecraft/generated/IoSource${index}.java`] = [
      "package net.minecraft.generated;",
      `public class IoSource${index} {`,
      `  static final String VALUE = "io-source-${index}";`,
      "}"
    ].join("\n");
  }

  await createJar(sourceJarPath, sourceEntries);
  return binaryJarPath;
}

async function createDecompiledSearchFixture(root: string): Promise<{
  jarPath: string;
  outputDir: string;
  classNames: string[];
}> {
  const jarPath = join(root, "mod-search-binary.jar");
  const outputDir = join(root, "decompiled");
  await mkdir(outputDir, { recursive: true });

  await createJar(jarPath, {
    "fabric.mod.json": JSON.stringify({ schemaVersion: 1, id: "perf-search", version: "1.0.0" }),
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const classNames: string[] = [];
  for (let index = 0; index < SEARCH_DECOMPILED_FILE_COUNT; index += 1) {
    const className = `net.minecraft.generated.ModPerf${index}`;
    classNames.push(className);
    const filePath = join(outputDir, "net", "minecraft", "generated", `ModPerf${index}.java`);
    await mkdir(dirname(filePath), { recursive: true });
    const content = [
      "package net.minecraft.generated;",
      `public class ModPerf${index} {`,
      `  String payload = "${index % SEARCH_HIT_INTERVAL === 0 ? "NeedleContentToken" : `payload_${index}`}";`,
      ...Array.from({ length: 35 }, (_, fillerIndex) => `  void helper${fillerIndex}() {}`),
      "}"
    ].join("\n");
    await writeFile(filePath, content, "utf8");
  }

  return { jarPath, outputDir, classNames };
}

async function measureSamples(runOnce: () => Promise<void>): Promise<number[]> {
  for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
    await runOnce();
  }

  const durationsMs: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const startedAt = performance.now();
    await runOnce();
    durationsMs.push(performance.now() - startedAt);
  }
  return durationsMs;
}

test("compareAgainstBaseline treats runtime mismatch as warning-only even in strict mode", () => {
  const baseline: IoOptimizationSnapshot = {
    schemaVersion: 1,
    capturedAt: "2026-03-29T00:00:00.000Z",
    runtime: { node: "v24.13.0", platform: "linux", arch: "x64" },
    samples: SAMPLES,
    fixtures: {
      workspaceModules: WORKSPACE_MODULE_COUNT,
      sourceJarResourcesBeforeJava: SOURCE_JAR_RESOURCE_PREFIX_COUNT,
      sourceJarJavaFiles: SOURCE_JAR_JAVA_FILE_COUNT,
      decompiledJavaFiles: SEARCH_DECOMPILED_FILE_COUNT
    },
    kpis: {
      workspaceDiscovery: { p50Ms: 10, p95Ms: 12 },
      sourceJarDetection: { p50Ms: 4, p95Ms: 5 },
      searchModSourceDecompiled: { p50Ms: 15, p95Ms: 18 }
    }
  };
  const current: IoOptimizationSnapshot = {
    ...baseline,
    runtime: { ...baseline.runtime, node: "v22.14.0" },
    kpis: {
      workspaceDiscovery: { p50Ms: 100, p95Ms: 120 },
      sourceJarDetection: { p50Ms: 40, p95Ms: 50 },
      searchModSourceDecompiled: { p50Ms: 150, p95Ms: 180 }
    }
  };

  assert.doesNotThrow(() => compareAgainstBaseline(current, baseline, true));
});

test("compareAgainstBaseline fails strict guardrails when runtime matches", () => {
  const baseline: IoOptimizationSnapshot = {
    schemaVersion: 1,
    capturedAt: "2026-03-29T00:00:00.000Z",
    runtime: { node: "v24.13.0", platform: "linux", arch: "x64" },
    samples: SAMPLES,
    fixtures: {
      workspaceModules: WORKSPACE_MODULE_COUNT,
      sourceJarResourcesBeforeJava: SOURCE_JAR_RESOURCE_PREFIX_COUNT,
      sourceJarJavaFiles: SOURCE_JAR_JAVA_FILE_COUNT,
      decompiledJavaFiles: SEARCH_DECOMPILED_FILE_COUNT
    },
    kpis: {
      workspaceDiscovery: { p50Ms: 10, p95Ms: 12 },
      sourceJarDetection: { p50Ms: 4, p95Ms: 5 },
      searchModSourceDecompiled: { p50Ms: 15, p95Ms: 18 }
    }
  };
  const current: IoOptimizationSnapshot = {
    ...baseline,
    kpis: {
      ...baseline.kpis,
      workspaceDiscovery: { p50Ms: 20, p95Ms: 12 }
    }
  };

  assert.throws(() => compareAgainstBaseline(current, baseline, true), /workspaceDiscovery\.p50Ms/);
});

test("io optimization perf benchmarks stay within locked baseline guardrails", async () => {
  const updateBaseline = process.env.UPDATE_PERF_BASELINE === "1";
  const strictGuardrails = isTruthyEnv("STRICT_PERF") || isTruthyEnv("CI");
  const baseline = updateBaseline ? undefined : await loadBaselineSnapshot();

  const root = await mkdtemp(join(tmpdir(), "io-optimization-perf-"));
  const workspaceRoot = await createWorkspaceFixture(root);
  const binaryJarPath = await createSourceJarFixture(root);
  const decompiledFixture = await createDecompiledSearchFixture(root);
  const config = buildTestConfig(root);
  const workspaceMappingService = new WorkspaceMappingService();

  const workspaceDurationsMs = await measureSamples(async () => {
    const mixins = await discoverWorkspaceMixins(workspaceRoot);
    const accessWideners = await discoverWorkspaceAccessWideners(workspaceRoot);
    const accessTransformers = await discoverWorkspaceAccessTransformers(workspaceRoot);
    const mapping = await workspaceMappingService.detectCompileMapping({ projectPath: workspaceRoot });
    const loader = await workspaceMappingService.detectProjectLoader(workspaceRoot);

    assert.equal(mixins.length, WORKSPACE_MODULE_COUNT);
    assert.equal(accessWideners.length, WORKSPACE_MODULE_COUNT);
    assert.equal(accessTransformers.length, WORKSPACE_MODULE_COUNT);
    assert.equal(mapping.resolved, true);
    assert.equal(mapping.mappingApplied, "mojang");
    assert.equal(loader.resolved, true);
    assert.equal(loader.loader, "fabric");
  });

  const sourceJarDurationsMs = await measureSamples(async () => {
    const resolved = await resolveSourceTarget(
      { kind: "jar", value: binaryJarPath },
      { allowDecompile: false },
      config
    );
    assert.equal(resolved.isDecompiled, false);
    assert.match(resolved.sourceJarPath ?? "", /-sources\.jar$/);
  });

  const fakeModDecompileService = {
    async decompileModJar(): Promise<DecompileModJarOutput> {
      return {
        modId: "perf-search",
        loader: "fabric",
        outputDir: decompiledFixture.outputDir,
        fileCount: decompiledFixture.classNames.length,
        files: decompiledFixture.classNames,
        warnings: []
      };
    }
  } satisfies Pick<ModDecompileService, "decompileModJar">;
  const modSearchService = new ModSearchService(
    fakeModDecompileService as unknown as ModDecompileService
  );

  const searchDurationsMs = await measureSamples(async () => {
    const result = await modSearchService.searchModSource({
      jarPath: decompiledFixture.jarPath,
      query: "NeedleContentToken",
      searchType: "content",
      limit: SEARCH_LIMIT
    });
    assert.ok(result.hits.length > 0);
    assert.ok(result.totalHits >= result.hits.length);
  });

  const snapshot: IoOptimizationSnapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    samples: SAMPLES,
    fixtures: {
      workspaceModules: WORKSPACE_MODULE_COUNT,
      sourceJarResourcesBeforeJava: SOURCE_JAR_RESOURCE_PREFIX_COUNT,
      sourceJarJavaFiles: SOURCE_JAR_JAVA_FILE_COUNT,
      decompiledJavaFiles: SEARCH_DECOMPILED_FILE_COUNT
    },
    kpis: {
      workspaceDiscovery: {
        p50Ms: roundMetric(percentile(workspaceDurationsMs, 50)),
        p95Ms: roundMetric(percentile(workspaceDurationsMs, 95))
      },
      sourceJarDetection: {
        p50Ms: roundMetric(percentile(sourceJarDurationsMs, 50)),
        p95Ms: roundMetric(percentile(sourceJarDurationsMs, 95))
      },
      searchModSourceDecompiled: {
        p50Ms: roundMetric(percentile(searchDurationsMs, 50)),
        p95Ms: roundMetric(percentile(searchDurationsMs, 95))
      }
    }
  };
  validateSnapshot(snapshot, "generated snapshot");

  console.info(
    JSON.stringify({
      event: "perf.io_optimization",
      strictGuardrails,
      updateBaseline,
      capturedAt: snapshot.capturedAt,
      samples: snapshot.samples,
      fixtures: snapshot.fixtures,
      kpis: snapshot.kpis
    })
  );

  if (updateBaseline) {
    await writeBaselineSnapshot(snapshot);
    return;
  }

  compareAgainstBaseline(snapshot, baseline as IoOptimizationSnapshot, strictGuardrails);
});
