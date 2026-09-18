import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { INDEX_SCHEMA_VERSION } from "../../src/source/indexer.ts";
import { __getZipOpenCount, __resetZipOpenCount, type JavaSourceScan } from "../../src/source-jar-reader.ts";
import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { seedIndexedArtifact, stubExplorer } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * A kind="jar" target counts as an unobfuscated Minecraft runtime jar only on
 * in-jar proof: a root version.json whose `id` is a 26.1+ Minecraft
 * version, `net/minecraft/SharedConstants.class`, and no `.java` entries. The
 * path never counts as evidence, so every jar here sits at a neutral name.
 */

const CLASS_BYTES = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const SHARED_CONSTANTS = "net/minecraft/SharedConstants.class";

type ResolveOutput = {
  version?: string;
  requestedMapping: string;
  mappingApplied: string;
  qualityFlags: string[];
  provenance: {
    transformChain: string[];
    resolvedFrom: { version?: string };
    unobfuscatedRuntime?: boolean;
  };
};

type ProblemError = {
  code?: string;
  details?: {
    nextAction?: string;
    suggestedCall?: { tool: string; params: Record<string, unknown> };
  };
};

async function makeService(root: string) {
  const { SourceService } = await import("../../src/source-service.ts");
  const service = new SourceService(buildTestConfig(root));
  // Decompilation is not what these tests are about; the mapping decision happens
  // before ingest, so skipping it keeps the tests on the resolver alone.
  (service as unknown as { ingestIfNeeded: (resolved: unknown) => Promise<void> }).ingestIfNeeded =
    async () => {};
  return service;
}

async function writeRuntimeJar(
  root: string,
  entries: Record<string, string | Buffer>
): Promise<string> {
  const jarPath = join(root, "runtime.jar");
  await createJar(jarPath, {
    "net/minecraft/world/item/Item.class": CLASS_BYTES,
    ...entries
  });
  return jarPath;
}

async function resolveJar(
  root: string,
  jarPath: string,
  mapping?: "mojang" | "obfuscated"
): Promise<ResolveOutput> {
  const service = await makeService(root);
  return (await service.resolveArtifact({
    target: { kind: "jar", value: jarPath },
    ...(mapping ? { mapping } : {})
  })) as unknown as ResolveOutput;
}

async function expectMojangRefused(root: string, jarPath: string): Promise<ProblemError> {
  const service = await makeService(root);
  let caught: unknown;
  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: jarPath },
        mapping: "mojang"
      }),
    (error: unknown) => {
      caught = error;
      assert.equal((error as ProblemError).code, ERROR_CODES.MAPPING_NOT_APPLIED);
      return true;
    }
  );
  return caught as ProblemError;
}

test("resolveArtifact accepts mapping mojang on a jar proven to be a Minecraft 26.x runtime jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-proven-mojang-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2", name: "26.2" }),
    [SHARED_CONSTANTS]: CLASS_BYTES
  });

  const resolved = await resolveJar(root, jarPath, "mojang");

  assert.equal(resolved.requestedMapping, "mojang");
  assert.equal(resolved.mappingApplied, "mojang");
  assert.ok(
    resolved.provenance.transformChain.includes("mapping:mojang-runtime-unobfuscated"),
    `expected the unobfuscated runtime pass-through, got ${JSON.stringify(resolved.provenance.transformChain)}`
  );
  assert.equal(resolved.provenance.unobfuscatedRuntime, true);
  assert.equal(resolved.version, "26.2");
  assert.equal(resolved.provenance.resolvedFrom.version, "26.2");
});

test("resolveArtifact keeps the obfuscated label on a proven 26.x runtime jar and flags unobfuscatedRuntime", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-proven-default-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2" }),
    [SHARED_CONSTANTS]: CLASS_BYTES
  });

  const resolved = await resolveJar(root, jarPath);

  // The as-shipped namespace keeps its label; the flag says what it means.
  assert.equal(resolved.requestedMapping, "obfuscated");
  assert.equal(resolved.mappingApplied, "obfuscated");
  assert.equal(resolved.provenance.unobfuscatedRuntime, true);
  assert.equal(resolved.version, "26.2");
});

