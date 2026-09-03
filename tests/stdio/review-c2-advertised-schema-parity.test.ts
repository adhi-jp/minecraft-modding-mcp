import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { z } from "zod";

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
 * differ between the pinned draft-07 bytes and zod's current output.
 */

// Default flag configuration: an inherited *_OFF=1 would shift this file onto a
// non-default registry and hide tools from the comparison.
delete process.env.BATCH_TOOLS_OFF;
delete process.env.VERIFY_MIXIN_TARGET_OFF;
const root = mkdtempSync(join(tmpdir(), "review-c2-schema-parity-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const EXPECTED_TOOL_COUNT = 41;

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
    EXPECTED_TOOL_COUNT,
    "tool count changed; update EXPECTED_TOOL_COUNT once the new tool is covered here"
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
