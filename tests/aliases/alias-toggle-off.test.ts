import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import type { JSONRPCMessage } from "@modelcontextprotocol/server";

import { ALIAS_TOOL_NAMES, CATALOG_TOOL_INVENTORY, CATALOG_TOOL_NAMES } from "../../src/tools/inventory.ts";
import {
  MODERN_META,
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "../stdio/inprocess-era-serve.ts";

/**
 * `MCP_DEPRECATED_TOOLS=off`: the 8.x aliases are neither listed nor
 * callable in either era and stay out of the tool schema registry, while the
 * catalog is served as usual. The `instructions` primer of both eras leaves
 * out its sentence about the deprecated aliases. The supervisor treats a
 * switched-off alias like any unknown name: its synthetic replies carry no
 * `meta.deprecated`, and it gets no long-running deadline. The server reads
 * the switch when it loads, so the environment is set here before the first
 * dynamic import of the server module, in a file of its own.
 */

process.env.MCP_DEPRECATED_TOOLS = "off";
const root = mkdtempSync(join(tmpdir(), "alias-toggle-off-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const ALIAS_PROBE = "list-versions";
const CATALOG_PROBE = "server-metrics";

let legacy: InProcessSession;
let modern: InProcessSession;
let legacyInstructions: unknown;

async function listNames(session: InProcessSession, params: Record<string, unknown>, id: string): Promise<string[]> {
  const frame = await session.request({ jsonrpc: "2.0", id, method: "tools/list", params });
  assert.equal(frame.error, undefined, `tools/list ${id} must succeed`);
  return (frame.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
}

before(async () => {
  legacy = await startInProcessSession();
  legacyInstructions = (await legacyHandshake(legacy, "2025-06-18", "toggle-off-init")).result?.instructions;
  modern = await startInProcessSession();
});

after(async () => {
  await legacy?.close();
  await modern?.close();
});

test("the switch is read as off", async () => {
  const { config } = await import("../../src/index.ts");
  assert.equal(config.deprecatedToolsEnabled, false);
});

test("both eras send the instructions primer without the deprecated-alias sentence", async () => {
  const { serverInstructions } = await import("../../src/index.ts");
  const discover = await modern.request({
    jsonrpc: "2.0",
    id: "toggle-off-discover",
    method: "server/discover",
    params: { _meta: MODERN_META }
  });
  const served = serverInstructions(true);
  const primer = serverInstructions(false);
  assert.match(served, /deprecated aliases/, "positive control: the primer of a server with aliases names them");
  assert.ok(served.startsWith(`${primer} `), "only the last sentence differs");
  for (const [era, instructions] of [["legacy", legacyInstructions], ["modern", discover.result?.instructions]] as const) {
    assert.equal(instructions, primer, `${era} instructions`);
    assert.doesNotMatch(String(instructions), /deprecated|8\.x/, `${era} instructions name no alias`);
  }
});

test("both eras list only the catalog tools", async () => {
  const catalogOrder = CATALOG_TOOL_INVENTORY.map((entry) => entry.name);
  assert.deepEqual(await listNames(legacy, {}, "toggle-off-legacy-list"), catalogOrder);
  assert.deepEqual(
    await listNames(modern, { _meta: MODERN_META }, "toggle-off-modern-list"),
    [...catalogOrder].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  );
});

test("the tool schema registry holds the catalog tools and no alias", async () => {
  const { getToolSchema, listRegisteredTools } = await import("../../src/tool-schema-registry.ts");
  for (const name of ALIAS_TOOL_NAMES) {
    assert.equal(getToolSchema(name), undefined, `${name} is not registered`);
  }
  assert.deepEqual(listRegisteredTools(), [...CATALOG_TOOL_NAMES].sort());
});

test("in the modern era an alias call fails as an unknown tool while a catalog tool answers", async () => {
  const aliasCall = await modern.request({
    jsonrpc: "2.0",
    id: "toggle-off-modern-alias",
    method: "tools/call",
    params: { _meta: MODERN_META, name: ALIAS_PROBE, arguments: {} }
  });
  assert.equal(aliasCall.result, undefined, "no tool result");
  assert.equal(aliasCall.error?.code, -32602);
  assert.match(aliasCall.error?.message ?? "", new RegExp(`Tool ${ALIAS_PROBE} not found`));

  const catalogCall = await modern.request({
    jsonrpc: "2.0",
    id: "toggle-off-modern-catalog",
    method: "tools/call",
    params: { _meta: MODERN_META, name: CATALOG_PROBE, arguments: {} }
  });
  assert.equal(catalogCall.error, undefined);
  const envelope = catalogCall.result?.structuredContent as { result?: unknown; meta?: Record<string, unknown> };
  assert.ok(envelope.result, "the catalog tool answers");
  assert.equal(envelope.meta?.tool, CATALOG_PROBE);
  assert.equal("deprecated" in (envelope.meta ?? {}), false, "a catalog reply carries no deprecation block");
});

type SupervisorHarness = {
  child?: unknown;
  childReady: boolean;
  liveChildren: Set<unknown>;
  handleClientMessage(message: JSONRPCMessage): void;
};

test("in the legacy era the supervisor answers an alias call with the frozen not-found reply and forwards a catalog call", async () => {
  // The registry was populated by the server module above, as src/cli.ts
  // loads the server before the supervisor starts.
  const { StdioSupervisor } = await import("../../src/stdio-supervisor.ts");
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "toggle-off-fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {}
  } as never) as unknown as SupervisorHarness;
  const child = {
    pid: 4344,
    stdin: {
      destroyed: false,
      write(payload: string) {
        workerWrites.push(payload);
        return true;
      },
      removeAllListeners() {}
    },
    stdout: { removeAllListeners() {} },
    stderr: { removeAllListeners() {} },
    kill: () => true
  };
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }
  } as JSONRPCMessage);
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} } as JSONRPCMessage);
  workerWrites.length = 0;

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: { name: ALIAS_PROBE, arguments: {} }
  } as JSONRPCMessage);
  const reply = outbound.find((frame) => (frame as { id?: unknown }).id === 41) as { result?: unknown } | undefined;
  assert.deepEqual(reply?.result, {
    content: [{ type: "text", text: `MCP error -32602: Tool ${ALIAS_PROBE} not found` }],
    isError: true
  });
  assert.equal(workerWrites.some((payload) => payload.includes(ALIAS_PROBE)), false, "the alias call never reaches the worker");

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: CATALOG_PROBE, arguments: {} }
  } as JSONRPCMessage);
  assert.equal(outbound.some((frame) => (frame as { id?: unknown }).id === 42), false, "no synthetic reply");
  assert.ok(workerWrites.some((payload) => payload.includes(`"${CATALOG_PROBE}"`)), "the catalog call reaches the worker");
});

