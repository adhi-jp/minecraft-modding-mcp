import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { Config } from "../../src/types.ts";
import { createJar } from "../helpers/zip.ts";

const BASELINE_PATH = join(process.cwd(), "tests/resources/perf/search-kpi-baseline.json");
const DATASET_FILE_COUNT = 3_000;
const SAMPLES = 30;
const WARMUP_SAMPLES = 5;
const P50_TARGET_RATIO_BY_INTENT = {
  text: 3,
  path: 2,
  symbol: 3
} as const;
const P95_TARGET_RATIO = 2;
const P50_JITTER_MARGIN_MS = 0.05;
const P95_JITTER_MARGIN_MS = 0.1;

type IntentName = "text" | "path" | "symbol";
type SearchMatch = "contains" | "exact" | "prefix" | "regex";

interface SearchIoSnapshot {
  dbRoundtrips: number;
  rowsScanned: number;
}

interface SearchRequest {
  intent: IntentName;
  query: string;
  match: SearchMatch;
}

interface BenchmarkRun {
  durationsMs: number[];
  dbRoundtripsDelta: number;
  rowsScannedDelta: number;
  heapDeltaBytes: number;
}

interface IntentKpi {
  indexedP50Ms: number;
  indexedP95Ms: number;
  scanP50Ms: number;
  scanP95Ms: number;
  indexedDbRoundtripsDelta: number;
  indexedRowsScannedDelta: number;
  indexedHeapDeltaBytes: number;
}

interface KpiSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  samples: number;
  kpis: Record<IntentName, IntentKpi>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function isTruthyEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
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
    indexInsertChunkSize: 200,
    maxMappingGraphCache: 16,
    maxSignatureCache: 2_000,
    maxVersionDetailCache: 256,
    maxNbtInputBytes: 4 * 1024 * 1024,
    maxNbtInflatedBytes: 16 * 1024 * 1024,
    maxNbtResponseBytes: 8 * 1024 * 1024
  };
}

function readSearchIoMetrics(service: { getRuntimeMetrics: () => unknown }): SearchIoSnapshot {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    dbRoundtrips:
      typeof snapshot.search_db_roundtrips === "number" ? snapshot.search_db_roundtrips : 0,
    rowsScanned:
      typeof snapshot.search_rows_scanned === "number" ? snapshot.search_rows_scanned : 0
  };
}