test("resolveArtifact still refuses mojang on a jar whose version.json names a legacy 1.x release", async () => {
  // A Loom-mapped 1.21.10 jar carries both version.json and SharedConstants; only
  // the id tells it apart, so the id must pass the unobfuscated-version test.
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-legacy-id-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "1.21.10" }),
    [SHARED_CONSTANTS]: CLASS_BYTES
  });

  await expectMojangRefused(root, jarPath);
  const resolved = await resolveJar(root, jarPath, "obfuscated");
  assert.equal(resolved.version, undefined);
  assert.equal("unobfuscatedRuntime" in resolved.provenance, false);
});

test("resolveArtifact still refuses mojang on a jar with a 26.x version.json but no SharedConstants class", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-no-shared-constants-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2" })
  });

  await expectMojangRefused(root, jarPath);
});

test("resolveArtifact still refuses mojang on a jar with SharedConstants but no version.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-no-version-json-"));
  const jarPath = await writeRuntimeJar(root, {
    [SHARED_CONSTANTS]: CLASS_BYTES
  });

  await expectMojangRefused(root, jarPath);
});

test("resolveArtifact serves a 26.x jar that carries .java entries through the source path, not the runtime gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-with-sources-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2" }),
    [SHARED_CONSTANTS]: CLASS_BYTES,
    "net/minecraft/world/item/Item.java": "package net.minecraft.world.item;\npublic class Item {}"
  });

  const resolved = await resolveJar(root, jarPath, "mojang");

  assert.equal(resolved.mappingApplied, "mojang");
  assert.ok(resolved.provenance.transformChain.includes("mapping:mojang-source-backed"));
  assert.ok(!resolved.provenance.transformChain.includes("mapping:mojang-runtime-unobfuscated"));
  assert.equal("unobfuscatedRuntime" in resolved.provenance, false);
  assert.equal(resolved.version, undefined);
});

test("resolveArtifact does not apply the runtime-jar proof to a dependency-origin jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-dependency-origin-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2" }),
    [SHARED_CONSTANTS]: CLASS_BYTES
  });
  const service = await makeService(root);
  (service as unknown as { synthesizeDependencyTarget: unknown }).synthesizeDependencyTarget = async () => ({
    target: { kind: "jar", value: jarPath },
    requestedMapping: "mojang",
    warnings: [],
    provenance: {
      group: "com.example",
      name: "bundles-minecraft",
      resolvedVersion: "26.2",
      source: "test-stub",
      cacheHit: false
    }
  });

  const resolved = (await service.resolveArtifact({
    target: { kind: "dependency", group: "com.example", name: "bundles-minecraft" },
    projectPath: root,
    mapping: "mojang"
  } as never)) as unknown as ResolveOutput;

  assert.equal(resolved.mappingApplied, "obfuscated");
  assert.ok(resolved.qualityFlags.includes("dependency-mapping-unverified"));
  assert.equal("unobfuscatedRuntime" in resolved.provenance, false);
  assert.equal(resolved.version, undefined);
});

