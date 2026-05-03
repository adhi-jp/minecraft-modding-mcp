import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExitTimestampGroups,
  buildLegacyJsonRpcError,
  buildSyntheticCallToolResult,
  buildWorkerRestartReply,
  decideRetryRecommendation,
  pruneRestartTimestamps,
  redactToolArgs,
  type ExitInfo,
  type PendingRequestSnapshot,
  type RestartContext
} from "../src/stdio-supervisor.ts";

const baseExit: ExitInfo = { code: 1, signal: null };

test("redactToolArgs preserves primitives, paths and small objects (modified=false)", () => {
  const args = {
    projectPath: "/Users/me/work/project",
    sourcePath: "/Users/me/work/project/src/Main.java",
    mixinConfigPath: "/Users/me/work/project/mixin.json",
    targetIndex: 5,
    keepAlive: true
  };
  const { args: redacted, modified } = redactToolArgs(args);
  assert.equal(redacted.projectPath, "/Users/me/work/project");
  assert.equal(redacted.sourcePath, "/Users/me/work/project/src/Main.java");
  assert.equal(redacted.mixinConfigPath, "/Users/me/work/project/mixin.json");
  assert.equal(redacted.targetIndex, 5);
  assert.equal(redacted.keepAlive, true);
  assert.equal(modified, false, "no truncate/redact happened, modified must be false");
});

test("redactToolArgs truncates strings > 256 bytes (modified=true)", () => {
  const long = "x".repeat(300);
  const { args: redacted, modified } = redactToolArgs({ blob: long });
  assert.match(String(redacted.blob), /^<truncated:\d+ bytes>$/);
  assert.equal(modified, true);
});

test("redactToolArgs strips secret-like keys regardless of casing (modified=true)", () => {
  const { args: redacted, modified } = redactToolArgs({
    apiKey: "sk-secret",
    Token: "abc",
    PASSWORD: "hunter2",
    nested: { secret: "yyy" }
  });
  assert.equal(redacted.apiKey, "<redacted>");
  assert.equal(redacted.Token, "<redacted>");
  assert.equal(redacted.PASSWORD, "<redacted>");
  const nested = redacted.nested as Record<string, unknown>;
  assert.equal(nested.secret, "<redacted>");
  assert.equal(modified, true);
});

test("redactToolArgs caps array length at 8 entries (modified=true)", () => {
  const args = { items: Array.from({ length: 12 }, (_, i) => i) };
  const { args: redacted, modified } = redactToolArgs(args);
  const items = redacted.items as unknown[];
  assert.equal(items.length, 9);
  assert.equal(items[8], "<+4 more>");
  assert.equal(modified, true);
});

test("redactToolArgs caps object key count at 16 (modified=true)", () => {
  const args: Record<string, number> = {};
  for (let i = 0; i < 20; i++) {
    args[`k${i}`] = i;
  }
  const { args: redacted, modified } = redactToolArgs(args);
  const keys = Object.keys(redacted);
  assert.equal(keys.length, 17);
  assert.ok(keys.includes("<+more>"));
  assert.equal(redacted["<+more>"], "<+4 more keys>");
  assert.equal(modified, true);
});

test("redactToolArgs returns empty object for non-object inputs (modified=false)", () => {
  for (const input of [null, undefined, [1, 2, 3], "string"]) {
    const { args, modified } = redactToolArgs(input);
    assert.deepEqual(args, {});
    assert.equal(modified, false);
  }
});

test("decideRetryRecommendation: target-lookup with targetTotal > 5 → narrow-query", () => {
  const rec = decideRetryRecommendation(
    {
      toolName: "validate-mixin",
      lastStage: "target-lookup",
      lastStageMeta: { targetIndex: 9, targetTotal: 12 },
      exit: baseExit
    },
    []
  );
  assert.equal(rec, "narrow-query");
});

test("decideRetryRecommendation: SIGABRT → clear-cache", () => {
  const rec = decideRetryRecommendation(
    {
      toolName: "validate-mixin",
      lastStage: "parse",
      lastStageMeta: undefined,
      exit: { code: null, signal: "SIGABRT" }
    },
    []
  );
  assert.equal(rec, "clear-cache");
});

