import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { z } from "zod";
import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";
import {
  clearRegisteredToolsForTest,
  registerToolSchema
} from "../../src/tool-schema-registry.ts";

/**
 * Legacy-era unknown-tool intercept: the premigration contract returned a
 * successful isError result for an unregistered tool name, and the
 * supervisor restores exactly that on the legacy wire.
 *
 * The v1 SDK answered tools/call for an unregistered name (typo OR
 * flag-disabled tool — indistinguishable by design) with a SUCCESSFUL
 * isError CallToolResult embedding "MCP error -32602: Tool <name> not
 * found" (frozen in tests/fixtures/premigration/error-code-inventory.json
 * and pinned by tests/manual/stdio-client-smoke.manual.ts). The v2 SDK
 * throws InvalidParams instead, so WITHOUT the supervisor intercept the
 * legacy wire regressed to a raw JSON-RPC -32602.
 *
 * Restore semantics: a LEGACY-era-admitted tools/call whose params.name has
 * no tool-schema registry entry (the same env-flag-gated registry the
 * synthetic builders consult; populated in the supervisor process because
 * src/cli.ts imports ./index.js before the supervisor starts) is answered
 * pre-forward/pre-queue with the frozen v1 envelope, in the originating
 * framing, WITHOUT consuming a queue slot and WITHOUT a finality tombstone
 * (never-forwarded ⇒ no tombstone entitlement). The modern era keeps the
 * raw -32602 (sanctioned modern contract), and white-box suites that run
 * with an EMPTY registry keep today's forwarding behavior (the intercept is
 * gated on a populated registry).
 */

const FROZEN_INVENTORY = JSON.parse(
  readFileSync(new URL("../fixtures/premigration/error-code-inventory.json", import.meta.url), "utf8")
) as { entries: Array<{ path: string; reply?: Record<string, unknown> }> };
const FROZEN_DISABLED_TOOL_REPLY = FROZEN_INVENTORY.entries.find(
  (entry) => entry.path === "disabled-tool"
)?.reply as Record<string, unknown>;

function frozenNotFoundResult(name: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }],
    isError: true
  };
}

// ── Wire half (real supervisor + real worker) ──────────────────────

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

type Frame = Record<string, unknown> & { id?: unknown };

async function canUseNativeStdioPipes(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(42));setTimeout(()=>process.exit(0),150);"],
      { stdio: ["pipe", "ignore", "ignore"] }
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === 0));
  });
}

function startWireSupervisor(root: string): {
  child: ChildProcessWithoutNullStreams;
  frames: Frame[];
  workerReady: () => boolean;
  send: (message: object) => void;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BATCH_TOOLS_OFF: "1",
      MCP_SUPERVISOR_DEBUG: "1",
      MCP_CACHE_DIR: join(root, "cache"),
      MCP_SQLITE_PATH: join(root, "cache", "source-cache.db")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let buffer = "";
  const frames: Frame[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        frames.push(JSON.parse(line) as Frame);
      } catch {
        // Ignore non-JSON stdout noise.
      }
    }
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  return {
    child,
    frames,
    workerReady: () => stderrBuffer.includes("supervisor.debug.worker_ready"),
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function wireReply(session: { frames: Frame[] }, id: number | string, label: string): Promise<Frame> {
  await waitFor(() => session.frames.some((frame) => frame.id === id), 30_000, label);
  return session.frames.find((frame) => frame.id === id)!;
}

test("wire legacy (BATCH_TOOLS_OFF=1): flag-disabled and typo tools/call both answer the frozen v1 isError envelope, indistinguishably", { timeout: 150_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "unknown-tool-wire-"));
  const session = startWireSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 90_000, "supervisor worker_ready adoption");

  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "unknown-tool-intercept-test", version: "1.0.0" }
    }
  });
  await wireReply(session, 1, "initialize reply");
  session.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  // id 2 matches the frozen baseline row's request id, so the WHOLE reply
  // object must deep-equal the frozen premigration fixture reply verbatim.
  session.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "batch-class-source", arguments: {} } });
  const disabled = await wireReply(session, 2, "flag-disabled tool reply");
  assert.ok(FROZEN_DISABLED_TOOL_REPLY, "the frozen baseline must carry the disabled-tool reply");
  assert.deepEqual(
    disabled,
    FROZEN_DISABLED_TOOL_REPLY,
    "the flag-disabled tools/call must answer the FROZEN premigration reply verbatim"
  );
  const disabledResult = disabled.result as Record<string, unknown>;
  assert.equal("structuredContent" in disabledResult, false, "the frozen envelope carries no structuredContent");

  session.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "no-such-tool-p3-typo", arguments: {} } });
  const typo = await wireReply(session, 3, "typo tool reply");
  assert.equal(typo.error, undefined, "a typo name must also answer the in-band envelope");
  assert.deepEqual(
    typo.result,
    frozenNotFoundResult("no-such-tool-p3-typo"),
    "the typo tools/call must answer the same frozen envelope shape"
  );

  // Indistinguishability: modulo the tool name, both results are identical.
  assert.deepEqual(disabledResult, frozenNotFoundResult("batch-class-source"));
});

