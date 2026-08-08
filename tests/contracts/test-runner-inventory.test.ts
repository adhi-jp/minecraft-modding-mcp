import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";

const EXPECTED_ORDINARY_TEST_FILES = 186;
// These constants pin the approved inventory so accidental runner-selection regressions
// surface as failures. Deliberately adding or splitting test files must update them:
// new behavior tests raise both counts, behavior-preserving splits raise only the file count.
// 178 -> 179 / 1647 -> 1652: tests/stdio/stdio-supervisor-response-framing.test.ts adds
// 5 response-framing correlation tests (MCP SDK v2 migration, per-request framing).
// 179 -> 181 / 1652 -> 1672 (repair round): tests/stdio/stdio-worker-protocol.test.ts
// adds 2 worker-level tests (fresh-factory negotiate-down, $/stageUpdate emission),
// tests/utils/zod3-parity.test.ts adds 13 fieldErrors byte-parity tests, and
// tests/stdio/json-rpc-framing.test.ts gains 5 mid-stream framing-switch tests.
// 1672 -> 1673: tests/utils/zod3-parity.test.ts gains the entry-tool
// positiveIntSchema integer-acceptance/float-bytes parity test.
// 181 -> 184 / 1673 -> 1698: supervisor era state machine (dual-era gate):
// tests/stdio/stdio-supervisor-era-state.test.ts adds 15 admission/rejection/
// notification tests, tests/stdio/stdio-supervisor-era-lifecycle.test.ts adds
// 9 replay-gating/discover-neutrality/capture-ordering tests, and
// tests/stdio/stdio-supervisor-era-wire.test.ts adds 1 real-worker -32022
// passthrough + era-lock wire test.
// 184 -> 185 / 1698 -> 1718 (era repair round): era-state gains 5 tests
// (era-aware cancellation forwarding, listen shallow-check ordering,
// enveloped-initialize legacy lock), era-lifecycle gains 3 (restart
// first-frame guard, cap-rejected-initialize capture hole, in-flight
// discover cancellation limitation), era-wire gains 3 (pipelined
// discover+initialize, worker-down discover release, Content-Length
// rejection framing), and tests/utils/era-classifier.test.ts adds 9
// classifier/builder unit tests.
// 185 -> 186 / 1718 -> 1729 (per-request protocol-context carriage):
// tests/stdio/stdio-supervisor-era-context.test.ts adds 7 snapshot
// capture/concurrent-distinctness/queued-restart-carriage/no-leak tests,
// era-wire gains 1 concurrent per-request -32022 distinctness guard, and
// tests/utils/era-classifier.test.ts gains 3 extractModernRequestContext
// unit tests.
const EXPECTED_ORDINARY_TEST_DECLARATIONS = 1729;
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
