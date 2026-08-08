import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

// Flag env must be set before the harness's first src/index.ts import
// (module-scope flag reads) — each flag configuration therefore gets its own
// test file/process; this one covers BATCH_TOOLS_OFF=1 + VERIFY_MIXIN_TARGET_OFF=1.
process.env.BATCH_TOOLS_OFF = "1";
process.env.VERIFY_MIXIN_TARGET_OFF = "1";
const root = mkdtempSync(join(tmpdir(), "p3-order-both-off-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

import {
  MODERN_META,
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "./inprocess-era-serve.ts";

/**
 * tools/list ordering under BATCH_TOOLS_OFF=1 + VERIFY_MIXIN_TARGET_OFF=1: the legacy era keeps the
 * frozen registration order of the corresponding golden config; the modern
 * era advertises the SAME tool set in raw name-ascending order (adopted
 * ordering policy — see stdio-modern-tools-list-order.test.ts for the
 * default config).
 */

const GOLDEN = JSON.parse(
  readFileSync(new URL("../fixtures/premigration/tools-list-order.both-off.json", import.meta.url), "utf8")
) as { toolNames: string[]; toolCount: number };

let modern: InProcessSession;
let legacy: InProcessSession;

before(async () => {
  modern = await startInProcessSession();
  legacy = await startInProcessSession();
  await legacyHandshake(legacy);
});

after(async () => {
  await modern?.close();
  await legacy?.close();
});

async function toolNames(session: InProcessSession, params: Record<string, unknown>, id: string): Promise<string[]> {
  const frame = await session.request({ jsonrpc: "2.0", id, method: "tools/list", params });
  assert.equal(frame.error, undefined);
  const tools = frame.result?.tools as Array<{ name: string }> | undefined;
  assert.ok(Array.isArray(tools), "tools/list must carry a tools array");
  return tools.map((tool) => tool.name);
}

test("BATCH_TOOLS_OFF=1 + VERIFY_MIXIN_TARGET_OFF=1: modern tools/list is raw name-ascending over the golden config's tool set", async () => {
  const names = await toolNames(modern, { _meta: MODERN_META }, "order-modern");
  assert.equal(names.length, GOLDEN.toolCount);
  assert.deepEqual(names, [...GOLDEN.toolNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test("BATCH_TOOLS_OFF=1 + VERIFY_MIXIN_TARGET_OFF=1: legacy tools/list keeps the frozen golden registration order", async () => {
  const names = await toolNames(legacy, {}, "order-legacy");
  assert.deepEqual(names, GOLDEN.toolNames);
});
