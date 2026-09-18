import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

/**
 * On Minecraft 26.1+ the runtime ships Mojang names, so an artifact labelled
 * "obfuscated" already holds Mojang names. The legacy advice
 * "Deobfuscated names ... usually require mapping=\"mojang\"" is false there and
 * sends an agent round a mapping change that cannot find a different class.
 */

const PRESENT_CLASS = "net.minecraft.world.item.Item";
const MISSING_CLASS = "net.minecraft.world.item.Itemz";

const LEGACY_HINT =
  `Artifact is indexed in obfuscated runtime names. Deobfuscated names like "${MISSING_CLASS}" ` +
  `usually require mapping="mojang" or a find-mapping lookup to obfuscated names.`;

async function serviceWithIndexedMinecraft(version: string, options: { withBinaryJar?: boolean } = {}) {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), `unobf-hints-${version}-`));
  const service = new SourceService(buildTestConfig(root));
  const artifactId = `minecraft-${version}`;
  seedIndexedArtifact(service, {
    artifactId,
    origin: "decompiled",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version,
    isDecompiled: true,
    ...(options.withBinaryJar ? { binaryJarPath: join(root, "client.jar") } : {}),
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
        qualifiedName: PRESENT_CLASS,
        line: 2
      }
    ],
    provenance: {
      target: { kind: "version", value: version },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "decompiled", version },
      transformChain: ["mapping:obfuscated-pass-through"]
    }
  });
  return { service, artifactId };
}

async function classNotFoundNextAction(version: string): Promise<{
  nextAction: string;
  didYouMean: Array<{ className: string }>;
}> {
  const { service, artifactId } = await serviceWithIndexedMinecraft(version);
  let caught: { code?: string; details?: { nextAction?: string; didYouMean?: Array<{ className: string }> } } | undefined;
  await assert.rejects(
    () => service.getClassSource({ artifactId, className: MISSING_CLASS, mode: "full" }),
    (error: unknown) => {
      caught = error as typeof caught;
      return caught?.code === ERROR_CODES.CLASS_NOT_FOUND;
    }
  );
  return {
    nextAction: caught?.details?.nextAction ?? "",
    didYouMean: caught?.details?.didYouMean ?? []
  };
}

test("a get-class-source miss on a 26.x artifact leads with didYouMean and never asks for mapping mojang", async () => {
  const { nextAction, didYouMean } = await classNotFoundNextAction("26.2");

  assert.equal(didYouMean[0]?.className, PRESENT_CLASS);
  assert.ok(
    nextAction.startsWith(`Did you mean "${PRESENT_CLASS}"?`),
    `the near-miss must lead the recovery advice; got: ${nextAction}`
  );
  assert.ok(nextAction.includes("find-class"), "find-class stays available as the fallback route");
  assert.ok(!nextAction.includes("usually require mapping"), `no namespace steering on 26.x; got: ${nextAction}`);
  assert.ok(!nextAction.includes("mapping=\"mojang\""), `no namespace steering on 26.x; got: ${nextAction}`);
  assert.match(nextAction, /Minecraft 26\.2 ships Mojang names/);
});

test("a get-class-source miss on a 1.x artifact keeps the exact obfuscated namespace hint", async () => {
  const { nextAction } = await classNotFoundNextAction("1.21.10");

  assert.equal(
    nextAction,
    `Use find-class to resolve the correct fully-qualified name for "Itemz". ${LEGACY_HINT}`
  );
});

test("a find-class miss on a 26.x artifact offers near-miss names instead of a mapping change", async () => {
  const { service, artifactId } = await serviceWithIndexedMinecraft("26.2");

  const result = service.findClass({ artifactId, className: MISSING_CLASS });

  assert.equal(result.total, 0);
  assert.ok(
    result.warnings.every((warning) => !warning.includes("usually require mapping")),
    `no namespace steering on 26.x; got: ${JSON.stringify(result.warnings)}`
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes(`Did you mean "${PRESENT_CLASS}"?`)),
    `the miss must carry the near-miss candidate; got: ${JSON.stringify(result.warnings)}`
  );
});

