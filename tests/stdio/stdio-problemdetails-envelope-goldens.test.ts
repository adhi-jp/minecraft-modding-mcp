import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { legacyHandshake, startInProcessSession, type InProcessSession } from "./inprocess-era-serve.ts";

/**
 * ProblemDetails envelope goldens vs the pre-migration captures,
 * promoted from the gate script into the automated suite over the public
 * in-process transport:
 *
 *  - tests/fixtures/premigration/problemdetails/*.json (13 fixtures) each
 *    freeze one recorded wire request (the authoritative replay input) and
 *    the normalized v1 reply. All 13 are replayed through ONE shared legacy
 *    session in recorded-id order (2..14): the get-runtime-metrics golden
 *    (id 14) records the tool_call_counts of the twelve preceding calls, so
 *    order and a fresh cache directory are part of the contract.
 *  - Live replies are passed through the SAME normalizer the capture used
 *    (scripts/premigration/lib.mjs normalizeCaptured) with this session's
 *    own path replacements, then compared per the approved outcome classes:
 *      1. the ten ordinary Zod-failure goldens and
 *         omitted-arguments-no-input-shape deep-equal their fixture replies;
 *      2. omitted-arguments-all-optional (json-to-nbt): under the refined
 *         omitted-arguments class (user decision 2026-08-16) the v1
 *         ProblemDetails VALIDATION error (ERR_INVALID_INPUT) is gone — the
 *         call reaches the handler, which rejects the absent document with
 *         the tool-level ERR_NBT_INVALID_TYPED_JSON ProblemDetails instead;
 *      3. omitted-arguments-required-fields (analyze-mod): stays an error,
 *         but the error-text class shifted from one top-level
 *         "expected object, received undefined" issue to per-field issues —
 *         only the stable class is asserted, not message bytes.
 *
 * Fixtures are protected read-only evidence; the mutation self-check below
 * operates on in-memory clones only.
 */

// Default flag configuration + fresh cache, mirroring the capture env
// (fixtures record only MCP_CACHE_DIR/MCP_SQLITE_PATH/pid file; no feature
// flags, no manifest override).
delete process.env.BATCH_TOOLS_OFF;
delete process.env.VERIFY_MIXIN_TARGET_OFF;
delete process.env.MCP_VERSION_MANIFEST_URL;
const root = mkdtempSync(join(tmpdir(), "problemdetails-goldens-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/premigration/problemdetails/", import.meta.url));
const CONTRACTS_DIR = fileURLToPath(new URL("../fixtures/premigration/tool-contracts/", import.meta.url));
const EXPECTED_FIXTURE_COUNT = 13;
const HANDLER_ERROR_CLASS_FIXTURE = "omitted-arguments-all-optional.json";
const REQUIRED_FIELDS_FIXTURE = "omitted-arguments-required-fields.json";
const NO_INPUT_SHAPE_FIXTURE = "omitted-arguments-no-input-shape.json";
const APPROVED_DEVIATION_FIXTURES = new Set([HANDLER_ERROR_CLASS_FIXTURE, REQUIRED_FIELDS_FIXTURE]);

type WireRequest = {
  id: number;
  jsonrpc: string;
  method: string;
  params: Record<string, unknown> & { name: string };
};
type Golden = {
  file: string;
  tool: string;
  sentParams: Record<string, unknown>;
  request: WireRequest;
  reply: { id: number; jsonrpc: string; result: Record<string, unknown> };
};

const goldens: Golden[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Omit<Golden, "file">) }));
/** Replay order = recorded wire order: the metrics golden depends on it. */
const replayOrder = [...goldens].sort((left, right) => left.request.id - right.request.id);

// ---------------------------------------------------------------------------
// Normalization (same lib the capture used, with THIS session's paths)
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
    // JSON round-trip first: the in-process transport hands over the raw
    // object, and wire serialization drops undefined-valued keys.
    lib.normalizeCaptured(JSON.parse(JSON.stringify(message)), { pathReplacements });
}

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
    if (!(key in actualRecord)) return `${path}.${key}: present in fixture, missing in live reply`;
    if (!(key in expectedRecord)) return `${path}.${key}: missing in fixture, present in live reply`;
    const diff = firstDifference(expectedRecord[key], actualRecord[key], `${path}.${key}`);
    if (diff !== null) return diff;
  }
  return null;
}

