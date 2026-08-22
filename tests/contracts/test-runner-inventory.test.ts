import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";

const EXPECTED_ORDINARY_TEST_FILES = 210;
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
// 186 -> 191 / 1729 -> 1757 (synthetic finality + modern decoration):
// tests/stdio/stdio-supervisor-synthetic-inventory.test.ts adds 17 era ×
// failure-type inventory tests (legacy fixture byte-compat, modern
// decoration, exactly-one-response finality, tombstone lifecycle),
// tests/stdio/stdio-supervisor-synthetic-toggle-off.test.ts adds 2
// SUPERVISOR_STRUCTURED_RESTART_OFF variants,
// tests/stdio/stdio-supervisor-synthetic-drift.test.ts adds 1 live-SDK
// structural drift guard, tests/utils/synthetic-decorator.test.ts adds 5
// decorator unit tests, and tests/utils/server-identity.test.ts adds 3
// canonical-identity unit tests.
// 191 -> 199 / 1757 -> 1781 (modern-surface completion slice): cache-hint
// values + era ordering + acceptance/inventory suites:
// tests/utils/mcp-helpers-cache-fields.test.ts adds 3 errorResource cache
// override tests, tests/stdio/stdio-modern-cache-hints.test.ts adds 6
// adopted-cache-value wire tests, tests/stdio/stdio-modern-tools-list-order
// .test.ts adds 2 ordering tests, tests/stdio/stdio-modern-discover-
// contents.test.ts adds 1 full-contents pin, tests/stdio/stdio-legacy-
// negotiation-matrix.test.ts adds 2 declarations (a 5-version matrix loop +
// the bogus-version case), tests/stdio/stdio-modern-result-type-inventory
// .test.ts adds 3 enumeration tests, tests/stdio/stdio-error-code-inventory
// .test.ts adds 5 inventory/source-scan tests, and tests/stdio/stdio-
// dependency-method-inventory.test.ts adds 2 per-era wire inventory tests.
// 199 -> 200 / 1781 -> 1788 (disabled-tool restore disposition):
// tests/stdio/stdio-supervisor-unknown-tool-intercept.test.ts adds 7
// legacy-era unknown-tool intercept tests (wire restore + modern guard +
// white-box queue/tombstone/registry-gate semantics).
// 200 -> 203 / 1788 -> 1797 (modern-surface repair round 2): per-flag-config
// tools/list ordering coverage — tests/stdio/stdio-modern-tools-list-order.
// {batch-tools-off,verify-mixin-target-off,both-off}.test.ts add 2 ordering
// tests each (per-process flag env, legacy golden order + modern sorted);
// stdio-modern-cache-hints.test.ts gains 1 legacy claim-shaped-invalid
// errorResource guard; stdio-supervisor-unknown-tool-intercept.test.ts
// gains 2 degraded-state (cap-blocked restart / queue-overflow) rows.
// 203 -> 204 / 1797 -> 1798 (public-transport boundary): tests/contracts/
// no-sdk-private-request-handler-access.test.ts adds 1 residual-scan test
// pinning that no src/test/script file reaches the SDK-private
// request-handler map — every protocol-level suite drives the server through
// the public in-process transport (tests/stdio/inprocess-era-serve.ts).
// 204 -> 206 / 1798 -> 1810 (dual-era acceptance-matrix backfill):
// tests/stdio/stdio-client-notification-hygiene.test.ts adds 4
// client-notification hygiene tests ($/stageUpdate suppression both eras +
// emission control + logLevel-key tolerance / notifications/message absence),
// tests/stdio/stdio-legacy-resource-matrix.test.ts adds 3 legacy resource
// matrix tests (exact fixed/template lists + nine undecorated reads);
// stdio-supervisor-era-wire.test.ts gains 1 pinned-path deep-invalid
// clientInfo -32602 test, stdio-supervisor-unknown-tool-intercept.test.ts
// gains 1 registry-HIT wire test, json-rpc-framing.test.ts and
// compat-stdio-transport.test.ts gain 1 bare-LF Content-Length pin each,
// and stdio-modern-cache-hints.test.ts gains 1 legacy per-resource
// cache-absence test.
// 206 -> 208 / 1810 -> 1820 (premigration golden promotion into the suite):
// tests/stdio/stdio-tool-contract-snapshots.test.ts adds 4 tool-contract
// snapshot tests (41-fixture set equality in both eras, legacy field
// identity with the recorded v1-only execution-key exception, modern
// inputSchema byte parity, mutation self-check), and
// tests/stdio/stdio-problemdetails-envelope-goldens.test.ts adds 6
// ProblemDetails golden tests (13-fixture replay inventory, ten ordinary
// Zod goldens + runtime-metrics deep-equal after normalization, the two
// approved omitted-arguments outcome classes, mutation self-check).
// 208 -> 209 / 1820 -> 1823 (supervisor finality and era-claim review fixes):
// tests/stdio/stdio-supervisor-finality-id-reuse.test.ts adds 2
// finality-entitlement tests (queue-limit synthesis for a reused live id must
// not settle the live validate-project entry; a cap-blocked re-initialize
// drops the orphaned preserved same-id initialize entry), and
// tests/stdio/stdio-supervisor-era-wire.test.ts gains 1 enveloped-initialize
// legacy-handshake wire test (era-claim strip before the worker).
// 209 -> 209 / 1823 -> 1824 (mixed-framing recovery): tests/stdio/json-rpc-
// framing.test.ts gains 1 test pinning that a line-delimited JSON array
// arriving after a Content-Length frame surfaces one parse error and resumes
// line framing, instead of leaving that frame and every later one buffered.
// 209 -> 209 / 1824 -> 1825 (2026-07-28 conformance and legacy parity):
// tests/stdio/stdio-supervisor-era-lifecycle.test.ts gains 1 worker-not-ready
// arrival-order test (a server/discover queued before the initial initialize
// is forwarded first once the worker is ready, while the queue suffix stays
// gated until the initialize response). The round's other repairs extend
// existing tests and add no declaration.
// 209 -> 209 / 1825 -> 1829 (frozen envelope replay): tests/stdio/stdio-tool-
// contract-snapshots.test.ts gains 4 tests that consume the per-tool
// envelopeSample fixtures the file previously ignored — sample inventory, the
// 40 invalid-input replays over the legacy transport, the get-runtime-metrics
// success replay, and an in-memory mutation self-check.
// 209 -> 210 / 1829 -> 1833 (SDK-private patching scan becomes a test):
// tests/contracts/no-sdk-private-patching.test.ts is a new 4-test file — the
// synthetic positive/negative matcher contract for the AST rules, and a
// real-source gate over src/. The scan previously existed only as a script
// that nothing in the suite ran.
// 210 -> 210 / 1833 -> 1835 (named-set regression gate): this file adds 2 tests
// for the post-suite gate — the frozen-fixture parse (1818 unique rows, exactly
// 11 legacy prefix strips, zero SKIP/TODO, timing-only decoration removal) and
// the frozen-minus-live comparison that reports removals while tolerating
// additions.
const EXPECTED_ORDINARY_TEST_DECLARATIONS = 1835;
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
