import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CI runs coverage gate", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(workflow, /- run: pnpm test:coverage/);
});

test("README documents coverage command for validation", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /pnpm test:coverage/);
});
