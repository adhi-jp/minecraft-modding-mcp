import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  MODERN_META,
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "./inprocess-era-serve.ts";

/**
 * tools/list ordering, per era (adopted ordering policy):
 *  - legacy era: registration order — FROZEN by the four premigration golden
 *    configs (tests/fixtures/premigration/tools-list-order.*.json);
 *  - modern era: raw tool-name-ascending (plain code-unit string order).
 *
 * Live probe @664604f: the SDK v2 tools/list handler emits registration
 * order on BOTH eras (Object.entries insertion order, no sort), so the
 * modern ordering is app-implemented through the SDK's documented
 * era-parameterized factory seam (McpRequestContext.era) — the frozen
 * legacy order must remain byte-identical.
 */

// Default flag configuration: clear both feature flags so an inherited
// *_OFF=1 in the runner's environment cannot silently shift this file onto a
// non-default registry and the wrong fixture.
delete process.env.BATCH_TOOLS_OFF;
delete process.env.VERIFY_MIXIN_TARGET_OFF;
const root = mkdtempSync(join(tmpdir(), "p3-tools-order-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const GOLDEN_DEFAULT = JSON.parse(
  readFileSync(new URL("../fixtures/premigration/tools-list-order.default.json", import.meta.url), "utf8")
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

test("modern tools/list is raw tool-name-ascending over the same default tool set", async () => {
  const names = await toolNames(modern, { _meta: MODERN_META }, "order-modern");
  const expected = [...GOLDEN_DEFAULT.toolNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(names.length, GOLDEN_DEFAULT.toolCount, "default flag config must advertise the golden tool count");
  assert.deepEqual(
    names,
    expected,
    "the modern era must advertise tools in raw name-ascending order"
  );
});

test("legacy tools/list keeps the frozen registration order of the default golden config", async () => {
  const names = await toolNames(legacy, {}, "order-legacy");
  assert.deepEqual(
    names,
    GOLDEN_DEFAULT.toolNames,
    "the legacy era must keep the FROZEN premigration registration order verbatim"
  );
});