test("a find-class miss on a 1.x artifact keeps the exact obfuscated namespace warning", async () => {
  const { service, artifactId } = await serviceWithIndexedMinecraft("1.21.10");

  const result = service.findClass({ artifactId, className: MISSING_CLASS });

  assert.equal(result.total, 0);
  assert.deepEqual(result.warnings, [`No exact class symbol matched "${MISSING_CLASS}". ${LEGACY_HINT}`]);
});

test("resolveClassNameForLookup is an identity between obfuscated and mojang on 26.x", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "unobf-lookup-identity-"));
  const service = new SourceService(buildTestConfig(root));
  const lookups: string[] = [];
  (service as unknown as { mappingService: Record<string, unknown> }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    async findMapping(input: { version: string }) {
      lookups.push(input.version);
      // The 26.x mapping graph is empty by design, so a real lookup misses too.
      return { resolved: false, candidates: [], warnings: [] };
    }
  };

  const modernWarnings: string[] = [];
  const toObfuscated = await service.resolveClassNameForLookup({
    className: PRESENT_CLASS,
    version: "26.2",
    sourceMapping: "mojang",
    targetMapping: "obfuscated",
    sourcePriority: undefined,
    warnings: modernWarnings,
    context: "source lookup"
  });
  const toMojang = await service.resolveClassNameForLookup({
    className: PRESENT_CLASS,
    version: "26.2",
    sourceMapping: "obfuscated",
    targetMapping: "mojang",
    sourcePriority: undefined,
    warnings: modernWarnings,
    context: "source lookup"
  });

  assert.equal(toObfuscated, PRESENT_CLASS);
  assert.equal(toMojang, PRESENT_CLASS);
  assert.deepEqual(modernWarnings, []);
  assert.deepEqual(lookups, [], "26.x must not consult the (empty) mapping graph");

  // Control: on a legacy version the lookup still runs and still reports its miss.
  const legacyWarnings: string[] = [];
  await service.resolveClassNameForLookup({
    className: PRESENT_CLASS,
    version: "1.21.10",
    sourceMapping: "mojang",
    targetMapping: "obfuscated",
    sourcePriority: undefined,
    warnings: legacyWarnings,
    context: "source lookup"
  });
  assert.deepEqual(lookups, ["1.21.10"]);
  assert.ok(legacyWarnings.some((warning) => warning.includes("Could not map class")));
});

test("get-class-source and get-class-members report unobfuscatedRuntime for a stored 26.x artifact whose provenance predates the flag", async () => {
  // Rows written before the flag existed are served warm and never rewritten, so
  // the flag is derived from the provenance's own recorded Minecraft version.
  const modern = await serviceWithIndexedMinecraft("26.2", { withBinaryJar: true });
  const legacy = await serviceWithIndexedMinecraft("1.21.10", { withBinaryJar: true });
  const { stubExplorer } = await import("../helpers/seed-artifact.ts");
  stubExplorer(modern.service, {});
  stubExplorer(legacy.service, {});

  const modernSource = await modern.service.getClassSource({
    artifactId: modern.artifactId,
    className: PRESENT_CLASS,
    mode: "full"
  });
  const legacySource = await legacy.service.getClassSource({
    artifactId: legacy.artifactId,
    className: PRESENT_CLASS,
    mode: "full"
  });
  const modernMembers = await modern.service.getClassMembers({
    artifactId: modern.artifactId,
    className: PRESENT_CLASS
  });

  assert.equal(modernSource.mappingApplied, "obfuscated");
  assert.equal((modernSource.provenance as { unobfuscatedRuntime?: boolean }).unobfuscatedRuntime, true);
  assert.equal((modernMembers.provenance as { unobfuscatedRuntime?: boolean }).unobfuscatedRuntime, true);
  assert.equal("unobfuscatedRuntime" in (legacySource.provenance as object), false);
});

const LIBRARY_CLASS = "org.jetbrains.annotations.Contract";

/**
 * A dependency artifact (org.jetbrains:annotations:<version>) read with mapping
 * "mojang". Its version is the library's own release number: 26.0.2 is not
 * Minecraft 26.0.2, so it must not reach the 26.1+ identity shortcut.
 */
