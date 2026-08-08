import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/server";

/**
 * Toggle variant of the synthetic inventory:
 * SUPERVISOR_STRUCTURED_RESTART_OFF=1 downgrades the tools/call restart
 * synthesis to the raw -32603 envelope. The flag is read at module load, so
 * this file sets it BEFORE dynamically importing the supervisor (node --test
 * runs each file in its own process; no other file sees the flag).
 *
 * Pins: the legacy toggle-off reply stays byte-identical to the premigration
 * fixture; the modern-era toggle-off reply is a raw error that gains NO
 * result-only decoration; and the synthesis is FINAL — a late
 * current-generation worker response for the id is discarded.
 */

process.env.SUPERVISOR_STRUCTURED_RESTART_OFF = "1";
const { StdioSupervisor } = await import("../../src/stdio-supervisor.ts");

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "premigration", "synthetic-shapes");
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
  emit(event: string, ...args: unknown[]): boolean;
};

type FakeScheduledTimer = NodeJS.Timeout & {
  at: number;
  callback: () => void;
  cleared: boolean;
};

type CapturedEvent = { level: string; event: string; details?: Record<string, unknown> };

type Harness = {
  child?: FakeChild;
  era?: unknown;
  handleClientMessage(message: JSONRPCMessage): void;
  handleWorkerMessage(child: FakeChild, message: JSONRPCMessage): void;
  handleWorkerReady(child: FakeChild): void;
  handleWorkerExit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void;
  spawnWorker(): void;
};

function createWorker(pid: number, writes: string[]): FakeChild {
  const stdin = new EventEmitter() as EventEmitter & FakeChild["stdin"];
  stdin.destroyed = false;
  stdin.write = (payload: string) => {
    writes.push(payload);
    return true;
  };
  const child = new EventEmitter() as unknown as EventEmitter & FakeChild;
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = new EventEmitter() as EventEmitter & FakeChild["stdout"];
  child.stderr = new EventEmitter() as EventEmitter & FakeChild["stderr"];
  child.kill = () => true;
  return child;
}

function createHarness(): {
  supervisor: Harness;
  outbound: JSONRPCMessage[];
  events: CapturedEvent[];
  children: FakeChild[];
  timers: FakeScheduledTimer[];
  setNow(value: number): void;
} {
  let now = 0;
  const timers: FakeScheduledTimer[] = [];
  const outbound: JSONRPCMessage[] = [];
  const events: CapturedEvent[] = [];
  const children = [createWorker(99_400_000, []), createWorker(99_400_001, [])];
  let spawnIndex = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: (level, event, details) => events.push({ level, event, details }),
    monotonicNow: () => now,
    workerSpawner: () => children[spawnIndex++] as never,
    treeTerminator: () => true,
    timerScheduler: (callback, delayMs) => {
      const timer = {
        at: now + delayMs,
        callback,
        cleared: false,
        unref() { return this; }
      } as unknown as FakeScheduledTimer;
      timers.push(timer);
      return timer;
    },
    timerClearer: (timer) => { (timer as FakeScheduledTimer).cleared = true; }
  } as never) as unknown as Harness;
  return { supervisor, outbound, events, children, timers, setNow(value: number) { now = value; } };
}

function legacyInitialize(id: number): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "premigration-harness", version: "0.0.0" }
    }
  } as JSONRPCRequest;
}

function initializeResult(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "synthetic-fixture", version: "1.0.0" }
    }
  } as JSONRPCMessage;
}

function toolsCall(id: number, meta?: Record<string, unknown>): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      ...(meta ? { _meta: meta } : {}),
      name: "get-runtime-metrics",
      arguments: {}
    }
  } as JSONRPCRequest;
}

function repliesFor(outbound: JSONRPCMessage[], id: number): JSONRPCMessage[] {
  return outbound.filter((message) => "id" in message && message.id === id);
}

function driveRestart(era: "legacy" | "modern"): ReturnType<typeof createHarness> {
  const harness = createHarness();
  const { supervisor, children } = harness;
  supervisor.spawnWorker();
  supervisor.handleWorkerReady(children[0]);
  if (era === "legacy") {
    supervisor.handleClientMessage(legacyInitialize(1));
    supervisor.handleWorkerMessage(children[0], initializeResult(1));
    supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
    supervisor.handleClientMessage(toolsCall(2));
  } else {
    supervisor.handleClientMessage(
      toolsCall(2, { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} })
    );
  }
  // REAL event emission (spawnWorker attached the exit/close listeners).
  children[0].emit("exit", null, "SIGKILL");
  return harness;
}

test("toggle-off legacy restart reply stays byte-identical to the premigration fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "restart-toolscall-toggle-off.json"), "utf8")
  ) as { reply: unknown };
  const harness = driveRestart("legacy");
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], fixture.reply);
});

test("toggle-off modern restart reply is a raw -32603 with no modern decoration and is final against a late response", () => {
  const harness = driveRestart("modern");
  const replies = repliesFor(harness.outbound, 2);
  assert.equal(replies.length, 1);
  const reply = replies[0] as { error?: { code?: number } };
  assert.equal(reply.error?.code, -32603, "toggle-off must downgrade the modern tools/call restart to the raw envelope");
  const serialized = JSON.stringify(replies[0]);
  assert.equal(serialized.includes("resultType"), false, "the raw toggle-off envelope must not gain resultType");
  assert.equal(serialized.includes(SERVER_INFO_KEY), false, "the raw toggle-off envelope must not gain the serverInfo _meta key");
  assert.equal(serialized.includes("ttlMs"), false);
  assert.equal(serialized.includes("cacheScope"), false);

  // Finality: adopt the replacement generation and deliver a late response.
  const retry = harness.timers.find((timer) => timer.at === 100 && !timer.cleared);
  assert.ok(retry, "restart retry timer must be armed");
  harness.setNow(100);
  retry.callback();
  assert.equal(harness.supervisor.child, harness.children[1]);
  harness.supervisor.handleWorkerMessage(harness.children[1], {
    jsonrpc: "2.0",
    id: 2,
    result: { late: true }
  } as JSONRPCMessage);
  assert.equal(
    repliesFor(harness.outbound, 2).length,
    1,
    "a late current-generation response for the toggle-off synthesized id must be discarded"
  );
  assert.equal(
    harness.events.some((event) => event.event === "supervisor.late_response_discarded"),
    true,
    "the discarded late response must be logged"
  );
});
