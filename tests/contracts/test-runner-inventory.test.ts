import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";

const loadTestFileSelection = (): Promise<{
  selectOrdinaryTestFiles: (root: string) => Promise<string[]>;
}> =>
  import("../../scripts/test-file-selection.mjs") as Promise<{
    selectOrdinaryTestFiles: (root: string) => Promise<string[]>;
  }>;

async function createSelectionFixture(t: TestContext, paths: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "test-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of paths) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "");
  }
  return root;
}

test("ordinary test discovery includes nested test files in sorted order", async (t) => {
  const root = await createSelectionFixture(t, [
    "nested/deeper/z.test.ts",
    "root.test.ts",
    "nested/a.test.ts"
  ]);
  const { selectOrdinaryTestFiles } = await loadTestFileSelection();

  const selected = await selectOrdinaryTestFiles(root);
  const relativePaths = selected.map((path) => relative(root, path).replaceAll("\\", "/"));
  assert.deepEqual(relativePaths, [
    "nested/a.test.ts",
    "nested/deeper/z.test.ts",
    "root.test.ts"
  ]);
});

test("ordinary test discovery excludes top-level special directories and non-test files", async (t) => {
  const root = await createSelectionFixture(t, [
    "ordinary.test.ts",
    "nested/helpers/ordinary.test.ts",
    "helpers/helper.test.ts",
    "manual/nested/manual.test.ts",
    "perf/performance.test.ts",
    "resources/resource.test.ts",
    "nested/source.ts",
    "nested/example.test.js",
    "notes.md"
  ]);
  const { selectOrdinaryTestFiles } = await loadTestFileSelection();

  const selected = await selectOrdinaryTestFiles(root);
  const relativePaths = selected.map((path) => relative(root, path).replaceAll("\\", "/"));
  assert.deepEqual(relativePaths, [
    "nested/helpers/ordinary.test.ts",
    "ordinary.test.ts"
  ]);
});
