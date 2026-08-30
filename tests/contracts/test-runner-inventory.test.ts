import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";

const EXPECTED_ORDINARY_TEST_FILES = 224;
// These constants pin the approved inventory so accidental runner-selection regressions
// surface as failures. Deliberately adding or splitting test files must update them:
// new behavior tests raise both counts, behavior-preserving splits raise only the file count.
// Historical deltas (which change raised the count, and why) live in git log
// / git blame for this file, not here.
const EXPECTED_ORDINARY_TEST_DECLARATIONS = 2137;
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

// The frozen premigration inventory (tests/fixtures/premigration/test-list.txt) is a
// NAMED-SET baseline: the counts above only pin how many tests exist, so deleting or
// renaming an inherited test while adding an unrelated one stays green. The helper
// exercised below is what `npm test` runs after a green suite to close that false-green.
type TapPoint = {
  depth: number;
  status: "ok" | "not ok";
  name: string;
  directive: string | null;
  key: string;
};

type FrozenNamedSet = {
  keys: Set<string>;
  rowCount: number;
  prefixStrippedCount: number;
  directiveRows: string[];
};

type NamedSetComparison = {
  missing: string[];
  missingCount: number;
  added: string[];
  addedCount: number;
  ok: boolean;
};

type TestNameInventoryModule = {
  parseTapPointLine: (line: string) => TapPoint | null;
  parseFrozenNamedSet: (text: string) => FrozenNamedSet;
  compareNamedTestSets: (frozen: Iterable<string>, live: Iterable<string>) => NamedSetComparison;
};

const loadTestNameInventory = (): Promise<TestNameInventoryModule> =>
  import("../../scripts/test-name-inventory.mjs") as Promise<TestNameInventoryModule>;

const FROZEN_NAMED_SET_URL = new URL("../fixtures/premigration/test-list.txt", import.meta.url);

test("the frozen premigration named set parses into a unique, directive-free key set", async () => {
  const { parseFrozenNamedSet, parseTapPointLine } = await loadTestNameInventory();

  const frozen = parseFrozenNamedSet(await readFile(FROZEN_NAMED_SET_URL, "utf8"));

  assert.equal(frozen.rowCount, 1818, "the frozen fixture holds 1818 TAP rows");
  assert.equal(frozen.keys.size, 1818, "every frozen row must canonicalize to a distinct key");
  assert.equal(
    frozen.prefixStrippedCount,
    11,
    "exactly the 11 legacy F-nn rows lose their prefix; a broader regex would also eat C-nn names"
  );
  assert.deepEqual(frozen.directiveRows, [], "a frozen SKIP/TODO row would freeze an unrun test");

  const frozenNames = [...frozen.keys].map((key) => key.split("\t")[2] ?? "");
  assert.equal(
    frozenNames.filter((name) => /^F-[0-9]{2}: /.test(name)).length,
    0,
    "no frozen key may keep the stripped legacy prefix"
  );
  assert.equal(
    frozenNames.filter((name) => /^C[0-9]+[a-z]?: /.test(name)).length,
    30,
    "C-nn names are real live names and must survive prefix handling untouched"
  );
  assert.ok(
    frozen.keys.has("0\tok\tgetModClassSource maxChars truncates output"),
    "a stripped row must be keyed under its live, unprefixed name"
  );

  const timed = parseTapPointLine("ok 12 - some behavior stays pinned # time=3ms");
  assert.deepEqual(timed, {
    depth: 0,
    status: "ok",
    name: "some behavior stays pinned",
    directive: null,
    key: "0\tok\tsome behavior stays pinned"
  });

  const nestedDuration = parseTapPointLine("    not ok 3 - nested behavior # duration_ms=1.5");
  assert.deepEqual(nestedDuration, {
    depth: 1,
    status: "not ok",
    name: "nested behavior",
    directive: null,
    key: "1\tnot ok\tnested behavior"
  });

  const behavioural = parseTapPointLine("ok 4 - keeps a trailing # comment-looking suffix");
  assert.deepEqual(behavioural, {
    depth: 0,
    status: "ok",
    name: "keeps a trailing # comment-looking suffix",
    directive: null,
    key: "0\tok\tkeeps a trailing # comment-looking suffix"
  });

  const skipped = parseTapPointLine("ok 5 - env guarded # SKIP java runtime not available");
  assert.deepEqual(skipped, {
    depth: 0,
    status: "ok",
    name: "env guarded",
    directive: "# SKIP java runtime not available",
    key: "0\tok\tenv guarded # SKIP java runtime not available"
  });

  assert.equal(parseTapPointLine("# Subtest: not a test point"), null);
  assert.equal(parseTapPointLine("1..5"), null);
});

test("the named-set comparison reports removed rows and tolerates added rows", async () => {
  const { compareNamedTestSets } = await loadTestNameInventory();
  const frozen = ["0\tok\talpha keeps working", "0\tok\tbeta keeps working", "1\tok\tnested gamma"];

  const result = compareNamedTestSets(frozen, [
    "0\tok\talpha keeps working",
    "1\tok\tnested gamma",
    "0\tok\tdelta is brand new"
  ]);

  assert.deepEqual(result.missing, ["0\tok\tbeta keeps working"], "the deleted row is the report");
  assert.equal(result.missingCount, 1);
  assert.equal(result.ok, false, "a missing frozen row must fail the gate");
  assert.deepEqual(result.added, ["0\tok\tdelta is brand new"]);

  const additionsOnly = compareNamedTestSets(frozen, [...frozen, "0\tok\tepsilon is brand new"]);
  assert.deepEqual(additionsOnly.missing, []);
  assert.equal(additionsOnly.addedCount, 1);
  assert.equal(additionsOnly.ok, true, "additions alone must never fail the gate");
});
