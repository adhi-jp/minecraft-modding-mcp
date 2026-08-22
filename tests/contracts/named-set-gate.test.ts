import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import {
  RUNTIME_CAPABILITY_IDS,
  FORCE_MISSING_CAPABILITIES_ENV,
  formatMissingCapabilityReason,
  type RuntimeCapabilityId
} from "../helpers/runtime-capabilities.ts";

/**
 * Contract for the post-suite named-test set gate.
 *
 * The gate separates two failures the old one conflated:
 *  - MISSING: a frozen name is gone. Coverage regression. Always fatal.
 *  - UNPROVEN: a frozen name exists but was skipped, so it did not execute. An
 *    environment capability gap. Fatal by default, downgradable to a warning by
 *    MCP_ALLOW_UNPROVEN_NAMED_TESTS.
 *
 * Neither UNPROVEN branch is reachable on a host where every capability is present, so
 * these tests drive the helpers with synthetic TAP, and one of them forces a real
 * capability off (MCP_TEST_FORCE_MISSING_CAPABILITIES) and runs a REAL guarded test file
 * through a REAL node test runner to prove the whole chain end to end.
 */

const execFileAsync = promisify(execFile);

type UnprovenRow = {
  key: string;
  directive: string;
  kind: string | null;
  capability: string | null;
  reason: string;
};

type CollectorResult = {
  provenKeys: Set<string>;
  unproven: UnprovenRow[];
  pointCount: number;
  unterminatedYaml: boolean;
};

type NamedSetComparison = {
  missing: string[];
  missingCount: number;
  unprovenFrozen: UnprovenRow[];
  unprovenFrozenCount: number;
  unprovenAdded: UnprovenRow[];
  unprovenAddedCount: number;
  provenFrozenCount: number;
  added: string[];
  addedCount: number;
  ok: boolean;
};

type InventoryModule = {
  classifyDirective: (directive: string) => {
    kind: string | null;
    capability: string | null;
    reason: string;
  };
  createTapPointCollector: () => {
    write: (chunk: string) => void;
    end: () => CollectorResult;
  };
  compareNamedTestSets: (
    frozen: Iterable<string>,
    proven: Iterable<string>,
    unproven?: Iterable<UnprovenRow | string>
  ) => NamedSetComparison;
};

type GateVerdict = {
  ok: boolean;
  status: "ok" | "unproven-accepted" | "failed";
  report: string[];
};

type GateModule = {
  ALLOW_UNPROVEN_ENV: string;
  readAllowUnprovenSetting: (env: NodeJS.ProcessEnv) => {
    enabled: boolean;
    raw: string | undefined;
    invalidValue: string | null;
  };
  evaluateNamedSetGate: (input: {
    frozen: { rowCount: number };
    live: { pointCount: number; unterminatedYaml: boolean };
    comparison: NamedSetComparison;
    env?: NodeJS.ProcessEnv;
    context?: { frozenPath?: string; tapPath?: string };
  }) => GateVerdict;
};

const loadInventory = (): Promise<InventoryModule> =>
  import("../../scripts/test-name-inventory.mjs") as Promise<InventoryModule>;
const loadGate = (): Promise<GateModule> =>
  import("../../scripts/named-set-gate.mjs") as Promise<GateModule>;

const PROVEN_ROW = "0\tok\talpha stays proven";
const SKIPPED_ROW = "0\tok\tbeta needs a capability";
const DELETED_ROW = "0\tok\tgamma was deleted";

function skipDirective(id: RuntimeCapabilityId): string {
  return `# SKIP ${formatMissingCapabilityReason(id)}`;
}

function unprovenRow(key: string, id: RuntimeCapabilityId): UnprovenRow {
  return {
    key,
    directive: skipDirective(id),
    kind: "SKIP",
    capability: id,
    reason: formatMissingCapabilityReason(id).split(": ").slice(1).join(": ")
  };
}

const LIVE_STUB = { pointCount: 3, unterminatedYaml: false };