type FakeWorker = EventEmitter & {
  pid: number;
  stdin: EventEmitter & { destroyed: boolean; write(payload: string): boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(): boolean;
};

type FakeTimer = { at: number; callback: () => void; cleared: boolean; unref(): FakeTimer };

type ManagedSupervisor = {
  spawnWorker(): void;
  handleWorkerReady(child: FakeWorker): void;
  handleWorkerMessage(child: FakeWorker, message: JSONRPCMessage): void;
  handleClientMessage(message: JSONRPCMessage): void;
};

/** A supervisor over fake workers and fake timers, in this process's (switched-off) registry. */
async function managedSupervisor(): Promise<{
  supervisor: ManagedSupervisor;
  workers: FakeWorker[];
  outbound: Array<JSONRPCMessage & { id?: unknown; result?: Record<string, unknown> }>;
  timers: FakeTimer[];
  setNow(value: number): void;
}> {
  const { StdioSupervisor } = await import("../../src/stdio-supervisor.ts");
  let now = 0;
  const outbound: Array<JSONRPCMessage & { id?: unknown; result?: Record<string, unknown> }> = [];
  const timers: FakeTimer[] = [];
  const workers = [0, 1].map((index) => {
    const stdin = Object.assign(new EventEmitter(), { destroyed: false, write: () => true });
    return Object.assign(new EventEmitter(), {
      pid: 99_600_000 + index,
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true
    }) as FakeWorker;
  });
  let spawned = 0;
  const supervisor = new StdioSupervisor({
    entryFile: "toggle-off-fixture.ts",
    validateProjectTimeoutMs: 10_000,
    clientWriter: (message: JSONRPCMessage) => outbound.push(message as never),
    eventWriter: () => {},
    monotonicNow: () => now,
    workerSpawner: () => workers[spawned++] as never,
    treeTerminator: () => true,
    timerScheduler: (callback: () => void, delayMs: number) => {
      const timer: FakeTimer = { at: now + delayMs, callback, cleared: false, unref: () => timer };
      timers.push(timer);
      return timer as never;
    },
    timerClearer: (timer: unknown) => {
      (timer as FakeTimer).cleared = true;
    }
  } as never) as unknown as ManagedSupervisor;
  supervisor.spawnWorker();
  supervisor.handleWorkerReady(workers[0]!);
  return { supervisor, workers, outbound, timers, setNow: (value) => { now = value; } };
}

test("in the legacy era a queue-overflow reply to a switched-off alias equals the one to an unknown tool", async () => {
  const { supervisor, workers, outbound } = await managedSupervisor();
  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } }
  } as JSONRPCMessage);
  supervisor.handleWorkerMessage(workers[0]!, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } }
  } as JSONRPCMessage);
  supervisor.handleClientMessage({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
    supervisor.handleClientMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } as JSONRPCMessage);
  // One running call, a queued long-running barrier and one more queued call
  // fill the queue, so the next two calls overflow before any name check.
  call(2, CATALOG_PROBE);
  call(3, "project-validate", { projectPath: "/workspace/example-mod" });
  call(4, CATALOG_PROBE);
  call(5, "validate-project", { task: "mixin" });
  call(6, "no-such-tool");

  const body = (id: number) => {
    const reply = outbound.find((frame) => frame.id === id);
    const structured = reply?.result?.structuredContent as { error: Record<string, unknown>; meta: Record<string, unknown> };
    assert.ok(structured, `id ${id} gets a structured overflow reply`);
    return structured;
  };
  const alias = body(5);
  const unknown = body(6);
  assert.equal(alias.error.code, "ERR_LIMIT_EXCEEDED");
  assert.equal("deprecated" in alias.meta, false, "a switched-off alias carries no deprecation block");
  assert.deepEqual(alias.meta, unknown.meta);
  assert.deepEqual({ ...alias.error, instance: undefined }, { ...unknown.error, instance: undefined });
});

