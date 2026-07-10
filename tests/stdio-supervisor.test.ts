import assert from "node:assert/strict";
import test, { describe } from "node:test";

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
import * as supervisorModule from "../src/stdio-supervisor.ts";

const supervisorExports = supervisorModule as Record<string, unknown>;

test("validate-project timeout configuration accepts only bounded ASCII decimals", () => {
  const load = supervisorExports.loadValidateProjectTimeoutMs;
  assert.equal(typeof load, "function");
  const parse = load as (value: string | undefined) => number;
  for (const value of [undefined, "", " 10000", "+10000", "1e4", "0x2710", "9999", "600001", "9007199254740992", "abc"]) {
    assert.equal(parse(value), 120_000, String(value));
  }
  assert.equal(parse("010000"), 10_000);
  assert.equal(parse("600000"), 600_000);
});

test("startup watchdog is capped independently from validate-project workload timeout", () => {
  const compute = supervisorExports.computeWorkerStartupWatchdogMs;
  assert.equal(typeof compute, "function");
  const watchdog = compute as (deadlineMs: number) => number;
  assert.equal(watchdog(10_000), 10_000);
  assert.equal(watchdog(120_000), 30_000);
  assert.equal(watchdog(600_000), 30_000);
});

test("restart backoff starts at 100 ms and caps at 30 seconds", () => {
  const compute = supervisorExports.computeRestartBackoffMs;
  assert.equal(typeof compute, "function");
  const delay = compute as (retryIndex: number) => number;
  assert.deepEqual(
    [0, 1, 2, 8, 9, 20].map(delay),
    [100, 200, 400, 25_600, 30_000, 30_000]
  );
});

test("POSIX tree termination targets the worker process group", () => {
  const terminate = supervisorExports.terminatePosixProcessGroup;
  assert.equal(typeof terminate, "function");
  const calls: Array<[number, string]> = [];
  const result = (terminate as (pid: number, kill: (pid: number, signal: string) => void) => boolean)(
    321,
    (pid, signal) => calls.push([pid, signal])
  );
  assert.equal(result, true);
  assert.deepEqual(calls, [[-321, "SIGKILL"]]);
});

test("POSIX tree termination reports failure without hiding direct-child fallback need", () => {
  const terminate = supervisorExports.terminatePosixProcessGroup;
  assert.equal(typeof terminate, "function");
  assert.equal(
    (terminate as (pid: number, kill: (pid: number, signal: string) => void) => boolean)(1, () => {
      throw new Error("EPERM");
    }),
    false
  );
});

test("POSIX tree termination treats an already-gone process group as cleaned up", () => {
  const terminate = supervisorExports.terminatePosixProcessGroup;
  assert.equal(typeof terminate, "function");
  assert.equal(
    (terminate as (pid: number, kill: (pid: number, signal: string) => void) => boolean)(654, () => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    }),
    true
  );
});

test("Windows tree termination command includes descendant and force flags", () => {
  const build = supervisorExports.buildWindowsTreeKillArgs;
  assert.equal(typeof build, "function");
  assert.deepEqual((build as (pid: number) => string[])(456), ["/PID", "456", "/T", "/F"]);
});

test("tree cleanup returns failure within its deadline when the helper never settles", async () => {
  const settle = supervisorExports.settleTreeCleanupWithin;
  assert.equal(typeof settle, "function");
  let timeoutCleanupCalls = 0;
  const result = await (settle as (
    operation: Promise<boolean>,
    timeoutMs: number,
    onTimeout: () => void
  ) => Promise<boolean>)(new Promise<boolean>(() => {}), 20, () => {
    timeoutCleanupCalls += 1;
  });
  assert.equal(result, false);
  assert.equal(timeoutCleanupCalls, 1);
});

test("only the initialized lifecycle notification is retained while the worker is unavailable", () => {
  const shouldRetain = supervisorExports.shouldRetainUnavailableNotification;
  assert.equal(typeof shouldRetain, "function");
  const retain = shouldRetain as (method: string) => boolean;
  assert.equal(retain("notifications/initialized"), true);
  assert.equal(retain("notifications/progress"), false);
  assert.equal(retain("notifications/resources/updated"), false);
});

