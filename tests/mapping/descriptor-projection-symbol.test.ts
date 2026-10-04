/**
 * When descriptor projection rewrites a candidate's descriptor into the target
 * namespace, the candidate's `symbol` must be rebuilt from the same target owner,
 * name and descriptor. Spreading only `descriptor` over the candidate left the
 * SOURCE-namespace descriptor embedded in `symbol`, so one SymbolReference carried
 * two namespaces at once.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import {
  installGradleUserHomeIsolation,
  withCwd,
  createLoomService,
  TEST_DESCRIPTOR_REMAP_TINY
} from "../helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

const OBFUSCATED_DESCRIPTOR = "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z";
const YARN_DESCRIPTOR =
  "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z";

test("MappingService findMapping keeps symbol and descriptor in one namespace after projection", async () => {
  const { root, service } = await createLoomService(
    "projection-symbol-findmapping-",
    TEST_DESCRIPTOR_REMAP_TINY
  );
  try {
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.class_1937",
        name: "method_1725",
        descriptor: OBFUSCATED_DESCRIPTOR,
        sourceMapping: "obfuscated",
        targetMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.descriptor, YARN_DESCRIPTOR);
    assert.equal(
      mapped.resolvedSymbol?.symbol,
      `net.minecraft.world.level.Level.setBlock${YARN_DESCRIPTOR}`,
      "symbol must carry the projected target descriptor, not the source-namespace one"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService resolveMethodMappingExact keeps symbol and descriptor in one namespace after projection", async () => {
  const { root, service } = await createLoomService(
    "projection-symbol-exact-",
    TEST_DESCRIPTOR_REMAP_TINY
  );
  try {
    const mapped = await withCwd(root, () =>
      service.resolveMethodMappingExact({
        version: "1.21.10",
        owner: "net.minecraft.class_1937",
        name: "method_1725",
        descriptor: OBFUSCATED_DESCRIPTOR,
        sourceMapping: "obfuscated",
        targetMapping: "yarn"
      })
    );

    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.descriptor, YARN_DESCRIPTOR);
    assert.equal(
      mapped.resolvedSymbol?.symbol,
      `net.minecraft.world.level.Level.setBlock${YARN_DESCRIPTOR}`,
      "symbol must carry the projected target descriptor, not the source-namespace one"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