test("resolveArtifact collects the runtime-jar proof without opening the archive more often than for an unproven jar", async () => {
  const provenRoot = await mkdtemp(join(tmpdir(), "unobf-jar-open-count-proven-"));
  const provenJar = await writeRuntimeJar(provenRoot, {
    "version.json": JSON.stringify({ id: "26.2" }),
    [SHARED_CONSTANTS]: CLASS_BYTES
  });
  const controlRoot = await mkdtemp(join(tmpdir(), "unobf-jar-open-count-control-"));
  const controlJar = await writeRuntimeJar(controlRoot, {
    "net/minecraft/world/level/Level.class": CLASS_BYTES
  });

  __resetZipOpenCount();
  const control = await resolveJar(controlRoot, controlJar, "obfuscated");
  const controlOpens = __getZipOpenCount();

  __resetZipOpenCount();
  const proven = await resolveJar(provenRoot, provenJar, "mojang");
  const provenOpens = __getZipOpenCount();

  assert.equal("unobfuscatedRuntime" in control.provenance, false);
  assert.equal(proven.provenance.unobfuscatedRuntime, true);
  // Absolute counts, not a comparison: an extra open on every jar would keep the two
  // equal. A decompile-bound jar resolve opens the archive exactly twice - the
  // subject scan (which looks for .java entries and now also collects the proof) and
  // the class-entry inspection before decompiling.
  assert.equal(controlOpens, 2, "an unproven jar resolve opens the archive twice");
  assert.equal(provenOpens, 2, "reading version.json must ride the existing archive walk, not a separate open");

  // The subject-scan stage alone: one open, and that walk already carries the proof.
  __resetZipOpenCount();
  let opensWhenScanned: number | undefined;
  let scan: JavaSourceScan | undefined;
  await resolveSourceTarget(
    { kind: "jar", value: provenJar },
    {
      allowDecompile: true,
      onSubjectJarScanned: (subjectScan) => {
        opensWhenScanned = __getZipOpenCount();
        scan = subjectScan;
      }
    },
    buildTestConfig(provenRoot)
  );
  assert.equal(opensWhenScanned, 1);
  assert.equal(scan?.hasJavaSources, false);
  assert.equal(scan?.minecraftRuntimeSignals?.hasSharedConstantsClass, true);
  assert.equal(scan?.minecraftRuntimeSignals?.versionJsonText, JSON.stringify({ id: "26.2" }));
});

test("resolveArtifact flags unobfuscatedRuntime for a 26.x version target and not for a 1.x one", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-version-target-flag-"));
  const jarPath = await writeRuntimeJar(root, {});
  const service = await makeService(root);
  (service as unknown as { versionService: Record<string, unknown> }).versionService = {
    ...(service as unknown as { versionService: Record<string, unknown> }).versionService,
    async resolveVersionJar(version: string) {
      return { version, jarPath, clientJarUrl: `https://example.test/${version}/client.jar` };
    }
  };

  const modern = (await service.resolveArtifact({
    target: { kind: "version", value: "26.1" },
    mapping: "obfuscated"
  })) as unknown as ResolveOutput;
  const legacy = (await service.resolveArtifact({
    target: { kind: "version", value: "1.21.10" },
    mapping: "obfuscated"
  })) as unknown as ResolveOutput;

  assert.equal(modern.mappingApplied, "obfuscated");
  assert.equal(modern.provenance.unobfuscatedRuntime, true);
  assert.equal(legacy.mappingApplied, "obfuscated");
  assert.equal("unobfuscatedRuntime" in legacy.provenance, false);
});

test("resolveArtifact flags unobfuscatedRuntime for a Minecraft 26.x runtime coordinate but not for a library with a 26.x-shaped version", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-coordinate-flag-"));
  await createJar(join(root, "m2", "net", "minecraft", "client", "26.1", "client-26.1.jar"), {
    "net/minecraft/world/item/Item.class": CLASS_BYTES
  });
  await createJar(join(root, "m2", "com", "example", "libunobf", "26.0.2", "libunobf-26.0.2.jar"), {
    "com/example/Lib.class": CLASS_BYTES
  });
  const service = await makeService(root);

  const runtime = (await service.resolveArtifact({
    target: { kind: "coordinate", value: "net.minecraft:client:26.1" },
    mapping: "obfuscated"
  })) as unknown as ResolveOutput;
  const library = (await service.resolveArtifact({
    target: { kind: "coordinate", value: "com.example:libunobf:26.0.2" },
    mapping: "obfuscated"
  })) as unknown as ResolveOutput;

  assert.equal(runtime.provenance.unobfuscatedRuntime, true);
  assert.equal("unobfuscatedRuntime" in library.provenance, false);
});

