import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

/**
 * Regression: an artifact-targeted call that omits `mapping` must run in the
 * namespace the artifact was resolved into, and every artifact-targeted tool
 * must agree on that default.
 *
 * Before the fix, get-class-source inherited `artifact.requestedMapping` while
 * get-class-members re-derived the version-target default ("obfuscated"), so
 * the documented find-class -> get-class-source -> get-class-members chain
 * handed back mojang source and obfuscated members (ownerFqn "dlp") for one
 * and the same artifact.
 */

const SOURCE_TEXT = `package net.minecraft.world.item;

public class Item {
  public static final int CODEC = 1;
}
`;

async function buildService(): Promise<{
  service: import("../../src/source-service.ts").SourceService;
  artifactId: string;
}> {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "artifact-mapping-inherit-"));
  const service = new SourceService(buildTestConfig(root));
  const artifactId = "artifact-resolved-as-mojang";

  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    qualityFlags: ["source-backed"],
    version: "1.21.11",
    sourceJarPath: join(root, "sources.jar"),
    binaryJarPath: join(root, "binary.jar"),
    files: [{ filePath: "net/minecraft/world/item/Item.java", content: SOURCE_TEXT }],
    symbols: [
      {
        filePath: "net/minecraft/world/item/Item.java",
        symbolKind: "class",
        symbolName: "Item",
        qualifiedName: "net.minecraft.world.item.Item",
        line: 3
      }
    ]
  });

  // The bytecode reader always answers in the jar's own terms; it must not be
  // what decides the RESPONSE namespace.
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      return {
        classAccessFlags: 0x0001,
        constructors: [],
        fields: [
          {
            ownerFqn: input.fqn,
            name: "CODEC",
            javaSignature: `public int CODEC`,
            jvmDescriptor: "I",
            accessFlags: 0x0009,
            isSynthetic: false
          }
        ],
        methods: [],
        warnings: [],
        context: {
          minecraftVersion: "unknown",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarHash: "deadbeef",
          generatedAt: "2026-08-22T00:00:00.000Z"
        }
      };
    }
  };

  return { service, artifactId };
}

test("get-class-members inherits the artifact's resolved mapping when `mapping` is omitted", async () => {
  const { service, artifactId } = await buildService();

  const members = await service.getClassMembers({
    className: "net.minecraft.world.item.Item",
    artifactId,
    maxMembers: 8
  } as never);

  // Pre-fix this was "obfuscated" (the version-target default), which made the
  // reader hand back obfuscated member names for a mojang artifact.
  assert.equal(members.requestedMapping, "mojang");
  assert.equal(members.mappingApplied, "mojang");
  assert.equal(members.returnedNamespace, "mojang");
});

test("get-class-source and get-class-members agree on the omitted-mapping default for one artifact", async () => {
  const { service, artifactId } = await buildService();

  const source = await service.getClassSource({
    className: "net.minecraft.world.item.Item",
    artifactId,
    mode: "full"
  } as never);
  const members = await service.getClassMembers({
    className: "net.minecraft.world.item.Item",
    artifactId
  } as never);

  assert.equal(
    members.requestedMapping,
    source.requestedMapping,
    "the two tools must resolve the same default mapping for the same artifact"
  );
  assert.equal(
    members.returnedNamespace,
    source.returnedNamespace,
    "the two tools must return the same namespace for the same artifact"
  );
});

test("an explicit `mapping` still overrides the artifact's resolved mapping", async () => {
  const { service, artifactId } = await buildService();

  const members = await service.getClassMembers({
    className: "net.minecraft.world.item.Item",
    artifactId,
    mapping: "obfuscated"
  } as never);

  assert.equal(members.requestedMapping, "obfuscated");
});

test("get-class-members context reports the namespace it actually returned, not the jar's", async () => {
  const { service, artifactId } = await buildService();

  const members = await service.getClassMembers({
    className: "net.minecraft.world.item.Item",
    artifactId
  } as never);

  // Pre-fix: mappingNamespace "obfuscated" and minecraftVersion "unknown" sat
  // next to returnedNamespace "mojang" in the same payload.
  assert.equal(members.context.mappingNamespace, members.returnedNamespace);
  assert.equal(members.context.minecraftVersion, "1.21.11");
});
