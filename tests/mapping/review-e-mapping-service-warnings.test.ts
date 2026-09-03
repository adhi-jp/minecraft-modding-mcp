import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installGradleUserHomeIsolation,
  buildTestConfig,
  createLoomService,
  createVersionServiceStub,
  withCwd,
  writeLoomTinyCache,
  TEST_TINY,
  TEST_TINY_YARN_2COL,
  TEST_DESCRIPTOR_REMAP_TINY
} from "../helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

test("findMapping reports the Loom index-budget truncation that shaped its answer", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "review-e-findmapping-budget-"));
  const previous = process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
  try {
    await writeLoomTinyCache(root, TEST_TINY);
    // A second selected file in its own subdirectory, so the budget is hit part-way
    // through the merge rather than before any file is read.
    const yarnDir = join(root, ".gradle", "loom-cache", "1.21.10", "yarn");
    await mkdir(yarnDir, { recursive: true });
    await writeFile(join(yarnDir, "yarn.tiny"), `${TEST_TINY_YARN_2COL}\n`, "utf8");
    process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES = "1";

    const service = new MappingService(
      buildTestConfig(root, { sourceRepos: [] }),
      createVersionServiceStub(),
      globalThis.fetch
    );
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "obfuscated",
        targetMapping: "intermediary"
      })
    );

    // Pre-fix find-mapping seeded an empty warnings array, so the tool most likely to
    // answer from a truncated index was the one that never mentioned the truncation.
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.includes("index budget") && warning.includes("MCP_LOOM_TINY_MAX_INDEX_ENTRIES")
      ),
      `expected the Loom truncation warning, got: ${JSON.stringify(result.warnings)}`
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
    } else {
      process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMethodMappingExact says an unqualified owner is why nothing matched", async () => {
  const { root, service } = await createLoomService(
    "review-e-unqualified-owner-",
    TEST_DESCRIPTOR_REMAP_TINY
  );
  try {
    const descriptor = "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z";

    // The same query with the fully-qualified owner resolves, so the only difference
    // is the missing package.
    const qualified = await withCwd(root, () =>
      service.resolveMethodMappingExact({
        version: "1.21.10",
        owner: "net.minecraft.class_1937",
        name: "method_1725",
        descriptor,
        sourceMapping: "intermediary",
        targetMapping: "yarn"
      })
    );
    assert.equal(qualified.status, "resolved");

    const bare = await withCwd(root, () =>
      service.resolveMethodMappingExact({
        version: "1.21.10",
        owner: "class_1937",
        name: "method_1725",
        descriptor,
        sourceMapping: "intermediary",
        targetMapping: "yarn"
      })
    );

    assert.equal(bare.status, "not_found");
    // Pre-fix the only warning blamed inheritance or relocation, which is not what
    // happened: an unqualified owner has no class record to project along the path.
    assert.ok(
      bare.warnings.some((warning) => /not fully qualified/i.test(warning)),
      `expected an unqualified-owner explanation, got: ${JSON.stringify(bare.warnings)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mapping_unavailable keeps the loader warnings that explain the missing path", async () => {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "review-e-unavailable-budget-"));
  const previous = process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
  try {
    // Same truncation setup as the test above: two selected tiny files, so the
    // index budget is exhausted part-way through the merge.
    await writeLoomTinyCache(root, TEST_TINY);
    const yarnDir = join(root, ".gradle", "loom-cache", "1.21.10", "yarn");
    await mkdir(yarnDir, { recursive: true });
    await writeFile(join(yarnDir, "yarn.tiny"), `${TEST_TINY_YARN_2COL}\n`, "utf8");
    process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES = "1";

    // The stub version service advertises no mojang mappings URL, so the graph
    // carries no mojang edge and `intermediary -> mojang` has no path — the exact
    // shape a truncated load can produce, and the one where the caller most needs
    // to be told the index was cut short.
    const service = new MappingService(
      buildTestConfig(root, { sourceRepos: [] }),
      createVersionServiceStub(),
      globalThis.fetch
    );

    const found = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "class",
        name: "net.minecraft.class_1937",
        sourceMapping: "intermediary",
        targetMapping: "mojang"
      })
    );
    assert.equal(found.status, "mapping_unavailable");
    assert.ok(
      found.warnings.some((warning) =>
        warning.includes("No mapping path is available for intermediary -> mojang")
      ),
      `expected the no-path warning, got: ${JSON.stringify(found.warnings)}`
    );
    // Pre-fix the early mapping_unavailable return replaced the graph's warnings with
    // a single no-path sentence, dropping the truncation notice on exactly the case
    // where a cut-short load may be why the path is gone.
    assert.ok(
      found.warnings.some(
        (warning) =>
          warning.includes("index budget") && warning.includes("MCP_LOOM_TINY_MAX_INDEX_ENTRIES")
      ),
      `expected the Loom truncation warning from find-mapping, got: ${JSON.stringify(found.warnings)}`
    );

    const exact = await withCwd(root, () =>
      service.resolveMethodMappingExact({
        version: "1.21.10",
        owner: "net.minecraft.class_1937",
        name: "method_x",
        descriptor: "(Lnet/minecraft/class_1937;)V",
        sourceMapping: "intermediary",
        targetMapping: "mojang"
      })
    );
    assert.equal(exact.status, "mapping_unavailable");
    assert.ok(
      exact.warnings.some((warning) =>
        warning.includes("No mapping path is available for intermediary -> mojang")
      ),
      `expected the no-path warning, got: ${JSON.stringify(exact.warnings)}`
    );
    assert.ok(
      exact.warnings.some(
        (warning) =>
          warning.includes("index budget") && warning.includes("MCP_LOOM_TINY_MAX_INDEX_ENTRIES")
      ),
      `expected the Loom truncation warning from resolve-method-mapping-exact, got: ${JSON.stringify(
        exact.warnings
      )}`
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES;
    } else {
      process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
