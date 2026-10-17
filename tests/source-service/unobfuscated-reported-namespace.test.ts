import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerResources } from "../../src/resources.ts";
import { probeMinecraftArtifact, reportedResolveNamespace } from "../../src/source/artifact-resolver.ts";
import type { SourceService as SourceServiceType } from "../../src/source-service.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { seedIndexedArtifact, stubExplorer } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * On a proven Minecraft 26.1+ runtime, responses report `mojang` where the
 * internal label is `obfuscated`. The stored row, the resolver output and every
 * branch input keep `obfuscated`; pre-26.1 artifacts, libraries whose own
 * version only looks like 26.x, and mixed-era comparisons keep today's value.
 */

const ITEM = "net.minecraft.world.item.Item";
const ITEM_FILE = "net/minecraft/world/item/Item.java";

async function newService(prefix: string): Promise<{ service: SourceServiceType; root: string }> {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { service: new SourceService(buildTestConfig(root)), root };
}

async function writeItemJar(root: string, name: string): Promise<string> {
  const jarPath = join(root, name);
  await createJar(jarPath, {
    "net/minecraft/world/item/Item.class": buildClassFile({
      internalName: "net/minecraft/world/item/Item",
      accessFlags: 0x0001,
      methods: [{ name: "getDescriptionId", descriptor: "()Ljava/lang/String;", accessFlags: 0x0001 }]
    })
  });
  return jarPath;
}

/** Seeds a warm row whose provenance has no unobfuscatedRuntime field. */
function seedMinecraftRow(
  service: SourceServiceType,
  root: string,
  version: string,
  options: { withProvenance: boolean }
): string {
  const artifactId = `minecraft-${version}-${options.withProvenance ? "prov" : "bare"}`;
  seedIndexedArtifact(service, {
    artifactId,
    origin: "decompiled",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version,
    isDecompiled: true,
    binaryJarPath: join(root, "client.jar"),
    files: [{ filePath: ITEM_FILE, content: "package net.minecraft.world.item;\npublic class Item {}\n" }],
    symbols: [{ filePath: ITEM_FILE, symbolKind: "class", symbolName: "Item", qualifiedName: ITEM, line: 2 }],
    ...(options.withProvenance
      ? {
          provenance: {
            target: { kind: "version", value: version },
            resolvedAt: new Date().toISOString(),
            resolvedFrom: { origin: "decompiled", version },
            transformChain: ["mapping:obfuscated-pass-through"]
          }
        }
      : {})
  });
  return artifactId;
}

async function reportedLabels(service: SourceServiceType, artifactId: string) {
  const source = await service.getClassSource({ artifactId, className: ITEM, mode: "metadata" });
  const members = await service.getClassMembers({ artifactId, className: ITEM });
  const search = await service.searchClassSource({ artifactId, query: "Item" });
  const files = await service.listArtifactFiles({ artifactId });
  const file = await service.getArtifactFile({ artifactId, filePath: ITEM_FILE });
  return {
    source: [source.mappingApplied, source.returnedNamespace],
    members: [members.mappingApplied, members.returnedNamespace, members.context.mappingNamespace],
    search: [search.mappingApplied, search.returnedNamespace],
    files: [files.mappingApplied],
    file: [file.mappingApplied, file.returnedNamespace]
  };
}

test("a warm 26.x row labelled obfuscated is reported as mojang while the stored row keeps obfuscated", async () => {
  for (const withProvenance of [true, false]) {
    const { service, root } = await newService("reported-ns-warm-");
    stubExplorer(service, {});
    const artifactId = seedMinecraftRow(service, root, "26.2", { withProvenance });

    const labels = await reportedLabels(service, artifactId);

    assert.deepEqual(
      labels,
      {
        source: ["mojang", "mojang"],
        members: ["mojang", "mojang", "mojang"],
        search: ["mojang", "mojang"],
        files: ["mojang"],
        file: ["mojang", "mojang"]
      },
      `withProvenance=${withProvenance}`
    );
    assert.equal(service.getArtifact(artifactId).mappingApplied, "obfuscated", "the stored label is never rewritten");
  }
});

test("a warm pre-26.1 row keeps reporting obfuscated", async () => {
  const { service, root } = await newService("reported-ns-legacy-");
  stubExplorer(service, {});
  const artifactId = seedMinecraftRow(service, root, "1.21.10", { withProvenance: true });

  const labels = await reportedLabels(service, artifactId);

  assert.deepEqual(labels, {
    source: ["obfuscated", "obfuscated"],
    members: ["obfuscated", "obfuscated", "obfuscated"],
    search: ["obfuscated", "obfuscated"],
    files: ["obfuscated"],
    file: ["obfuscated", "obfuscated"]
  });
});