/** Compare a golden's recorded reply message to a normalized live message. */
function compareGolden(golden: Golden, normalizedLive: unknown): string | null {
  const diff = firstDifference(golden.reply, normalizedLive, "reply");
  return diff === null ? null : `${golden.file}: ${diff}`;
}

// ---------------------------------------------------------------------------
// One shared legacy session; replays happen once, in recorded-id order
// ---------------------------------------------------------------------------

let session: InProcessSession;
const liveReplies = new Map<string, unknown>(); // fixture file -> raw reply frame
const normalizedReplies = new Map<string, unknown>(); // fixture file -> normalized message

before(async () => {
  await loadNormalizer();
  session = await startInProcessSession();
  await legacyHandshake(session, "2025-06-18", "problemdetails-init");
  for (const golden of replayOrder) {
    // The recorded request is the authoritative replay input, id included.
    // The three omitted-arguments recordings carry NO `arguments` key, and
    // replaying the recorded object verbatim preserves that omission.
    const reply = await session.request(golden.request);
    liveReplies.set(golden.file, reply);
    normalizedReplies.set(golden.file, normalizeLiveMessage(reply));
  }
});

after(async () => {
  await session?.close();
});

test("all 13 problemdetails goldens are enumerated and replayed once with their recorded wire requests", () => {
  assert.equal(
    goldens.length,
    EXPECTED_FIXTURE_COUNT,
    `tests/fixtures/premigration/problemdetails must hold exactly ${EXPECTED_FIXTURE_COUNT} fixtures`
  );
  const ids = replayOrder.map((golden) => golden.request.id);
  assert.deepEqual(ids, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], "recorded ids are the replay order");
  for (const golden of goldens) {
    assert.ok(liveReplies.has(golden.file), `${golden.file} must have been replayed`);
    const argumentsOmitted = golden.sentParams["__argumentsOmitted"] === true;
    assert.equal(
      "arguments" in golden.request.params,
      !argumentsOmitted,
      `${golden.file}: the recorded request must ${argumentsOmitted ? "omit" : "carry"} the arguments key`
    );
  }
});

test("the ten ordinary Zod-failure goldens reconcile deep-equal after normalization", () => {
  const mismatches: string[] = [];
  for (const golden of goldens) {
    if (APPROVED_DEVIATION_FIXTURES.has(golden.file) || golden.file === NO_INPUT_SHAPE_FIXTURE) continue;
    const mismatch = compareGolden(golden, normalizedReplies.get(golden.file));
    if (mismatch !== null) mismatches.push(mismatch);
  }
  assert.equal(
    goldens.length - APPROVED_DEVIATION_FIXTURES.size - 1,
    10,
    "exactly ten ordinary Zod-failure goldens"
  );
  assert.deepEqual(mismatches, [], `problemdetails golden mismatches:\n${mismatches.join("\n")}`);
});

test("omitted-arguments-no-input-shape (get-runtime-metrics) reconciles deep-equal, cross-call counters included", () => {
  // This golden was already a SUCCESS pre-migration (no params schema), and
  // its tool_call_counts freeze the twelve preceding replays of this session.
  const golden = goldens.find((candidate) => candidate.file === NO_INPUT_SHAPE_FIXTURE);
  assert.ok(golden, `${NO_INPUT_SHAPE_FIXTURE} must exist`);
  const mismatch = compareGolden(golden, normalizedReplies.get(golden.file));
  assert.equal(mismatch, null, `runtime-metrics golden mismatch — ${mismatch}`);
});

