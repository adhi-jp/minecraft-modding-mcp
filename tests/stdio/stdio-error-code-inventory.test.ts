import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

/**
 * Error-code inventory: one auditable file enumerating every planned wire
 * error path with the code OBSERVED from the production surface, plus a
 * source scan over src/ for JSON-RPC error-code literals.
 *
 * Observation strategy per row:
 *  - "driven-here" rows are exercised live through the in-process serveStdio
 *    harness (real SDK entry + real factory) in THIS file;
 *  - "builder" rows observe the code from the production reply builder the
 *    supervisor uses on that path (era-classifier / stdio-supervisor
 *    exports), with the end-to-end wire proof delegated to the named
 *    committed suite;
 *  - "fixture" rows re-assert the frozen premigration baseline
 *    (tests/fixtures/premigration/error-code-inventory.json), whose
 *    continuing wire accuracy is pinned by the named committed suite.
 */

// BATCH_TOOLS_OFF removes the batch tools from registration for THIS test
// process only — the disabled-tool row needs it. Must be set before the
// harness's first src/index.ts import.
process.env.BATCH_TOOLS_OFF = "1";
const root = mkdtempSync(join(tmpdir(), "p3-error-codes-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

import {
  MODERN_META,
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "./inprocess-era-serve.ts";
import {
  buildEraConflictRejection,
  buildMissingMetaRejection,
  buildMethodNotFoundRejection,
  classifyEraSignal
} from "../../src/era-classifier.ts";
import {
  buildLegacyJsonRpcError,
  buildSupervisorQueueLimitReply,
  buildValidateProjectTimeoutReply,
  buildWorkerRestartReply
} from "../../src/stdio-supervisor.ts";

const BASELINE = JSON.parse(
  readFileSync(new URL("../fixtures/premigration/error-code-inventory.json", import.meta.url), "utf8")
) as {
  observedWireCodes: number[];
  reservedRangeViolations: unknown[];
  entries: Array<{
    path: string;
    method: string;
    wireCode: number | null;
    problemCode: string | null;
    classification: string;
  }>;
};

let legacy: InProcessSession;
let modern: InProcessSession;
let nextId = 1;

function id(): number {
  return nextId++;
}

before(async () => {
  legacy = await startInProcessSession();
  await legacyHandshake(legacy);
  modern = await startInProcessSession();
});

after(async () => {
  await legacy?.close();
  await modern?.close();
});

test("invalid tool input answers a SUCCESSFUL CallToolResult carrying ProblemDetails (no JSON-RPC error code), both eras", async () => {
  for (const [session, params, label] of [
    [legacy, { name: "analyze-mod", arguments: {} }, "legacy"],
    [modern, { _meta: MODERN_META, name: "analyze-mod", arguments: {} }, "modern"]
  ] as const) {
    const frame = await session.request({ jsonrpc: "2.0", id: id(), method: "tools/call", params });
    assert.equal(frame.error, undefined, `${label}: invalid input must NOT produce a JSON-RPC error`);
    assert.equal(frame.result?.isError, true, `${label}: invalid input answers an isError tool result`);
    const structured = frame.result?.structuredContent as { error?: { code?: string } } | undefined;
    assert.equal(structured?.error?.code, "ERR_INVALID_INPUT", `${label}: the ProblemDetails code is ERR_INVALID_INPUT`);
  }
});

test("an unmatched resource URI answers JSON-RPC -32602, both eras", async () => {
  const legacyFrame = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { uri: "mc://premigration/no-such-resource" }
  });
  assert.equal(legacyFrame.error?.code, -32602);

  const modernFrame = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "resources/read",
    params: { _meta: MODERN_META, uri: "mc://premigration/no-such-resource" }
  });
  assert.equal(modernFrame.error?.code, -32602);
});