test("restart backoff reserves its exact delay even when live-cap blocks the timer", () => {
  const BackoffState = supervisorExports.RestartBackoffState as {
    new(): {
      reserve(now: number): { epoch: number; notBefore: number; delayMs: number };
      reset(): void;
    };
  };
  assert.equal(typeof BackoffState, "function");
  const state = new BackoffState();
  assert.deepEqual(state.reserve(1_000), { epoch: 1, notBefore: 1_100, delayMs: 100 });
  assert.deepEqual(state.reserve(1_050), { epoch: 2, notBefore: 1_250, delayMs: 200 });
  assert.deepEqual(state.reserve(1_250), { epoch: 3, notBefore: 1_650, delayMs: 400 });
  state.reset();
  assert.deepEqual(state.reserve(2_000), { epoch: 4, notBefore: 2_100, delayMs: 100 });
});

test("POSIX unresolved-token shutdown retry targets the saved process group", () => {
  const retry = supervisorExports.retryPosixTreeToken;
  assert.equal(typeof retry, "function");
  const calls: Array<[number, string]> = [];
  assert.equal(
    (retry as (pid: number, kill: (pid: number, signal: string) => void) => boolean)(
      987,
      (pid, signal) => calls.push([pid, signal])
    ),
    true
  );
  assert.deepEqual(calls, [[-987, "SIGKILL"]]);
});

test("POSIX unresolved-token shutdown retry clears already-gone process groups", () => {
  const retry = supervisorExports.retryPosixTreeToken;
  assert.equal(typeof retry, "function");
  assert.equal(
    (retry as (pid: number, kill: (pid: number, signal: string) => void) => boolean)(
      988,
      () => {
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      }
    ),
    true
  );
});

test("supervisor queue overflow tool result has the exact public envelope", () => {
  const build = supervisorExports.buildSupervisorQueueLimitReply;
  assert.equal(typeof build, "function");
  const reply = (build as (id: string | number, method: string) => Record<string, unknown>)("q-3", "tools/call");
  const result = reply.result as Record<string, unknown>;
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.deepEqual(structured, {
    error: {
      type: "about:blank/mcp/limit-exceeded",
      title: "Supervisor queue limit exceeded",
      detail: "The MCP supervisor request queue is full.",
      status: 413,
      code: "ERR_LIMIT_EXCEEDED",
      instance: "urn:mcp:request:q-3",
      retryClass: "transient",
      issueOrigin: "tool_issue",
      hints: ["Retry after the supervisor queue drains."]
    },
    meta: {
      synthetic: true,
      syntheticSource: "supervisor",
      queue: { reason: "supervisor-request-queue", maxQueued: 2, queuedCount: 2 }
    }
  });
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content[0].type, "text");
  assert.deepEqual(JSON.parse(content[0].text), structured);
});

test("supervisor queue overflow non-tool result is a raw JSON-RPC error without data", () => {
  const build = supervisorExports.buildSupervisorQueueLimitReply;
  assert.equal(typeof build, "function");
  assert.deepEqual(
    (build as (id: string | number, method: string) => unknown)(7, "resources/read"),
    {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "MCP supervisor request queue is full." }
    }
  );
});

test("validate-project timeout result uses the standard envelope and exact timeout metadata", () => {
  const build = supervisorExports.buildValidateProjectTimeoutReply;
  assert.equal(typeof build, "function");
  const reply = (build as (input: Record<string, unknown>) => Record<string, unknown>)({
    request: {
      id: "timeout-1",
      method: "tools/call",
      toolName: "validate-project",
      toolArgsRedacted: { task: "project-summary" },
      toolArgsRedactedModified: false,
      startedAt: 100,
      lastStage: "validate-project:mixin-validation",
      lastStageStartedAt: 700,
      lastStageMeta: { targetIndex: 2, token: "secret" }
    },
    phase: "running",
    deadlineMs: 1_000,
    now: 1_100,
    workerRestartInitiated: true
  });
  const result = reply.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  assert.equal(result.isError, true);
  const structured = result.structuredContent as { error: Record<string, unknown>; meta: { timeout: Record<string, unknown> } };
  assert.equal(structured.error.code, "ERR_TOOL_TIMEOUT");
  assert.equal(structured.error.status, 408);
  assert.equal(structured.error.retryClass, "transient");
  assert.equal(structured.error.issueOrigin, "tool_issue");
  assert.deepEqual(structured.meta.timeout, {
    tool: "validate-project",
    phase: "running",
    durationMs: 1_000,
    deadlineMs: 1_000,
    lastStage: "validate-project:mixin-validation",
    lastStageElapsedMs: 400,
    lastStageMeta: { targetIndex: 2, token: "<redacted>" },
    redactedToolArgs: { task: "project-summary" },
    redactedToolArgsModified: false,
    retryRecommendation: "same-request",
    workerRestartInitiated: true
  });
});