test("omitted-arguments-all-optional (json-to-nbt) reaches the handler and answers the tool-level ERR_NBT_INVALID_TYPED_JSON", () => {
  // Refined omitted-arguments class (user decision 2026-08-16, superseding
  // the original "becomes a success" prediction): the v1 VALIDATION-layer
  // rejection (ERR_INVALID_INPUT, the fixture bytes) is gone — the {}-typed
  // input passes the identity validator, the handler runs, and the handler
  // itself rejects the absent document with the tool-owned
  // ERR_NBT_INVALID_TYPED_JSON ProblemDetails. Asserting the tool-owned
  // stable fields pins the wire-visible code change; SDK/zod text is not
  // re-frozen here.
  const frame = liveReplies.get(HANDLER_ERROR_CLASS_FIXTURE) as {
    error?: unknown;
    result?: Record<string, unknown>;
  };
  assert.ok(frame, `${HANDLER_ERROR_CLASS_FIXTURE} must have been replayed`);
  assert.equal(frame.error, undefined, "json-to-nbt with omitted arguments must not produce an error frame");
  assert.ok(frame.result !== undefined && frame.result !== null, "a result must be present");
  assert.equal(frame.result.isError, true, "the handler rejects the absent document as a tool-level error");
  const structured = frame.result.structuredContent as { error?: Record<string, unknown> };
  assert.notEqual(
    structured?.error?.code,
    "ERR_INVALID_INPUT",
    "the v1 validation-layer rejection must be gone (the class merge landed)"
  );
  assert.equal(structured?.error?.code, "ERR_NBT_INVALID_TYPED_JSON");
  assert.equal(structured?.error?.status, 400);
  assert.equal(structured?.error?.retryClass, "input");
  assert.equal(structured?.error?.issueOrigin, "code_issue");
  assert.equal(structured?.error?.detail, "Invalid typed NBT JSON document.");
});

test("omitted-arguments-required-fields (analyze-mod) stays ERR_INVALID_INPUT with per-field required paths", () => {
  // APPROVED class shift: still an error under the omitted-arguments merge,
  // but v1's single top-level "expected object, received undefined" issue
  // became per-field issues. Assert the stable class, not message bytes.
  const frame = liveReplies.get(REQUIRED_FIELDS_FIXTURE) as { error?: unknown; result?: Record<string, unknown> };
  assert.ok(frame, `${REQUIRED_FIELDS_FIXTURE} must have been replayed`);
  assert.equal(frame.error, undefined, "the reply must be a tool-level error, not a protocol error frame");
  assert.equal(frame.result?.isError, true, "analyze-mod with omitted arguments must stay a tool-level error");
  const structured = frame.result?.structuredContent as {
    error?: { code?: unknown; fieldErrors?: Array<{ path?: unknown }> };
  };
  assert.equal(structured?.error?.code, "ERR_INVALID_INPUT");
  const requiredFields = (
    JSON.parse(readFileSync(join(CONTRACTS_DIR, "analyze-mod.json"), "utf8")) as {
      advertised: { inputSchema: { required: string[] } };
    }
  ).advertised.inputSchema.required;
  assert.ok(requiredFields.length > 0, "the analyze-mod contract fixture must pin required fields");
  const issuePaths = (structured?.error?.fieldErrors ?? []).map((issue) => issue.path);
  for (const field of requiredFields) {
    assert.ok(
      issuePaths.includes(field),
      `per-field issue paths ${JSON.stringify(issuePaths)} must include required field "${field}"`
    );
  }
});

test("self-check: the comparator reports a mutated in-memory golden copy with fixture name and first differing path", (t) => {
  const golden = goldens.find((candidate) => candidate.file === "invalid_type-missing-required.json");
  assert.ok(golden, "self-check needs the invalid_type-missing-required golden");
  const normalizedLive = normalizedReplies.get(golden.file);

  // Flip one message character in a CLONE of the recorded reply (never
  // written to disk) and require the comparison to REPORT the mismatch.
  const mutant = structuredClone(golden);
  const mutantError = (mutant.reply.result.structuredContent as { error: { detail: string } }).error;
  mutantError.detail = mutantError.detail.replace("failed.", "failed!");
  const report = compareGolden(mutant, normalizedLive);
  assert.ok(report !== null, "the comparator must report the mutated golden clone");
  t.diagnostic(`mutation report (reply message char): ${report}`);
  assert.match(
    report,
    /^invalid_type-missing-required\.json: reply\.result\.structuredContent\.error\.detail: /
  );

  // The untouched golden still matches — the mutation was the only difference.
  assert.equal(compareGolden(golden, normalizedLive), null);
});