test("a mojang refusal on an unproven jar explains mapping obfuscated as the as-shipped names", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-refusal-wording-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2" })
  });

  const error = await expectMojangRefused(root, jarPath);
  const nextAction = error.details?.nextAction ?? "";
  const suggested = error.details?.suggestedCall;

  assert.ok(
    !nextAction.includes("runtime obfuscated namespace"),
    `a modern jar's as-shipped names are not obfuscated; got: ${nextAction}`
  );
  assert.match(nextAction, /as shipped/);
  assert.match(nextAction, /Mojang names on Minecraft 26\.1\+/);
  assert.match(nextAction, /target kind "version"/);
  assert.equal(suggested?.tool, "resolve-artifact");
  assert.equal(suggested?.params.mapping, "obfuscated");
  assert.deepEqual(suggested?.params.target, { kind: "jar", value: jarPath });
});

test("a mojang refusal on a jar in a 26.x project is never re-suggested with mapping mojang", async () => {
  // scope=merged only drives Loom source discovery for version targets, so
  // re-suggesting mojang+merged for the same jar reproduces the same refusal.
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-refusal-loop-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  await writeFile(join(projectPath, "gradle.properties"), "minecraft_version=26.2\n", "utf8");
  const jarPath = await writeRuntimeJar(root, {});
  const service = await makeService(root);

  let caught: ProblemError | undefined;
  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: jarPath },
        mapping: "mojang",
        scope: "vanilla",
        projectPath
      }),
    (error: unknown) => {
      caught = error as ProblemError;
      return caught.code === ERROR_CODES.MAPPING_NOT_APPLIED;
    }
  );

  const suggested = caught?.details?.suggestedCall;
  assert.equal(suggested?.tool, "resolve-artifact");
  assert.notEqual(suggested?.params.mapping, "mojang", "the retry must not repeat the refused request");
  assert.equal(suggested?.params.mapping, "obfuscated");
  assert.ok(!(caught?.details?.nextAction ?? "").includes("scope=merged"));
});

test("a mojang refusal on a 1.x version target keeps the legacy obfuscated retry text", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-legacy-fallback-text-"));
  const service = await makeService(root);

  const fallback = await (service as unknown as {
    buildMappingFallbackSuggestedCall: (args: Record<string, unknown>) => Promise<{
      nextAction: string;
      suggestedCall: { params: Record<string, unknown> };
    }>;
  }).buildMappingFallbackSuggestedCall({
    input: { target: { kind: "version", value: "1.21.10" } },
    kind: "version",
    value: "1.21.10",
    scope: undefined,
    effectiveMapping: "mojang"
  });

  assert.equal(fallback.nextAction, "Retry with mapping=obfuscated to use the runtime obfuscated namespace.");
  assert.equal(fallback.suggestedCall.params.mapping, "obfuscated");
});

const ITEM = "net.minecraft.world.item.Item";
const MISSING_ITEM = "net.minecraft.world.item.Itemz";
const SEEDED_INDEXED_AT = "2026-01-01T00:00:00.000Z";

type StoredRow = {
  version?: string;
  requestedMapping?: string;
  mappingApplied?: string;
  provenance?: { resolvedFrom?: { version?: string }; unobfuscatedRuntime?: boolean; transformChain?: string[] };
};

/**
 * A service whose cache holds the row an earlier release wrote for this 26.x jar,
 * before the jar could be proved to be a runtime jar: same artifactId (the content
 * hash), no version, labelled "obfuscated", no unobfuscatedRuntime flag, and index
 * meta that makes every later resolve of the jar a warm cache hit.
 */