test("wire modern guard: a registry-miss tools/call keeps the raw JSON-RPC -32602 (sanctioned modern contract)", { timeout: 150_000 }, async (t) => {
  if (!(await canUseNativeStdioPipes())) {
    t.skip("native child-process stdio pipes close immediately in this runtime");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "unknown-tool-modern-"));
  const session = startWireSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 90_000, "supervisor worker_ready adoption");

  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} },
      name: "batch-class-source",
      arguments: {}
    }
  });
  const reply = await wireReply(session, 1, "modern registry-miss reply");
  assert.equal(reply.result, undefined, "the modern era must NOT synthesize the legacy envelope");
  assert.deepEqual(reply.error, { code: -32602, message: "Tool batch-class-source not found" });
});

// ── White-box half (in-process supervisor, fake worker) ────────────

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
};

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  era?: unknown;
  liveChildren: Set<FakeChild>;
  unresolvedTreeTokens: Set<number>;
  queuedRequests: Array<{ message: JSONRPCRequest; pending: { id: string | number } }>;
  queuedNotifications: JSONRPCMessage[];
  pendingRequests: Map<string, unknown>;
  syntheticTombstones: Map<string, unknown>;
  handleClientMessage(message: JSONRPCMessage): void;
};

function createWorker(pid: number, writes: string[]): FakeChild {
  return {
    pid,
    stdin: {
      destroyed: false,
      write(payload) {
        writes.push(payload);
        return true;
      },
      removeAllListeners() {}
    },
    stdout: { removeAllListeners() {} },
    stderr: { removeAllListeners() {} },
    kill: () => true
  };
}

function createHarness(options: { workerReady: boolean }): {
  supervisor: Harness;
  outbound: JSONRPCMessage[];
  workerWrites: string[];
} {
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {}
  } as never) as unknown as Harness;
  if (options.workerReady) {
    const child = createWorker(4242, workerWrites);
    supervisor.child = child;
    supervisor.childReady = true;
    supervisor.liveChildren.add(child);
  }
  return { supervisor, outbound, workerWrites };
}

function legacyHandshakeFrames(supervisor: Harness): void {
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }
  } as JSONRPCMessage);
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} } as JSONRPCMessage);
}

function claimlessCall(id: number | string, name: string): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } } as JSONRPCMessage;
}

function withPopulatedRegistry(t: { after(fn: () => void): void }): void {
  clearRegisteredToolsForTest();
  registerToolSchema("list-versions", z.object({}));
  t.after(() => clearRegisteredToolsForTest());
}

