import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { z } from "zod";

import { EXPECTED_TOOLS } from "../helpers/expected-tools.ts";

/**
 * Advertised inputSchema vs runtime Zod schema: property-set parity.
 *
 * Two schemas describe every tool and they are maintained independently:
 *
 *  - `V1_PARITY_SCHEMAS[name]` (src/v1-parity-schemas.ts) is the pinned
 *    pre-migration wire advertisement, served VERBATIM as `inputSchema` in
 *    tools/list for BOTH eras through src/registration-adapter.ts.
 *  - `getToolSchema(name)` (src/tool-schema-registry.ts) is the Zod schema
 *    `validateToolParams` actually enforces at call time.
 *
 * tests/stdio/stdio-tool-contract-snapshots.test.ts compares the live
 * advertisement to the fixture that GENERATED those pinned bytes, so both
 * sides of that comparison move together: it cannot see the advertisement
 * drifting away from the enforced schema. That drift is a real, shipped bug
 * class — a parameter accepted by the runtime schema but missing from the
 * advertisement is invisible to every client, and one advertised but not
 * accepted is rejected on use.
 *
 * This test closes that gap at the level the drift occurs: the top-level
 * property names and the required set. It intentionally does NOT compare
 * nested shapes, descriptions, or JSON Schema dialect details — those legitimately
 * differ between the pinned draft-07 bytes and zod's current output. The one
 * description this file does compare is the `mapping` description of tools that
 * inherit the target artifact's resolved mapping, see the last test.
 */

const root = mkdtempSync(join(tmpdir(), "review-c2-schema-parity-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: unknown;
};

function propertyNames(schema: JsonSchemaObject): string[] {
  return Object.keys(schema.properties ?? {}).sort();
}

function requiredNames(schema: JsonSchemaObject): string[] {
  return Array.isArray(schema.required) ? [...(schema.required as string[])].sort() : [];
}

test("every tool's advertised inputSchema property set matches its runtime Zod schema", async () => {
  // Importing the app registers every enabled tool's Zod schema in the registry.
  await import("../../src/index.ts");
  const { listRegisteredTools, getToolSchema } = await import("../../src/tool-schema-registry.ts");
  const { V1_PARITY_SCHEMAS } = await import("../../src/v1-parity-schemas.ts");

  const tools = listRegisteredTools();
  assert.equal(
    tools.length,
    EXPECTED_TOOLS.length,
    "tool count changed; cover the new tool here"
  );

  const drift: string[] = [];
  for (const name of tools) {
    const advertised = V1_PARITY_SCHEMAS[name] as JsonSchemaObject | undefined;
    assert.ok(advertised, `no pinned advertisement for registered tool ${name}`);
    const zodSchema = getToolSchema(name);
    assert.ok(zodSchema, `no runtime schema for registered tool ${name}`);
    const runtime = z.toJSONSchema(zodSchema, { io: "input" }) as JsonSchemaObject;

    const advertisedProps = propertyNames(advertised);
    const runtimeProps = propertyNames(runtime);
    if (advertisedProps.join(",") !== runtimeProps.join(",")) {
      drift.push(
        `${name}: properties advertised=[${advertisedProps.join(", ")}] runtime=[${runtimeProps.join(", ")}]`
      );
    }

    const advertisedRequired = requiredNames(advertised);
    const runtimeRequired = requiredNames(runtime);
    if (advertisedRequired.join(",") !== runtimeRequired.join(",")) {
      drift.push(
        `${name}: required advertised=[${advertisedRequired.join(", ")}] runtime=[${runtimeRequired.join(", ")}]`
      );
    }
  }

  assert.deepEqual(
    drift,
    [],
    "advertised inputSchema drifted from the enforced Zod schema; regenerate the pinned schemas or fix the Zod schema"
  );
});

test("the parity comparison detects an injected property-set drift", async () => {
  await import("../../src/index.ts");
  const { getToolSchema } = await import("../../src/tool-schema-registry.ts");
  const { V1_PARITY_SCHEMAS } = await import("../../src/v1-parity-schemas.ts");

  // Self-check on an in-memory clone only: the pinned module is never mutated.
  // A Zod schema that gains a top-level property the pinned advertisement
  // lacks is exactly the drift the test above must catch.
  const baseline = z.toJSONSchema(getToolSchema("list-versions")!, { io: "input" }) as JsonSchemaObject;
  const perturbed: JsonSchemaObject = {
    ...baseline,
    properties: { ...(baseline.properties ?? {}), newlyAcceptedParam: { type: "string" } }
  };
  const advertised = V1_PARITY_SCHEMAS["list-versions"] as JsonSchemaObject;

  assert.notDeepEqual(
    propertyNames(perturbed),
    propertyNames(advertised),
    "a Zod schema gaining a property must diverge from the pinned advertisement"
  );
  assert.deepEqual(
    propertyNames(baseline),
    propertyNames(advertised),
    "the unperturbed pair must still agree"
  );
});

type MappingDescriptionSchema = { properties?: { mapping?: { description?: string } } };

function mappingDescription(schema: MappingDescriptionSchema): string | undefined {
  return schema.properties?.mapping?.description;
}

test("get-class-members advertises and enforces the same inherited-mapping default description", async () => {
  await import("../../src/index.ts");
  const { getToolSchema } = await import("../../src/tool-schema-registry.ts");
  const { V1_PARITY_SCHEMAS } = await import("../../src/v1-parity-schemas.ts");

  // get-class-members falls back to the mapping its target artifact was resolved
  // with when `mapping` is omitted, so neither description may claim a fixed
  // `obfuscated` default.
  const inheritingTools = ["get-class-members"];
  for (const name of inheritingTools) {
    const runtime = mappingDescription(
      z.toJSONSchema(getToolSchema(name)!, { io: "input" }) as MappingDescriptionSchema
    );
    const advertised = mappingDescription(V1_PARITY_SCHEMAS[name] as MappingDescriptionSchema);

    assert.ok(advertised, `${name} advertises a mapping description`);
    assert.equal(runtime, advertised, `${name}: runtime and advertised mapping descriptions differ`);
    assert.match(advertised, /resolved with/i, `${name}: description names the resolved mapping`);
    assert.match(advertised, /obfuscated when the target has none/i);
    assert.doesNotMatch(advertised, /^default obfuscated$/i);
  }

  // The lifecycle and diff tools take no artifact, so their fixed default stays.
  for (const name of ["trace-symbol-lifecycle", "diff-class-signatures"]) {
    assert.equal(
      mappingDescription(V1_PARITY_SCHEMAS[name] as MappingDescriptionSchema),
      "default obfuscated",
      `${name} keeps its fixed default description`
    );
  }
});