test("decideRetryRecommendation: 60s 内 3 回連続死亡 → report-bug (current restart included)", () => {
  // The third death is `now`; supervisor passes [pruned_prior..., now] (length=3)
  // to decideRetryRecommendation so the threshold fires on the actual 3rd event.
  const rec = decideRetryRecommendation(
    {
      toolName: "validate-mixin",
      lastStage: "resolve",
      lastStageMeta: undefined,
      exit: { code: 1, signal: null }
    },
    [1000, 2000, 3000]
  );
  assert.equal(rec, "report-bug");
});

test("buildWorkerRestartReply: third worker exit in 60s triggers report-bug recommendation", () => {
  // Regression test for the off-by-one: with only 2 PRIOR timestamps the
  // recommendation must still be report-bug because the current restart is
  // counted toward the threshold.
  const req: PendingRequestSnapshot = {
    id: 1,
    method: "tools/call",
    toolName: "validate-mixin",
    toolArgsRedacted: {},
    startedAt: 0,
    lastStage: "resolve",
    lastStageStartedAt: 0
  };
  const { reply, updatedTimestamps } = buildWorkerRestartReply(
    req,
    { code: 1, signal: null },
    100,
    [10, 20] // only 2 PRIOR restarts
  );
  const r = reply as {
    result: { structuredContent: { meta: { restart: Record<string, unknown> } } };
  };
  const restart = r.result.structuredContent.meta.restart;
  assert.equal(restart.retryRecommendation, "report-bug");
  assert.equal(updatedTimestamps.length, 3);
});

test("decideRetryRecommendation: default → same-request", () => {
  const rec = decideRetryRecommendation(
    {
      toolName: "validate-mixin",
      lastStage: "resolve",
      lastStageMeta: undefined,
      exit: { code: 1, signal: null }
    },
    []
  );
  assert.equal(rec, "same-request");
});

test("decideRetryRecommendation prefers narrow-query over clear-cache when both apply", () => {
  const rec = decideRetryRecommendation(
    {
      toolName: "validate-mixin",
      lastStage: "target-lookup",
      lastStageMeta: { targetIndex: 9, targetTotal: 12 },
      exit: { code: null, signal: "SIGABRT" }
    },
    []
  );
  assert.equal(rec, "narrow-query");
});

test("buildSyntheticCallToolResult shape includes structuredContent.error.code and meta.restart", () => {
  const ctx: RestartContext = {
    toolName: "validate-mixin",
    durationMs: 1234,
    lastStage: "target-lookup",
    lastStageElapsedMs: 555,
    lastStageMeta: { targetIndex: 9, targetTotal: 12 },
    exit: { code: null, signal: "SIGABRT" },
    toolArgsRedacted: { projectPath: "/p" },
    retryRecommendation: "narrow-query"
  };
  const reply = buildSyntheticCallToolResult(42, ctx) as {
    jsonrpc: string;
    id: number;
    result: {
      isError: boolean;
      content: { type: string; text: string }[];
      structuredContent: {
        error: Record<string, unknown>;
        meta: Record<string, unknown>;
      };
    };
  };
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.id, 42);
  assert.equal(reply.result.isError, true);

  const error = reply.result.structuredContent.error;
  assert.equal(error.type, "about:blank/mcp/worker-restart");
  assert.equal(error.title, "MCP worker restarted");
  assert.equal(error.code, "ERR_WORKER_RESTART");
  assert.equal(error.status, 503);
  assert.equal(error.instance, "urn:mcp:request:42");
  assert.equal(error.failedStage, "target-lookup");
  assert.deepEqual(error.suggestedCall, {
    tool: "validate-mixin",
    params: { projectPath: "/p" }
  });

  const meta = reply.result.structuredContent.meta;
  assert.equal(meta.synthetic, true);
  assert.equal(meta.syntheticSource, "supervisor");
  const restart = meta.restart as Record<string, unknown>;
  assert.equal(restart.tool, "validate-mixin");
  assert.equal(restart.durationMs, 1234);
  assert.equal(restart.lastStage, "target-lookup");
  assert.equal(restart.lastStageElapsedMs, 555);
  assert.deepEqual(restart.lastStageMeta, { targetIndex: 9, targetTotal: 12 });
  assert.deepEqual(restart.exit, { code: null, signal: "SIGABRT" });
  assert.equal(restart.retryRecommendation, "narrow-query");

  // content[0].text duplicates structuredContent as JSON
  const parsed = JSON.parse(reply.result.content[0].text);
  assert.equal(parsed.error.code, "ERR_WORKER_RESTART");
});