async function readArtifactMetadataResource(service: SourceServiceType, artifactId: string) {
  let handler: ((uri: URL, params: Record<string, string>) => Promise<any>) | undefined;
  const server = {
    registerResource(name: string, _template: unknown, _metadata: unknown, registered: typeof handler) {
      if (name === "artifact-metadata") handler = registered;
    }
  };
  registerResources(server as never, service);
  const result = await handler!(new URL(`mc://artifact/${artifactId}`), { artifactId });
  return JSON.parse(result.contents[0].text).result as Record<string, unknown>;
}

test("the artifact-metadata resource reports the same namespace as the tools", async () => {
  const { service, root } = await newService("reported-ns-resource-");
  const modernId = seedMinecraftRow(service, root, "26.2", { withProvenance: true });
  const legacyId = seedMinecraftRow(service, root, "1.21.10", { withProvenance: true });

  const modern = await readArtifactMetadataResource(service, modernId);
  assert.equal(modern.mappingApplied, "mojang");
  assert.deepEqual(
    { ...modern, mappingApplied: "obfuscated" },
    JSON.parse(JSON.stringify(service.getArtifact(modernId))),
    "only mappingApplied is relabelled"
  );
  assert.equal(service.getArtifact(modernId).mappingApplied, "obfuscated", "the stored label is never rewritten");

  const legacy = await readArtifactMetadataResource(service, legacyId);
  assert.equal(legacy.mappingApplied, "obfuscated");
});

test("a library row whose own version looks like 26.x keeps reporting obfuscated", async () => {
  const { service, root } = await newService("reported-ns-library-");
  stubExplorer(service, {});
  const coordinate = "org.jetbrains:annotations:26.0.2";
  const artifactId = "annotations-26.0.2";
  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: ["dependency-mapping-unverified"],
    version: "26.0.2",
    binaryJarPath: join(root, "annotations-26.0.2.jar"),
    files: [{ filePath: "org/jetbrains/annotations/Contract.java", content: "package org.jetbrains.annotations;\npublic @interface Contract {}\n" }],
    symbols: [{ filePath: "org/jetbrains/annotations/Contract.java", symbolKind: "class", symbolName: "Contract", qualifiedName: "org.jetbrains.annotations.Contract", line: 2 }],
    provenance: {
      target: { kind: "coordinate", value: coordinate },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2", coordinate, version: "26.0.2" },
      transformChain: []
    }
  });

  const source = await service.getClassSource({ artifactId, className: "org.jetbrains.annotations.Contract", mode: "metadata" });
  const search = await service.searchClassSource({ artifactId, query: "Contract" });

  assert.equal(source.mappingApplied, "obfuscated");
  assert.equal(source.returnedNamespace, "obfuscated");
  assert.ok(source.qualityFlags.includes("dependency-mapping-unverified"));
  assert.equal(search.mappingApplied, "obfuscated");
});

test("an artifact served from a nested jar keeps reporting obfuscated even when its recorded version looks like 26.x", async () => {
  const { service, root } = await newService("reported-ns-nested-");
  stubExplorer(service, {});
  const artifactId = "nested-26.2";
  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version: "26.2",
    binaryJarPath: join(root, "nested.jar"),
    files: [{ filePath: ITEM_FILE, content: "package net.minecraft.world.item;\npublic class Item {}\n" }],
    symbols: [{ filePath: ITEM_FILE, symbolKind: "class", symbolName: "Item", qualifiedName: ITEM, line: 2 }],
    provenance: {
      target: { kind: "version", value: "26.2" },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-jar", version: "26.2" },
      transformChain: [],
      nestedJar: { entryName: "META-INF/jars/inner.jar", shellArtifactId: "shell" }
    }
  });

  const source = await service.getClassSource({ artifactId, className: ITEM, mode: "metadata" });
  const search = await service.searchClassSource({ artifactId, query: "Item" });
  const files = await service.listArtifactFiles({ artifactId });

  assert.deepEqual(
    [source.mappingApplied, source.returnedNamespace, search.mappingApplied, files.mappingApplied],
    ["obfuscated", "obfuscated", "obfuscated", "obfuscated"]
  );
});