test("white-box: with an EMPTY registry a legacy registry-miss tools/call forwards unchanged (unit-suite compatibility gate)", (t) => {
  clearRegisteredToolsForTest();
  t.after(() => clearRegisteredToolsForTest());
  const { supervisor, outbound, workerWrites } = createHarness({ workerReady: true });
  legacyHandshakeFrames(supervisor);
  workerWrites.length = 0;

  supervisor.handleClientMessage(claimlessCall(11, "definitely-not-registered"));

  assert.equal(outbound.some((frame) => (frame as { id?: unknown }).id === 11), false, "no synthetic reply with an empty registry");
  assert.ok(
    workerWrites.some((payload) => payload.includes("\"definitely-not-registered\"")),
    "the request must forward to the worker exactly as before"
  );
});

test("white-box: a legacy registry-miss tools/call is answered with the frozen envelope pre-forward, and a registry HIT still forwards", (t) => {
  withPopulatedRegistry(t);
  const { supervisor, outbound, workerWrites } = createHarness({ workerReady: true });
  legacyHandshakeFrames(supervisor);
  workerWrites.length = 0;

  supervisor.handleClientMessage(claimlessCall(21, "batch-class-source"));
  const intercepted = outbound.find((frame) => (frame as { id?: unknown }).id === 21) as
    | { result?: unknown; error?: unknown }
    | undefined;
  assert.ok(intercepted, "the registry miss must be answered synthetically");
  assert.equal(intercepted.error, undefined);
  assert.deepEqual(intercepted.result, frozenNotFoundResult("batch-class-source"));
  assert.equal(
    workerWrites.some((payload) => payload.includes("batch-class-source")),
    false,
    "the intercepted request must never reach the worker"
  );

  supervisor.handleClientMessage(claimlessCall(22, "list-versions"));
  assert.ok(
    workerWrites.some((payload) => payload.includes("\"list-versions\"")),
    "a registered tool must forward exactly as today"
  );
  assert.equal(supervisor.pendingRequests.has("number:22"), true, "the forwarded call goes pending as before");
});

test("white-box: worker-down legacy registry-miss answers immediately without consuming a queue slot", (t) => {
  withPopulatedRegistry(t);
  const { supervisor, outbound } = createHarness({ workerReady: false });
  legacyHandshakeFrames(supervisor);

  supervisor.handleClientMessage(claimlessCall(31, "batch-class-source"));

  const reply = outbound.find((frame) => (frame as { id?: unknown }).id === 31) as
    | { result?: unknown }
    | undefined;
  assert.ok(reply, "the intercept must answer even with the worker down");
  assert.deepEqual(reply.result, frozenNotFoundResult("batch-class-source"));
  assert.equal(
    supervisor.queuedRequests.some((entry) => entry.pending.id === 31),
    false,
    "the intercepted request must not occupy a supervisor queue slot"
  );
  assert.equal(supervisor.pendingRequests.size, 0, "nothing goes pending for an intercepted request");
});

test("white-box: an intercepted id records NO finality tombstone and a subsequent legitimate reuse of the id serves normally", (t) => {
  withPopulatedRegistry(t);
  const { supervisor, outbound, workerWrites } = createHarness({ workerReady: true });
  legacyHandshakeFrames(supervisor);
  workerWrites.length = 0;

  supervisor.handleClientMessage(claimlessCall(41, "batch-class-source"));
  assert.ok(outbound.some((frame) => (frame as { id?: unknown }).id === 41), "the miss is answered synthetically");
  assert.equal(
    supervisor.syntheticTombstones.has("number:41"),
    false,
    "never-forwarded synthesis must not record a finality tombstone"
  );

  // The client may legally reuse the id after the terminal reply: a
  // registered tool under the same id must forward and go pending.
  supervisor.handleClientMessage(claimlessCall(41, "list-versions"));
  assert.ok(
    workerWrites.some((payload) => payload.includes("\"list-versions\"")),
    "the reused id must forward to the worker"
  );
  assert.equal(supervisor.pendingRequests.has("number:41"), true, "the reused id goes pending normally");
});

