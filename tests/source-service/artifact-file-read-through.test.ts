import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __getZipOpenCount, __resetZipOpenCount } from "../../src/source-jar-reader.ts";
import { SourceService } from "../../src/source-service.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

const STONE_MODEL = JSON.stringify({ parent: "minecraft:block/cube_all", textures: { all: "minecraft:block/stone" } });

async function resolveFixtureArtifact(entries: Record<string, string | Buffer>): Promise<{
  service: SourceService;
  artifactId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "read-through-"));
  const binaryJarPath = join(root, "client.jar");
  const sourcesJarPath = join(root, "client-sources.jar");
  await createJar(binaryJarPath, {
    "net/minecraft/world/level/block/Block.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    ...entries
  });
  await createJar(sourcesJarPath, {
    "net/minecraft/world/level/block/Block.java": [
      "package net.minecraft.world.level.block;",
      "public class Block {}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });
  return { service, artifactId: resolved.artifactId };
}

test("an assets JSON path is served read-through from the backing jar with a delivery marker", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/models/block/stone.json": STONE_MODEL
  });

  const result = await service.getArtifactFile({
    artifactId,
    filePath: "assets/minecraft/models/block/stone.json"
  });

  assert.equal(result.content, STONE_MODEL);
  assert.equal(result.deliveryMode, "jar-read-through");
  assert.equal(result.truncated, false);
});

test("a data JSON path (dimension_type) is served read-through", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "data/minecraft/dimension_type/overworld.json": JSON.stringify({ ultrawarm: false })
  });

  const result = await service.getArtifactFile({
    artifactId,
    filePath: "data/minecraft/dimension_type/overworld.json"
  });

  assert.match(result.content, /ultrawarm/);
  assert.equal(result.deliveryMode, "jar-read-through");
});

test("read-through content is capped at 512 KiB with the truncation flag set", async () => {
  const bigText = `{"pad":"${"x".repeat(700 * 1024)}"}`;
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/lang/en_us.json": bigText
  });

  const result = await service.getArtifactFile({
    artifactId,
    filePath: "assets/minecraft/lang/en_us.json"
  });

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 512 * 1024);
  assert.equal(result.contentBytes, Buffer.byteLength(bigText, "utf8"));
});

test("traversal-shaped file paths are rejected as invalid input", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({});

  for (const filePath of ["../outside.json", "assets/../../etc/passwd", "/etc/passwd"]) {
    await assert.rejects(
      () => service.getArtifactFile({ artifactId, filePath }),
      (error: Error & { code?: string }) => error.code === "ERR_INVALID_INPUT"
    );
  }
});

test("a binary asset entry answers with metadata and an explicit reason instead of content", async () => {
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7)
  ]);
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/textures/block/stone.png": pngBytes
  });

  const result = await service.getArtifactFile({
    artifactId,
    filePath: "assets/minecraft/textures/block/stone.png"
  });

  assert.equal(result.content, "");
  assert.equal(result.contentBytes, pngBytes.length);
  assert.equal(result.deliveryMode, "jar-read-through");
  assert.ok(result.contentOmittedReason && /binary|text/i.test(result.contentOmittedReason));
});

test("a missing asset path returns nearby-path hints including the relocated directory", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/items/stick.json": JSON.stringify({ model: "minecraft:item/stick" })
  });

  await assert.rejects(
    () =>
      service.getArtifactFile({
        artifactId,
        filePath: "assets/minecraft/models/item/stick.json"
      }),
    (error: Error & { code?: string; details?: { nearbyPaths?: string[] } }) => {
      assert.equal(error.code, "ERR_FILE_NOT_FOUND");
      assert.ok(
        error.details?.nearbyPaths?.includes("assets/minecraft/items/stick.json"),
        `expected relocation hint, got: ${JSON.stringify(error.details)}`
      );
      return true;
    }
  );
});

test("indexed Java sources keep being served from the index without opening the jar", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/models/block/stone.json": STONE_MODEL
  });

  __resetZipOpenCount();
  const result = await service.getArtifactFile({
    artifactId,
    filePath: "net/minecraft/world/level/block/Block.java"
  });

  assert.match(result.content, /public class Block/);
  assert.equal(result.deliveryMode, undefined);
  assert.equal(__getZipOpenCount(), 0);
});

test("list-artifact-files points assets prefixes at the read-through path", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/models/block/stone.json": STONE_MODEL
  });

  const result = await service.listArtifactFiles({
    artifactId,
    prefix: "assets/"
  });

  assert.equal(result.items.length, 0);
  assert.ok(
    result.warnings.some(
      (warning) => warning.includes("are not indexed") && warning.includes("get-artifact-file")
    ),
    `expected read-through guidance, got: ${JSON.stringify(result.warnings)}`
  );
});

test("a caller maxBytes below the read-through cap wins", async () => {
  const text = `{"pad":"${"y".repeat(64 * 1024)}"}`;
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/lang/ja_jp.json": text
  });

  const result = await service.getArtifactFile({
    artifactId,
    filePath: "assets/minecraft/lang/ja_jp.json",
    maxBytes: 1024
  });

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 1024);
  assert.equal(result.contentBytes, Buffer.byteLength(text, "utf8"));
});

test("mcmeta files count as text for read-through delivery", async () => {
  const mcmeta = JSON.stringify({ animation: { frametime: 2 } });
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/textures/block/fire_0.png.mcmeta": mcmeta
  });

  const result = await service.getArtifactFile({
    artifactId,
    filePath: "assets/minecraft/textures/block/fire_0.png.mcmeta"
  });

  assert.equal(result.content, mcmeta);
  assert.equal(result.deliveryMode, "jar-read-through");
});