function metricDelta(after: number, before: number): number {
  return Math.max(0, Math.trunc(after - before));
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function createPerfJars(root: string): Promise<string> {
  const binaryJarPath = join(root, "perf-server.jar");
  const sourcesJarPath = join(root, "perf-server-sources.jar");

  await createJar(binaryJarPath, {
    "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const sourceEntries: Record<string, string> = {};
  for (let index = 0; index < DATASET_FILE_COUNT; index += 1) {
    const special = index % 40 === 0;
    const classStem = special ? `NeedlePath${index}` : `PerfClass${index}`;
    const methodName = index === 1_234 ? "targetSymbolHook" : `tick${index}`;
    const token = special ? "SearchLatencyNeedleToken" : `payload_${index}`;
    const filePath = `net/minecraft/generated/${classStem}.java`;
    const sourceText = [
      "package net.minecraft.generated;",
      `public class ${classStem} {`,
      `  static String payload = "${token}";`,
      `  void ${methodName}() {}`,
      `  void helper${index}() {}`,
      "}"
    ].join("\n");
    sourceEntries[filePath] = sourceText;
  }

  await createJar(sourcesJarPath, sourceEntries);
  return binaryJarPath;
}

function validateSnapshot(snapshot: unknown, source: string): asserts snapshot is KpiSnapshot {
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
  if (typeof asRecord.samples !== "number" || !Number.isFinite(asRecord.samples)) {
    throw new Error(`${source}: samples must be a finite number`);
  }
  if (typeof asRecord.runtime !== "object" || asRecord.runtime === null) {
    throw new Error(`${source}: runtime must be an object`);
  }

  const kpis = asRecord.kpis;
  if (typeof kpis !== "object" || kpis === null) {
    throw new Error(`${source}: kpis must be an object`);
  }

  for (const intent of ["text", "path", "symbol"] as const) {
    const row = (kpis as Record<string, unknown>)[intent];
    if (typeof row !== "object" || row === null) {
      throw new Error(`${source}: kpis.${intent} must be an object`);
    }
    const rowRecord = row as Record<string, unknown>;
    for (const key of [
      "indexedP50Ms",
      "indexedP95Ms",
      "scanP50Ms",
      "scanP95Ms",
      "indexedDbRoundtripsDelta",
      "indexedRowsScannedDelta",
      "indexedHeapDeltaBytes"
    ]) {
      const value = rowRecord[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${source}: kpis.${intent}.${key} must be a non-negative number`);
      }
    }
  }
}

async function loadBaselineSnapshot(): Promise<KpiSnapshot> {
  let raw: string;
  try {
    raw = await readFile(BASELINE_PATH, "utf8");
  } catch (error) {
    assert.fail(
      [
        `Missing perf baseline at ${BASELINE_PATH}.`,
        "Generate it with: npm run test:perf:update-baseline"
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

  return parsed as KpiSnapshot;
}

async function writeBaselineSnapshot(snapshot: KpiSnapshot): Promise<void> {
  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  const tmpPath = `${BASELINE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tmpPath, BASELINE_PATH);
}

async function runSearchBenchmark(
  service: {
    searchClassSource: (input: Record<string, unknown>) => Promise<{ hits: unknown[] }>;
    getRuntimeMetrics: () => unknown;
  },
  artifactId: string,
  request: SearchRequest,
  collectIoAndHeap: boolean
): Promise<BenchmarkRun> {
  const callSearch = async (): Promise<{ hits: unknown[] }> =>
    service.searchClassSource({
      artifactId,
      query: request.query,
      intent: request.intent,
      match: request.match,
      include: {
        includeDefinition: false,
        includeOneHop: false
      },
      limit: 200
    });

  for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
    const warm = await callSearch();
    assert.ok(warm.hits.length > 0, `warmup returned no hits for ${request.intent}/${request.match}`);
  }

  const before = collectIoAndHeap ? readSearchIoMetrics(service) : undefined;
  const heapStart = collectIoAndHeap ? process.memoryUsage().heapUsed : 0;
  let heapPeak = heapStart;
  const durationsMs: number[] = [];

  for (let i = 0; i < SAMPLES; i += 1) {
    const startedAt = performance.now();
    const result = await callSearch();
    const elapsed = performance.now() - startedAt;
    durationsMs.push(elapsed);
    assert.ok(result.hits.length > 0, `search returned no hits for ${request.intent}/${request.match}`);

    if (collectIoAndHeap) {
      const currentHeap = process.memoryUsage().heapUsed;
      if (currentHeap > heapPeak) {
        heapPeak = currentHeap;
      }
    }
  }

  const after = collectIoAndHeap ? readSearchIoMetrics(service) : undefined;
  return {
    durationsMs,
    dbRoundtripsDelta:
      collectIoAndHeap && before && after
        ? metricDelta(after.dbRoundtrips, before.dbRoundtrips)
        : 0,
    rowsScannedDelta:
      collectIoAndHeap && before && after ? metricDelta(after.rowsScanned, before.rowsScanned) : 0,
    heapDeltaBytes: collectIoAndHeap ? metricDelta(heapPeak, heapStart) : 0
  };
}

function evaluateGuardrail(
  intent: IntentName,
  metricName: keyof Pick<
    IntentKpi,
    "indexedDbRoundtripsDelta" | "indexedRowsScannedDelta" | "indexedHeapDeltaBytes"
  >,
  current: number,
  baseline: number,
  maxMultiplier: number
): string | undefined {
  const limit = baseline === 0 ? 0 : baseline * maxMultiplier;
  if (current <= limit) {
    return undefined;
  }
  return `${intent}.${metricName}: ${current} exceeded guardrail limit ${roundMetric(limit)} (baseline ${baseline})`;
}

function runtimesMatch(current: KpiSnapshot, baseline: KpiSnapshot): boolean {
  return (
    current.runtime.node === baseline.runtime.node &&
    current.runtime.platform === baseline.runtime.platform &&
    current.runtime.arch === baseline.runtime.arch
  );
}

function compareAgainstBaseline(
  current: KpiSnapshot,
  baseline: KpiSnapshot,
  strictGuardrails: boolean
): void {
  const warnings: string[] = [];
  const runtimeMatchesBaseline = runtimesMatch(current, baseline);
  const enforceBaselineStrict = strictGuardrails && runtimeMatchesBaseline;

  if (!runtimeMatchesBaseline) {
    warnings.push(
      [
        "baseline runtime mismatch; baseline-dependent guardrails are warning-only",
        `current=${current.runtime.node}/${current.runtime.platform}/${current.runtime.arch}`,
        `baseline=${baseline.runtime.node}/${baseline.runtime.platform}/${baseline.runtime.arch}`
      ].join("; ")
    );
  }

  for (const intent of ["text", "path", "symbol"] as const) {
    const row = current.kpis[intent];
    const baseRow = baseline.kpis[intent];
    const p50TargetRatio = P50_TARGET_RATIO_BY_INTENT[intent];
    const indexedP50Limit = row.scanP50Ms / p50TargetRatio + P50_JITTER_MARGIN_MS;
    const indexedP95Limit = row.scanP95Ms / P95_TARGET_RATIO + P95_JITTER_MARGIN_MS;

    assert.ok(
      row.indexedP50Ms <= indexedP50Limit,
      `${intent}: indexedP50Ms=${roundMetric(row.indexedP50Ms)} must be <= scanP50Ms/${p50TargetRatio}+${P50_JITTER_MARGIN_MS}=${roundMetric(
        indexedP50Limit
      )}`
    );
    assert.ok(
      row.indexedP95Ms <= indexedP95Limit,
      `${intent}: indexedP95Ms=${roundMetric(row.indexedP95Ms)} must be <= scanP95Ms/${P95_TARGET_RATIO}+${P95_JITTER_MARGIN_MS}=${roundMetric(
        indexedP95Limit
      )}`
    );

    const dbViolation = evaluateGuardrail(
      intent,
      "indexedDbRoundtripsDelta",
      row.indexedDbRoundtripsDelta,
      baseRow.indexedDbRoundtripsDelta,
      1.15
    );
    const rowViolation = evaluateGuardrail(
      intent,
      "indexedRowsScannedDelta",
      row.indexedRowsScannedDelta,
      baseRow.indexedRowsScannedDelta,
      1.15
    );
    const heapViolation = evaluateGuardrail(
      intent,
      "indexedHeapDeltaBytes",
      row.indexedHeapDeltaBytes,
      baseRow.indexedHeapDeltaBytes,
      1.2
    );

    for (const violation of [dbViolation, rowViolation]) {
      if (!violation) {
        continue;
      }
      if (enforceBaselineStrict) {
        assert.fail(violation);
      } else {
        warnings.push(violation);
      }
    }

    if (heapViolation) {
      warnings.push(`${heapViolation} [non-blocking: heap guardrail]`);
    }
  }

  if (warnings.length > 0) {
    console.warn(
      JSON.stringify({
        event: "perf.search.intent.guardrail_warning",
        strictGuardrails,
        runtimeMatchesBaseline,
        warnings
      })
    );
  }
}

interface SnapshotTestOverrides {
  runtime?: Partial<KpiSnapshot["runtime"]>;
  kpis?: Partial<Record<IntentName, Partial<IntentKpi>>>;
}

function buildSnapshotForGuardrailTest(overrides?: SnapshotTestOverrides): KpiSnapshot {
  const baseIntent = (): IntentKpi => ({
    indexedP50Ms: 1,
    indexedP95Ms: 2,
    scanP50Ms: 6,
    scanP95Ms: 8,
    indexedDbRoundtripsDelta: 100,
    indexedRowsScannedDelta: 200,
    indexedHeapDeltaBytes: 1_000_000
  });
  const base: KpiSnapshot = {
    schemaVersion: 1,
    capturedAt: "2026-02-24T00:00:00.000Z",
    runtime: {
      node: "v24.13.0",
      platform: "linux",
      arch: "x64"
    },
    samples: SAMPLES,
    kpis: {
      text: baseIntent(),
      path: baseIntent(),
      symbol: baseIntent()
    }
  };

  if (!overrides) {
    return base;
  }

  if (overrides.runtime) {
    base.runtime = {
      ...base.runtime,
      ...overrides.runtime
    };
  }

  if (overrides.kpis) {
    for (const intent of ["text", "path", "symbol"] as const) {
      const intentOverride = overrides.kpis[intent];
      if (!intentOverride) {
        continue;
      }
      base.kpis[intent] = {
        ...base.kpis[intent],
        ...intentOverride
      };
    }
  }

  return base;
}

test("compareAgainstBaseline keeps heap guardrail warning-only in strict mode", () => {
  const baseline = buildSnapshotForGuardrailTest();
  const current = buildSnapshotForGuardrailTest({
    kpis: {
      path: {
        indexedHeapDeltaBytes: 2_000_000
      }
    }
  });

  assert.doesNotThrow(() => compareAgainstBaseline(current, baseline, true));
});

test("compareAgainstBaseline does not fail strict baseline guardrails on runtime mismatch", () => {
  const baseline = buildSnapshotForGuardrailTest();
  const current = buildSnapshotForGuardrailTest({
    runtime: {
      node: "v22.12.0"
    },
    kpis: {
      text: {
        indexedDbRoundtripsDelta: 200,
        indexedRowsScannedDelta: 400
      }
    }
  });

  assert.doesNotThrow(() => compareAgainstBaseline(current, baseline, true));
});

test("compareAgainstBaseline fails strict baseline guardrails when runtime matches", () => {
  const baseline = buildSnapshotForGuardrailTest();
  const current = buildSnapshotForGuardrailTest({
    kpis: {
      text: {
        indexedDbRoundtripsDelta: 200
      }
    }
  });

  assert.throws(
    () => compareAgainstBaseline(current, baseline, true),
    /indexedDbRoundtripsDelta/
  );
});

test("search perf intents honor locked KPIs and baseline guardrails", async () => {
  const updateBaseline = process.env.UPDATE_PERF_BASELINE === "1";
  const strictGuardrails = isTruthyEnv("STRICT_PERF") || isTruthyEnv("CI");
  const baseline = updateBaseline ? undefined : await loadBaselineSnapshot();

  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "search-intents-perf-"));
  const binaryJarPath = await createPerfJars(root);

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "official"
  });

  const indexedRequests: Record<IntentName, SearchRequest> = {
    text: {
      intent: "text",
      query: "SearchLatencyNeedleToken",
      match: "contains"
    },
    path: {
      intent: "path",
      query: "NeedlePath",
      match: "contains"
    },
    symbol: {
      intent: "symbol",
      query: "targetSymbolHook",
      match: "exact"
    }
  };
  const scanRequests: Record<IntentName, SearchRequest> = {
    text: {
      intent: "text",
      query: "SearchLatencyNeedleToken",
      match: "regex"
    },
    path: {
      intent: "path",
      query: "NeedlePath.*\\.java$",
      match: "regex"
    },
    symbol: {
      intent: "symbol",
      query: "^targetSymbolHook$",
      match: "regex"
    }
  };

  const kpis = {} as Record<IntentName, IntentKpi>;
  for (const intent of ["text", "path", "symbol"] as const) {
    const indexed = await runSearchBenchmark(service, resolved.artifactId, indexedRequests[intent], true);
    const scanned = await runSearchBenchmark(service, resolved.artifactId, scanRequests[intent], false);

    kpis[intent] = {
      indexedP50Ms: roundMetric(percentile(indexed.durationsMs, 50)),
      indexedP95Ms: roundMetric(percentile(indexed.durationsMs, 95)),
      scanP50Ms: roundMetric(percentile(scanned.durationsMs, 50)),
      scanP95Ms: roundMetric(percentile(scanned.durationsMs, 95)),
      indexedDbRoundtripsDelta: indexed.dbRoundtripsDelta,
      indexedRowsScannedDelta: indexed.rowsScannedDelta,
      indexedHeapDeltaBytes: indexed.heapDeltaBytes
    };
  }

  const snapshot: KpiSnapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    samples: SAMPLES,
    kpis
  };
  validateSnapshot(snapshot, "generated snapshot");

  console.info(
    JSON.stringify({
      event: "perf.search.intents",
      strictGuardrails,
      updateBaseline,
      capturedAt: snapshot.capturedAt,
      samples: snapshot.samples,
      kpis: snapshot.kpis
    })
  );

  if (updateBaseline) {
    await writeBaselineSnapshot(snapshot);
    return;
  }

  compareAgainstBaseline(snapshot, baseline as KpiSnapshot, strictGuardrails);
});
