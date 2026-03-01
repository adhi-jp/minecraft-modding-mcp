import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("src throws use createError payloads instead of bare Error", async () => {
  const sourceFiles = [
    "src/minecraft-explorer-service.ts",
    "src/source-jar-reader.ts",
    "src/path-resolver.ts",
    "src/repo-downloader.ts",
    "src/mapping-service.ts"
  ] as const;

  for (const filePath of sourceFiles) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /throw new Error\(/, `${filePath} still uses throw new Error(...)`);
  }
});