async function evaluate(
  frozenRows: string[],
  provenRows: string[],
  unproven: UnprovenRow[],
  env: NodeJS.ProcessEnv
): Promise<GateVerdict> {
  const [{ compareNamedTestSets }, { evaluateNamedSetGate }] = await Promise.all([
    loadInventory(),
    loadGate()
  ]);
  const comparison = compareNamedTestSets(frozenRows, provenRows, unproven);
  return evaluateNamedSetGate({
    frozen: { rowCount: frozenRows.length },
    live: LIVE_STUB,
    comparison,
    env
  });
}

test("every declared runtime capability renders a directive the gate can attribute", async () => {
  const { classifyDirective } = await loadInventory();

  assert.ok(RUNTIME_CAPABILITY_IDS.length >= 4, "the guarded suites declare at least four capabilities");
  for (const id of RUNTIME_CAPABILITY_IDS) {
    const classified = classifyDirective(skipDirective(id));
    assert.equal(classified.kind, "SKIP", `${id} must render as a SKIP directive`);
    assert.equal(classified.capability, id, `${id} must be recoverable from its own directive`);
    assert.notEqual(classified.reason, "", `${id} must carry a human explanation`);
    assert.ok(
      !classified.reason.includes("["),
      `${id} reason must be the explanation only, with the id already parsed off`
    );
  }

  // Prose skips and TODOs stay un-attributed on purpose: the escape hatch must not cover
  // a directive that declares no capability.
  assert.deepEqual(classifyDirective("# SKIP flaky on tuesdays"), {
    kind: "SKIP",
    capability: null,
    reason: "flaky on tuesdays"
  });
  assert.deepEqual(classifyDirective("# TODO not written yet"), {
    kind: "TODO",
    capability: null,
    reason: "not written yet"
  });
});

test("the TAP collector separates executed points from skipped points", async () => {
  const { createTapPointCollector } = await loadInventory();
  const collector = createTapPointCollector();

  collector.write("TAP version 13\n");
  collector.write("# Subtest: alpha stays proven\nok 1 - alpha stays proven # time=3ms\n");
  collector.write("  ---\n  duration_ms: 1\n  ...\n");
  collector.write(`ok 2 - beta needs a capability ${skipDirective("java-runtime")}\n`);
  collector.write("    ok 1 - nested stays proven\n1..2\n");
  const live = collector.end();

  assert.equal(live.pointCount, 3);
  assert.equal(live.unterminatedYaml, false);
  assert.deepEqual(
    [...live.provenKeys].sort(),
    [PROVEN_ROW, "1\tok\tnested stays proven"],
    "only executed points are proof"
  );
  assert.equal(live.unproven.length, 1);
  // The key is the NAME alone: a skipped row must line up with its frozen counterpart
  // rather than reading as one deletion plus one unrelated addition.
  assert.equal(live.unproven[0]?.key, SKIPPED_ROW);
  assert.equal(live.unproven[0]?.capability, "java-runtime");
});

test("MISSING frozen rows fail the gate whether or not the escape hatch is set", async () => {
  const { ALLOW_UNPROVEN_ENV } = await loadGate();

  for (const env of [{}, { [ALLOW_UNPROVEN_ENV]: "1" }]) {
    const verdict = await evaluate([PROVEN_ROW, DELETED_ROW], [PROVEN_ROW], [], env);
    const report = verdict.report.join("\n");

    assert.equal(verdict.ok, false, `a deleted frozen row must fail with env ${JSON.stringify(env)}`);
    assert.equal(verdict.status, "failed");
    assert.match(report, /named-test set gate: FAILED/);
    assert.match(report, /MISSING — 1 frozen named test row\(s\) absent from this run/);
    assert.match(report, /- depth=0 ok gamma was deleted/);
  }
});

