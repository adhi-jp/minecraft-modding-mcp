import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { ALIAS_TOOL_NAMES } from "../../src/tools/inventory.ts";

/**
 * Each alias validates its input with the 8.x schema it registers in the tool
 * schema registry, and its accepted input must stay the 8.x input: the alias
 * layer takes bug fixes only. The listing does not show that schema, so
 * this test compares the JSON Schema of each registered validating schema
 * with the frozen 8.x listing entry in
 * tests/fixtures/premigration/tool-contracts/<tool>.json: every property path
 * (top level and nested, through `items` and union branches), every
 * `required` list, and every `default`. Descriptions and JSON Schema dialect
 * details are not compared; they legitimately differ between the frozen
 * draft-07 bytes and zod's output.
 *
 * The post-capture edits listed in tests/fixtures/premigration/README.md
 * brought those fixtures in line with the validating schemas, so no
 * difference is expected for any alias.
 */

const root = mkdtempSync(join(tmpdir(), "alias-input-schema-parity-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");
delete process.env.MCP_DEPRECATED_TOOLS;

const CONTRACTS_DIR = fileURLToPath(new URL("../fixtures/premigration/tool-contracts/", import.meta.url));

type SchemaNode = {
  $ref?: string;
  default?: unknown;
  required?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode | SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
};

/** What the comparison reads from one schema, each entry keyed by its property path. */
type SchemaFacts = { properties: Set<string>; required: Set<string>; defaults: Set<string> };

/** Resolves a local JSON Pointer reference such as `#/properties/limit` against the schema root. */
function resolveLocalRef(rootNode: SchemaNode, ref: string): SchemaNode | undefined {
  if (!ref.startsWith("#")) return undefined;
  let current: unknown = rootNode;
  for (const rawSegment of ref.slice(1).split("/").filter((segment) => segment !== "")) {
    const segment = decodeURIComponent(rawSegment).replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as SchemaNode;
}

/**
 * Walks `properties`, `items` and the anyOf/oneOf/allOf branches. A local
 * `$ref` is followed and its target read at the referring path, so a shared
 * definition cannot add a default or a property where the other side has
 * none. Branches share their parent's path and the facts are sets, so branch
 * order does not matter. `activeRefs` guards against reference cycles.
 */
function collect(
  rootNode: SchemaNode,
  node: SchemaNode | undefined,
  path: string,
  facts: SchemaFacts,
  activeRefs: ReadonlySet<string> = new Set()
): void {
  if (node === undefined || node === null || typeof node !== "object") return;
  if (typeof node.$ref === "string" && !activeRefs.has(node.$ref)) {
    const target = resolveLocalRef(rootNode, node.$ref);
    assert.ok(target !== undefined, `unresolvable local $ref ${node.$ref} at ${path || "."}`);
    collect(rootNode, target, path, facts, new Set([...activeRefs, node.$ref]));
  }
  if ("default" in node) facts.defaults.add(`${path}=${JSON.stringify(node.default)}`);
  if (Array.isArray(node.required) && node.required.length > 0) {
    facts.required.add(`${path || "."} requires ${[...(node.required as string[])].sort().join(", ")}`);
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    facts.properties.add(`${path}.${key}`);
    collect(rootNode, child, `${path}.${key}`, facts, activeRefs);
  }
  for (const item of Array.isArray(node.items) ? node.items : [node.items]) {
    collect(rootNode, item, `${path}[]`, facts, activeRefs);
  }
  for (const branches of [node.anyOf, node.oneOf, node.allOf]) {
    for (const branch of branches ?? []) collect(rootNode, branch, path, facts, activeRefs);
  }
}

function schemaFacts(schema: SchemaNode): SchemaFacts {
  const facts: SchemaFacts = { properties: new Set(), required: new Set(), defaults: new Set() };
  collect(schema, schema, "", facts);
  return facts;
}

/** The differences between the frozen 8.x facts and the validating schema's facts, one line each. */
function differences(tool: string, frozen: SchemaFacts, runtime: SchemaFacts): string[] {
  const lines: string[] = [];
  for (const kind of ["properties", "required", "defaults"] as const) {
    for (const entry of frozen[kind]) {
      if (!runtime[kind].has(entry)) lines.push(`${tool}: ${kind} ${entry} is in the 8.x contract but not accepted`);
    }
    for (const entry of runtime[kind]) {
      if (!frozen[kind].has(entry)) lines.push(`${tool}: ${kind} ${entry} is accepted but not in the 8.x contract`);
    }
  }
  return lines;
}

function frozenInputSchema(tool: string): SchemaNode {
  const contract = JSON.parse(readFileSync(join(CONTRACTS_DIR, `${tool}.json`), "utf8")) as {
    advertised: { inputSchema: SchemaNode };
  };
  return contract.advertised.inputSchema;
}

let getToolSchema: (name: string) => z.ZodType | undefined;

before(async () => {
  // Loading the server registers every alias's validating schema.
  await import("../../src/index.ts");
  ({ getToolSchema } = await import("../../src/tool-schema-registry.ts"));
});

function runtimeFacts(tool: string): SchemaFacts {
  const schema = getToolSchema(tool);
  assert.ok(schema, `${tool} registers its validating schema`);
  return schemaFacts(z.toJSONSchema(schema, { io: "input" }) as SchemaNode);
}

test("every alias accepts exactly the properties, required fields and defaults of its frozen 8.x contract", (t) => {
  const drift: string[] = [];
  const totals = { properties: 0, nested: 0, required: 0, defaults: 0 };
  for (const tool of [...ALIAS_TOOL_NAMES].sort()) {
    const runtime = runtimeFacts(tool);
    totals.properties += runtime.properties.size;
    totals.nested += [...runtime.properties].filter((path) => path.lastIndexOf(".") > 0 || path.includes("[]")).length;
    totals.required += runtime.required.size;
    totals.defaults += runtime.defaults.size;
    drift.push(...differences(tool, schemaFacts(frozenInputSchema(tool)), runtime));
  }
  t.diagnostic(`compared ${totals.properties} property paths (${totals.nested} nested), ${totals.required} required lists, ${totals.defaults} defaults`);
  // Guard against a vacuous pass: the walk must see nested properties, required lists and defaults.
  assert.ok(totals.nested > 0 && totals.required > 0 && totals.defaults > 0, "the walk sees nested facts");
  assert.deepEqual(drift, [], `alias input drifted from the frozen 8.x contract:\n${drift.join("\n")}`);
});

test("self-check: the comparison reports an added property, a changed default and a dropped required field", () => {
  const frozen = schemaFacts(frozenInputSchema("list-versions"));
  const runtime = schemaFacts(z.toJSONSchema(getToolSchema("list-versions")!, { io: "input" }) as SchemaNode);
  assert.deepEqual(differences("list-versions", frozen, runtime), [], "the unperturbed pair agrees");

  const perturbed: SchemaFacts = {
    properties: new Set([...runtime.properties, ".newlyAcceptedParam"]),
    required: new Set(),
    defaults: new Set([...runtime.defaults].map((entry) => (entry.startsWith(".limit=") ? ".limit=21" : entry)))
  };
  const reported = differences("list-versions", { ...frozen, required: new Set([". requires version"]) }, perturbed);
  assert.ok(reported.some((line) => line.includes("properties .newlyAcceptedParam is accepted")), reported.join("\n"));
  assert.ok(reported.some((line) => line.includes("defaults .limit=21 is accepted")), reported.join("\n"));
  assert.ok(reported.some((line) => line.includes("required . requires version is in the 8.x contract")), reported.join("\n"));
});
