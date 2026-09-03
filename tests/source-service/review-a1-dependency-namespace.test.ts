import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceService } from "../../src/source-service.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

// ---------------------------------------------------------------------------
// The unobfuscated-namespace reconciliation exists for the Minecraft RUNTIME:
// a 26.x runtime jar labelled "obfuscated" really does carry mojang names, so
// collapsing the label avoids a doomed remap pass.
//
// A dependency's coordinate version is not a Minecraft version. `26.0.2` is
// org.jetbrains:annotations' own release number, and the resolver already
// decided - deliberately - that such an artifact is served in its native
// namespace, reporting mappingApplied="obfuscated" with the
// "dependency-mapping-unverified" flag and a warning saying so. Relabelling it
// "mojang" here contradicts the flag and the warning in the same payload.
// ---------------------------------------------------------------------------

const DEPENDENCY_FLAG = "dependency-mapping-unverified";

test("get-class-members keeps a dependency's obfuscated namespace when its own version looks unobfuscated", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-a1-dep-members-"));
  const binaryJarPath = join(
    root,
    "m2",
    "org",
    "jetbrains",
    "annotations",
    "26.0.2",
    "annotations-26.0.2.jar"
  );
  await createJar(binaryJarPath, {
    "org/jetbrains/annotations/NotNull.class": buildClassFile({
      internalName: "org/jetbrains/annotations/NotNull",
      // public interface abstract annotation
      accessFlags: 0x2601,
      interfaceInternalNames: ["java/lang/annotation/Annotation"],
      methods: [{ name: "value", descriptor: "()Ljava/lang/String;", accessFlags: 0x0401 }]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  // The artifact resolves binary-only; nothing here needs a decompiler pass.
  (service as unknown as { ingestIfNeeded: (resolved: unknown) => Promise<void> }).ingestIfNeeded =
    async () => {};

  const result = await service.getClassMembers({
    className: "org.jetbrains.annotations.NotNull",
    target: { kind: "dependency", group: "org.jetbrains", name: "annotations", version: "26.0.2" },
    mapping: "mojang"
  } as never);

  assert.equal(result.requestedMapping, "mojang");
  assert.equal(
    result.mappingApplied,
    "obfuscated",
    "a dependency's own release number must not be read as an unobfuscated Minecraft version"
  );
  assert.ok(
    result.qualityFlags.includes(DEPENDENCY_FLAG),
    `Expected ${DEPENDENCY_FLAG} to survive, got: ${JSON.stringify(result.qualityFlags)}`
  );
});

test("get-class-source keeps a dependency's obfuscated namespace when its own version looks unobfuscated", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-a1-dep-source-"));
  const service = new SourceService(buildTestConfig(root));
  const artifactId = "dep-annotations-26-0-2";

  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-m2",
    version: "26.0.2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [DEPENDENCY_FLAG],
    isDecompiled: true,
    provenance: {
      target: { kind: "dependency", group: "org.jetbrains", name: "annotations", version: "26.0.2" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2", coordinate: "org.jetbrains:annotations:26.0.2" },
      transformChain: [],
      dependencyResolution: {
        group: "org.jetbrains",
        name: "annotations",
        resolvedVersion: "26.0.2",
        source: "explicit",
        cacheHit: false
      }
    },
    files: [
      {
        filePath: "org/jetbrains/annotations/NotNull.java",
        content: "package org.jetbrains.annotations;\npublic @interface NotNull {}\n"
      }
    ],
    symbols: [
      {
        filePath: "org/jetbrains/annotations/NotNull.java",
        symbolKind: "class",
        symbolName: "NotNull",
        qualifiedName: "org.jetbrains.annotations.NotNull",
        line: 2
      }
    ]
  });

  const result = await service.getClassSource({
    className: "org.jetbrains.annotations.NotNull",
    artifactId,
    mapping: "mojang",
    mode: "full"
  } as never);

  assert.equal(result.requestedMapping, "mojang");
  assert.equal(
    result.mappingApplied,
    "obfuscated",
    "a dependency's own release number must not be read as an unobfuscated Minecraft version"
  );
  assert.ok(
    result.qualityFlags.includes(DEPENDENCY_FLAG),
    `Expected ${DEPENDENCY_FLAG} to survive, got: ${JSON.stringify(result.qualityFlags)}`
  );
});

test("get-class-members still collapses a genuine unobfuscated Minecraft runtime namespace", async () => {
  // The counterexample that keeps the fix honest: a vanilla 26.x artifact has
  // no dependency provenance and no library coordinate, so the reconciliation
  // it was written for still applies.
  const root = await mkdtemp(join(tmpdir(), "review-a1-vanilla-members-"));
  const service = new SourceService(buildTestConfig(root));
  const binaryJarPath = join(root, "minecraft-merged-26.1.jar");
  const artifactId = "vanilla-26-1";

  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-jar",
    version: "26.1",
    binaryJarPath,
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files: [],
    symbols: []
  });

  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [],
        warnings: [],
        context: {
          minecraftVersion: "26.1",
          mappingType: "mojang",
          mappingNamespace: "mojang",
          jarSignature: "hash",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };

  const result = await service.getClassMembers({
    className: "net.minecraft.world.item.Item",
    artifactId,
    mapping: "mojang"
  } as never);

  assert.equal(result.mappingApplied, "mojang");
});