test("disabled tool (BATCH_TOOLS_OFF): legacy answers the restored premigration isError envelope; modern keeps the raw -32602", async () => {
  // Restored via the supervisor intercept: the premigration legacy contract
  // returned a SUCCESSFUL isError result for an unregistered tool name, and
  // the supervisor synthesizes exactly that envelope for LEGACY-era registry
  // misses because the v2 SDK throws a raw -32602 instead
  // (buildUnknownToolNotFoundReply; wire proof in
  // tests/stdio/stdio-supervisor-unknown-tool-intercept.test.ts, which
  // deep-equals the live reply against the frozen baseline fixture row).
  // The MODERN era keeps the raw -32602 as the sanctioned contract (tool
  // absence is a params problem on 2026-07-28, mirroring the SDK's own
  // not-found mapping; the modern era never had a v1 contract).
  //
  // Legacy row: observe the production builder against the frozen baseline
  // reply bytes (this in-process harness serves the WORKER surface without
  // the supervisor, so the restored legacy shape is not observable here).
  const { buildUnknownToolNotFoundReply } = await import("../../src/stdio-supervisor.ts");
  const baseline = BASELINE.entries.find((entry) => entry.path === "disabled-tool") as
    | { reply?: Record<string, unknown> }
    | undefined;
  assert.ok(baseline?.reply, "the frozen baseline must carry the disabled-tool reply");
  assert.deepEqual(
    buildUnknownToolNotFoundReply(2, "batch-class-source"),
    baseline.reply,
    "the supervisor's synthesized legacy reply must deep-equal the frozen premigration baseline row"
  );

  // Worker-level (and modern-era) shape: the raw -32602 the SDK emits —
  // what the supervisor intercepts on legacy and passes through on modern.
  const legacyWorker = await legacy.request({
    jsonrpc: "2.0",
    id: id(),
    method: "tools/call",
    params: { name: "batch-class-source", arguments: {} }
  });
  assert.equal(legacyWorker.result, undefined, "the bare worker surface answers no result envelope");
  assert.equal(legacyWorker.error?.code, -32602);
  assert.equal(legacyWorker.error?.message, "Tool batch-class-source not found");

  const modernFrame = await modern.request({
    jsonrpc: "2.0",
    id: id(),
    method: "tools/call",
    params: { _meta: MODERN_META, name: "batch-class-source", arguments: {} }
  });
  assert.equal(modernFrame.result, undefined, "the modern era keeps the raw error");
  assert.equal(modernFrame.error?.code, -32602);
  assert.equal(modernFrame.error?.message, "Tool batch-class-source not found");
});