const baseExit: ExitInfo = { code: 1, signal: null };

describe("redactToolArgs", () => {
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

  test("redactToolArgs preserves long PRESERVED_PATH_KEYS values without truncation", () => {
    const long = "/" + "a".repeat(400);
    const { args, modified } = redactToolArgs({
      projectPath: long,
      sourcePath: long,
      mixinConfigPath: long
    });
    assert.equal(args.projectPath, long);
    assert.equal(args.sourcePath, long);
    assert.equal(args.mixinConfigPath, long);
    assert.equal(modified, false);
  });

  test("redactToolArgs redacts secret-like keys whose name is NOT a preserved path", () => {
    const { args, modified } = redactToolArgs({ tokenPath: "/usr/local/secret.token" });
    assert.equal(args.tokenPath, "<redacted>");
    assert.equal(modified, true);
  });

  test("redactToolArgs truncates long strings inside arrays", () => {
    const { args, modified } = redactToolArgs({
      items: ["x".repeat(300), "short"]
    });
    const items = args.items as unknown[];
    assert.match(String(items[0]), /^<truncated:\d+ bytes>$/);
    assert.equal(items[1], "short");
    assert.equal(modified, true);
  });
});

describe("decideRetryRecommendation", () => {
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

  test("decideRetryRecommendation maps SIGSEGV and SIGKILL to clear-cache", () => {
    const ctxBase = { toolName: "validate-mixin", lastStage: undefined, lastStageMeta: undefined };
    const segv = decideRetryRecommendation(
      { ...ctxBase, exit: { code: null, signal: "SIGSEGV" } },
      []
    );
    const kill = decideRetryRecommendation(
      { ...ctxBase, exit: { code: null, signal: "SIGKILL" } },
      []
    );
    assert.equal(segv, "clear-cache");
    assert.equal(kill, "clear-cache");
  });

  test("decideRetryRecommendation: SIGTERM does NOT map to clear-cache (default branch)", () => {
    const result = decideRetryRecommendation(
      { toolName: "x", lastStage: undefined, lastStageMeta: undefined, exit: { code: null, signal: "SIGTERM" } },
      []
    );
    assert.equal(result, "same-request");
  });

  test("decideRetryRecommendation: target-lookup boundary at targetTotal === 5 (no narrow-query) and 6 (narrow-query)", () => {
    const make = (targetTotal: unknown) =>
      decideRetryRecommendation(
        {
          toolName: "validate-mixin",
          lastStage: "target-lookup",
          lastStageMeta: { targetTotal } as Record<string, unknown>,
          exit: baseExit
        },
        []
      );
    assert.equal(make(5), "same-request");
    assert.equal(make(6), "narrow-query");
    assert.equal(make(undefined), "same-request");
    assert.equal(make("12"), "same-request");
    assert.equal(make(Number.NaN), "same-request");
  });

  test("decideRetryRecommendation: repeated restart threshold yields report-bug only at >= threshold", () => {
    const ctx = { toolName: "x", lastStage: undefined, lastStageMeta: undefined, exit: baseExit };
    // RESTART_REPEAT_THRESHOLD is 3 according to existing test fixtures
    assert.equal(decideRetryRecommendation(ctx, [1, 2]), "same-request");
    assert.equal(decideRetryRecommendation(ctx, [1, 2, 3]), "report-bug");
  });
});

