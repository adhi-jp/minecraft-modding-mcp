import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ALIAS_TOOL_NAMES, CATALOG_TOOL_NAMES } from "../../../src/tools/inventory.ts";
import { listTools, type ToolSchema } from "../../helpers/mcp-tools-harness.ts";

function schemaDeclaresProperty(schema: unknown, key: string): boolean {
  if (Array.isArray(schema)) {
    return schema.some((entry) => schemaDeclaresProperty(entry, key));
  }
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && key in (properties as Record<string, unknown>)) {
      return true;
    }
    return Object.values(record).some((value) => schemaDeclaresProperty(value, key));
  }
  return false;
}

test("tools/list exposes the expected MCP tools without legacy mc prefixes", async () => {
  const toolNames = (await listTools()).map((entry) => entry.name).sort();

  assert.deepEqual(toolNames, [...CATALOG_TOOL_NAMES, ...ALIAS_TOOL_NAMES].sort());
  assert.ok(toolNames.every((name) => !name.startsWith("mc-")));
});

test("read-only tools do not expose file-writing fields", async () => {
  const tools = (await listTools()) as Array<ToolSchema & { annotations?: { readOnlyHint?: boolean } }>;
  const offenders = tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .filter((tool) => schemaDeclaresProperty(tool.inputSchema, "outputFile"))
    .map((tool) => tool.name)
    .sort();

  assert.deepEqual(
    offenders,
    [],
    `read-only tools must not accept the write-capable outputFile field: ${offenders.join(", ")}`
  );
});

test("index-artifact declares write annotations (readOnlyHint:false, idempotentHint:true)", async () => {
  const tools = (await listTools()) as Array<
    ToolSchema & { annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }
  >;
  const indexArtifact = tools.find((tool) => tool.name === "index-artifact");
  assert.ok(indexArtifact, "index-artifact tool must be registered");
  assert.equal(
    indexArtifact?.annotations?.readOnlyHint,
    false,
    "index-artifact writes the SQLite index, so it must declare readOnlyHint:false"
  );
  assert.equal(
    indexArtifact?.annotations?.idempotentHint,
    true,
    "re-indexing the same artifact is idempotent, so it must declare idempotentHint:true"
  );
});

test("network-local NBT/runtime tools declare openWorldHint:false; network/cache tools do not", async () => {
  const tools = (await listTools()) as Array<
    ToolSchema & { annotations?: { openWorldHint?: boolean } }
  >;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Purely-local deterministic transforms must be marked closed-world.
  for (const name of ["nbt-to-json", "nbt-apply-json-patch", "json-to-nbt", "get-runtime-metrics"]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(
      tool?.annotations?.openWorldHint,
      false,
      `${name} is a deterministic local transform and must declare openWorldHint:false`
    );
  }

  // Cache-with-network-fallback tools must NOT be marked closed-world (they fetch on a miss).
  for (const name of ["get-class-source", "get-class-members", "find-mapping", "find-class", "search-class-source"]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.notEqual(
      tool?.annotations?.openWorldHint,
      false,
      `${name} falls back to network on a cache miss and must not declare openWorldHint:false`
    );
  }
});

test("index.ts serializes heavy analysis tools to protect MCP transport stability", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const gateSource = await readFile("src/tool-execution-gate.ts", "utf8");

  // The one gate instance lives beside the gate class so catalog tools share it.
  assert.match(source, /import\s+\{\s*heavyToolExecutionGate\s*\}\s+from\s+"\.\/tool-execution-gate\.js"/);
  assert.match(source, /const HEAVY_TOOL_NAMES = new Set\(\[/);
  assert.match(source, /"trace-symbol-lifecycle"/);
  assert.match(source, /"diff-class-signatures"/);
  assert.match(source, /"compare-versions"/);
  assert.match(source, /"find-mapping"/);
  assert.match(
    gateSource,
    /export const heavyToolExecutionGate = new ToolExecutionGate\(\{ maxConcurrent: 1, maxQueue: 2 \}\)/
  );
  assert.match(source, /HEAVY_TOOL_NAMES\.has\(tool\)/);
  assert.match(source, /heavyToolExecutionGate\.run\(tool,\s*\(\)\s*=>\s*action\(parsedInput\)\)/s);
});

test("index.ts wires check-symbol-exists into inspect-minecraft partial-source fallbacks", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /const inspectMinecraftService = new InspectMinecraftService\(\{/);
  assert.match(source, /checkSymbolExists:\s*\(input\)\s*=>\s*sourceService\.checkSymbolExists\(input\)/);
});