test("in the modern era a switched-off long-running alias gets no deadline and no timeout reply", async () => {
  const { supervisor, outbound, timers, setNow } = await managedSupervisor();
  const call = (id: number, name: string, args: Record<string, unknown>) =>
    supervisor.handleClientMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { _meta: MODERN_META, name, arguments: args }
    } as JSONRPCMessage);
  call(2, "project-validate", { projectPath: "/workspace/example-mod" });
  const projectDeadlines = timers.filter((timer) => !timer.cleared && timer.at === 10_000);
  assert.equal(projectDeadlines.length, 1, "the catalog long-running call is armed (positive control)");

  call(3, "validate-project", { projectPath: "/workspace/example-mod" });
  assert.deepEqual(
    timers.filter((timer) => !timer.cleared).map((timer) => timer.at),
    [10_000],
    "the switched-off alias gets no deadline of its own"
  );

  setNow(10_000);
  projectDeadlines[0]!.callback();
  const timedOut = outbound.find((frame) => frame.id === 2)?.result?.structuredContent as { error?: { code?: string } };
  assert.equal(timedOut?.error?.code, "ERR_TOOL_TIMEOUT", "the catalog call times out");
  assert.equal(outbound.some((frame) => frame.id === 3), false, "the switched-off alias gets no timeout reply");
});