test("UNPROVEN frozen rows fail by default and name the capability that held them back", async () => {
  const verdict = await evaluate(
    [PROVEN_ROW, SKIPPED_ROW],
    [PROVEN_ROW],
    [unprovenRow(SKIPPED_ROW, "native-stdio-pipes")],
    {}
  );
  const report = verdict.report.join("\n");

  assert.equal(verdict.ok, false, "fail closed: an unproven frozen contract is not a pass");
  assert.equal(verdict.status, "failed");
  assert.match(report, /UNPROVEN — 1 test point\(s\) exist but did not execute here \(1 of them frozen\)/);
  assert.match(report, /capability \[native-stdio-pipes\] — native child-process stdio pipes close immediately/);
  assert.match(report, /- depth=0 ok beta needs a capability/, "the gate must NAME the unproven rows");
  assert.match(report, /Set MCP_ALLOW_UNPROVEN_NAMED_TESTS=1 to downgrade UNPROVEN/);
  assert.doesNotMatch(report, /MISSING —/, "a skipped row is not a coverage regression");
});

test("the escape hatch downgrades UNPROVEN to a warning without hiding the rows", async () => {
  const { ALLOW_UNPROVEN_ENV } = await loadGate();
  const verdict = await evaluate(
    [PROVEN_ROW, SKIPPED_ROW],
    [PROVEN_ROW],
    [unprovenRow(SKIPPED_ROW, "native-stdio-pipes")],
    { [ALLOW_UNPROVEN_ENV]: "TRUE" }
  );
  const report = verdict.report.join("\n");

  assert.equal(verdict.ok, true, "the hatch lets a capability-limited machine pass");
  assert.equal(verdict.status, "unproven-accepted");
  assert.match(report, /named-test set gate: WARNING — MCP_ALLOW_UNPROVEN_NAMED_TESTS is set/);
  assert.match(report, /capability \[native-stdio-pipes\]/, "the reason stays printed");
  assert.match(report, /- depth=0 ok beta needs a capability/, "the rows stay printed");
  assert.match(
    report,
    /PASSED WITH UNPROVEN ROWS — this run did NOT prove the full frozen set/,
    "the summary must be unmistakable about what was not proven"
  );
  assert.match(report, /1 of 2 frozen named rows proven/);

  const allProven = await evaluate([PROVEN_ROW], [PROVEN_ROW], [], {
    [ALLOW_UNPROVEN_ENV]: "1"
  });
  assert.equal(allProven.status, "ok", "the hatch changes nothing when nothing was skipped");
  assert.match(allProven.report.join("\n"), /all 1 frozen named rows present and proven/);
});

test("an unattributed SKIP or TODO always fails, escape hatch or not", async () => {
  const { ALLOW_UNPROVEN_ENV } = await loadGate();
  const stray: UnprovenRow = {
    key: SKIPPED_ROW,
    directive: "# TODO finish this",
    kind: "TODO",
    capability: null,
    reason: "finish this"
  };

  for (const env of [{}, { [ALLOW_UNPROVEN_ENV]: "1" }]) {
    const verdict = await evaluate([PROVEN_ROW, SKIPPED_ROW], [PROVEN_ROW], [stray], env);
    const report = verdict.report.join("\n");

    assert.equal(verdict.ok, false, `an un-attributed directive must fail with env ${JSON.stringify(env)}`);
    assert.match(report, /UNATTRIBUTED DIRECTIVE — 1 test point\(s\)/);
    assert.match(report, /no declared capability — TODO finish this/);
    assert.match(report, /skipWithoutCapability/, "the report must say how to declare a capability");
  }
});

test("the escape hatch only activates for recognized values", async () => {
  const { ALLOW_UNPROVEN_ENV, readAllowUnprovenSetting } = await loadGate();

  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(
      readAllowUnprovenSetting({ [ALLOW_UNPROVEN_ENV]: value }).enabled,
      true,
      `${JSON.stringify(value)} must enable the hatch`
    );
  }
  for (const value of ["", "0", "false", "no", "off"]) {
    const setting = readAllowUnprovenSetting({ [ALLOW_UNPROVEN_ENV]: value });
    assert.equal(setting.enabled, false, `${JSON.stringify(value)} must leave the hatch off`);
    assert.equal(setting.invalidValue, null);
  }
  assert.deepEqual(readAllowUnprovenSetting({}), {
    enabled: false,
    raw: undefined,
    invalidValue: null
  });

  // An unrecognized value must not be guessed at in either direction.
  const bogus = readAllowUnprovenSetting({ [ALLOW_UNPROVEN_ENV]: "maybe" });
  assert.equal(bogus.enabled, false, "fail closed on an unrecognized value");
  assert.equal(bogus.invalidValue, "maybe");

  const verdict = await evaluate(
    [PROVEN_ROW, SKIPPED_ROW],
    [PROVEN_ROW],
    [unprovenRow(SKIPPED_ROW, "java-runtime")],
    { [ALLOW_UNPROVEN_ENV]: "maybe" }
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.report.join("\n"), /ignoring MCP_ALLOW_UNPROVEN_NAMED_TESTS="maybe"/);
});