test("buildLegacyJsonRpcError returns -32603 envelope", () => {
  const reply = buildLegacyJsonRpcError(7) as {
    jsonrpc: string;
    id: number;
    error: { code: number; message: string };
  };
  assert.equal(reply.error.code, -32603);
  assert.equal(
    reply.error.message,
    "MCP worker restarted while handling the request. Retry the request."
  );
});

test("buildWorkerRestartReply returns synthetic for tools/call", () => {
  const req: PendingRequestSnapshot = {
    id: 1,
    method: "tools/call",
    toolName: "validate-mixin",
    toolArgsRedacted: { projectPath: "/p" },
    startedAt: 1000,
    lastStage: "target-lookup",
    lastStageStartedAt: 1500,
    lastStageMeta: { targetIndex: 3, targetTotal: 8 }
  };
  const { reply, updatedTimestamps } = buildWorkerRestartReply(
    req,
    { code: null, signal: "SIGKILL" },
    2500,
    []
  );
  const r = reply as {
    result: {
      structuredContent: { error: Record<string, unknown>; meta: Record<string, unknown> };
    };
  };
  assert.equal(r.result.structuredContent.error.code, "ERR_WORKER_RESTART");
  const restart = r.result.structuredContent.meta.restart as Record<string, unknown>;
  assert.equal(restart.durationMs, 1500);
  assert.equal(restart.lastStageElapsedMs, 1000);
  assert.equal(updatedTimestamps.length, 1);
  assert.equal(updatedTimestamps[0], 2500);
});

test("buildWorkerRestartReply returns raw -32603 for non-tools/call", () => {
  const req: PendingRequestSnapshot = {
    id: 9,
    method: "initialize",
    startedAt: 0
  };
  const { reply } = buildWorkerRestartReply(req, baseExit, 100, []);
  const r = reply as { error: { code: number } };
  assert.equal(r.error.code, -32603);
});

test("buildWorkerRestartReply returns raw -32603 when structuredRestartDisabled", () => {
  const req: PendingRequestSnapshot = {
    id: 1,
    method: "tools/call",
    toolName: "validate-mixin",
    toolArgsRedacted: {},
    startedAt: 0
  };
  const { reply } = buildWorkerRestartReply(req, baseExit, 100, [], {
    structuredRestartDisabled: true
  });
  const r = reply as {
    error?: { code: number; message: string };
    result?: unknown;
  };
  assert.equal(r.error?.code, -32603);
  assert.equal(
    r.error?.message,
    "MCP worker restarted while handling the request. Retry the request."
  );
  assert.equal(r.result, undefined);
});

test("pruneRestartTimestamps drops entries older than the window", () => {
  const now = 100_000;
  const result = pruneRestartTimestamps([10_000, 50_000, 99_000], now, 60_000);
  assert.deepEqual(result, [50_000, 99_000]);
});