describe("buildSyntheticCallToolResult", () => {
  test("buildSyntheticCallToolResult shape includes structuredContent.error.code and meta.restart", async () => {
    // Boot src/index.ts so the supervisor's `getToolSchema` registration
    // check clears for `validate-mixin`, and use schema-valid args so the
    // downstream `buildSuggestedCall` validation also passes — both gates
    // must clear for the suggestion to surface.
    await import("../src/index.ts");

    const ctx: RestartContext = {
      toolName: "validate-mixin",
      durationMs: 1234,
      lastStage: "target-lookup",
      lastStageElapsedMs: 555,
      lastStageMeta: { targetIndex: 9, targetTotal: 12 },
      exit: { code: null, signal: "SIGABRT" },
      toolArgsRedacted: {
        input: { mode: "inline", source: "package x; class Y {}" },
        version: "1.21.10"
      },
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
      params: {
        input: { mode: "inline", source: "package x; class Y {}" },
        version: "1.21.10"
      }
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

  test("buildSyntheticCallToolResult drops suggestedCall when toolName is unregistered (typo / disabled / version-skewed)", async () => {
    // An unregistered tool name (typo, BATCH_TOOLS_OFF=1 /
    // VERIFY_MIXIN_TARGET_OFF=1 disabled tool, version-skew from an older
    // server run) cannot produce a re-callable payload. The supervisor must
    // check `getToolSchema` itself because `buildSuggestedCall` fails open
    // for unregistered names by design.
    await import("../src/index.ts");

    const ctx: RestartContext = {
      toolName: "not-a-real-tool",
      durationMs: 100,
      lastStage: "target-lookup",
      lastStageElapsedMs: 50,
      lastStageMeta: undefined,
      exit: { code: 1, signal: null },
      toolArgsRedacted: { projectPath: "/p" },
      toolArgsRedactedModified: false,
      retryRecommendation: "same-request"
    };
    const reply = buildSyntheticCallToolResult(101, ctx) as {
      result: {
        structuredContent: {
          error: Record<string, unknown>;
          meta: Record<string, unknown>;
        };
      };
    };
    const error = reply.result.structuredContent.error;
    assert.equal(
      error.suggestedCall,
      undefined,
      "synthetic restart with unregistered toolName must drop suggestedCall (registry-not-registered → not re-callable)"
    );
    // Diagnostic args still surface for debug inspection.
    const restart = reply.result.structuredContent.meta.restart as Record<string, unknown>;
    assert.deepEqual(restart.redactedToolArgs, { projectPath: "/p" });
  });

  test("buildSyntheticCallToolResult drops suggestedCall when toolName is missing (caller-side skip-gate)", () => {
    // When ctx.toolName is absent the supervisor falls back to
    // tool = "unknown", which is not re-callable; skip the gate at the call
    // site rather than relying on a fail-closed unknown-tool branch (that
    // would disrupt every test exercising services without booting
    // src/index.ts). `restart.redactedToolArgs` still surfaces the args.
    const ctx: RestartContext = {
      durationMs: 100,
      lastStage: "target-lookup",
      lastStageElapsedMs: 50,
      lastStageMeta: undefined,
      exit: { code: 1, signal: null },
      toolArgsRedacted: { projectPath: "/p" },
      retryRecommendation: "same-request"
      // toolName intentionally omitted — supervisor falls back to "unknown".
    };
    const reply = buildSyntheticCallToolResult(99, ctx) as {
      result: {
        structuredContent: {
          error: Record<string, unknown>;
          meta: Record<string, unknown>;
        };
      };
    };
    const error = reply.result.structuredContent.error;
    // Caller-side skip: no suggestedCall on the public envelope when the
    // tool name was synthesized as "unknown".
    assert.equal(
      error.suggestedCall,
      undefined,
      "synthetic restart with toolName=undefined must drop suggestedCall (supervisor skips the gate for unsynthesizable names)"
    );
    // Diagnostic args still surface for debug inspection.
    const restart = reply.result.structuredContent.meta.restart as Record<string, unknown>;
    assert.deepEqual(restart.redactedToolArgs, { projectPath: "/p" });
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

  test("buildSyntheticCallToolResult EMITS suggestedCall when toolName is registered AND args satisfy the schema (clean restart path)", async () => {
    // The supervisor checks `getToolSchema` before calling
    // `buildSuggestedCall`; both the registration check and the schema gate
    // must pass for the suggestion to surface.
    await import("../src/index.ts");

    const ctx: RestartContext = {
      toolName: "validate-mixin",
      durationMs: 1,
      lastStage: "parse",
      lastStageElapsedMs: 0,
      lastStageMeta: undefined,
      exit: baseExit,
      toolArgsRedacted: {
        input: { mode: "inline", source: "package x; class Y {}" },
        version: "1.21"
      },
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
      params: {
        input: { mode: "inline", source: "package x; class Y {}" },
        version: "1.21"
      }
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

  test("buildSyntheticCallToolResult hints carry the recommendation phrase for each branch", () => {
    const id = "id-1";
    const baseCtx: RestartContext = {
      toolName: "validate-mixin",
      lastStage: "target-lookup",
      lastStageMeta: { targetIndex: 9, targetTotal: 12 },
      lastStageStartedAt: 1000,
      exit: baseExit,
      retryRecommendation: "narrow-query",
      toolArgsRedacted: undefined,
      toolArgsRedactedModified: false
    };
    const checkHint = (recommendation: RestartContext["retryRecommendation"], re: RegExp) => {
      const reply = buildSyntheticCallToolResult(id, {
        ...baseCtx,
        retryRecommendation: recommendation
      });
      const result = (reply as any).result;
      const error = result.structuredContent.error;
      assert.ok(
        Array.isArray(error.hints) && re.test(error.hints[0]),
        `expected hint for ${recommendation} to match ${re}, got: ${JSON.stringify(error.hints)}`
      );
    };
    checkHint("narrow-query", /narrow mixinConfigPath to one file and retry/);
    checkHint("clear-cache", /clear cache and retry/);
    checkHint("report-bug", /report a bug/);
    checkHint("same-request", /retry the same request/);
  });

  test("buildSyntheticCallToolResult hints fall back to stage-tracking-began message when lastStage is undefined", () => {
    const reply = buildSyntheticCallToolResult("id-2", {
      toolName: "validate-mixin",
      lastStage: undefined,
      lastStageMeta: undefined,
      lastStageStartedAt: undefined,
      exit: baseExit,
      retryRecommendation: "same-request",
      toolArgsRedacted: undefined,
      toolArgsRedactedModified: false
    });
    const error = (reply as any).result.structuredContent.error;
    assert.deepEqual(error.hints, ["worker exited before stage tracking began"]);
  });
});

describe("buildWorkerRestartReply", () => {
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

  test("buildWorkerRestartReply yields a structured envelope without throwing when lastStageStartedAt is undefined", () => {
    const { reply } = buildWorkerRestartReply(
      {
        id: "id-3",
        method: "tools/call",
        toolName: "validate-mixin",
        startedAt: 1000,
        lastStage: undefined,
        lastStageStartedAt: undefined,
        lastStageMeta: undefined
      } as PendingRequestSnapshot,
      baseExit,
      9999,
      []
    );
    // structured (CallToolResult) envelope path: result.structuredContent.error.hints
    const error = (reply as any).result?.structuredContent?.error;
    assert.ok(error && typeof error === "object", "expected structured restart envelope");
    // hints fallback when lastStage is undefined
    assert.deepEqual(error.hints, ["worker exited before stage tracking began"]);
  });
});

describe("buildLegacyJsonRpcError", () => {
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
});

describe("pruneRestartTimestamps", () => {
  test("pruneRestartTimestamps drops entries older than the window", () => {
    const now = 100_000;
    const result = pruneRestartTimestamps([10_000, 50_000, 99_000], now, 60_000);
    assert.deepEqual(result, [50_000, 99_000]);
  });

  test("pruneRestartTimestamps keeps timestamps equal to the cutoff and drops the value 1 ms older", () => {
    const now = 100_000;
    const window = 60_000;
    const cutoff = now - window;
    const result = pruneRestartTimestamps([cutoff, cutoff - 1, cutoff + 1], now, window);
    assert.deepEqual(result, [cutoff, cutoff + 1]);
  });
});

describe("buildExitTimestampGroups", () => {
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
});