async function serviceWithPreProofJarRow(root: string, jarPath: string, storedVersion?: string) {
  const { SourceService } = await import("../../src/source-service.ts");
  const service = new SourceService(buildTestConfig(root));
  const internals = service as unknown as {
    ingestIfNeeded: (resolved: { artifactId: string; artifactSignature: string }) => Promise<void>;
    indexMetaRepo: {
      upsert: (meta: Record<string, unknown>) => void;
      get: (artifactId: string) => { indexedAt: string } | undefined;
    };
    artifactsRepo: { getArtifact: (artifactId: string) => StoredRow | undefined };
  };

  // The id and signature this jar resolves to, captured without indexing anything.
  let identity: { artifactId: string; artifactSignature: string } | undefined;
  internals.ingestIfNeeded = async (resolved) => {
    identity = { artifactId: resolved.artifactId, artifactSignature: resolved.artifactSignature };
  };
  await service.resolveArtifact({ target: { kind: "jar", value: jarPath }, mapping: "obfuscated" });
  delete (internals as { ingestIfNeeded?: unknown }).ingestIfNeeded;
  assert.ok(identity, "the capture resolve reached ingest");

  seedIndexedArtifact(service, {
    artifactId: identity.artifactId,
    origin: "decompiled",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    ...(storedVersion ? { version: storedVersion } : {}),
    binaryJarPath: jarPath,
    isDecompiled: true,
    files: [
      {
        filePath: "net/minecraft/world/item/Item.java",
        content: "package net.minecraft.world.item;\npublic class Item {}\n"
      }
    ],
    symbols: [
      {
        filePath: "net/minecraft/world/item/Item.java",
        symbolKind: "class",
        symbolName: "Item",
        qualifiedName: ITEM,
        line: 2
      }
    ],
    provenance: {
      target: { kind: "jar", value: jarPath },
      resolvedAt: SEEDED_INDEXED_AT,
      resolvedFrom: { origin: "decompiled", binaryJarPath: jarPath, ...(storedVersion ? { version: storedVersion } : {}) },
      transformChain: ["mapping:obfuscated-pass-through"]
    }
  });
  internals.indexMetaRepo.upsert({
    artifactId: identity.artifactId,
    artifactSignature: identity.artifactSignature,
    indexSchemaVersion: INDEX_SCHEMA_VERSION,
    filesCount: 1,
    symbolsCount: 1,
    ftsRowsCount: 1,
    indexedAt: SEEDED_INDEXED_AT,
    indexDurationMs: 1
  });
  return { service, internals, artifactId: identity.artifactId, artifactSignature: identity.artifactSignature };
}

test("a warm resolve of a proven 26.x jar backfills the version onto a row indexed before the proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-warm-backfill-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2" }),
    [SHARED_CONSTANTS]: CLASS_BYTES
  });
  const { service, internals, artifactId } = await serviceWithPreProofJarRow(root, jarPath);
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

  const resolved = (await service.resolveArtifact({
    target: { kind: "jar", value: jarPath },
    mapping: "mojang"
  })) as unknown as ResolveOutput & { artifactId: string };

  assert.equal(resolved.artifactId, artifactId);
  assert.equal(resolved.version, "26.2");
  assert.equal(internals.indexMetaRepo.get(artifactId)?.indexedAt, SEEDED_INDEXED_AT, "served warm, not re-indexed");
  const members = await service.getClassMembers({ artifactId, className: ITEM, mapping: "mojang" });
  assert.deepEqual(members.members.methods.map((method) => method.name), ["getDescriptionId"]);

  let nextAction = "";
  await assert.rejects(
    () => service.getClassSource({ artifactId, className: MISSING_ITEM, mode: "full" }),
    (error: unknown) => {
      nextAction = (error as ProblemError).details?.nextAction ?? "";
      return (error as ProblemError).code === ERROR_CODES.CLASS_NOT_FOUND;
    }
  );
  assert.ok(!nextAction.includes("usually require mapping"), `no legacy namespace hint on 26.x; got: ${nextAction}`);
  assert.match(nextAction, /Minecraft 26\.2 ships Mojang names/);

  const found = service.findClass({ artifactId, className: MISSING_ITEM });
  assert.equal(found.total, 0);
  assert.ok(found.warnings.every((warning) => !warning.includes("usually require mapping")), JSON.stringify(found.warnings));
  assert.ok(found.warnings.some((warning) => warning.includes(`Did you mean "${ITEM}"?`)), JSON.stringify(found.warnings));

  const row = internals.artifactsRepo.getArtifact(artifactId);
  assert.equal(row?.version, "26.2");
  assert.equal(row?.provenance?.resolvedFrom?.version, "26.2");
  assert.equal(row?.provenance?.unobfuscatedRuntime, true);
  // Only the gaps are filled: the label and chain the row was indexed under stay.
  assert.equal(row?.mappingApplied, "obfuscated");
  assert.equal(row?.requestedMapping, "obfuscated");
  assert.deepEqual(row?.provenance?.transformChain, ["mapping:obfuscated-pass-through"]);
});

