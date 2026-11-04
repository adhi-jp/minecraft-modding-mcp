import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { redactToolArgs } from "../../src/stdio-supervisor.ts";
import {
  ALIAS_REMOVAL_VERSION,
  ALIAS_TOOL_INVENTORY,
  CATALOG_TOOL_NAMES,
  aliasDeprecation
} from "../../src/tools/inventory.ts";
import {
  MODERN_META,
  legacyHandshake,
  startInProcessSession,
  type Frame,
  type InProcessSession
} from "../stdio/inprocess-era-serve.ts";
import { expectedDeprecation } from "./deprecation.ts";

/**
 * Every alias reply carries `meta.deprecated`: the catalog tools that
 * replace the alias — only the task's tool when a multiplexed alias is
 * called with one of its tasks — and the removal release, in the JSON text
 * and in `structuredContent` alike, on success and on error, while the rest
 * of the 8.x reply is unchanged.
 */

const root = mkdtempSync(join(tmpdir(), "alias-replies-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
delete process.env.MCP_DEPRECATED_TOOLS;

test("aliasDeprecation names an alias's replacements and the removal release, and nothing for other names", () => {
  assert.equal(ALIAS_REMOVAL_VERSION, "10.0.0");
  for (const entry of ALIAS_TOOL_INVENTORY) {
    assert.deepEqual(aliasDeprecation(entry.name), { replacedBy: [...entry.replacedBy], removeIn: "10.0.0" }, entry.name);
  }
  for (const name of [...CATALOG_TOOL_NAMES, "no-such-tool", undefined]) {
    assert.equal(aliasDeprecation(name), undefined, String(name));
  }
});

test("aliasDeprecation narrows a multiplexed alias to the tool of a known task and keeps the full list otherwise", () => {
  assert.deepEqual(aliasDeprecation("analyze-symbol", { task: "exact-map" }), { replacedBy: ["symbol-map"], removeIn: "10.0.0" });
  assert.deepEqual(aliasDeprecation("inspect-minecraft", { task: "class-overview", subject: {} }), {
    replacedBy: ["class-find"],
    removeIn: "10.0.0"
  });
  const multiplexed = ALIAS_TOOL_INVENTORY.filter((entry) => entry.tasks !== undefined);
  assert.equal(multiplexed.length, 5, "the five multiplexed tools");
  for (const entry of multiplexed) {
    for (const [task, tool] of Object.entries(entry.tasks!)) {
      assert.deepEqual(aliasDeprecation(entry.name, { task }), { replacedBy: [tool], removeIn: "10.0.0" }, `${entry.name} ${task}`);
      assert.deepEqual(aliasDeprecation(entry.name, { task }), expectedDeprecation(entry.name, { task }));
    }
    const full = { replacedBy: [...entry.replacedBy], removeIn: "10.0.0" };
    for (const args of [{ task: "auto" }, { task: "constructor" }, { task: "__proto__" }, { task: 3 }, {}, null, [], "versions", undefined]) {
      assert.deepEqual(aliasDeprecation(entry.name, args), full, `${entry.name} with ${JSON.stringify(args)}`);
    }
  }
  assert.deepEqual(aliasDeprecation("list-versions", { task: "versions" }), { replacedBy: ["version-list"], removeIn: "10.0.0" });
});

test("aliasDeprecation reads the task only as an own property of the arguments", () => {
  const full = expectedDeprecation("validate-project");
  assert.equal(full.replacedBy.length, 3);
  const wire = JSON.parse('{"__proto__":{"task":"mixin"},"projectPath":"/workspace/example-mod"}') as Record<string, unknown>;
  // The supervisor's redacted copy assigns the `__proto__` key, which makes
  // `{ task: "mixin" }` the copy's prototype; the handler sees the parsed
  // object, where `__proto__` is an own key. Both name every replacement.
  const redacted = redactToolArgs(wire).args;
  assert.equal((redacted as { task?: unknown }).task, "mixin", "the redacted copy inherits task");
  for (const args of [wire, redacted, Object.create({ task: "mixin" })]) {
    assert.deepEqual(aliasDeprecation("validate-project", args), full);
  }
  assert.deepEqual(aliasDeprecation("validate-project", { task: "mixin" }), { replacedBy: ["mixin-validate"], removeIn: "10.0.0" });
});

test("aliasDeprecation returns a fresh list each time", () => {
  const first = aliasDeprecation("get-class-source")!;
  first.replacedBy.push("mutated");
  assert.deepEqual(aliasDeprecation("get-class-source")!.replacedBy, ["source-read", "source-export"]);
});

let legacy: InProcessSession;
let modern: InProcessSession;
let nextId = 0;

before(async () => {
  legacy = await startInProcessSession();
  await legacyHandshake(legacy, "2025-06-18", "alias-replies-init");
  modern = await startInProcessSession();
});

after(async () => {
  await legacy?.close();
  await modern?.close();
});

type Envelope = { result?: unknown; error?: { code?: string }; meta: Record<string, unknown> & { tool?: string } };

async function call(era: "legacy" | "modern", name: string, args: Record<string, unknown>): Promise<{ frame: Frame; envelope: Envelope }> {
  nextId += 1;
  const session = era === "legacy" ? legacy : modern;
  const frame = await session.request({
    jsonrpc: "2.0",
    id: `alias-replies-${nextId}`,
    method: "tools/call",
    params: era === "legacy" ? { name, arguments: args } : { _meta: MODERN_META, name, arguments: args }
  });
  assert.equal(frame.error, undefined, `${name}: a tool result, not a protocol error`);
  const result = frame.result as { content: Array<{ type: string; text: string }>; structuredContent: Envelope };
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.text, JSON.stringify(result.structuredContent), `${name}: the text is the structured reply`);
  return { frame, envelope: result.structuredContent };
}

test("a successful alias reply keeps its 8.x envelope and adds meta.deprecated in both eras", async () => {
  for (const era of ["legacy", "modern"] as const) {
    const { frame, envelope } = await call(era, "get-runtime-metrics", {});
    assert.equal(frame.result?.isError, undefined, `${era}: success`);
    assert.ok(envelope.result, `${era}: result`);
    assert.equal(envelope.meta.tool, "get-runtime-metrics", `${era}: the 8.x meta is kept`);
    assert.equal(typeof envelope.meta.requestId, "string");
    assert.deepEqual(envelope.meta.deprecated, { replacedBy: ["server-metrics"], removeIn: "10.0.0" });
  }
});

test("an alias error reply adds meta.deprecated, narrowed to the task's tool when the call names a known task", async () => {
  const exists = await call("legacy", "analyze-symbol", { task: "exists" });
  assert.equal(exists.frame.result?.isError, true);
  assert.equal(exists.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(exists.envelope.meta.deprecated, { replacedBy: ["symbol-check"], removeIn: "10.0.0" });

  const unknownTask = await call("legacy", "inspect-minecraft", { task: "no-such-task" });
  assert.equal(unknownTask.frame.result?.isError, true);
  assert.equal(unknownTask.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(unknownTask.envelope.meta.deprecated, expectedDeprecation("inspect-minecraft"));
  assert.equal((unknownTask.envelope.meta.deprecated as { replacedBy: string[] }).replacedBy.length, 8);
});