test("white-box: a cap-blocked legacy registry-miss keeps the worker-restart envelope (degraded-state row preserved)", (t) => {
  // Pre-migration, a registry-miss tools/call issued while the worker is
  // terminalized (restart cap reached) received the SAME synthetic restart
  // envelope as any other request — the degraded state answers first, and
  // the intercept must not mask it.
  withPopulatedRegistry(t);
  const { supervisor, outbound } = createHarness({ workerReady: false });
  supervisor.unresolvedTreeTokens.add(9001);
  supervisor.unresolvedTreeTokens.add(9002);
  legacyHandshakeFrames(supervisor);

  supervisor.handleClientMessage(claimlessCall(71, "batch-class-source"));

  const reply = outbound.find((frame) => (frame as { id?: unknown }).id === 71) as
    | { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } }
    | undefined;
  assert.ok(reply?.result, "the cap-blocked state must answer synthetically");
  assert.equal(reply.result.isError, true);
  assert.equal(
    reply.result.structuredContent?.error?.code,
    "ERR_WORKER_RESTART",
    "the cap-blocked degraded state must answer the restart envelope, not the not-found envelope"
  );
});

test("white-box: a queue-overflow legacy registry-miss keeps the queue-limit envelope (degraded-state row preserved)", (t) => {
  // Pre-migration, a registry-miss tools/call arriving over a full
  // supervisor queue received ERR_LIMIT_EXCEEDED like any other tools/call —
  // overflow answers first, and the intercept must not consume the request
  // before the overflow check.
  withPopulatedRegistry(t);
  const { supervisor, outbound } = createHarness({ workerReady: false });
  legacyHandshakeFrames(supervisor);

  // Two registered calls fill the queue while the worker is down.
  supervisor.handleClientMessage(claimlessCall(81, "list-versions"));
  supervisor.handleClientMessage(claimlessCall(82, "list-versions"));
  assert.equal(supervisor.queuedRequests.length, 2, "precondition: the supervisor queue is full");

  supervisor.handleClientMessage(claimlessCall(83, "batch-class-source"));

  const reply = outbound.find((frame) => (frame as { id?: unknown }).id === 83) as
    | { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } }
    | undefined;
  assert.ok(reply?.result, "the overflow state must answer synthetically");
  assert.equal(reply.result.isError, true);
  assert.equal(
    reply.result.structuredContent?.error?.code,
    "ERR_LIMIT_EXCEEDED",
    "the queue-overflow degraded state must answer the queue-limit envelope, not the not-found envelope"
  );
});

test("white-box: era ordering guards — unselected stays missing_meta and a modern-locked miss is never intercepted", (t) => {
  withPopulatedRegistry(t);

  // Unselected: rule-5 missing_meta rejection wins (admission precedes the
  // intercept; no era is selected by a claim-less tools/call).
  {
    const { supervisor, outbound } = createHarness({ workerReady: true });
    supervisor.handleClientMessage(claimlessCall(51, "batch-class-source"));
    const rejection = outbound.find((frame) => (frame as { id?: unknown }).id === 51) as
      | { error?: { code?: number; data?: { kind?: string } } }
      | undefined;
    assert.equal(rejection?.error?.code, -32602);
    assert.equal(rejection?.error?.data?.kind, "missing_meta", "the unselected state keeps the rule-5 rejection");
  }

  // Modern-locked: the enveloped miss forwards to the worker (which answers
  // the sanctioned raw -32602); the intercept must not fire.
  {
    const { supervisor, outbound, workerWrites } = createHarness({ workerReady: true });
    supervisor.handleClientMessage({
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        _meta: { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} },
        name: "batch-class-source",
        arguments: {}
      }
    } as JSONRPCMessage);
    assert.equal(outbound.some((frame) => (frame as { id?: unknown }).id === 61), false, "no synthetic reply on the modern era");
    assert.ok(
      workerWrites.some((payload) => payload.includes("batch-class-source")),
      "the modern miss must forward to the worker unchanged"
    );
  }
});
