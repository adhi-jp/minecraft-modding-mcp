import { readdir } from "node:fs/promises";
import { relative, sep } from "node:path";

export const SPECIAL_TEST_DIRECTORIES = new Set(["helpers", "manual", "perf", "resources", "smoke"]);

async function collectRecursiveFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
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

export async function selectOrdinaryTestFiles(root = "tests") {
  const files = await collectRecursiveFiles(root);
  return files
    .filter((path) => path.endsWith(".test.ts"))
    .filter((path) => {
      const [firstSegment] = relative(root, path).split(sep);
      return firstSegment !== undefined && !SPECIAL_TEST_DIRECTORIES.has(firstSegment);
    })
    .sort();
}