test("get-class-members on a warm 26.x row returns the same members for mapping mojang as for the reported default", async () => {
  const { service, root } = await newService("reported-ns-roundtrip-");
  stubExplorer(service, {
    methods: [
      {
        ownerFqn: ITEM,
        name: "getDescriptionId",
        javaSignature: "public java.lang.String getDescriptionId()",
        jvmDescriptor: "()Ljava/lang/String;",
        accessFlags: 0x0001,
        isSynthetic: false
      }
    ]
  });
  const artifactId = seedMinecraftRow(service, root, "26.2", { withProvenance: true });

  const asReported = await service.getClassMembers({ artifactId, className: ITEM });
  const sentBack = await service.getClassMembers({ artifactId, className: ITEM, mapping: "mojang" });

  assert.equal(asReported.returnedNamespace, "mojang");
  assert.equal(sentBack.returnedNamespace, "mojang");
  assert.deepEqual(sentBack.members, asReported.members);
  assert.deepEqual(sentBack.counts, asReported.counts);
  assert.deepEqual(sentBack.warnings, asReported.warnings);
});

test("a workspace target on a 26.x project without a mappings line reports mojang in the tool response", async () => {
  const { service, root } = await newService("reported-ns-workspace-");
  const projectPath = await mkdtemp(join(tmpdir(), "reported-ns-workspace-project-"));
  await writeFile(join(projectPath, "gradle.properties"), "minecraft_version=26.2\n", "utf8");
  await writeFile(
    join(projectPath, "build.gradle"),
    ["plugins {", "  id 'net.fabricmc.fabric-loom' version '1.14-SNAPSHOT'", "}", "dependencies {", "}"].join("\n"),
    "utf8"
  );
  const jarPath = await writeItemJar(root, "client-26.2.jar");
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(version: string) {
      return { version, jarPath, source: "downloaded" as const, clientJarUrl: "cache:index" };
    },
    async listVersionIds() {
      return ["26.2"];
    }
  };
  // Decompilation is not under test; the label is settled before ingest.
  (service as unknown as { ingestIfNeeded: () => Promise<void> }).ingestIfNeeded = async () => {};

  const target = { kind: "workspace" as const };
  const resolved = await service.resolveArtifact({ target, projectPath, scope: "vanilla" });
  const members = await service.getClassMembers({ target, projectPath, scope: "vanilla", className: ITEM });

  // The resolve output keeps the internal label; the resolve-artifact tool reports it relabelled.
  assert.equal(resolved.mappingApplied, "obfuscated");
  assert.equal(resolved.provenance.workspaceResolution?.detected.minecraftVersion, "26.2");
  assert.equal(reportedResolveNamespace(resolved), "mojang");
  assert.equal(members.mappingApplied, "mojang");
  assert.equal(members.returnedNamespace, "mojang");
  assert.equal(members.context.mappingNamespace, "mojang");
});

test("the validate-project artifact probe reports mojang on 26.x and obfuscated on a legacy version", async () => {
  const root = await mkdtemp(join(tmpdir(), "reported-ns-probe-"));
  const jarPath = await writeItemJar(root, "client.jar");
  const svc = {
    versionService: {
      resolveVersionJar: async (version: string) => ({
        version,
        jarPath,
        source: "downloaded" as const,
        clientJarUrl: "cache:index"
      })
    }
  } as unknown as SourceServiceType;

  const probe = async (version: string, mapping?: "obfuscated") =>
    (await probeMinecraftArtifact(svc, { target: { kind: "version", value: version }, ...(mapping ? { mapping } : {}) }))
      .mappingApplied;

  assert.equal(await probe("26.2"), "mojang");
  assert.equal(await probe("26.2", "obfuscated"), "mojang");
  assert.equal(await probe("1.21.10"), "obfuscated");
  assert.equal(await probe("1.21.10", "obfuscated"), "obfuscated");
});

/** A service whose manifest and jars are stubbed, and whose every jar holds the same Item signature. */
async function lifecycleService(versionsNewestFirst: string[]): Promise<SourceServiceType> {
  const { service, root } = await newService("reported-ns-lifecycle-");
  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versionsNewestFirst;
    },
    async resolveVersionJar(version: string) {
      return { version, jarPath: join(root, `${version}.jar`), source: "downloaded" as const, clientJarUrl: `https://example.test/${version}.jar` };
    }
  };
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature() {
      return {
        constructors: [],
        fields: [],
        methods: [
          {
            ownerFqn: ITEM,
            name: "getDescriptionId",
            javaSignature: "public java.lang.String getDescriptionId()",
            jvmDescriptor: "()Ljava/lang/String;",
            accessFlags: 0x0001,
            isSynthetic: false
          }
        ],
        warnings: [],
        context: {
          minecraftVersion: "unknown",
          mappingType: "unknown",
          mappingNamespace: "obfuscated",
          jarSignature: "fake",
          generatedAt: new Date().toISOString()
        }
      };
    }
  };
  return service;
}

