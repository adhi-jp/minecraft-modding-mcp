import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ERROR_CODES } from "../src/errors.ts";
import type { SourceMapping } from "../src/types.ts";
import {
  installGradleUserHomeIsolation,
  buildTestConfig,
  withCwd,
  createVersionServiceStub,
  queryFromSymbol,
  createLoomService,
  writeLoomTinyCache,
  TEST_TINY,
  TEST_AMBIGUOUS_METHOD_TINY,
  TEST_AMBIGUOUS_CLASS_TINY,
  TEST_DESCRIPTOR_REMAP_TINY,
  TEST_DESCRIPTOR_REMAP_MIXED_JDK_TINY,
  TEST_TINY_YARN_2COL,
  TEST_MOJANG_CLIENT_MAPPINGS
} from "./helpers/mapping-service-fixtures.ts";

installGradleUserHomeIsolation();

test("MappingService checkSymbolExists matches a descriptor against an intermediary-coordinate yarn tiny", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-yarn-2col-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    await writeLoomTinyCache(root, TEST_TINY_YARN_2COL);
    const service = new MappingService(config, createVersionServiceStub(), globalThis.fetch);

    const result = await withCwd(root, () =>
      service.checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.level.Level",
        name: "doThing",
        // Query descriptor is in yarn (named) coordinates; the stored descriptor
        // is in intermediary coordinates. Projecting only to obfuscated (absent
        // from this graph) used to miss it and report not_found.
        descriptor: "(Lnet/minecraft/world/level/Level;)V",
        sourceMapping: "yarn"
      } as never)
    );

    assert.equal(result.resolved, true, `expected resolved, got ${JSON.stringify(result)}`);
    assert.equal(result.status, "resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checks symbol existence across class/field/method kinds", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const classExists = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            name: string;
            owner?: string;
            sourceMapping: SourceMapping;
            descriptor?: string;
          }) => Promise<{ resolved: boolean; status: string }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "obfuscated"
      })
    );
    assert.equal(classExists.resolved, true);
    assert.equal(classExists.status, "resolved");

    await assert.rejects(
      () =>
        withCwd(root, () =>
          (
            service as unknown as {
              checkSymbolExists: (input: {
                version: string;
                kind: "class" | "field" | "method";
                owner?: string;
                name: string;
                sourceMapping: SourceMapping;
                descriptor?: string;
                signatureMode?: "exact" | "name-only";
              }) => Promise<{ resolved: boolean; status: string }>;
            }
          ).checkSymbolExists({
            version: "1.21.10",
            kind: "method",
            owner: "a.b.C",
            name: "f",
            sourceMapping: "obfuscated",
            // Default signatureMode is now name-only; assert the strict path explicitly.
            signatureMode: "exact"
          })
        ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );

    const methodExists = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
            descriptor?: string;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{ resolved: boolean; status: string }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(I)V",
        // Default signatureMode is now name-only (would ignore the descriptor and go ambiguous);
        // assert exact descriptor resolution explicitly.
        signatureMode: "exact",
        sourceMapping: "obfuscated"
      })
    );
    assert.equal(methodExists.resolved, true);
    assert.equal(methodExists.status, "resolved");

    // signatureMode=name-only should NOT throw when descriptor is omitted
    const nameOnlyResult = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{ resolved: boolean; status: string; candidates: unknown[] }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        sourceMapping: "obfuscated",
        signatureMode: "name-only"
      })
    );
    // Two overloads of "f" exist, so name-only resolves as ambiguous
    assert.equal(nameOnlyResult.status, "ambiguous");
    assert.ok(nameOnlyResult.candidates.length >= 2);

    // signatureMode=name-only with unique method "e" should resolve
    const nameOnlyUnique = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{ resolved: boolean; status: string; candidates: unknown[] }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "e",
        sourceMapping: "obfuscated",
        signatureMode: "name-only"
      })
    );
    assert.equal(nameOnlyUnique.resolved, true);
    assert.equal(nameOnlyUnique.status, "resolved");
    assert.equal(nameOnlyUnique.candidates.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService.findMapping honors nameMode=auto for dotless non-obfuscated class names", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-find-namemode-"));
  try {
    const config = buildTestConfig(root);
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/mappings/client.txt") {
        return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const service = new MappingService(
      config,
      createVersionServiceStub("https://example.test/mappings/client.txt"),
      fetchStub
    );

    // nameMode=auto lets a dotless non-obfuscated class name through to resolution
    // (no ERR_INVALID_INPUT at the normalize step). It need not resolve — just not be rejected.
    const lenient = await service.findMapping({
      version: "1.21.10",
      kind: "class",
      name: "NamedClass",
      sourceMapping: "mojang",
      targetMapping: "obfuscated",
      nameMode: "auto"
    });
    assert.ok(
      ["resolved", "not_found", "ambiguous", "mapping_unavailable"].includes(lenient.status),
      `expected a resolution status, got ${lenient.status}`
    );

    // nameMode=fqcn still requires a fully-qualified name for a non-obfuscated mapping.
    await assert.rejects(
      () =>
        service.findMapping({
          version: "1.21.10",
          kind: "class",
          name: "NamedClass",
          sourceMapping: "mojang",
          targetMapping: "obfuscated",
          nameMode: "fqcn"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkSymbolExists projects descriptor class references before matching overloads", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-projection-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Tiny records store the descriptor with intermediary/obfuscated class refs like
    // `Lnet/minecraft/class_2338;`. The caller uses yarn namespace with the named class
    // references (`BlockPos`, `BlockState`). Without descriptor projection the verbatim
    // comparison would fail; with projection the yarn descriptor is translated to the
    // intermediary/obfuscated form before matching and the lookup resolves.
    const yarnDescriptor =
      "(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;I)Z";
    const resolved = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            descriptor?: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{
            resolved: boolean;
            status: string;
            candidates: Array<{ name: string; descriptor?: string }>;
          }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.level.Level",
        name: "setBlock",
        descriptor: yarnDescriptor,
        sourceMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(resolved.resolved, true, "exact descriptor with remapped class refs should resolve");
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.candidates.length, 1);
    assert.equal(resolved.candidates[0]?.name, "setBlock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping signatureMode=exact accepts partial projection for mixed MC + JDK descriptors", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-findmapping-exact-mixed-jdk-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_MIXED_JDK_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Before the fix, findMapping returned mapping_unavailable here because projection.complete
    // was false (Ljava/lang/String; is not in the mapping graph). The partial projection is
    // still useful: ItemStack gets remapped to class_1799 while String passes through, and the
    // resulting descriptor matches the stored record verbatim.
    const yarnDescriptor = "(Lnet/minecraft/world/item/ItemStack;Ljava/lang/String;)V";
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.item.ItemStack",
        name: "tagWithLabel",
        descriptor: yarnDescriptor,
        sourceMapping: "yarn",
        targetMapping: "obfuscated",
        signatureMode: "exact"
      })
    );

    assert.equal(mapped.resolved, true, "mixed MC + JDK descriptor should still resolve in exact mode");
    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.name, "method_9000");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping signatureMode=exact accepts obfuscated-canonical descriptors on multi-hop paths", async () => {
  // Mojang -> Yarn lookups traverse mojang -> obfuscated -> intermediary -> yarn. Tiny v2
  // stores a single descriptor (typically obfuscated) and shares it across columns, so the
  // final Yarn candidate can carry an obfuscated-form descriptor instead of the yarn-form
  // projection that the strict filter's `strictDescriptor` holds. The filter must still
  // accept the candidate; otherwise the advertised exact retry path produces false `not_found`
  // for the most common migration shape (Mojang method whose descriptor references a remapped
  // Minecraft class).
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-findmapping-exact-multihop-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Use the obfuscated-form descriptor the caller sees via resolveMethodMappingExact's
    // projection target. Source namespace is obfuscated so the lookup is exact-identity on
    // the descriptor side but still exercises the strict filter's accepted-descriptors set.
    const descriptor = "(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z";
    const mapped = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.class_1937",
        name: "method_1725",
        descriptor,
        sourceMapping: "obfuscated",
        targetMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(
      mapped.resolved,
      true,
      "multi-hop exact lookup must resolve even when candidate descriptor stays in obfuscated form"
    );
    assert.equal(mapped.status, "resolved");
    assert.equal(mapped.resolvedSymbol?.name, "setBlock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping omitted signatureMode behaves as name-only at the service layer", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-findmapping-omitted-sigmode-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_AMBIGUOUS_METHOD_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // When signatureMode is omitted the service default must match the public tool schema
    // default ("name-only"). Callers that omit the descriptor entirely on kind=method must
    // therefore not receive ERR_INVALID_INPUT from the descriptor-required path.
    const result = await withCwd(root, () =>
      service.findMapping({
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "e",
        sourceMapping: "obfuscated",
        targetMapping: "intermediary"
      })
    );

    // The fixture has two `e` overloads sharing `(I)V`, so name-only returns both.
    assert.notEqual(result.status, "mapping_unavailable");
    assert.ok(result.candidates.length >= 1, "omitted signatureMode must not error on missing descriptor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkSymbolExists accepts partial projection when descriptor mixes remapped MC classes with unmapped JDK classes", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-mixed-jdk-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_DESCRIPTOR_REMAP_MIXED_JDK_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);

    // Caller uses yarn-named classes for the MC type and the JDK String class reference.
    // projectMethodDescriptorToTarget cannot resolve `java/lang/String` (not in the mapping
    // graph) and marks the projection incomplete, but the partial projection still maps
    // `ItemStack -> class_1799` while leaving `Ljava/lang/String;` pass-through, so the
    // result aligns with the stored record descriptor `(Lclass_1799;Ljava/lang/String;)V`.
    const yarnDescriptor = "(Lnet/minecraft/world/item/ItemStack;Ljava/lang/String;)V";
    const resolved = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            owner?: string;
            name: string;
            descriptor?: string;
            sourceMapping: SourceMapping;
            signatureMode?: "exact" | "name-only";
          }) => Promise<{
            resolved: boolean;
            status: string;
            candidates: Array<{ name: string }>;
          }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "method",
        owner: "net.minecraft.world.item.ItemStack",
        name: "tagWithLabel",
        descriptor: yarnDescriptor,
        sourceMapping: "yarn",
        signatureMode: "exact"
      })
    );

    assert.equal(
      resolved.resolved,
      true,
      "partial projection (MC class remapped, JDK class pass-through) should still resolve the exact overload"
    );
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.candidates.length, 1);
    assert.equal(resolved.candidates[0]?.name, "tagWithLabel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService supports short class name checks when nameMode=auto", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-auto-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${TEST_TINY}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            name: string;
            sourceMapping: SourceMapping;
            nameMode?: "fqcn" | "auto";
          }) => Promise<{ resolved: boolean; status: string; resolvedSymbol?: { symbol: string } }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "C",
        sourceMapping: "obfuscated",
        nameMode: "auto"
      })
    );

    assert.equal(result.resolved, true);
    assert.equal(result.status, "resolved");
    assert.equal(result.resolvedSymbol?.symbol, "a.b.C");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkSymbolExists supports maxCandidates", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-max-candidates-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const tiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/one/C\tyarn/one/C",
      "c\tx/y/C\tinter/two/C\tyarn/two/C"
    ].join("\n");
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${tiny}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      service.checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "C",
        sourceMapping: "obfuscated",
        nameMode: "auto",
        maxCandidates: 1
      } as never)
    );

    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidateCount, 2);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidatesTruncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService returns ambiguous for short class names when multiple FQCNs match nameMode=auto", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-auto-ambiguous-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const tiny = [
      "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
      "c\ta/b/C\tinter/one/C\tyarn/one/C",
      "c\tx/y/C\tinter/two/C\tyarn/two/C"
    ].join("\n");
    const loomTinyPath = join(root, ".gradle", "loom-cache", "1.21.10", "mappings.tiny");
    await mkdir(join(root, ".gradle", "loom-cache", "1.21.10"), { recursive: true });
    await writeFile(loomTinyPath, `${tiny}\n`, "utf8");

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await withCwd(root, () =>
      (
        service as unknown as {
          checkSymbolExists: (input: {
            version: string;
            kind: "class" | "field" | "method";
            name: string;
            sourceMapping: SourceMapping;
            nameMode?: "fqcn" | "auto";
          }) => Promise<{ resolved: boolean; status: string; candidates: Array<{ symbol: string }>; warnings: string[] }>;
        }
      ).checkSymbolExists({
        version: "1.21.10",
        kind: "class",
        name: "C",
        sourceMapping: "obfuscated",
        nameMode: "auto"
      })
    );

    assert.equal(result.resolved, false);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidates.length, 2);
    assert.ok(result.warnings.some((warning) => warning.includes("fully-qualified class name")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService findMapping handles representative ambiguity metadata flows", async (t) => {
  await t.test("includes ambiguityReasons and warning when multiple owners match", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-ambiguity-reasons-",
      TEST_AMBIGUOUS_CLASS_TINY
    );
    try {
      const result = await withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          kind: "class",
          name: "a.b.C",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.status, "ambiguous");
      assert.ok(result.warnings.some((warning) => warning.includes("Ambiguous mapping")));
      assert.ok(result.ambiguityReasons);
      assert.ok(result.ambiguityReasons.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("supports disambiguation hints for ambiguous class matches", async () => {
    const { root, service } = await createLoomService(
      "mapping-service-find-disambiguation-",
      TEST_AMBIGUOUS_CLASS_TINY
    );
    try {
      const result = await withCwd(root, () =>
        (
          service as unknown as {
            findMapping: (input: {
              version: string;
              kind: "class" | "field" | "method";
              name: string;
              sourceMapping: SourceMapping;
              targetMapping: SourceMapping;
              disambiguation?: { ownerHint?: string; descriptorHint?: string };
            }) => Promise<{ status: string; resolvedSymbol?: { symbol: string } }>;
          }
        ).findMapping({
          version: "1.21.10",
          kind: "class",
          name: "a.b.C",
          sourceMapping: "obfuscated",
          targetMapping: "intermediary",
          disambiguation: { ownerHint: "inter.two" }
        })
      );

      assert.equal(result.status, "resolved");
      assert.equal(result.resolvedSymbol?.symbol, "inter.two.C");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("omits ambiguityReasons when a single candidate resolves", async () => {
    const { root, service } = await createLoomService("mapping-service-no-ambiguity-", TEST_TINY);
    try {
      const result = await withCwd(root, () =>
        service.findMapping({
          version: "1.21.10",
          ...queryFromSymbol("a.b.C"),
          sourceMapping: "obfuscated",
          targetMapping: "intermediary"
        })
      );

      assert.equal(result.status, "resolved");
      assert.equal(result.ambiguityReasons, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("MappingService returns mapping_unavailable for symbol existence when mapping graph is absent", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-symbol-exists-unavailable-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    const result = await (
      service as unknown as {
        checkSymbolExists: (input: {
          version: string;
          kind: "class" | "field" | "method";
          owner?: string;
          name: string;
          sourceMapping: SourceMapping;
        }) => Promise<{ resolved: boolean; status: string }>;
      }
    ).checkSymbolExists({
      version: "1.21.10",
      kind: "class",
      name: "intermediary.pkg.InterClass",
      sourceMapping: "intermediary"
    });

    assert.equal(result.resolved, false);
    assert.equal(result.status, "mapping_unavailable");

    await assert.rejects(
      () =>
        (
          service as unknown as {
            checkSymbolExists: (input: {
              version: string;
              kind: "class" | "field" | "method";
              owner?: string;
              name: string;
              sourceMapping: SourceMapping;
              descriptor?: string;
              signatureMode?: "exact" | "name-only";
            }) => Promise<{ resolved: boolean; status: string }>;
          }
        ).checkSymbolExists({
          version: "1.21.10",
          kind: "method",
          owner: "a.b.C",
          name: "f",
          sourceMapping: "obfuscated",
          // Default signatureMode is now name-only; assert the strict descriptor-required path.
          signatureMode: "exact"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );

    await assert.rejects(
      () =>
        (
          service as unknown as {
            checkSymbolExists: (input: {
              version: string;
              kind: "class" | "field" | "method";
              owner?: string;
              name: string;
              sourceMapping: SourceMapping;
            }) => Promise<{ resolved: boolean; status: string }>;
          }
        ).checkSymbolExists({
          version: "1.21.10",
          kind: "class",
          owner: "a.b.C",
          name: "a.b.C",
          sourceMapping: "obfuscated"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService returns empty graph for unobfuscated version (26.1)", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-unobfuscated-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    const fetchCalls: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const result = await service.findMapping({
      version: "26.1",
      kind: "class",
      name: "a.b.C",
      sourceMapping: "obfuscated",
      targetMapping: "yarn"
    });

    assert.equal(result.status, "mapping_unavailable");
    assert.ok(
      result.warnings.some((w) => w.includes("No mapping path")),
      "Expected a warning about missing mapping path"
    );
    assert.equal(fetchCalls.length, 0, "No network requests should be made for unobfuscated versions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkMappingHealth treats unobfuscated mojang runtime names as healthy", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-unobfuscated-health-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });

    const fetchStub = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: `https://example.test/versions/${version}.json`,
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, fetchStub);
    const mojangHealth = await service.checkMappingHealth({
      version: "26.1",
      requestedMapping: "mojang"
    });
    const yarnHealth = await service.checkMappingHealth({
      version: "26.1",
      requestedMapping: "yarn"
    });

    assert.deepEqual(mojangHealth, {
      mojangMappingsAvailable: true,
      tinyMappingsAvailable: true,
      memberRemapAvailable: true,
      degradations: []
    });
    assert.deepEqual(yarnHealth, {
      mojangMappingsAvailable: true,
      tinyMappingsAvailable: false,
      memberRemapAvailable: false,
      degradations: ["Version 26.1 is unobfuscated; yarn mappings are not applicable."]
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MappingService checkMappingHealth skips tiny namespace loading for mojang and obfuscated requests", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");

  async function assertHealthSkipsTiny(requestedMapping: "mojang" | "obfuscated") {
    const root = await mkdtemp(join(tmpdir(), `mapping-service-health-${requestedMapping}-`));
    try {
      const config = buildTestConfig(root);
      const fetchStub = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.test/mappings/client.txt") {
          return new Response(TEST_MOJANG_CLIENT_MAPPINGS, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const service = new MappingService(
        config,
        createVersionServiceStub("https://example.test/mappings/client.txt"),
        fetchStub
      );

      let loomTinyLoads = 0;
      let mavenTinyLoads = 0;
      (service as unknown as {
        loadTinyPairsFromLoom: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
        loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
      }).loadTinyPairsFromLoom = async () => {
        loomTinyLoads += 1;
        return {
          pairs: new Map(),
          warnings: ["unexpected loom tiny load"],
          mappingArtifact: "loom-cache:none"
        };
      };
      (service as unknown as {
        loadTinyPairsFromMaven: (version: string) => Promise<{ pairs: Map<unknown, unknown>; warnings: string[]; mappingArtifact: string }>;
      }).loadTinyPairsFromMaven = async () => {
        mavenTinyLoads += 1;
        return {
          pairs: new Map(),
          warnings: ["unexpected maven tiny load"],
          mappingArtifact: "maven:none"
        };
      };

      const health = await service.checkMappingHealth({
        version: "1.21.10",
        requestedMapping
      });

      assert.equal(health.mojangMappingsAvailable, true);
      assert.equal(health.tinyMappingsAvailable, true);
      assert.equal(health.memberRemapAvailable, true);
      assert.equal(loomTinyLoads, 0);
      assert.equal(mavenTinyLoads, 0);
      assert.deepEqual(health.degradations, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  await assertHealthSkipsTiny("mojang");
  await assertHealthSkipsTiny("obfuscated");
});

test("MappingService rejects class queries that include owner", async () => {
  const { MappingService } = await import("../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), "mapping-service-class-owner-invalid-"));
  try {
    const config = buildTestConfig(root, { sourceRepos: [] });
    const versionServiceStub = {
      async resolveVersionMappings(version: string) {
        return {
          version,
          versionManifestUrl: "https://example.test/version_manifest_v2.json",
          versionDetailUrl: "https://example.test/versions/1.21.10.json",
          mappingsUrl: undefined
        };
      }
    };

    const service = new MappingService(config, versionServiceStub, globalThis.fetch);
    await assert.rejects(
      () =>
        service.findMapping({
          version: "1.21.10",
          kind: "class",
          name: "a.b.C",
          owner: "a.b",
          sourceMapping: "obfuscated",
          targetMapping: "mojang"
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.INVALID_INPUT
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
