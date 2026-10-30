import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchYarnCoordinates, parseTinyFromJar } from "../../../src/mapping/loaders/tiny-maven.ts";
import { createCraftedJar } from "../../helpers/zip-crafted.ts";

/** A small, legitimate tiny v2 entry that must always survive extraction. */
const SMALL_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/NamedClass"
].join("\n");

/**
 * Builds a valid tiny v2 file that decompresses far past a small test-scale
 * bound but is cheap on disk, standing in for a `.tiny` entry with a small
 * compressed size and a huge inflated size ("zip bomb" style).
 */
function buildBombTiny(classCount: number): string {
  const lines = ["tiny\t2\t0\tobfuscated\tintermediary\tnamed"];
  for (let index = 0; index < classCount; index += 1) {
    lines.push(`c\tbomb/pkg/Class${index}\tinter/pkg/BombClass${index}\tyarn/pkg/NamedBomb${index}`);
  }
  return lines.join("\n");
}

function allSymbols(merged: Map<string, { records: Map<string, { symbol: string }> }>): string[] {
  const symbols: string[] = [];
  for (const index of merged.values()) {
    for (const record of index.records.values()) {
      symbols.push(record.symbol);
    }
  }
  return symbols;
}

test("parseTinyFromJar bounds a .tiny entry that decompresses far past the configured entry-size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiny-maven-zip-bomb-"));
  const jarPath = join(root, "yarn.jar");
  const boundBytes = 8 * 1024;
  const bombContent = buildBombTiny(6000);

  assert.ok(
    bombContent.length > boundBytes * 10,
    "the crafted bomb entry must decompress to well past the test bound"
  );

  await createCraftedJar(jarPath, [
    { name: "mappings/small.tiny", data: SMALL_TINY, method: "store" },
    { name: "mappings/bomb.tiny", data: bombContent, method: "deflate" }
  ]);

  const onDiskBytes = (await stat(jarPath)).size;
  assert.ok(
    onDiskBytes < bombContent.length / 4,
    `expected the deflate-compressed bomb entry to be cheap on disk; got ${onDiskBytes} bytes ` +
      `for ${bombContent.length} decompressed bytes`
  );

  const merged = await parseTinyFromJar(jarPath, boundBytes);
  const symbols = allSymbols(merged);

  assert.ok(
    symbols.includes("intermediary.pkg.InterClass"),
    "the small, in-bound entry must still be parsed"
  );
  assert.ok(
    !symbols.some((symbol) => symbol.includes("BombClass") || symbol.includes("NamedBomb")),
    "the oversized entry must be bounded/skipped rather than fully inflated and parsed"
  );
});

const YARN_REPO = "https://repo-a.test";
const YARN_FALLBACK = ["1.21.10"];

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

function stallingBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")), {
        once: true
      });
    }
  });
}

for (const row of [
  { label: "a 503 answer", expected: [], answer: () => new Response("unavailable", { status: 503 }) },
  { label: "a 404 answer", expected: [], answer: () => new Response("not found", { status: 404 }) },
  {
    label: "a thrown request",
    expected: YARN_FALLBACK,
    answer: () => {
      throw new TypeError("fetch failed");
    }
  },
  {
    label: "a request that never answers",
    expected: YARN_FALLBACK,
    answer: (init: RequestInit | undefined) => waitForAbort(init?.signal)
  },
  {
    label: "a body that stalls",
    expected: YARN_FALLBACK,
    answer: (init: RequestInit | undefined) => new Response(stallingBody(init?.signal), { status: 200 })
  }
]) {
  test(`fetchYarnCoordinates answers ${JSON.stringify(row.expected)} for ${row.label} within its timeout`, { timeout: 10_000 }, async () => {
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => row.answer(init)) as typeof fetch;

    const startedAt = Date.now();
    const coordinates = await fetchYarnCoordinates(fetchFn, YARN_REPO, "1.21.10", YARN_FALLBACK, 100);

    assert.deepEqual(coordinates, row.expected);
    assert.ok(Date.now() - startedAt < 5_000, "the metadata request must end within its timeout");
  });
}

test("resolveTinyMappingFile bounds its yarn build-list fetch with the 30-second timeout of its own downloads", async () => {
  const source = await readFile("src/mapping-service.ts", "utf8");
  const resolveBlock = source.match(/export async function resolveTinyMappingFile\([\s\S]*?\n\}\n/m)?.[0] ?? "";

  assert.match(resolveBlock, /fetchYarnCoordinates\(effectiveFetch, FABRIC_MAVEN, version, \[\], 30_000\)/);
});
