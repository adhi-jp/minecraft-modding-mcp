import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";

const EXPECTED_ORDINARY_TEST_FILES = 168;
// Baseline before the migration was 144 ordinary files with 1522 top-level test declarations.
// The new contract tests add four declarations, while behavior-preserving splits increase only the file count.
const EXPECTED_ORDINARY_TEST_DECLARATIONS = 1526;
const SPECIAL_DIRECTORIES = new Set(["helpers", "manual", "perf", "resources", "smoke"]);

async function collectRecursiveFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectRecursiveFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function collectOrdinaryTestFiles(): Promise<string[]> {
  const files = await collectRecursiveFiles("tests");
  return files
    .filter((path) => path.endsWith(".test.ts"))
    .filter((path) => {
      const [firstSegment] = relative("tests", path).split(sep);
      return firstSegment !== undefined && !SPECIAL_DIRECTORIES.has(firstSegment);
    })
    .sort();
}

function countTopLevelTestDeclarations(source: string): number {
  return [...source.matchAll(/^\s*test\s*\(/gm)].length;
}

test("ordinary test inventory keeps the approved test declaration count", async () => {
  const files = await collectOrdinaryTestFiles();
  const declarationCounts = await Promise.all(
    files.map(async (path) => countTopLevelTestDeclarations(await readFile(path, "utf8")))
  );
  const declarationCount = declarationCounts.reduce((sum, count) => sum + count, 0);

  assert.equal(
    files.length,
    EXPECTED_ORDINARY_TEST_FILES,
    "ordinary test migration must select every approved recursive .test.ts file"
  );
  assert.equal(
    declarationCount,
    EXPECTED_ORDINARY_TEST_DECLARATIONS,
    "ordinary test migration must preserve every approved top-level test declaration"
  );
});

test("the explicit runner selection matches the ordinary recursive inventory", async () => {
  const [{ selectOrdinaryTestFiles }, inventory] = await Promise.all([
    import("../../scripts/test-file-selection.mjs") as Promise<{
      selectOrdinaryTestFiles: () => Promise<string[]>;
    }>,
    collectOrdinaryTestFiles()
  ]);

  assert.deepEqual(await selectOrdinaryTestFiles(), inventory);
});
