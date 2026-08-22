import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MODERN_META,
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "./inprocess-era-serve.ts";

/**
 * Per-tool contract snapshots vs the pre-migration goldens, promoted
 * from the gate script into the automated suite over the public in-process
 * transport:
 *
 *  - tests/fixtures/premigration/tool-contracts/<tool>.json freezes each v1
 *    tools/list entry with VERBATIM inputSchema bytes (wire property order).
 *  - The live legacy advertisement must be field-identical per tool, with ONE
 *    recorded scope exception: `execution` ({"taskSupport":"forbidden"}) is a
 *    v1-SDK-advertised field that SDK v2 legitimately omits, so it is
 *    excluded from the live comparison and pinned on the fixture side only.
 *  - Both-eras parity of the advertised inputSchema bytes, proven during the
 *    migration spike: a modern-era session advertises the SAME inputSchema
 *    bytes per tool and the same full wire entry (the modern list is
 *    name-ascending sorted and its result carries top-level decoration —
 *    per-entry fields only here).
 *
 *  - Each fixture ALSO freezes one `envelopeSample`: a recorded legacy
 *    tools/call exchange (40 invalid-input at contiguous ids 4..43, plus the
 *    single get-runtime-metrics success at id 2). All 41 are replayed through
 *    the SAME legacy session in recorded-id order and their replies compared
 *    field-identical after normalization. The success sample goes FIRST: it
 *    froze an empty tool_call_counts, and runtime metrics are module-global.
 *    Live replies pass through the SAME normalizer the capture used
 *    (scripts/premigration/lib.mjs normalizeCaptured) with this session's own
 *    path replacements. There is NO approved deviation for envelopes — the
 *    v1-only `execution` exception above is an ADVERTISED-side exception only.
 *
 * Fixtures are protected read-only evidence; the mutation self-check below
 * operates on in-memory clones only.
 */

// Default flag configuration: clear both feature flags so an inherited
// *_OFF=1 cannot shift this file onto a non-default registry.
delete process.env.BATCH_TOOLS_OFF;
delete process.env.VERIFY_MIXIN_TARGET_OFF;
const root = mkdtempSync(join(tmpdir(), "tool-contract-snapshots-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/premigration/tool-contracts/", import.meta.url));
const EXPECTED_FIXTURE_COUNT = 41;
/** The v1-only advertised field excluded from live comparison (recorded scope exception). */
const V1_EXECUTION = { taskSupport: "forbidden" };

type Advertised = {
  annotations: unknown;
  description: unknown;
  execution: unknown;
  inputSchema: unknown;
  name: string;
};
type EnvelopeRequest = {
  id: number;
  jsonrpc: string;
  method: string;
  params: Record<string, unknown> & { name: string };
};
/** One frozen legacy tools/call exchange recorded next to the advertisement. */
type EnvelopeSample = {
  kind: string;
  request: EnvelopeRequest;
  reply: Record<string, unknown>;
};
type ContractFixture = { file: string; advertised: Advertised; envelopeSample: EnvelopeSample };
type LiveTool = Record<string, unknown> & { name: string };

const fixtures: ContractFixture[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => {
    const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as {
      advertised: Advertised;
      envelopeSample: EnvelopeSample;
    };
    return { file, advertised: parsed.advertised, envelopeSample: parsed.envelopeSample };
  });
const fixtureByName = new Map(fixtures.map((fixture) => [fixture.advertised.name, fixture]));

// ---------------------------------------------------------------------------
// Envelope sample expectations (frozen legacy tools/call exchanges)
// ---------------------------------------------------------------------------

/** The single recorded success sample; MUST be the first tools/call replayed. */
const SUCCESS_SAMPLE_TOOL = "get-runtime-metrics";
const SUCCESS_SAMPLE_ID = 2;
/** The 40 invalid-input samples occupy contiguous recorded ids 4..43. */
const INVALID_INPUT_SAMPLE_COUNT = 40;
const INVALID_INPUT_IDS = Array.from({ length: INVALID_INPUT_SAMPLE_COUNT }, (_, index) => index + 4);
/** Deterministic pick for the envelope mutation self-check (first sorted invalid-input fixture). */
const ENVELOPE_SELF_CHECK_FILE = "analyze-mod-jar.json";

/** Normalized live reply message per fixture file, filled once during setup. */
const normalizedEnvelopeReplies = new Map<string, unknown>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a `_meta` key appears anywhere in the value (modern decoration). */
function containsMetaKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMetaKey);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, child]) => key === "_meta" || containsMetaKey(child));
}

