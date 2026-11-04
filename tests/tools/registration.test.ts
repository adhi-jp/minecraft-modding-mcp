import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { z } from "zod";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";
import { getToolSchema, listRegisteredTools } from "../../src/tool-schema-registry.ts";
import { ALIAS_TOOL_NAMES, CATALOG_TOOL_NAMES } from "../../src/tools/inventory.ts";
import type { CatalogToolSpec } from "../../src/tools/types.ts";
import { startCatalogSession } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-registration-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

function probeSpec(name: string): CatalogToolSpec {
  return {
    name,
    description: `Test-only catalog tool ${name}.`,
    annotations: { readOnlyHint: true },
    inputSchema: z.strictObject({ query: z.string().optional() }),
    examples: [{}],
    statuses: ["ok"],
    handler: async () => ({ result: { name } })
  };
}

// Registered in this order: legacy keeps it, modern sorts the group by name.
const PROBES = [probeSpec("zeta-probe"), probeSpec("alpha-probe")];

async function listedNames(specs: readonly CatalogToolSpec[], era: "legacy" | "modern"): Promise<string[]> {
  const session = await startCatalogSession(specs, era);
  try {
    return await session.listToolNames();
  } finally {
    await session.close();
  }
}

test("both eras list catalog tools first, each group in its era's order", async () => {
  const legacyAliases = await listedNames([], "legacy");
  const modernAliases = await listedNames([], "modern");
  assert.deepEqual([...legacyAliases].sort(), [...ALIAS_TOOL_NAMES].sort(), "without catalog tools the 8.x tools are listed");
  assert.deepEqual(modernAliases, [...legacyAliases].sort(), "the modern era sorts the 8.x tools by name");

  for (let build = 1; build <= 2; build += 1) {
    assert.deepEqual(
      await listedNames(PROBES, "legacy"),
      ["zeta-probe", "alpha-probe", ...legacyAliases],
      `legacy build ${build}: catalog tools in registration order, then the 8.x tools in call-site order`
    );
    assert.deepEqual(
      await listedNames(PROBES, "modern"),
      ["alpha-probe", "zeta-probe", ...modernAliases],
      `modern build ${build}: catalog tools sorted, then the 8.x tools sorted`
    );
  }
});

test("repeated builds register each catalog schema once and keep the registry consistent", async () => {
  await listedNames(PROBES, "legacy");
  const afterFirst = listRegisteredTools();
  await listedNames(PROBES, "legacy");
  await listedNames(PROBES, "modern");
  assert.deepEqual(listRegisteredTools(), afterFirst, "rebuilding adds and replaces nothing");
  for (const spec of PROBES) {
    assert.equal(getToolSchema(spec.name), spec.inputSchema, `${spec.name} is registered with its validating schema`);
  }
  for (const name of [...CATALOG_TOOL_NAMES, ...ALIAS_TOOL_NAMES]) {
    assert.ok(getToolSchema(name) !== undefined, `${name} is in the tool schema registry`);
  }
});

test("a catalog tool registered in the worker is callable by name", async () => {
  const session = await startCatalogSession(PROBES, "legacy");
  try {
    const frame = await session.callTool("alpha-probe", {});
    const structured = frame.result?.structuredContent as { result?: unknown; meta?: { tool?: unknown } };
    assert.deepEqual(structured.result, { name: "alpha-probe" });
    assert.equal(structured.meta?.tool, "alpha-probe");
  } finally {
    await session.close();
  }
});

type SupervisorHarness = {
  child?: unknown;
  childReady: boolean;
  liveChildren: Set<unknown>;
  handleClientMessage(message: JSONRPCMessage): void;
};

test("in the legacy era an unknown tool still gets the frozen not-found reply while a catalog tool is forwarded", async () => {
  // Populate the registry exactly as the supervisor process does (src/cli.ts imports the app first).
  await listedNames(PROBES, "legacy");
  const outbound: JSONRPCMessage[] = [];
  const workerWrites: string[] = [];
  const supervisor = new StdioSupervisor({
    entryFile: "registration-fixture.ts",
    clientWriter: (message: JSONRPCMessage) => outbound.push(message),
    eventWriter: () => {}
  } as never) as unknown as SupervisorHarness;
  const child = {
    pid: 4343,
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
    id: 31,
    method: "tools/call",
    params: { name: "no-such-catalog-tool", arguments: {} }
  } as JSONRPCMessage);
  const reply = outbound.find((frame) => (frame as { id?: unknown }).id === 31) as { result?: unknown } | undefined;
  assert.deepEqual(reply?.result, {
    content: [{ type: "text", text: "MCP error -32602: Tool no-such-catalog-tool not found" }],
    isError: true
  });
  assert.equal(workerWrites.some((payload) => payload.includes("no-such-catalog-tool")), false);

  supervisor.handleClientMessage({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "zeta-probe", arguments: {} }
  } as JSONRPCMessage);
  assert.equal(outbound.some((frame) => (frame as { id?: unknown }).id === 32), false, "no synthetic reply");
  assert.ok(workerWrites.some((payload) => payload.includes("\"zeta-probe\"")), "the catalog call reaches the worker");
});