test("a warm resolve never replaces a version the stored row already records", async () => {
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-warm-keep-version-"));
  const jarPath = await writeRuntimeJar(root, {
    "version.json": JSON.stringify({ id: "26.2" }),
    [SHARED_CONSTANTS]: CLASS_BYTES
  });
  const { service, internals, artifactId } = await serviceWithPreProofJarRow(root, jarPath, "26.1");

  await service.resolveArtifact({ target: { kind: "jar", value: jarPath }, mapping: "mojang" });

  const row = internals.artifactsRepo.getArtifact(artifactId);
  assert.equal(row?.version, "26.1");
  assert.equal(row?.provenance?.resolvedFrom?.version, "26.1");
  assert.equal(row?.provenance?.unobfuscatedRuntime, undefined);
});

test("a warm ingest does not persist a version the fresh provenance does not record", async () => {
  // get-class-source's binary fallback re-ingests with the caller's version, which
  // preferProjectVersion may have taken from gradle.properties, and with the stored
  // provenance. That version describes the project, not these bytes.
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-warm-project-version-"));
  const jarPath = await writeRuntimeJar(root, {});
  const { service, internals, artifactId, artifactSignature } = await serviceWithPreProofJarRow(root, jarPath);
  const stored = internals.artifactsRepo.getArtifact(artifactId) as StoredRow & Record<string, unknown>;

  await (service as unknown as { ingestIfNeeded: (resolved: Record<string, unknown>) => Promise<void> }).ingestIfNeeded({
    artifactId,
    artifactSignature,
    origin: "decompiled",
    binaryJarPath: jarPath,
    version: "1.21.10",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    provenance: stored.provenance,
    qualityFlags: ["binary-fallback"],
    isDecompiled: true,
    resolvedAt: new Date().toISOString()
  });

  const row = internals.artifactsRepo.getArtifact(artifactId);
  assert.equal(internals.indexMetaRepo.get(artifactId)?.indexedAt, SEEDED_INDEXED_AT, "served warm");
  assert.equal(row?.version, undefined);
  assert.equal(row?.provenance?.resolvedFrom?.version, undefined);
});

test("a warm ingest does not backfill a library version recorded by a dependency resolve", async () => {
  // A jar first indexed as kind:"jar" (version NULL) can later be reached as a
  // dependency whose fresh provenance records the library's own release. That
  // version describes a library, not Minecraft, and the stored provenance does not
  // mark the row as a dependency, so later lookups would read it as Minecraft's.
  const root = await mkdtemp(join(tmpdir(), "unobf-jar-warm-library-version-"));
  const jarPath = await writeRuntimeJar(root, {});
  const { service, internals, artifactId, artifactSignature } = await serviceWithPreProofJarRow(root, jarPath);
  const stored = internals.artifactsRepo.getArtifact(artifactId) as StoredRow & Record<string, unknown>;
  const storedProvenance = (stored.provenance ?? {}) as { resolvedFrom?: Record<string, unknown> } & Record<string, unknown>;

  await (service as unknown as { ingestIfNeeded: (resolved: Record<string, unknown>) => Promise<void> }).ingestIfNeeded({
    artifactId,
    artifactSignature,
    origin: "local-jar",
    binaryJarPath: jarPath,
    version: "26.0.2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    provenance: { ...storedProvenance, resolvedFrom: { ...(storedProvenance.resolvedFrom ?? {}), version: "26.0.2" } },
    qualityFlags: [],
    isDecompiled: false,
    resolvedAt: new Date().toISOString()
  });

  const row = internals.artifactsRepo.getArtifact(artifactId);
  assert.equal(internals.indexMetaRepo.get(artifactId)?.indexedAt, SEEDED_INDEXED_AT, "served warm");
  assert.equal(row?.version, undefined);
  assert.equal(row?.provenance?.unobfuscatedRuntime, undefined);
});
