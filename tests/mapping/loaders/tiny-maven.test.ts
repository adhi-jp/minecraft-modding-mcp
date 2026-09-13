import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseTinyFromJar } from "../../../src/mapping/loaders/tiny-maven.ts";
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