async function libraryLookupWarnings(libraryVersion: string): Promise<{
  sourceWarnings: string[];
  memberWarnings: string[];
  lookups: string[];
}> {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), `unobf-library-${libraryVersion}-`));
  const service = new SourceService(buildTestConfig(root));
  const coordinate = `org.jetbrains:annotations:${libraryVersion}`;
  const artifactId = `annotations-${libraryVersion}`;
  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-m2",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    version: libraryVersion,
    binaryJarPath: join(root, `annotations-${libraryVersion}.jar`),
    files: [
      {
        filePath: "org/jetbrains/annotations/Contract.java",
        content: "package org.jetbrains.annotations;\npublic @interface Contract {}\n"
      }
    ],
    symbols: [
      {
        filePath: "org/jetbrains/annotations/Contract.java",
        symbolKind: "class",
        symbolName: "Contract",
        qualifiedName: LIBRARY_CLASS,
        line: 2
      }
    ],
    provenance: {
      target: { kind: "coordinate", value: coordinate },
      resolvedAt: new Date().toISOString(),
      resolvedFrom: { origin: "local-m2", coordinate, version: libraryVersion },
      transformChain: []
    }
  });
  const lookups: string[] = [];
  const miss = (input: { version: string; kind?: string; name: string }) => {
    lookups.push(`${input.kind ?? "method"}@${input.version}`);
    return { resolved: false, candidates: [], candidateCount: 0, warnings: [] };
  };
  (service as unknown as { mappingService: Record<string, unknown> }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    async findMapping(input: { version: string; kind: string; name: string }) {
      return miss(input);
    },
    async resolveMethodMappingExact(input: { version: string; name: string }) {
      return miss(input);
    }
  };
  const { stubExplorer } = await import("../helpers/seed-artifact.ts");
  stubExplorer(service, {
    methods: [
      {
        ownerFqn: LIBRARY_CLASS,
        name: "value",
        javaSignature: "public abstract java.lang.String value()",
        jvmDescriptor: "()Ljava/lang/String;",
        accessFlags: 0x0401,
        isSynthetic: false
      }
    ]
  });

  const source = await service.getClassSource({ artifactId, className: LIBRARY_CLASS, mapping: "mojang", mode: "full" });
  const members = await service.getClassMembers({ artifactId, className: LIBRARY_CLASS, mapping: "mojang" });
  return { sourceWarnings: source.warnings, memberWarnings: members.warnings, lookups };
}

test("a library whose own version looks like Minecraft 26.x keeps the mapping warnings a 24.x library gets", async () => {
  const baseline = await libraryLookupWarnings("24.1.0");
  // The baseline is the unchanged pre-26.x path: it consults mappings and reports the misses.
  assert.ok(baseline.lookups.length > 0);
  assert.ok(baseline.sourceWarnings.some((warning) => warning.startsWith(`Could not map class "${LIBRARY_CLASS}" from mojang to obfuscated`)));
  assert.ok(baseline.memberWarnings.some((warning) => warning.startsWith(`Could not map class "${LIBRARY_CLASS}" from mojang to obfuscated`)));
  assert.ok(baseline.memberWarnings.some((warning) => warning.startsWith("Could not remap 1 method from obfuscated to mojang")));

  for (const libraryVersion of ["26.0.2", "27.1.0"]) {
    const library = await libraryLookupWarnings(libraryVersion);
    const asBaseline = (warnings: string[]) => warnings.map((warning) => warning.replaceAll(libraryVersion, "24.1.0"));
    assert.deepEqual(asBaseline(library.sourceWarnings), baseline.sourceWarnings, `${libraryVersion} get-class-source`);
    assert.deepEqual(asBaseline(library.memberWarnings), baseline.memberWarnings, `${libraryVersion} get-class-members`);
    assert.deepEqual(
      library.lookups,
      baseline.lookups.map((lookup) => lookup.replace("24.1.0", libraryVersion)),
      `${libraryVersion} consults mappings exactly as the 24.x library does`
    );
  }
});