test("a forced-missing capability produces an attributable UNPROVEN row over the real test runner", async () => {
  // End-to-end over the real chain: a real guarded test file, a real node test runner,
  // real TAP. Every capability is present on a healthy dev box, so the guard is forced
  // off to reach the branch at all.
  const guardedFile = "tests/stdio/stdio-supervisor-synthetic-drift.test.ts";
  const childEnv = { ...process.env, [FORCE_MISSING_CAPABILITIES_ENV]: "native-stdio-pipes" };
  // Inherited from OUR test runner: it would switch the nested runner off TAP and onto
  // node's internal child-reporter protocol, leaving stdout empty.
  delete childEnv.NODE_TEST_CONTEXT;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", guardedFile],
    { cwd: process.cwd(), env: childEnv, timeout: 60_000 }
  );

  const [{ createTapPointCollector, compareNamedTestSets }, { evaluateNamedSetGate, ALLOW_UNPROVEN_ENV }] =
    await Promise.all([loadInventory(), loadGate()]);
  const collector = createTapPointCollector();
  collector.write(stdout);
  const live = collector.end();

  assert.equal(live.provenKeys.size, 0, "the forced guard must leave nothing proven in that file");
  assert.equal(live.unproven.length, 1, "the guarded test must appear as exactly one unproven point");
  const row = live.unproven[0];
  assert.equal(row?.capability, "native-stdio-pipes", "the real guard must declare its capability");
  assert.match(row?.reason ?? "", /native child-process stdio pipes/);

  // The frozen counterpart of that live row must land in UNPROVEN, never in MISSING.
  const frozenRows = [row?.key ?? ""];
  const comparison = compareNamedTestSets(frozenRows, live.provenKeys, live.unproven);
  assert.deepEqual(comparison.missing, [], "a skipped frozen row is not a deletion");
  assert.equal(comparison.unprovenFrozenCount, 1);

  const closed = evaluateNamedSetGate({
    frozen: { rowCount: frozenRows.length },
    live,
    comparison,
    env: {}
  });
  assert.equal(closed.ok, false, "UNPROVEN fails by default on the real path too");
  assert.match(closed.report.join("\n"), /capability \[native-stdio-pipes\]/);

  const open = evaluateNamedSetGate({
    frozen: { rowCount: frozenRows.length },
    live,
    comparison,
    env: { [ALLOW_UNPROVEN_ENV]: "1" }
  });
  assert.equal(open.ok, true, "the hatch accepts the real capability gap");
  assert.equal(open.status, "unproven-accepted");
});

test("no test file skips outside the shared capability helper", async () => {
  // The gate can only attribute a skip that declared a capability, so a raw t.skip()
  // anywhere in the suite would reintroduce the opaque "N tests were skipped" report.
  const allowed = new Set([
    "tests/helpers/runtime-capabilities.ts",
    "tests/contracts/named-set-gate.test.ts"
  ]);
  const rawSkip = new RegExp(`\\b[a-zA-Z_$][\\w$]*\\${"."}skip\\s*\\(`);

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...(await walk(path)));
      } else if (entry.isFile() && path.endsWith(".ts")) {
        files.push(path);
      }
    }
    return files;
  }

  const offenders: string[] = [];
  for (const path of await walk("tests")) {
    if (allowed.has(path)) {
      continue;
    }
    const source = await readFile(path, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (rawSkip.test(line)) {
        offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "route environment guards through skipWithoutCapability() in tests/helpers/runtime-capabilities.ts"
  );
});
