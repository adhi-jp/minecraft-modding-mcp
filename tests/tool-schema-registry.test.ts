import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import { EXPECTED_TOOLS } from "./helpers/expected-tools.ts";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-tool-schema-registry-cache");

test("registry contains every public tool from EXPECTED_TOOLS after server import", async () => {
  await import("../src/index.ts");
  const { listRegisteredTools } = await import("../src/tool-schema-registry.ts");
  const registered = new Set(listRegisteredTools());
  for (const name of EXPECTED_TOOLS) {
    assert.ok(
      registered.has(name),
      `tool ${name} is missing from tool-schema-registry`
    );
  }
});

test("validateToolParams accepts a well-formed get-class-source payload (D3)", async () => {
  await import("../src/index.ts");
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");
  const result = validateToolParams("get-class-source", {
    className: "net.minecraft.world.entity.LivingEntity",
    target: { type: "resolve", kind: "version", value: "1.21.10" }
  });
  assert.equal(result.valid, true);
});

test("validateToolParams rejects the bug-report shaped payload (D4)", async () => {
  await import("../src/index.ts");
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");
  const result = validateToolParams("get-class-members", {
    target: {
      type: "resolve",
      kind: "coordinate",
      value: "{\"type\": \"resolve\", \"kind\": \"version\", \"value\": \"1.21.10\"}"
    }
  });
  assert.equal(result.valid, false);
  if (result.valid) return;
  const offendingPaths = result.errors.map((entry) => entry.path).join(",");
  assert.ok(
    /target|className/.test(offendingPaths),
    `expected fieldErrors to mention target or className, got ${offendingPaths}`
  );
});

test("validateToolParams returns Unknown tool for an unregistered name", async () => {
  await import("../src/index.ts");
  const { validateToolParams } = await import("../src/tool-schema-registry.ts");
  const result = validateToolParams("definitely-not-a-real-tool", {});
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.match(result.errors[0]!.message, /Unknown tool/);
});

test("registerToolSchema throws on duplicate registration", async () => {
  const { registerToolSchema } = await import("../src/tool-schema-registry.ts");
  const uniqueName = `__test-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  registerToolSchema(uniqueName, z.object({}));
  assert.throws(
    () => registerToolSchema(uniqueName, z.object({})),
    /already registered/
  );
});

test("listRegisteredTools returns names in sorted order", async () => {
  await import("../src/index.ts");
  const { listRegisteredTools } = await import("../src/tool-schema-registry.ts");
  const names = listRegisteredTools();
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted);
});

// mkdtemp side-effect to keep `tmpdir` / `mkdtemp` imports live for lint.
test.before(async () => {
  await mkdtemp(join(tmpdir(), "mcp-tool-schema-registry-pre-"));
});

test("registry tool count matches EXPECTED_TOOLS length exactly (no extra registrations leak)", async () => {
  await import("../src/index.ts");
  const { listRegisteredTools } = await import("../src/tool-schema-registry.ts");
  const registered = listRegisteredTools();
  // EXPECTED_TOOLS represents the public tool surface this file pins. Filter
  // out internal test-tool names introduced via registerToolSchema in other
  // tests (their names start with `__test-tool-`).
  const publicTools = registered.filter((name) => !name.startsWith("__test-tool-"));
  assert.equal(
    publicTools.length,
    EXPECTED_TOOLS.length,
    `expected ${EXPECTED_TOOLS.length} public tools, got ${publicTools.length}: ${publicTools.join(", ")}`
  );
});

test("registry does NOT contain removed/legacy tool names from earlier renames", async () => {
  await import("../src/index.ts");
  const { listRegisteredTools } = await import("../src/tool-schema-registry.ts");
  const registered = new Set(listRegisteredTools());
  for (const removed of [
    // Pre-rename top-level workflow names that should never resurrect.
    // (Mapping-value / parameter-name tokens like `official`, `targetKind`,
    // `snippetLines` are not tool names and live in a different test.)
    "inspect-mc-class",
    "explore-mod",
    "mc-list-versions",
    "mc-resolve-artifact"
  ]) {
    assert.ok(
      !registered.has(removed),
      `tool-schema-registry must NOT contain removed tool name "${removed}"`
    );
  }
});