test("the per-path inventory table matches the observed/builder/baseline codes", () => {
  // Supervisor rejection builders (production code paths; wire proof in the
  // named committed suites).
  const eraConflictModern = buildEraConflictRejection(1, "modern") as { error?: { code?: number } };
  const eraConflictLegacy = buildEraConflictRejection(1, "legacy") as { error?: { code?: number } };
  const missingMeta = buildMissingMetaRejection(1, classifyEraSignal({}), "unselected") as { error?: { code?: number } };
  const listenRejected = buildMethodNotFoundRejection(1) as { error?: { code?: number } };
  const queueOverflowOther = buildSupervisorQueueLimitReply(1, "resources/list") as { error?: { code?: number } };
  const queueOverflowToolsCall = buildSupervisorQueueLimitReply(1, "tools/call") as {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } };
  };
  const restartRaw = buildLegacyJsonRpcError(1) as { error?: { code?: number } };
  const restartStructured = buildWorkerRestartReply(
    { id: 1, method: "tools/call", toolName: "list-versions", startedAt: 0, era: "legacy" },
    { code: null, signal: "SIGKILL" },
    10,
    []
  ).reply as { error?: unknown; result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
  const timeoutStructured = buildValidateProjectTimeoutReply({
    request: { id: 1, method: "tools/call", toolName: "validate-project", startedAt: 0, era: "legacy" },
    phase: "running",
    deadlineMs: 10,
    now: 10,
    workerRestartInitiated: false
  }) as { error?: unknown; result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };

  // Era conflicts (covering wire suites: stdio-supervisor-era-state.test.ts,
  // stdio-supervisor-era-wire.test.ts).
  assert.equal(eraConflictModern.error?.code, -32601, "modern-locked legacy initialize → -32601 era_conflict");
  assert.equal(eraConflictLegacy.error?.code, -32600, "legacy-locked modern request → -32600 era_conflict");
  // Missing meta (covering: stdio-supervisor-era-state.test.ts, the
  // Content-Length rejection case in stdio-supervisor-era-wire.test.ts).
  assert.equal(missingMeta.error?.code, -32602, "claim-less non-handshake request → -32602 missing_meta");
  // Modern subscriptions/listen admission (covering: stdio-supervisor-era-state.test.ts).
  assert.equal(listenRejected.error?.code, -32601, "modern subscriptions/listen → -32601 at admission");
  // Unsupported modern version -32022 is WORKER-emitted (SDK), pinned over
  // the wire by stdio-supervisor-era-wire.test.ts (data {supported:["2026-07-28"], requested}).
  // Queue overflow (covering: stdio-supervisor.test.ts, synthetic-inventory).
  assert.equal(queueOverflowOther.error?.code, -32000, "queue overflow non-tools/call → raw -32000");
  assert.equal(queueOverflowToolsCall.error, undefined, "queue overflow tools/call → structured result");
  assert.equal(queueOverflowToolsCall.result?.isError, true);
  assert.equal(queueOverflowToolsCall.result?.structuredContent?.error?.code, "ERR_LIMIT_EXCEEDED");
  // Worker restart (covering: stdio-supervisor-synthetic-inventory.test.ts,
  // stdio-supervisor-synthetic-toggle-off.test.ts for the raw -32603 variants).
  assert.equal(restartRaw.error?.code, -32603, "restart non-tools/call (and toggle-off) → raw -32603");
  assert.equal(restartStructured.error, undefined, "restart tools/call → structured result");
  assert.equal(restartStructured.result?.isError, true);
  assert.equal(restartStructured.result?.structuredContent?.error?.code, "ERR_WORKER_RESTART");
  // validate-project timeout (covering: stdio-supervisor-timeout.test.ts).
  assert.equal(timeoutStructured.error, undefined, "timeout → structured tool result");
  assert.equal(timeoutStructured.result?.isError, true);
  assert.equal(timeoutStructured.result?.structuredContent?.error?.code, "ERR_TOOL_TIMEOUT");

  // Frozen premigration baseline consistency (the frozen fixture is the
  // inventory anchor; its wire accuracy is carried by the synthetic-inventory
  // byte-compat suite and the golden replays).
  assert.deepEqual(
    [...BASELINE.observedWireCodes].sort((a, b) => a - b),
    [-32603, -32602, -32000]
  );
  assert.deepEqual(BASELINE.reservedRangeViolations, []);
  const expectedByPath: Record<string, { wireCode: number | null; problemCode: string | null }> = {
    "unmatched-resource-uri:resources/read": { wireCode: -32602, problemCode: null },
    "disabled-tool:tools/call": { wireCode: null, problemCode: null },
    "queue-overflow:tools/call": { wireCode: null, problemCode: "ERR_LIMIT_EXCEEDED" },
    "queue-overflow:resources/list": { wireCode: -32000, problemCode: null },
    "worker-restart:tools/call": { wireCode: null, problemCode: "ERR_WORKER_RESTART" },
    "worker-restart:resources/list": { wireCode: -32603, problemCode: null },
    "worker-restart-toggle-off:tools/call": { wireCode: -32603, problemCode: null },
    "validate-project-timeout:tools/call": { wireCode: null, problemCode: "ERR_TOOL_TIMEOUT" },
    "startup-failure-terminalization:initialize": { wireCode: -32603, problemCode: null },
    "startup-failure-terminalization:tools/call": { wireCode: null, problemCode: "ERR_WORKER_RESTART" },
    "startup-failure-terminalization:resources/list": { wireCode: -32603, problemCode: null }
  };
  for (const entry of BASELINE.entries) {
    if (entry.path === "tool-input-validation") {
      // Covered live above: ProblemDetails-in-result, never a wire code
      // (the single get-runtime-metrics success row is the one exception).
      assert.equal(entry.wireCode, null, `${entry.path} rows carry no wire code`);
      continue;
    }
    const expected = expectedByPath[`${entry.path}:${entry.method}`];
    assert.ok(expected, `baseline entry ${entry.path}:${entry.method} must be enumerated in the inventory table`);
    assert.equal(entry.wireCode, expected.wireCode, `${entry.path}:${entry.method} wireCode`);
    assert.equal(entry.problemCode, expected.problemCode, `${entry.path}:${entry.method} problemCode`);
  }
});

test("src/ emits no reserved-range JSON-RPC codes: none in -32020..-32099, none in -32001..-32019, no -32002/-32042", () => {
  const srcRoot = join(process.cwd(), "src");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(srcRoot);
  assert.ok(files.length > 50, "sanity: the src scan must see the real tree");

  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const found = new Map<number, string[]>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // -32002 / -32042 are banned even in comments (no dormant references).
    for (const banned of ["-32002", "-32042"]) {
      assert.ok(!source.includes(banned), `${file}: ${banned} must not appear anywhere in src/`);
    }
    const code = stripComments(source);
    for (const match of code.matchAll(/-32\d{3}/g)) {
      const value = Number(match[0]);
      const bucket = found.get(value) ?? [];
      bucket.push(file);
      found.set(value, bucket);
    }
  }

  for (const [value, where] of found) {
    assert.ok(
      !(value <= -32020 && value >= -32099),
      `reserved 2026-era range code ${value} must not be emitted from src/ (found in ${where.join(", ")})`
    );
    if (value <= -32001 && value >= -32019) {
      assert.fail(`server-defined code ${value} is beyond the premigration baseline (-32000 only); found in ${where.join(", ")}`);
    }
  }
  // The baseline's only server-defined code stays the queue-overflow -32000.
  assert.ok(found.has(-32000), "the queue-overflow -32000 must remain the sole server-defined code");
});