test("an invalid-UTF-8 text entry is rejected instead of silently corrupted", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "assets/minecraft/lang/broken.json": Buffer.from([0x7b, 0xff, 0xfe, 0x7d])
  });

  await assert.rejects(
    () =>
      service.getArtifactFile({
        artifactId,
        filePath: "assets/minecraft/lang/broken.json"
      }),
    (error: Error & { code?: string }) => error.code === "ERR_INVALID_INPUT"
  );
});

// ---------------------------------------------------------------------------
// Root-level and META-INF entries (regression: read-through used to be gated
// on an assets/ + data/ path prefix, so the two files an agent reaches for
// first when inspecting a mod jar were permanently ERR_FILE_NOT_FOUND).
// ---------------------------------------------------------------------------

const FABRIC_MOD_JSON = JSON.stringify({ schemaVersion: 1, id: "modid", version: "1.0.0" });
const MANIFEST = "Manifest-Version: 1.0\r\nFabric-Loom-Version: 1.11\r\n";

test("an archive-root fabric.mod.json is served read-through", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "fabric.mod.json": FABRIC_MOD_JSON
  });

  const result = await service.getArtifactFile({ artifactId, filePath: "fabric.mod.json" });

  assert.equal(result.content, FABRIC_MOD_JSON);
  assert.equal(result.deliveryMode, "jar-read-through");
  assert.equal(result.truncated, false);
});

test("META-INF/MANIFEST.MF is served read-through", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "META-INF/MANIFEST.MF": MANIFEST
  });

  const result = await service.getArtifactFile({ artifactId, filePath: "META-INF/MANIFEST.MF" });

  assert.match(result.content, /Manifest-Version: 1\.0/);
  assert.equal(result.deliveryMode, "jar-read-through");
});

test("an archive-root mixin config and access widener are served read-through", async () => {
  const mixins = JSON.stringify({ package: "com.example.mixin", mixins: ["ExampleMixin"] });
  const widener = "accessWidener v2 named\naccessible field net/minecraft/world/item/Item id I\n";
  const { service, artifactId } = await resolveFixtureArtifact({
    "modid.mixins.json": mixins,
    "modid.accesswidener": widener
  });

  assert.equal((await service.getArtifactFile({ artifactId, filePath: "modid.mixins.json" })).content, mixins);
  assert.equal(
    (await service.getArtifactFile({ artifactId, filePath: "modid.accesswidener" })).content,
    widener
  );
});

test("an extension-less text entry is sniffed and delivered, not refused on its name", async () => {
  const license = "MIT License\n\nPermission is hereby granted...\n";
  const { service, artifactId } = await resolveFixtureArtifact({
    LICENSE_modid: license,
    "META-INF/services/net.fabricmc.api.ModInitializer": "com.example.ExampleMod\n"
  });

  assert.equal((await service.getArtifactFile({ artifactId, filePath: "LICENSE_modid" })).content, license);
  assert.match(
    (
      await service.getArtifactFile({
        artifactId,
        filePath: "META-INF/services/net.fabricmc.api.ModInitializer"
      })
    ).content,
    /com\.example\.ExampleMod/
  );
});

test("an extension-less BINARY entry stays metadata-only after sniffing", async () => {
  const blob = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.alloc(64, 0)]);
  const { service, artifactId } = await resolveFixtureArtifact({ "META-INF/blob": blob });

  const result = await service.getArtifactFile({ artifactId, filePath: "META-INF/blob" });

  assert.equal(result.content, "");
  assert.equal(result.contentBytes, blob.length);
  assert.ok(result.contentOmittedReason && /not UTF-8 text/i.test(result.contentOmittedReason));
});

test("a root-level entry keeps the 512 KiB cap and the truncation flag", async () => {
  const bigText = `{"pad":"${"x".repeat(700 * 1024)}"}`;
  const { service, artifactId } = await resolveFixtureArtifact({ "fabric.mod.json": bigText });

  const result = await service.getArtifactFile({ artifactId, filePath: "fabric.mod.json" });

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 512 * 1024);
  assert.equal(result.contentBytes, Buffer.byteLength(bigText, "utf8"));
});

test("a root-level traversal-shaped path is still ERR_INVALID_INPUT", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({ "fabric.mod.json": FABRIC_MOD_JSON });

  for (const filePath of ["../fabric.mod.json", "/fabric.mod.json", "META-INF/../../fabric.mod.json"]) {
    await assert.rejects(
      () => service.getArtifactFile({ artifactId, filePath }),
      (error: Error & { code?: string }) => error.code === "ERR_INVALID_INPUT"
    );
  }
});

test("a missing root-level entry reports nearby paths instead of a bare not-found", async () => {
  const { service, artifactId } = await resolveFixtureArtifact({
    "META-INF/neoforge.mods.toml": "[[mods]]\nmodId=\"modid\"\n"
  });

  await assert.rejects(
    () => service.getArtifactFile({ artifactId, filePath: "neoforge.mods.toml" }),
    (error: Error & { code?: string; details?: { nearbyPaths?: string[] } }) => {
      assert.equal(error.code, "ERR_FILE_NOT_FOUND");
      assert.ok(
        error.details?.nearbyPaths?.includes("META-INF/neoforge.mods.toml"),
        `expected relocation hint, got: ${JSON.stringify(error.details)}`
      );
      return true;
    }
  );
});