test("buildSyntheticCallToolResult: lastStageElapsedMs measures stage-entry to crash, NOT the gap from the latest per-target emit", () => {
  // Contract: `lastStageStartedAt` is set at stage entry, not on per-target
  // meta updates. Asserted at the synthesis boundary by passing a snapshot
  // whose `lastStageStartedAt` reflects stage entry while the meta carries
  // a per-target index; `lastStageElapsedMs` must measure from stage entry.
  const stageEnteredAt = 1_000_000;
  const crashedAt = 1_031_200;
  const ctx: RestartContext = {
    toolName: "validate-mixin",
    durationMs: crashedAt - 999_900,
    lastStage: "target-lookup",
    // Stage entered at 1_000_000; even if 12 per-target emits happened
    // between then and now, the elapsed time should still measure from
    // stage entry, not from the latest emit.
    lastStageElapsedMs: crashedAt - stageEnteredAt,
    lastStageMeta: { targetIndex: 9, targetTotal: 12 },
    exit: { code: null, signal: "SIGABRT" },
    toolArgsRedacted: {},
    retryRecommendation: "narrow-query"
  };
  const reply = buildSyntheticCallToolResult(42, ctx) as {
    result: { structuredContent: { meta: { restart: Record<string, unknown> } } };
  };
  const restart = reply.result.structuredContent.meta.restart;
  assert.equal(restart.lastStageElapsedMs, 31_200);
  assert.equal((restart.lastStageMeta as Record<string, unknown>).targetIndex, 9);
});

test("buildExitTimestampGroups: one worker exit with N concurrent same-tool requests records exactly one death", () => {
  // Grouping by toolName ensures one exit records one death, regardless of
  // how many concurrent pending requests it killed; per-request recording
  // would inflate recentRestarts to N.
  const recent = new Map<string, number[]>();
  const { prunedByTool, updatedByTool } = buildExitTimestampGroups(
    // 3 concurrent pending validate-mixin calls all killed by one exit
    ["validate-mixin", "validate-mixin", "validate-mixin"],
    recent,
    100
  );
  assert.equal(prunedByTool.size, 1);
  assert.deepEqual(prunedByTool.get("validate-mixin"), []);
  assert.equal(updatedByTool.size, 1);
  assert.deepEqual(updatedByTool.get("validate-mixin"), [100]);
});

test("buildExitTimestampGroups: distinct toolNames each get their own pruned/updated entry", () => {
  const recent = new Map<string, number[]>([
    ["validate-mixin", [10, 20]],
    ["resolve-artifact", [50]]
  ]);
  const { prunedByTool, updatedByTool } = buildExitTimestampGroups(
    ["validate-mixin", "resolve-artifact", "validate-mixin"],
    recent,
    100
  );
  assert.equal(prunedByTool.size, 2);
  assert.deepEqual(prunedByTool.get("validate-mixin"), [10, 20]);
  assert.deepEqual(prunedByTool.get("resolve-artifact"), [50]);
  assert.deepEqual(updatedByTool.get("validate-mixin"), [10, 20, 100]);
  assert.deepEqual(updatedByTool.get("resolve-artifact"), [50, 100]);
});

test("buildExitTimestampGroups: undefined toolName collapses to 'unknown'", () => {
  const recent = new Map<string, number[]>();
  const { prunedByTool, updatedByTool } = buildExitTimestampGroups(
    [undefined, undefined],
    recent,
    100
  );
  assert.equal(prunedByTool.size, 1);
  assert.equal(updatedByTool.get("unknown")?.length, 1);
});

test("buildExitTimestampGroups: prunes entries older than the restart window", () => {
  const recent = new Map<string, number[]>([
    ["validate-mixin", [10, 20, 90_000]] // 10 / 20 are older than 60s window from now=100_000
  ]);
  const { prunedByTool, updatedByTool } = buildExitTimestampGroups(
    ["validate-mixin"],
    recent,
    100_000
  );
  assert.deepEqual(prunedByTool.get("validate-mixin"), [90_000]);
  assert.deepEqual(updatedByTool.get("validate-mixin"), [90_000, 100_000]);
});

