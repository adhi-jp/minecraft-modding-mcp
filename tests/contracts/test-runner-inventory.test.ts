import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";

const EXPECTED_ORDINARY_TEST_FILES = 221;
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
// 210 -> 211 / 1835 -> 1850 (protocol-layer repairs): 15 new tests across four
// defects. tests/stdio/stdio-framing-fatal-wire.test.ts is a new 2-test file
// pinning the framing invariant over the real wire (an unarrivable declared
// body terminates the session; a header with no usable length still
// recovers). The other 12 extend existing suites: 4 framing-reader arms
// (unarrived oversized body, duplicate Content-Length, over-declared length,
// schema-invalid-but-well-framed body), the subscriptions/listen
// defense-in-depth arm, the cancellation dispatch-barrier release, the
// malformed-initialize rejection (white-box + 2 wire), the per-request
// protocolVersion validation (1 white-box + 2 wire) and the bounded-map proof
// for request/cancel pairs with fresh ids.
// 212 -> 213 / 1862 -> 1871 (named-set gate: MISSING vs UNPROVEN): the post-suite gate
// used to fail on ANY TAP SKIP/TODO directive, so a host without Java, without working
// child-process stdio pipes, or on a non-POSIX platform failed `npm test` on a green
// suite with an opaque skip count. tests/contracts/named-set-gate.test.ts is a new
// 9-test file pinning the split (a vanished frozen name is MISSING and always fatal; a
// skipped one is UNPROVEN, fatal by default, downgradable by
// MCP_ALLOW_UNPROVEN_NAMED_TESTS), the capability attribution carried in the skip
// directive, the un-attributed-directive rule, and a real forced-capability-off run
// through the node test runner. The 13 guarded files keep their declarations: only the
// body of each guard changed, never a test name.
// 213 -> 214 / 1871 -> 1875 (manual-smoke suite watchdog):
// tests/stdio/manual-smoke-suite-watchdog.test.ts adds 4 tests for the helper that
// replaced the manual stdio smoke's fixed 60 s aggregate cap over
// tests/stdio/stdio-supervisor-timeout.test.ts — a suite whose own declared per-test
// budgets already sum past that cap, so a fully passing run was being killed. The
// watchdog polices IDLENESS with a budget derived from the suite's longest declared
// per-test timeout: budget derivation, slow-but-progressing, wedged, and non-zero exit.
// 214 -> 217 / 1875 -> 1903 (reference-project defect repair round): three new files —
// tests/source-service/artifact-mapping-inheritance.test.ts (4 tests: an
// artifact-targeted call inherits the artifact's resolved mapping, so
// get-class-source and get-class-members stop disagreeing on the omitted-mapping
// default), tests/source-service/access-transformer-moddev.test.ts (5 tests:
// ModDevGradle loader-version artifact discovery and the no-self-contradicting-hint
// rule) and tests/source-service/runtime-provenance-truthfulness.test.ts (5 tests:
// served version/loader provenance and the refusal to certify across loaders).
// Three existing files grow: artifact-file-read-through +8 (root-level and META-INF
// jar entries), version-diff-service +4 (class diff namespace and packageFilter
// agreement) and classsource-findclass +2 (nested-type FQN/ranking, partial-coverage
// recovery call).
// 217 -> 218 / 1903 -> 1910 (stdio worker process-leak round): the worker held an
// unconditional keep-alive interval whose only clearInterval ran on process "exit", so a
// worker whose supervisor died never drained its event loop — one full `npm test` run
// ended with 20 resident orphans. tests/contracts/no-direct-sigkill.test.ts is a new
// 2-test guard (the tests/stdio force-kill scan with its non-vacuity floor, plus the
// detector's own positives/hatch/look-alike cases) keeping teardowns on the shared
// stopSupervisor() ladder. Three existing files grow: stdio-worker-protocol +2 (the
// worker exits on stdin EOF, and on an EOF that arrived during startup),
// stdio-supervisor-process-tree +1 (parent-liveness backstop on a never-EOF stdin) and
// stdio-supervisor-timeout +2 (SIGHUP shutdown, and an uncaught supervisor exception
// that still reaps the worker).
// 218 -> 218 / 1910 -> 1914 (wrong-artifact answers round): no new files. Two existing
// files grow: tests/source-service/partial-source-fallback.test.ts +1 (ERR_CLASS_NOT_FOUND
// keeps the caller's artifactId, didYouMean and suggestedCall when the internal binary
// fallback succeeded but still missed the class) and
// tests/entry-tools/workflows/inspect-workspace-focus.test.ts +3 (inspect-minecraft
// forwards target.kind="workspace" when subject mapping/scope are omitted, lets
// ERR_WORKSPACE_VERSION_UNRESOLVED propagate instead of degrading to ERR_INVALID_INPUT,
// and keeps the WORKSPACE_TARGET_OFF=1 kill switch on the previous routing).
// 218 -> 218 / 1914 -> 1918 (responses that misdescribe themselves round): no new files.
// Two existing files grow: tests/nbt/nbt-typed-json.test.ts +2 (the typed-document
// rejection carries fieldErrors keyed by the offending JSON pointer, and names the
// typedJson argument when the whole document is wrong) and
// tests/nbt/nbt-pipeline.test.ts +2 (json-to-nbt and nbt-apply-json-patch attach an
// nbt-to-json recovery example without setting the primary-drop marker). The
// resolve-method-mapping-exact truthfulness case is a t.test subtest inside
// tests/mapping/mapping-service-method-exact-api-matrix.test.ts, which this counter
// does not include.
// 218 -> 220 / 1918 -> 1924 (supervisor and worker lifecycle repair round): two new
// files. tests/stdio/stdio-supervisor-ready-exit-storm.test.ts adds 2 tests for the
// restart backoff after a worker that signals ready and then stands down cleanly in the
// same breath — the shape a host that closes a spawned child's stdin immediately
// produces, which adoption's backoff reset otherwise answered with an unbounded 100 ms
// respawn loop. tests/stdio/stdio-child-lifecycle-ladder.test.ts adds 3 tests driving the
// shared teardown helper's SIGTERM and force-kill rungs, which every real call site
// (all supervisors, all exiting on stdin EOF) had left unexecuted. One existing file
// grows: stdio-supervisor-timeout.test.ts +1 (a fatal supervisor error ends the process
// even while a referenced handle holds the event loop, since registering fatal handlers
// suppresses node's default abort). The strengthened parent-liveness positive control
// and the worker-descendant reaping assertions extend existing tests and add no
// declaration.
// 220 -> 220 / 1924 -> 1931 (accepted-review repair round): no new files. Four existing
// files grow: tests/source-service/partial-source-fallback.test.ts +3 (near-miss
// candidates unioned across the requested and fallback artifacts, the attribution field
// that marks the fallback's entries, and the allowDecompile forwarding that was
// previously invisible because the only test on that path stubbed the resolver without
// inspecting its argument), tests/nbt/nbt-pipeline.test.ts +2 (the five default
// nextAction strings, none of which any assertion reached, and a stage that supplies its
// own nextAction keeping it), tests/contracts/no-direct-sigkill.test.ts +1 (the
// broadened detector's positive/negative matrix for the bare call, the numeric signal,
// a signal held in a const, a call split across lines and the shell force-kill) and
// tests/mod/nested-jar-redirect.test.ts +1 (a failed lookup after a nested-jar redirect
// reports one artifact's identity, namespace and quality, not two). The owner-strict
// resolver cases are t.test subtests inside
// tests/mapping/mapping-service-method-exact-api-matrix.test.ts and the compact-projection
// case is a row in an existing table loop, neither of which this counter includes.
// 220 -> 220 / 1931 -> 1935 (release-gate reconciliation): no new files. One existing
// file grows: tests/package/publish-workflow.test.ts +4. The npm release path's
// prerelease protection lived entirely in shell inside .github/workflows/publish.yml
// with nothing in the repository asserting any of it, so a future edit could revert it
// silently while every property that file already pinned stayed green. The four new
// tests lift the `Resolve the npm dist-tag`, `Verify the pushed tag matches the package
// version` and `Reject a bypass of the frozen named-test set gate` steps out of the real
// workflow by step name and EXECUTE them under `bash -e` rather than restating their
// logic: a prerelease resolving to `rc` and two stable versions (one already published)
// to `latest`, the tag/version guard proven in both directions, and the escape hatch
// rejected at any value — including empty and `0` — while an unset variable passes. A
// fourth pins the rejection step ahead of `pnpm test`, since a bypass caught after the
// suite has run catches nothing.
// 220 -> 221 / 1935 -> 1957 (release CHANGELOG gate): one new file,
// tests/contracts/changelog-release-section-gate.test.ts, adds 22 tests for
// scripts/changelog-release-gate.mjs. CHANGELOG.md is an end-user document whose
// work-log detail is only permitted under `## [Unreleased]`, and the release cut that
// must rewrite it had nothing enforcing it: a section promoted verbatim shipped once in
// 4.1.0 and again in 7.0.0-rc.0. The gate is mechanical, so the tests pin what it fires
// on (every forbidden marker, the length ceiling from both sides), what it must not
// touch (`## [Unreleased]`, user-facing docs/README/package.json paths), the structural
// failures (missing, undated and empty sections) and the report an author reads. One
// test runs the live CHANGELOG.md section for the current package version, so the gate
// and the file it guards cannot drift apart. Six of the thirteen came from an external
// review that reproduced real bypasses of the first implementation: a violation parked on
// a continuation line or spread across nested bullets, a fenced sample heading truncating
// the section, CRLF input the extractor could not read while the version lister could, and
// a repeated version heading hiding everything under it. Those tests pin the closed
// bypasses; the CLI and workflow-wiring tests pin that the gate is actually reachable,
// since a correct gate nobody runs enforces nothing. A second review round added four
// more after finding that the first fix had closed only the reported shape of each
// escape: `-` was recognized but `*`, `+` and ordered markers were not, an entry still
// ended at the first blank line so a later paragraph of the same item was dropped, the
// markers were case-sensitive, and a four-space run or a backtick-bearing info string was
// accepted as a code fence. Text belonging to no entry is now a finding rather than
// silently skipped, which is what turned those escapes from invisible into failures.
// A third round added five more, again because the previous fix had generalized only as far
// as the reported case: nesting was decided by a fixed column, which both split this
// repository's two-space child bullets into separate entries and rejected a legal
// one-to-three-space top-level item; an unclosed fence inside an item swallowed every later
// release section, so the gate saw a clean file; an item with no visible text counted as an
// entry; markup that renders away (code spans, backslash escapes, character references,
// HTML comments) split a marker in the source while the reader still saw the forbidden
// token; and link reference definitions and HTML comments were reported as visible text.
// 221 -> 221 / 1957 -> 1960 (coordinate resolve defect round): no new files.
// tests/source-service/source-resolver.test.ts adds 3 tests — a Gradle-cache
// module with a binary jar and no sources jar must keep its binaryJarPath, and a
// repeated coordinate resolve must reuse the cached source/binary jar instead of
// re-downloading it (which churned the mtime-derived artifactId).
// 221 -> 221 / 1960 -> 1966 (error-envelope honesty round): no new files. Four
// existing files grow. tests/mod/nested-jar-redirect.test.ts +2: the shell-jar
// nested-jar inventory reaches the published envelope (it was populated in
// error.details and then dropped, because ProblemDetails had no field for it and
// the context allowlist is primitive-only), and a shell-jar miss no longer
// advises remapping a jar that holds no classes at all.
// tests/source-service/classsource-findclass.test.ts +2: the same obfuscation
// advice is withheld from a native dependency miss (get-class-source had no
// guard where find-class already had one), and a members lookup on an artifact
// the tool resolved without a binary jar publishes issueOrigin "tool_issue"
// instead of blaming the caller's input.
// tests/source-service/class-source-recovery.test.ts +1: the hint that ends in
// mapping="mojang" is suppressed when the caller already sent a mapping — the
// generic dropSatisfiedParameterAsks backstop cannot reach it, since it matches
// an imperative "Provide/Pass mapping" and the sentence is concatenated into a
// single published hint.
// tests/entry-tools/workflows/validate-project.test.ts +1: task="mixin" with no
// version stops filling the hole with a hardcoded "1.21.10" — a suggestedCall that
// RUNS and validates the mixin against a Minecraft version the project does not
// use. The two roles are split instead of dropping the payload: suggestedCall
// becomes the argument-free list-versions step (the same recovery the sibling
// "version required but none resolved" site already uses), and the task="mixin"
// retry shape travels as a <your-mc-version> exampleCalls template.
const EXPECTED_ORDINARY_TEST_DECLARATIONS = 1966;
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
