import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALIAS_TOOL_INVENTORY,
  ALIAS_TOOL_NAMES,
  CATALOG_TOOL_INVENTORY,
  CATALOG_TOOL_NAMES
} from "../../src/tools/inventory.ts";
import {
  MODERN_META,
  legacyHandshake,
  startInProcessSession,
  type InProcessSession
} from "../stdio/inprocess-era-serve.ts";
import { CATALOG_SIZE_BUDGET, listingSize, type ListedTool } from "../tools/catalog-lint.ts";

/**
 * The default tools/list in both eras: the catalog tools first, then every
 * 8.x tool as a deprecated alias with a minimal entry — a description naming
 * the removal release and the replacing catalog tools, the permissive input
 * schema `{ "type": "object" }`, `_meta.deprecated`, and the 8.x annotations,
 * which come from the frozen 8.x listing entries in
 * tests/fixtures/premigration/tool-contracts/. The size budgets use the same
 * formula as the catalog contract test.
 */

const root = mkdtempSync(join(tmpdir(), "alias-listing-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
delete process.env.MCP_DEPRECATED_TOOLS;

/** Σ of the 41 alias entries, same formula as the catalog budget. */
const ALIAS_SIZE_BUDGET = 15_000;
const CONTRACTS_DIR = fileURLToPath(new URL("../fixtures/premigration/tool-contracts/", import.meta.url));

/** The 8.x annotations of a tool, from its frozen 8.x listing entry. */
function eightXAnnotations(name: string): unknown {
  const contract = JSON.parse(readFileSync(join(CONTRACTS_DIR, `${name}.json`), "utf8")) as {
    advertised: { annotations: unknown };
  };
  return contract.advertised.annotations;
}

/** `a`, `a or b`, `a, b or c`. */
function alternatives(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

let legacy: InProcessSession;
let modern: InProcessSession;
const listings = new Map<"legacy" | "modern", ListedTool[]>();

async function listTools(session: InProcessSession, params: Record<string, unknown>, id: string): Promise<ListedTool[]> {
  const frame = await session.request({ jsonrpc: "2.0", id, method: "tools/list", params });
  assert.equal(frame.error, undefined, `tools/list ${id} must succeed`);
  const tools = frame.result?.tools;
  assert.ok(Array.isArray(tools), `tools/list ${id} must carry a tools array`);
  // Wire-equivalent entries: undefined-valued own properties are dropped.
  return JSON.parse(JSON.stringify(tools)) as ListedTool[];
}

before(async () => {
  legacy = await startInProcessSession();
  await legacyHandshake(legacy, "2025-06-18", "alias-listing-init");
  modern = await startInProcessSession();
  listings.set("legacy", await listTools(legacy, {}, "alias-listing-legacy"));
  listings.set("modern", await listTools(modern, { _meta: MODERN_META }, "alias-listing-modern"));
});

after(async () => {
  await legacy?.close();
  await modern?.close();
});

test("both eras list the catalog tools first, then every 8.x tool, each group in its era's order", () => {
  const catalogOrder = CATALOG_TOOL_INVENTORY.map((entry) => entry.name);
  const aliasOrder = ALIAS_TOOL_INVENTORY.map((entry) => entry.name);
  assert.deepEqual(
    listings.get("legacy")!.map((tool) => tool.name),
    [...catalogOrder, ...aliasOrder],
    "legacy: registration order — the catalog, then the 8.x tools in their call-site order"
  );
  assert.deepEqual(
    listings.get("modern")!.map((tool) => tool.name),
    [...[...catalogOrder].sort(byCodeUnit), ...[...aliasOrder].sort(byCodeUnit)],
    "modern: each group sorted by name"
  );
});

test("every 8.x tool is listed as a minimal deprecated entry with its 8.x annotations in both eras", () => {
  for (const [era, tools] of listings) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const entry of ALIAS_TOOL_INVENTORY) {
      const listed = byName.get(entry.name);
      assert.ok(listed, `${era}: ${entry.name} is listed`);
      const perTask = entry.tasks !== undefined ? " (one per task)" : "";
      assert.deepEqual(
        listed,
        {
          name: entry.name,
          description: `Deprecated 8.x tool, removed in 10.0.0; use ${alternatives(entry.replacedBy)}${perTask}.`,
          inputSchema: { type: "object" },
          annotations: eightXAnnotations(entry.name),
          _meta: { deprecated: { replacedBy: [...entry.replacedBy], removeIn: "10.0.0" } }
        },
        `${era}: ${entry.name} has exactly the minimal entry (no title, no 8.x input schema)`
      );
    }
  }
});

test("every replacement an alias names is a listed catalog tool", () => {
  const listedNames = new Set(listings.get("legacy")!.map((tool) => tool.name));
  for (const entry of ALIAS_TOOL_INVENTORY) {
    assert.ok(entry.replacedBy.length > 0, `${entry.name} names a replacement`);
    for (const name of [...entry.replacedBy, ...Object.values(entry.tasks ?? {})]) {
      assert.ok(CATALOG_TOOL_NAMES.has(name), `${entry.name}: ${name} is a catalog tool`);
      assert.ok(listedNames.has(name), `${entry.name}: ${name} is listed`);
    }
    for (const taskTool of Object.values(entry.tasks ?? {})) {
      assert.ok(entry.replacedBy.includes(taskTool), `${entry.name}: the task tool ${taskTool} is among its replacements`);
    }
  }
});

test("the alias entries and the catalog entries each fit their size budget", (t) => {
  for (const [era, tools] of listings) {
    const aliasTotal = tools
      .filter((tool) => ALIAS_TOOL_NAMES.has(tool.name))
      .reduce((sum, tool) => sum + listingSize(tool), 0);
    const catalogTotal = tools
      .filter((tool) => CATALOG_TOOL_NAMES.has(tool.name))
      .reduce((sum, tool) => sum + listingSize(tool), 0);
    t.diagnostic(`${era}: alias entries ${aliasTotal}, catalog entries ${catalogTotal}, listing ${aliasTotal + catalogTotal}`);
    assert.ok(aliasTotal > 0 && catalogTotal > 0, `${era}: both groups are measured`);
    assert.ok(aliasTotal <= ALIAS_SIZE_BUDGET, `${era}: alias entries are ${aliasTotal} characters (budget ${ALIAS_SIZE_BUDGET})`);
    assert.ok(
      catalogTotal <= CATALOG_SIZE_BUDGET,
      `${era}: catalog entries are ${catalogTotal} characters (budget ${CATALOG_SIZE_BUDGET})`
    );
  }
});