/** Fixtures whose envelope sample is a loaded invalid-input exchange. */
function invalidInputFixtures(): ContractFixture[] {
  return fixtures.filter(
    (fixture) => isPlainObject(fixture.envelopeSample) && fixture.envelopeSample.kind === "invalid-input"
  );
}

/** Recorded wire order: the success sample (id 2) precedes every invalid-input id (4..43). */
const envelopeReplayOrder = [...fixtures].sort(
  (left, right) => left.envelopeSample.request.id - right.envelopeSample.request.id
);

// ---------------------------------------------------------------------------
// Envelope normalization (same lib the capture used, with THIS session's paths)
// ---------------------------------------------------------------------------

type Normalize = (value: unknown, options?: { pathReplacements?: [string, string][] }) => unknown;
let normalizeLiveMessage: (message: unknown) => unknown;

async function loadNormalizer(): Promise<void> {
  const lib = (await import("../../scripts/premigration/lib.mjs")) as {
    normalizeCaptured: Normalize;
    REPO_ROOT: string;
  };
  // defaultPathReplacements() is bound to the CAPTURE-time scratch root, so
  // substitute this session's own scratch root (rule N2, longest-first).
  const pathReplacements: [string, string][] = (
    [
      [root, "<SCRATCH>"],
      [lib.REPO_ROOT, "<REPO>"],
      [homedir(), "<HOME>"]
    ] as [string, string][]
  ).sort((left, right) => right[0].length - left[0].length);
  normalizeLiveMessage = (message) =>
    // JSON round-trip first: the InMemoryTransport hands over the raw result
    // object, whose undefined-valued own-properties real stdio serialization
    // drops; normalize the WIRE-equivalent message, as the capture did.
    lib.normalizeCaptured(JSON.parse(JSON.stringify(message)), { pathReplacements });
}

// ---------------------------------------------------------------------------
// Comparison helpers (self-checked by the mutation test below)
// ---------------------------------------------------------------------------

