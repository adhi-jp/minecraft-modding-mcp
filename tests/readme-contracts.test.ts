import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("README documents analyze-mod-jar inputs that match implementation", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /\| `analyze-mod-jar` \|.*`jarPath`, `includeClasses\?` \|/);
  assert.doesNotMatch(readme, /includeAllClasses\?/);
  assert.doesNotMatch(readme, /includeRawMetadata\?/);
});