test("buildWorkerRestartReply: pruned timestamps without current restart still receive correct count for recommendation", () => {
  // The supervisor passes the pruned (pre-current) list per call;
  // buildWorkerRestartReply appends `now` once internally to produce the
  // count fed to decideRetryRecommendation.
  const req: PendingRequestSnapshot = {
    id: 1,
    method: "tools/call",
    toolName: "validate-mixin",
    toolArgsRedacted: {},
    startedAt: 0,
    lastStage: "resolve",
    lastStageStartedAt: 0
  };
  // 2 prior + 1 current → length=3 → report-bug.
  const result1 = buildWorkerRestartReply(req, { code: 1, signal: null }, 100, [10, 20]);
  const r1 = result1.reply as {
    result: { structuredContent: { meta: { restart: Record<string, unknown> } } };
  };
  assert.equal(r1.result.structuredContent.meta.restart.retryRecommendation, "report-bug");

  // 1 prior + 1 current → length=2 → same-request (default).
  const result2 = buildWorkerRestartReply(req, { code: 1, signal: null }, 100, [50]);
  const r2 = result2.reply as {
    result: { structuredContent: { meta: { restart: Record<string, unknown> } } };
  };
  assert.equal(r2.result.structuredContent.meta.restart.retryRecommendation, "same-request");
});

test("buildSyntheticCallToolResult OMITS suggestedCall when redaction modified the args", () => {
  // Redacted args carry sentinel placeholders ("<truncated:…>", "<redacted>")
  // that are not retryable; `suggestedCall` must be omitted when
  // toolArgsRedactedModified=true. The redacted form remains visible on the
  // diagnostic-only `meta.restart.redactedToolArgs` field.
  const ctx: RestartContext = {
    toolName: "validate-mixin",
    durationMs: 1234,
    lastStage: "parse",
    lastStageElapsedMs: 100,
    lastStageMeta: undefined,
    exit: baseExit,
    toolArgsRedacted: { source: "<truncated:300 bytes>", projectPath: "/p" },
    toolArgsRedactedModified: true,
    retryRecommendation: "same-request"
  };
  const reply = buildSyntheticCallToolResult(7, ctx) as {
    result: {
      structuredContent: {
        error: Record<string, unknown>;
        meta: { restart: Record<string, unknown> };
      };
    };
  };
  assert.equal(reply.result.structuredContent.error.suggestedCall, undefined);
  assert.deepEqual(
    reply.result.structuredContent.meta.restart.redactedToolArgs,
    { source: "<truncated:300 bytes>", projectPath: "/p" }
  );
  assert.equal(reply.result.structuredContent.meta.restart.redactedToolArgsModified, true);
});

test("buildSyntheticCallToolResult EMITS suggestedCall when redaction did not modify the args", () => {
  // When the args round-trip cleanly (no truncate / no <redacted>),
  // `suggestedCall` is safe to surface; the diagnostic field still echoes
  // the args.
  const ctx: RestartContext = {
    toolName: "validate-mixin",
    durationMs: 1,
    lastStage: "parse",
    lastStageElapsedMs: 0,
    lastStageMeta: undefined,
    exit: baseExit,
    toolArgsRedacted: { projectPath: "/p", version: "1.21" },
    toolArgsRedactedModified: false,
    retryRecommendation: "same-request"
  };
  const reply = buildSyntheticCallToolResult(7, ctx) as {
    result: {
      structuredContent: {
        error: Record<string, unknown>;
        meta: { restart: Record<string, unknown> };
      };
    };
  };
  assert.deepEqual(reply.result.structuredContent.error.suggestedCall, {
    tool: "validate-mixin",
    params: { projectPath: "/p", version: "1.21" }
  });
  assert.equal(reply.result.structuredContent.meta.restart.redactedToolArgsModified, false);
});

test("buildSyntheticCallToolResult omits suggestedCall when toolArgsRedacted undefined", () => {
  const ctx: RestartContext = {
    toolName: "x",
    durationMs: 0,
    lastStage: undefined,
    lastStageElapsedMs: undefined,
    lastStageMeta: undefined,
    exit: baseExit,
    toolArgsRedacted: undefined,
    retryRecommendation: "same-request"
  };
  const reply = buildSyntheticCallToolResult(1, ctx) as {
    result: { structuredContent: { error: Record<string, unknown> } };
  };
  assert.equal(reply.result.structuredContent.error.suggestedCall, undefined);
});
