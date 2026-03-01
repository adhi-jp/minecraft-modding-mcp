import assert from "node:assert/strict";
import test from "node:test";
import Database from "../../src/storage/sqlite.ts";

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

test("search perf smoke (10k files, indexed vs scan)", async () => {
  const { runMigrations } = await import("../../src/storage/migrations.ts");
  const { ArtifactsRepo } = await import("../../src/storage/artifacts-repo.ts");
  const { FilesRepo } = await import("../../src/storage/files-repo.ts");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const artifacts = new ArtifactsRepo(db);
  const files = new FilesRepo(db);
  const artifactId = "perf-artifact";
  artifacts.upsertArtifact({
    artifactId,
    origin: "local-jar",
    artifactSignature: "perf",
    isDecompiled: false,
    timestamp: new Date().toISOString()
  });

  const records = Array.from({ length: 10_000 }, (_, index) => {
    const withToken = index % 50 === 0;
    const body = withToken
      ? `public class C${index} { void runGameLoopToken() {} }`
      : `public class C${index} { void noop() {} }`;
    return {
      filePath: `net/minecraft/generated/C${index}.java`,
      content: body,
      contentBytes: Buffer.byteLength(body, "utf8"),
      contentHash: `h-${index}`
    };
  });
  files.replaceFilesForArtifact(artifactId, records);

  // Warm cache
  files.searchFiles(artifactId, { query: "runGameLoopToken", limit: 200 });

  const allFilePaths: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = files.listFiles(artifactId, { limit: 500, cursor });
    allFilePaths.push(...page.items);
    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  const searchDurations: number[] = [];
  const scanDurations: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    const searchStart = performance.now();
    const searchResult = files.searchFiles(artifactId, { query: "runGameLoopToken", limit: 200 });
    searchDurations.push(performance.now() - searchStart);

    const scanStart = performance.now();
    const scanned: string[] = [];
    for (const filePath of allFilePaths) {
      const row = files.getFileContent(artifactId, filePath);
      if (!row) {
        continue;
      }
      if (row.content.toLowerCase().includes("rungamelooptoken")) {
        scanned.push(row.filePath);
      }
      if (scanned.length >= 200) {
        break;
      }
    }
    scanDurations.push(performance.now() - scanStart);

    const target = searchResult.items[i % searchResult.items.length];
    assert.ok(target);
    assert.ok(scanned.length > 0);
  }

  const indexedP50 = percentile(searchDurations, 50);
  const indexedP95 = percentile(searchDurations, 95);
  const scanP50 = percentile(scanDurations, 50);
  const scanP95 = percentile(scanDurations, 95);
  const ratio = scanP50 > 0 ? scanP50 / Math.max(indexedP50, 0.0001) : Number.POSITIVE_INFINITY;

  console.info(
    JSON.stringify({
      event: "perf.search",
      samples: 30,
      indexedP50,
      indexedP95,
      scanP50,
      scanP95,
      p50RatioScanToIndexed: ratio
    })
  );

  // Plan target: indexed path should be at least 3x faster at p50.
  assert.ok(indexedP50 <= scanP50 / 3);
});
