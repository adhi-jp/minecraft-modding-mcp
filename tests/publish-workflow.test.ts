import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publish workflow publishes scoped package with explicit public access", async () => {
  const workflow = await readFile(".github/workflows/publish.yml", "utf8");

  assert.match(workflow, /registry-url:\s*"https:\/\/registry\.npmjs\.org"/);
  assert.match(workflow, /npm publish --no-git-checks --access public/);
});
