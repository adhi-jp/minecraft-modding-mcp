import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ORDINARY_TEST_DIRECTORIES = new Set([
  "contracts",
  "entry-tools",
  "integration",
  "mapping",
  "mixin",
  "mod",
  "nbt",
  "package",
  "runtime",
  "source-service",
  "stdio",
  "storage",
  "utils"
]);

const SPECIAL_DIRECTORIES = new Set([
  "helpers",
  "manual",
  "perf",
  "resources",
  "smoke"
]);

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

test("ordinary test files live in approved domain directories", async () => {
  const allTestFiles = (await collectFiles("tests"))
    .filter((path) => path.endsWith(".test.ts"))
    .sort();
  const topLevelTestFiles = allTestFiles.filter((path) => dirname(path) === "tests");

  assert.deepEqual(
    topLevelTestFiles,
    [],
    `Move top-level ordinary tests into domain directories: ${topLevelTestFiles.join(", ")}`
  );

  for (const path of allTestFiles) {
    const [firstSegment] = relative("tests", path).split(sep);
    assert.ok(firstSegment, `Expected ${path} to be below tests/`);
    assert.equal(
      SPECIAL_DIRECTORIES.has(firstSegment),
      false,
      `${path} is an ordinary .test.ts file and must not live under a special test directory`
    );
    assert.ok(
      ORDINARY_TEST_DIRECTORIES.has(firstSegment),
      `${path} must live under an approved ordinary test domain directory`
    );
  }
});

test("the test-layout contract stays in the contracts domain", () => {
  const thisFile = relative(process.cwd(), fileURLToPath(import.meta.url));

  assert.equal(dirname(thisFile), "tests/contracts");
  assert.equal(basename(thisFile), "test-layout.test.ts");
});
