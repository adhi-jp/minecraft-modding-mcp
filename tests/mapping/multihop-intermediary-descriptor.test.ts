/**
 * A Mojang -> Yarn exact-descriptor lookup across THREE separate mapping files:
 * the Mojang ProGuard client mappings (mojang <-> obfuscated), a tiny headed
 * `official intermediary`, and a tiny headed `intermediary named`. Tiny v2 stores
 * one descriptor per method row in the file's FIRST namespace, so the last hop's
 * record carries an intermediary-coordinate descriptor. `findMapping`'s strict
 * accepted-descriptor set only held the mojang, target and obfuscated forms, so the
 * one correct candidate was filtered out and the lookup answered not_found.
 *
 * The existing "accepts obfuscated-canonical descriptors on multi-hop paths" test
 * uses a single three-column tiny, which gives a DIRECT obfuscated->yarn edge and
 * never reaches this shape.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  installGradleUserHomeIsolation,
  buildTestConfig,
  withCwd,
  createVersionServiceStub
} from "../helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

const MAPPINGS_URL = "https://example.test/mappings/client.txt";

// mojang <-> obfuscated
const SPLIT_MOJANG_CLIENT_MAPPINGS = [
  "net.minecraft.core.BlockPos -> a:",
  "net.minecraft.world.level.Level -> b:",
  "    4:4:boolean setBlock(net.minecraft.core.BlockPos) -> c"
].join("\n");

// obfuscated <-> intermediary, descriptors in official (obfuscated) coordinates.
const SPLIT_OFFICIAL_INTERMEDIARY_TINY = [
  "tiny\t2\t0\tofficial\tintermediary",
  "c\ta\tnet/minecraft/class_2338",
  "c\tb\tnet/minecraft/class_1937",
  "\tm\t(La;)Z\tc\tmethod_1725"
].join("\n");

// intermediary <-> yarn, descriptors in INTERMEDIARY coordinates.
const SPLIT_INTERMEDIARY_NAMED_TINY = [
  "tiny\t2\t0\tintermediary\tnamed",
  "c\tnet/minecraft/class_2338\tnet/minecraft/util/math/BlockPos",
  "c\tnet/minecraft/class_1937\tnet/minecraft/world/World",
  "\tm\t(Lnet/minecraft/class_2338;)Z\tmethod_1725\tsetBlockState"
].join("\n");

const MOJANG_DESCRIPTOR = "(Lnet/minecraft/core/BlockPos;)Z";

async function createSplitMappingService(prefix: string) {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), prefix));
  const config = buildTestConfig(root, { sourceRepos: [] });
  const loomDir = join(root, ".gradle", "loom-cache", "1.21.10");
  await mkdir(loomDir, { recursive: true });
  await writeFile(join(loomDir, "mappings.tiny"), `${SPLIT_OFFICIAL_INTERMEDIARY_TINY}\n`, "utf8");
  await writeFile(join(loomDir, "yarn-mappings.tiny"), `${SPLIT_INTERMEDIARY_NAMED_TINY}\n`, "utf8");

  const fetchStub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === MAPPINGS_URL) {
      return new Response(SPLIT_MOJANG_CLIENT_MAPPINGS, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    root,
    service: new MappingService(config, createVersionServiceStub(MAPPINGS_URL), fetchStub)
  };
}

test("MappingService findMapping signatureMode=exact resolves mojang->yarn across separate mapping files", async () => {
  const { root, service } = await createSplitMappingService("split-mapping-files-");
  try {
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.level.Level",
        name: "setBlock",
        descriptor: MOJANG_DESCRIPTOR,
        sourceMapping: "mojang",
        targetMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(
      mapped.status,
      "resolved",
      `expected a resolved mojang->yarn lookup, got ${JSON.stringify(mapped)}`
    );
    assert.equal(mapped.resolvedSymbol?.name, "setBlockState");
    assert.equal(mapped.resolvedSymbol?.owner, "net.minecraft.world.World");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService resolveMethodMappingExact resolves mojang->yarn across separate mapping files", async () => {
  const { root, service } = await createSplitMappingService("split-mapping-files-exact-");
  try {
    const mapped = await withCwd(root, () =>
      service.resolveMethodMappingExact({
        version: "1.21.10",
        owner: "net.minecraft.world.level.Level",
        name: "setBlock",
        descriptor: MOJANG_DESCRIPTOR,
        sourceMapping: "mojang",
        targetMapping: "yarn"
      })
    );

    assert.equal(
      mapped.status,
      "resolved",
      `expected a resolved mojang->yarn lookup, got ${JSON.stringify(mapped)}`
    );
    assert.equal(mapped.resolvedSymbol?.name, "setBlockState");
    assert.equal(mapped.resolvedSymbol?.owner, "net.minecraft.world.World");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