/** First structural difference between two JSON values, or null; deterministic key order. */
function firstDifference(expected: unknown, actual: unknown, path: string): string | null {
  if (Object.is(expected, actual)) return null;
  const bothObjects =
    typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null;
  if (!bothObjects) {
    return `${path}: fixture ${JSON.stringify(expected)} !== live ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return `${path}: fixture is ${Array.isArray(expected) ? "array" : "object"}, live is ${
      Array.isArray(actual) ? "array" : "object"
    }`;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}.length: fixture ${expected.length} !== live ${actual.length}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const diff = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (diff !== null) return diff;
    }
    return null;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
  for (const key of keys) {
    if (!(key in actualRecord)) return `${path}.${key}: present in fixture, missing in live value`;
    if (!(key in expectedRecord)) return `${path}.${key}: missing in fixture, present in live value`;
    const diff = firstDifference(expectedRecord[key], actualRecord[key], `${path}.${key}`);
    if (diff !== null) return diff;
  }
  return null;
}

/** First differing character between two strings, with local context, or null. */
function firstByteDifference(expected: string, actual: string, label: string): string | null {
  if (expected === actual) return null;
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) index += 1;
  const context = (value: string): string =>
    JSON.stringify(value.slice(Math.max(0, index - 20), index + 20));
  return (
    `${label}: bytes differ at char ${index} ` +
    `(fixture len ${expected.length}, live len ${actual.length}); ` +
    `fixture …${context(expected)}… vs live …${context(actual)}…`
  );
}

/**
 * Full per-tool contract comparison. Returns the first mismatch (prefixed
 * with the tool name) or null. The v1-only `execution` key is excluded from
 * the live side by design (recorded scope exception, asserted separately).
 */
function compareContract(advertised: Advertised, live: LiveTool): string | null {
  const tool = advertised.name;
  const expectedKeys = Object.keys(advertised).filter((key) => key !== "execution").sort();
  const liveKeys = Object.keys(live).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(liveKeys)) {
    return `${tool}: advertised key set differs — fixture(minus execution) [${expectedKeys.join(", ")}] vs live [${liveKeys.join(", ")}]`;
  }
  for (const field of ["name", "description"] as const) {
    if (advertised[field] !== live[field]) {
      return `${tool}: ${field}: fixture ${JSON.stringify(advertised[field])} !== live ${JSON.stringify(live[field])}`;
    }
  }
  const annotationsDiff = firstDifference(advertised.annotations, live.annotations, "annotations");
  if (annotationsDiff !== null) return `${tool}: ${annotationsDiff}`;
  // Verbatim wire-order byte comparison: the fixture recorded inputSchema in
  // wire property order and JSON round-trips preserve object key order.
  const byteDiff = firstByteDifference(
    JSON.stringify(advertised.inputSchema),
    JSON.stringify(live.inputSchema),
    "inputSchema"
  );
  if (byteDiff !== null) return `${tool}: ${byteDiff}`;
  return null;
}

function setDifference(left: string[], right: Set<string>): string[] {
  return left.filter((name) => !right.has(name));
}

// ---------------------------------------------------------------------------
// One legacy session + one modern session (runtime budget: lists only)
// ---------------------------------------------------------------------------

let legacy: InProcessSession;
let modern: InProcessSession;
let legacyTools: LiveTool[];
let modernTools: LiveTool[];

async function listTools(session: InProcessSession, params: Record<string, unknown>, id: string): Promise<LiveTool[]> {
  const frame = await session.request({ jsonrpc: "2.0", id, method: "tools/list", params });
  assert.equal(frame.error, undefined, `tools/list ${id} must succeed`);
  const tools = frame.result?.tools as LiveTool[] | undefined;
  assert.ok(Array.isArray(tools), `tools/list ${id} must carry a tools array`);
  // The InMemoryTransport hands over the raw result object, which carries
  // own-properties with `undefined` values (title/icons/execution/_meta on
  // SDK v2) that stdio JSON serialization drops. Round-trip through JSON to
  // compare the WIRE-equivalent entry, exactly what a real client receives;
  // object key order is preserved, so verbatim byte comparison is unaffected.
  return JSON.parse(JSON.stringify(tools)) as LiveTool[];
}

before(async () => {
  await loadNormalizer();
  legacy = await startInProcessSession();
  await legacyHandshake(legacy, "2025-06-18", "contract-init");
  modern = await startInProcessSession();
  legacyTools = await listTools(legacy, {}, "contract-legacy-list");
  modernTools = await listTools(modern, { _meta: MODERN_META }, "contract-modern-list");
  // Envelope replay over the SAME legacy session, in recorded-id order. The
  // recorded request is the authoritative replay input, id included. The
  // get-runtime-metrics sample (id 2) froze an empty tool_call_counts and
  // zeroed aggregates, so it MUST land before any other tools/call: runtime
  // metrics are module-global and accumulate across calls.
  for (const fixture of envelopeReplayOrder) {
    const reply = await legacy.request(fixture.envelopeSample.request);
    normalizedEnvelopeReplies.set(fixture.file, normalizeLiveMessage(reply));
  }
});

after(async () => {
  await legacy?.close();
  await modern?.close();
});

test("contract fixture inventory and live advertisement cover the same 41 tools in both eras", () => {
  assert.equal(
    fixtures.length,
    EXPECTED_FIXTURE_COUNT,
    `tests/fixtures/premigration/tool-contracts must hold exactly ${EXPECTED_FIXTURE_COUNT} fixtures`
  );
  for (const fixture of fixtures) {
    assert.equal(
      `${fixture.advertised.name}.json`,
      fixture.file,
      `fixture ${fixture.file} must be named after its advertised tool`
    );
  }
  const fixtureNames = fixtures.map((fixture) => fixture.advertised.name);
  for (const [eraLabel, tools] of [
    ["legacy", legacyTools],
    ["modern", modernTools]
  ] as const) {
    const liveNames = tools.map((tool) => tool.name);
    assert.deepEqual(
      setDifference(fixtureNames, new Set(liveNames)),
      [],
      `${eraLabel}: every contract fixture must have a live advertised tool`
    );
    assert.deepEqual(
      setDifference(liveNames, new Set(fixtureNames)),
      [],
      `${eraLabel}: every live advertised tool must have a contract fixture`
    );
    assert.equal(liveNames.length, EXPECTED_FIXTURE_COUNT, `${eraLabel}: advertised tool count`);
  }
});

test("legacy tools/list entries are field-identical to the contract fixtures (execution excluded as recorded)", () => {
  const liveByName = new Map(legacyTools.map((tool) => [tool.name, tool]));
  const mismatches: string[] = [];
  for (const { advertised } of fixtures) {
    // Fixture-side pin of the recorded scope exception: v1 advertised
    // execution={"taskSupport":"forbidden"}; SDK v2 legitimately omits it.
    const executionDiff = firstDifference(V1_EXECUTION, advertised.execution, "execution");
    assert.equal(
      executionDiff,
      null,
      `${advertised.name}: fixture execution must be the known v1 value — ${executionDiff}`
    );
    const live = liveByName.get(advertised.name);
    if (live === undefined) {
      mismatches.push(`${advertised.name}: not advertised by the live legacy session`);
      continue;
    }
    assert.ok(
      !("execution" in live),
      `${advertised.name}: SDK v2 must omit the v1-only execution field (found ${JSON.stringify(live.execution)})`
    );
    const mismatch = compareContract(advertised, live);
    if (mismatch !== null) mismatches.push(mismatch);
  }
  assert.deepEqual(mismatches, [], `legacy contract snapshot mismatches:\n${mismatches.join("\n")}`);
});

test("modern tools/list advertises byte-identical inputSchema per tool (both-eras parity)", () => {
  const mismatches: string[] = [];
  for (const tool of modernTools) {
    const fixture = fixtureByName.get(tool.name);
    if (fixture === undefined) {
      mismatches.push(`${tool.name}: modern-advertised tool has no contract fixture`);
      continue;
    }
    // FULL wire-entry comparison through the SAME comparator the legacy test
    // uses (JSON round-trip already applied by listTools; the v1-only
    // `execution` scope exception is identical): entry key-set parity,
    // name/description equality, annotations deep-equal, and verbatim
    // inputSchema byte equality.
    const mismatch = compareContract(fixture.advertised, tool);
    if (mismatch !== null) mismatches.push(mismatch);
  }
  assert.deepEqual(mismatches, [], `modern contract parity mismatches:\n${mismatches.join("\n")}`);
});

test("self-check: the comparator reports a mutated in-memory fixture copy with tool name and first differing path", (t) => {
  const original = fixtureByName.get("get-runtime-metrics");
  assert.ok(original, "self-check needs the get-runtime-metrics fixture");
  const live = legacyTools.find((tool) => tool.name === "get-runtime-metrics");
  assert.ok(live, "self-check needs the live get-runtime-metrics entry");

  // Mutation 1: flip one annotation value in a CLONE (never written to disk).
  const annotationMutant = structuredClone(original.advertised);
  (annotationMutant.annotations as Record<string, unknown>).readOnlyHint = false;
  const annotationReport = compareContract(annotationMutant, live);
  assert.ok(annotationReport !== null, "comparator must report the mutated annotations clone");
  t.diagnostic(`mutation report (annotations): ${annotationReport}`);
  assert.match(annotationReport, /^get-runtime-metrics: annotations\.readOnlyHint: /);

  // Mutation 2: flip one inputSchema byte in a CLONE.
  const schemaMutant = structuredClone(original.advertised);
  (schemaMutant.inputSchema as Record<string, unknown>).type = "objecT";
  const schemaReport = compareContract(schemaMutant, live);
  assert.ok(schemaReport !== null, "comparator must report the mutated inputSchema clone");
  t.diagnostic(`mutation report (inputSchema byte): ${schemaReport}`);
  assert.match(schemaReport, /^get-runtime-metrics: inputSchema: bytes differ at char \d+/);

  // The untouched fixture still matches — the mutants were the only difference.
  assert.equal(compareContract(original.advertised, live), null);
});

test("envelope samples freeze 41 legacy tools/call exchanges: 1 success at id 2 and 40 invalid-input at contiguous ids 4..43", () => {
  const successTools: string[] = [];
  const invalidInputIds: number[] = [];
  for (const fixture of fixtures) {
    const sample = fixture.envelopeSample;
    assert.ok(
      isPlainObject(sample),
      `${fixture.file}: fixture must expose an envelopeSample object (the loader must read it, not just advertised)`
    );
    assert.ok(isPlainObject(sample.request), `${fixture.file}: envelopeSample.request must be an object`);
    assert.ok(isPlainObject(sample.reply), `${fixture.file}: envelopeSample.reply must be an object`);
    assert.equal(sample.request.method, "tools/call", `${fixture.file}: every recorded request is a tools/call`);
    assert.equal(
      sample.request.params.name,
      fixture.advertised.name,
      `${fixture.file}: recorded params.name must equal the advertised tool name`
    );
    assert.equal(
      sample.reply.id,
      sample.request.id,
      `${fixture.file}: the recorded reply must answer its recorded request id`
    );
    assert.ok(
      !containsMetaKey(sample),
      `${fixture.file}: legacy-era samples must carry no modern _meta decoration`
    );
    if (sample.kind === "success") {
      successTools.push(fixture.advertised.name);
      assert.equal(sample.request.id, SUCCESS_SAMPLE_ID, `${fixture.file}: success sample id`);
    } else {
      assert.equal(sample.kind, "invalid-input", `${fixture.file}: unexpected envelopeSample kind`);
      invalidInputIds.push(sample.request.id);
    }
  }
  assert.deepEqual(
    successTools,
    [SUCCESS_SAMPLE_TOOL],
    "exactly one success sample must exist, and it must be get-runtime-metrics"
  );
  assert.deepEqual(
    [...invalidInputIds].sort((left, right) => left - right),
    INVALID_INPUT_IDS,
    "the 40 invalid-input samples must occupy contiguous recorded ids 4..43"
  );
});

test("all 40 invalid-input envelope samples replay field-identical over the legacy public transport", () => {
  const samples = invalidInputFixtures();
  assert.equal(
    samples.length,
    INVALID_INPUT_SAMPLE_COUNT,
    `exactly ${INVALID_INPUT_SAMPLE_COUNT} invalid-input envelope samples must be loaded and replayed`
  );
  const mismatches: string[] = [];
  for (const fixture of samples) {
    const normalized = normalizedEnvelopeReplies.get(fixture.file);
    if (normalized === undefined) {
      mismatches.push(`${fixture.file}: envelope sample was never replayed`);
      continue;
    }
    const diff = firstDifference(fixture.envelopeSample.reply, normalized, "reply");
    if (diff !== null) mismatches.push(`${fixture.file}: ${diff}`);
  }
  assert.deepEqual(
    mismatches,
    [],
    `invalid-input envelope replay mismatches (${mismatches.length}/${samples.length}):\n${mismatches.join("\n")}`
  );
});

test("the get-runtime-metrics success envelope sample replays field-identical as the session's first tools/call", () => {
  const fixture = fixtureByName.get(SUCCESS_SAMPLE_TOOL);
  assert.ok(fixture, `the ${SUCCESS_SAMPLE_TOOL} contract fixture must exist`);
  assert.ok(
    isPlainObject(fixture.envelopeSample),
    `${SUCCESS_SAMPLE_TOOL}: fixture must expose an envelopeSample object`
  );
  assert.equal(fixture.envelopeSample.kind, "success", `${SUCCESS_SAMPLE_TOOL}: sample kind`);
  const normalized = normalizedEnvelopeReplies.get(fixture.file);
  assert.ok(
    normalized !== undefined,
    `${fixture.file}: the success sample must have been replayed first during setup`
  );
  // Its counters (tool_call_counts {}, zeroed aggregates) were frozen before
  // any other tool call, so replay order is part of the contract.
  const diff = firstDifference(fixture.envelopeSample.reply, normalized, "reply");
  assert.equal(diff, null, `${SUCCESS_SAMPLE_TOOL} envelope sample mismatch — ${diff}`);
});

test("self-check: the envelope comparator reports a mutated in-memory sample clone with its first differing path", (t) => {
  const fixture = fixtures.find((candidate) => candidate.file === ENVELOPE_SELF_CHECK_FILE);
  assert.ok(fixture, `self-check needs the ${ENVELOPE_SELF_CHECK_FILE} fixture`);
  assert.ok(
    isPlainObject(fixture.envelopeSample),
    `${ENVELOPE_SELF_CHECK_FILE}: fixture must expose an envelopeSample object`
  );
  const normalized = normalizedEnvelopeReplies.get(fixture.file);
  assert.ok(normalized !== undefined, `${fixture.file}: envelope sample must have been replayed`);

  // Perturb one nested value in a CLONE (never written to disk).
  const mutant = structuredClone(fixture.envelopeSample.reply) as {
    result: { structuredContent: { error: { detail: string } } };
  };
  const mutantError = mutant.result.structuredContent.error;
  mutantError.detail = `${mutantError.detail} (mutated)`;
  const report = firstDifference(mutant, normalized, "reply");
  assert.ok(report !== null, "the comparator must report the mutated envelope clone");
  t.diagnostic(`mutation report (envelope reply detail): ${report}`);
  assert.match(report, /^reply\.result\.structuredContent\.error\.detail: /);

  // The untouched sample still matches — the mutation was the only difference.
  assert.equal(firstDifference(fixture.envelopeSample.reply, normalized, "reply"), null);

  // The fixture on disk is byte-untouched: the clone above never escaped memory.
  const onDisk = (
    JSON.parse(readFileSync(join(FIXTURE_DIR, fixture.file), "utf8")) as { envelopeSample: EnvelopeSample }
  ).envelopeSample;
  assert.equal(
    firstDifference(onDisk, fixture.envelopeSample, "onDisk"),
    null,
    `${fixture.file}: the protected fixture must be unchanged on disk after the mutation self-check`
  );
});
