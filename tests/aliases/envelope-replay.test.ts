import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { createPremigrationNormalizer, firstDifference } from "../helpers/premigration-compare.ts";
import { ALIAS_TOOL_NAMES } from "../../src/tools/inventory.ts";
import { legacyHandshake, startInProcessSession, type InProcessSession } from "../stdio/inprocess-era-serve.ts";
import { assertDeprecationCarried, stripDeprecation, type RemovedDeprecation } from "./deprecation.ts";

/**
 * Alias fidelity: the premigration envelope samples replayed through the
 * deprecated aliases over the public in-process transport.
 *
 *  - Each tests/fixtures/premigration/tool-contracts/<tool>.json freezes one
 *    `envelopeSample`: a recorded legacy tools/call exchange (40
 *    invalid-input at contiguous ids 4..43, plus the single
 *    get-runtime-metrics success at id 2). All 41 are replayed through the
 *    SAME legacy session in recorded-id order and their replies compared
 *    field-identical after normalization. The success sample goes FIRST: it
 *    froze an empty tool_call_counts, and runtime metrics are module-global.
 *  - Live replies pass through the SAME normalizer the capture used
 *    (scripts/premigration/lib.mjs normalizeCaptured) with this session's own
 *    path replacements, plus one rule for aliases: `meta.deprecated` is
 *    removed from the structured reply and from its JSON text. Every reply
 *    must carry that block in both representations, naming the catalog tools
 *    that replace the alias and the removal release; no other deviation is
 *    allowed.
 *
 * The fixtures' `advertised` halves are a historical record of the 8.x
 * listing entries; the aliases advertise minimal entries, which
 * tests/aliases/alias-listing.test.ts checks.
 *
 * Fixtures are protected read-only evidence; the mutation self-check below
 * operates on in-memory clones only.
 */

const root = mkdtempSync(join(tmpdir(), "alias-envelope-replay-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/premigration/tool-contracts/", import.meta.url));
const EXPECTED_FIXTURE_COUNT = 41;

type EnvelopeRequest = {
  id: number;
  jsonrpc: string;
  method: string;
  params: Record<string, unknown> & { name: string; arguments?: unknown };
};
/** One frozen legacy tools/call exchange recorded next to the advertisement. */
type EnvelopeSample = {
  kind: string;
  request: EnvelopeRequest;
  reply: Record<string, unknown>;
};
type ContractFixture = { file: string; name: string; envelopeSample: EnvelopeSample };

const fixtures: ContractFixture[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => {
    const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as {
      advertised: { name: string };
      envelopeSample: EnvelopeSample;
    };
    return { file, name: parsed.advertised.name, envelopeSample: parsed.envelopeSample };
  });
const fixtureByName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));

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
/** The `meta.deprecated` blocks the alias rule removed, per fixture file. */
const removedDeprecations = new Map<string, RemovedDeprecation>();

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

let normalizePremigration: (message: unknown) => unknown;

/**
 * The capture normalization plus the alias rule: `meta.deprecated` is
 * recorded for its own assertions and removed before the golden comparison.
 */
function normalizeAliasReply(file: string, reply: unknown): unknown {
  const { message, removed } = stripDeprecation(normalizePremigration(reply));
  removedDeprecations.set(file, removed);
  return message;
}

// ---------------------------------------------------------------------------
// One legacy session; replays happen once, in recorded-id order
// ---------------------------------------------------------------------------

let legacy: InProcessSession;

before(async () => {
  normalizePremigration = await createPremigrationNormalizer(root);
  legacy = await startInProcessSession();
  await legacyHandshake(legacy, "2025-06-18", "contract-init");
  // The recorded request is the authoritative replay input, id included. The
  // get-runtime-metrics sample (id 2) froze an empty tool_call_counts and
  // zeroed aggregates, so it MUST land before any other tools/call: runtime
  // metrics are module-global and accumulate across calls.
  for (const fixture of envelopeReplayOrder) {
    const reply = await legacy.request(fixture.envelopeSample.request);
    normalizedEnvelopeReplies.set(fixture.file, normalizeAliasReply(fixture.file, reply));
  }
});

after(async () => {
  await legacy?.close();
});

test("the contract fixtures cover exactly the 8.x tools of the tool inventory", () => {
  assert.equal(
    fixtures.length,
    EXPECTED_FIXTURE_COUNT,
    `tests/fixtures/premigration/tool-contracts must hold exactly ${EXPECTED_FIXTURE_COUNT} fixtures`
  );
  for (const fixture of fixtures) {
    assert.equal(`${fixture.name}.json`, fixture.file, `fixture ${fixture.file} must be named after its tool`);
  }
  assert.deepEqual(
    fixtures.map((fixture) => fixture.name).sort(),
    [...ALIAS_TOOL_NAMES].sort(),
    "the contract fixtures cover exactly the 8.x tools of the tool inventory"
  );
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
      fixture.name,
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
      successTools.push(fixture.name);
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

test("all 40 invalid-input envelope samples replay field-identical through the aliases over the legacy public transport", () => {
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

test("every replayed alias reply carries meta.deprecated naming its catalog replacements in both representations", () => {
  assert.equal(removedDeprecations.size, EXPECTED_FIXTURE_COUNT, "every sample was replayed");
  for (const fixture of fixtures) {
    const removed = removedDeprecations.get(fixture.file);
    assert.ok(removed, `${fixture.file}: replayed`);
    assertDeprecationCarried(removed, fixture.name, fixture.envelopeSample.request.params.arguments, fixture.file);
  }
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