test("diff-class-signatures reports mojang only when both endpoints are 26.x", async () => {
  const service = await lifecycleService(["26.2", "26.1", "1.21.10"]);
  const diff = async (fromVersion: string, toVersion: string, mapping?: "obfuscated") =>
    (await service.diffClassSignatures({ className: ITEM, fromVersion, toVersion, ...(mapping ? { mapping } : {}) }))
      .query.mapping;

  assert.equal(await diff("26.1", "26.2"), "mojang");
  assert.equal(await diff("26.1", "26.2", "obfuscated"), "mojang");
  // A mixed-era comparison keeps today's value, with mapping omitted and explicit.
  assert.equal(await diff("1.21.10", "26.2"), "obfuscated");
  assert.equal(await diff("1.21.10", "26.2", "obfuscated"), "obfuscated");
});

test("trace-symbol-lifecycle reports mojang only when every scanned version is 26.x", async () => {
  const service = await lifecycleService(["26.2", "26.1", "1.21.10"]);
  const trace = async (fromVersion: string, toVersion: string, mapping?: "obfuscated") =>
    (await service.traceSymbolLifecycle({
      symbol: `${ITEM}.getDescriptionId`,
      fromVersion,
      toVersion,
      ...(mapping ? { mapping } : {})
    })).query.mapping;

  assert.equal(await trace("26.1", "26.2"), "mojang");
  assert.equal(await trace("26.1", "26.2", "obfuscated"), "mojang");
  // A range that reaches a pre-26.1 version keeps today's value, omitted or explicit.
  assert.equal(await trace("1.21.10", "26.2"), "obfuscated");
  assert.equal(await trace("1.21.10", "26.2", "obfuscated"), "obfuscated");
});

const ITEM_MIXIN = [
  "import net.minecraft.world.item.Item;",
  "import org.spongepowered.asm.mixin.Mixin;",
  "import org.spongepowered.asm.mixin.injection.Inject;",
  "import org.spongepowered.asm.mixin.injection.At;",
  "@Mixin(Item.class)",
  "public abstract class ItemMixin {",
  '  @Inject(method = "getDescriptionId", at = @At("HEAD"))',
  "  private void onGetDescriptionId() {}",
  "}"
].join("\n");

async function validateItemMixin(version: string, mapping?: "obfuscated" | "mojang") {
  const { service, root } = await newService("reported-ns-mixin-");
  const jarPath = await writeItemJar(root, `${version}.jar`);
  (service as unknown as { versionService: unknown }).versionService = {
    async resolveVersionJar(requested: string) {
      return { version: requested, jarPath };
    }
  };
  const output = await service.validateMixin({
    input: { mode: "inline", source: ITEM_MIXIN },
    version,
    ...(mapping ? { mapping } : {}),
    reportMode: "full"
  });
  const single = output.results[0]?.result;
  assert.ok(single, JSON.stringify(output));
  return single;
}

test("validate-mixin reports mojang on 26.x without a mapping-mismatch penalty", async () => {
  for (const mapping of [undefined, "obfuscated"] as const) {
    const result = await validateItemMixin("26.2", mapping);

    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.provenance?.requestedMapping, "obfuscated");
    assert.equal(result.provenance?.mappingApplied, "mojang");
    assert.deepEqual(
      result.confidenceBreakdown?.penalties,
      [],
      `the relabel must not cost a mapping-fallback penalty: ${JSON.stringify(result.confidenceBreakdown)}`
    );
    assert.ok(!(result.provenance?.resolutionNotes ?? []).some((note) => note.startsWith("Mapping fallback")));
  }
});

test("validate-mixin with mapping mojang on 26.x treats it as the runtime names, with no tool issue", async () => {
  const result = await validateItemMixin("26.2", "mojang");

  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.ok(
    (result.targetOutcomes ?? []).every((outcome) => outcome.status === "ok"),
    `no target may be a tool issue: ${JSON.stringify(result.targetOutcomes)}`
  );
  assert.ok(
    !result.warnings.some((warning) => warning.startsWith("Could not map class")),
    `no class translation against the empty mapping graph: ${JSON.stringify(result.warnings)}`
  );
  assert.equal(result.provenance?.mappingApplied, "mojang");
  assert.deepEqual(result.confidenceBreakdown?.penalties, []);
});
