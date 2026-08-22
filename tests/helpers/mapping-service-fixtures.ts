/**
 * Shared fixtures and helpers factored out of tests/mapping-service.test.ts when
 * that oversized suite was split into per-feature slices
 * (mapping-service-cache-mojang, mapping-service-loom-maven,
 * mapping-service-method-exact-api-matrix, mapping-service-symbol-findmapping-health).
 *
 * `installGradleUserHomeIsolation()` registers the before/after lifecycle hook
 * that isolates every test from the host's real ~/.gradle (scanning large real
 * Loom caches can OOM the single-process runner); each split file must call it
 * once at module scope because the hook cannot be a passive imported const.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after } from "node:test";

import type { MappingService as MappingServiceType } from "../../src/mapping-service.ts";
import { buildMappingTestConfig } from "./test-config.ts";

// Isolate all tests from the host's real ~/.gradle to avoid scanning
// large real Loom caches (which can cause OOM in the single-process runner).
export function installGradleUserHomeIsolation(): void {
  let savedGradleUserHome: string | undefined;
  before(() => {
    savedGradleUserHome = process.env.GRADLE_USER_HOME;
    process.env.GRADLE_USER_HOME = join(tmpdir(), "mapping-service-test-gradle-home-nonexistent");
  });
  after(() => {
    if (savedGradleUserHome === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = savedGradleUserHome;
    }
  });
}

export const buildTestConfig = buildMappingTestConfig;

export async function withCwd<T>(nextCwd: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(nextCwd);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

export const TEST_MOJANG_CLIENT_MAPPINGS = [
  "com.mojang.NamedClass -> a.b.C:",
  "    int namedField -> d",
  "    void namedMethod(int) -> e",
  "    4:4:void overloaded(int) -> f",
  "    8:8:void overloaded(java.lang.String) -> f"
].join("\n");

export const TEST_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");

export const TEST_TINY_ALT = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/AltNamedClass"
].join("\n");

export const TEST_TINY_OFFICIAL = [
  "tiny\t2\t0\tofficial\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");

export const TEST_AMBIGUOUS_METHOD_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\te\tinterMethodAlt\tnamedMethod"
].join("\n");

// Same ambiguous pair as TEST_AMBIGUOUS_METHOD_TINY, plus an unrelated class whose
// method shares the obfuscated simple name `e` under a DIFFERENT descriptor.
//
// What this fixture adds, measured against the real service under the
// installGradleUserHomeIsolation() harness every consumer of these fixtures runs:
// TEST_AMBIGUOUS_METHOD_TINY yields 2 raw candidates and 2 strict ones (nothing is
// rejected), while this fixture yields 3 raw against the same 2 strict. So the third
// record is exactly what separates the raw name-matched list from the set the exact
// resolver judges, and it is rejected for its DESCRIPTOR, not its owner.
//
// The isolation hook is load-bearing for those numbers, not incidental. Run the same
// query with GRADLE_USER_HOME pointing at a developer's real ~/.gradle and a bundled
// 1.21.10 Loom intermediary mapping contributes ~50 further `e`-named records to the
// raw list on BOTH fixtures, which makes the two look identical apart from an
// off-by-one. Any assertion on rejected-candidate counts therefore belongs behind the
// isolation hook.
export const TEST_AMBIGUOUS_METHOD_WITH_FOREIGN_NAME_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\te\tinterMethodAlt\tnamedMethod",
  "c\ta/b/D\tinter/pkg/OtherClass\tyarn/pkg/OtherNamedClass",
  "\tm\t(Ljava/lang/String;)V\te\tinterForeignMethod\tforeignNamedMethod"
].join("\n");

// Two DIFFERENT owner classes, each declaring exactly one method with the SAME
// obfuscated name `e` AND the same descriptor `(I)V`. An owner+name+descriptor query
// against `a.b.C` therefore has one correct answer. The owner-less `e(I)V` simple-name
// key still reaches `a/b/D`'s method, so only a filter that compares OWNERS as well as
// descriptors can discard it; a descriptor-only filter keeps both and reports ambiguity
// next to a confidence-1 exact match.
export const TEST_FOREIGN_OWNER_SAME_DESCRIPTOR_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "c\ta/b/D\tinter/pkg/OtherClass\tyarn/pkg/OtherNamedClass",
  "\tm\t(I)V\te\tinterForeignMethod\tforeignNamedMethod"
].join("\n");

// `a/b/C` is mapped but declares no `e(I)V` of its own; the only `e(I)V` in the file
// belongs to `a/b/Base`. This stands in for an INHERITED method. Owner-strict exact
// resolution cannot answer such a query — the tiny format records declarations, not the
// class hierarchy — so the accepted outcome is not_found plus guidance toward the
// owner-agnostic find-mapping lookup, rather than silently answering with a superclass.
export const TEST_INHERITED_METHOD_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/pkg/InterClass\tyarn/pkg/NamedClass",
  "c\ta/b/Base\tinter/pkg/BaseClass\tyarn/pkg/BaseNamedClass",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod"
].join("\n");

export const TEST_AMBIGUOUS_CLASS_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tinter/one/C\tyarn/one/C",
  "c\ta/b/C\tinter/two/C\tyarn/two/C"
].join("\n");

export const TEST_DESCRIPTOR_REMAP_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_2338\tnet/minecraft/class_2338\tnet/minecraft/core/BlockPos",
  "c\tnet/minecraft/class_2680\tnet/minecraft/class_2680\tnet/minecraft/world/level/block/state/BlockState",
  "c\tnet/minecraft/class_1937\tnet/minecraft/class_1937\tnet/minecraft/world/level/Level",
  "\tm\t(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z\tmethod_1725\tmethod_1725\tsetBlock"
].join("\n");

// Fixture where the method descriptor mixes a remapped Minecraft class and an unmapped
// JDK class (java/lang/String). The projection graph has no entry for java/lang/String,
// so projectMethodDescriptorToTarget leaves it unchanged and marks the projection
// incomplete. checkSymbolExists must still accept the partial projection and match the
// record, otherwise the most common "MC class + String name" overload shape fails lookup.
export const TEST_DESCRIPTOR_REMAP_MIXED_JDK_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_1792\tnet/minecraft/class_1792\tnet/minecraft/world/item/Item",
  "c\tnet/minecraft/class_1799\tnet/minecraft/class_1799\tnet/minecraft/world/item/ItemStack",
  "\tm\t(Lnet/minecraft/class_1799;Ljava/lang/String;)V\tmethod_9000\tmethod_9000\ttagWithLabel"
].join("\n");

export const TEST_DESCRIPTOR_REMAP_TINY_PROJECT = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_2338\tnet/minecraft/class_2338\tnet/minecraft/core/BlockPos",
  "c\tnet/minecraft/class_1937\tnet/minecraft/class_1937\tnet/minecraft/world/level/Level",
  "\tm\t(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z\tmethod_1725\tmethod_1725\tsetBlock"
].join("\n");

export const TEST_DESCRIPTOR_REMAP_TINY_GRADLE_HOME = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\tnet/minecraft/class_2680\tnet/minecraft/class_2680\tnet/minecraft/world/level/block/state/BlockState"
].join("\n");

// Three distinct methods on one owner that ALL reference the same parameter class,
// so their descriptor class-projections are identical and can be shared graph-wide.
export const TEST_SHARED_CLASS_REF_TINY = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/Owner\tinter/Owner\tnamed/Owner",
  "\tm\t(La/b/Shared;)V\tm1\tinterM1\talpha",
  "\tm\t(La/b/Shared;)V\tm2\tinterM2\tbeta",
  "\tm\t(La/b/Shared;)V\tm3\tinterM3\tgamma",
  "c\ta/b/Shared\tinter/Shared\tnamed/Shared"
].join("\n");

// A standalone Fabric yarn tiny declares only `intermediary named` (no obfuscated
// column), so the stored method descriptor is in INTERMEDIARY coordinates.
export const TEST_TINY_YARN_2COL = [
  "tiny\t2\t0\tintermediary\tnamed",
  "c\tnet/minecraft/class_1937\tnet/minecraft/world/level/Level",
  "\tm\t(Lnet/minecraft/class_1937;)V\tmethod_x\tdoThing"
].join("\n");

export function createVersionServiceStub(mappingsUrl?: string) {
  return {
    async resolveVersionMappings(version: string) {
      return {
        version,
        versionManifestUrl: "https://example.test/version_manifest_v2.json",
        versionDetailUrl: `https://example.test/versions/${version}.json`,
        mappingsUrl
      };
    }
  };
}

export async function writeLoomTinyCache(root: string, tiny: string, version = "1.21.10"): Promise<string> {
  const loomTinyPath = join(root, ".gradle", "loom-cache", version, "mappings.tiny");
  await mkdir(join(root, ".gradle", "loom-cache", version), { recursive: true });
  await writeFile(loomTinyPath, `${tiny}\n`, "utf8");
  return loomTinyPath;
}

export async function writeFabricLoomTinyCache(
  gradleUserHome: string,
  tiny: string,
  version = "1.21.10",
  fileName = "mappings.tiny"
): Promise<string> {
  const loomTinyPath = join(gradleUserHome, "caches", "fabric-loom", version, fileName);
  await mkdir(join(gradleUserHome, "caches", "fabric-loom", version), { recursive: true });
  await writeFile(loomTinyPath, `${tiny}\n`, "utf8");
  return loomTinyPath;
}

export async function createLoomService(
  prefix: string,
  tiny: string
): Promise<{ root: string; service: MappingServiceType }> {
  const { MappingService } = await import("../../src/mapping-service.ts");
  const root = await mkdtemp(join(tmpdir(), prefix));
  const config = buildTestConfig(root, { sourceRepos: [] });
  await writeLoomTinyCache(root, tiny);
  return {
    root,
    service: new MappingService(config, createVersionServiceStub(), globalThis.fetch)
  };
}

export type SymbolQueryInput = {
  kind: "class" | "field" | "method";
  name: string;
  owner?: string;
  descriptor?: string;
};

export function queryFromSymbol(symbol: string): SymbolQueryInput {
  const trimmed = symbol.trim();
  const normalized = trimmed.replace(/\//g, ".");
  const descriptorStart = normalized.indexOf("(");
  if (descriptorStart >= 0) {
    const ownerAndName = normalized.slice(0, descriptorStart);
    const dotIndex = ownerAndName.lastIndexOf(".");
    return {
      kind: "method",
      owner: ownerAndName.slice(0, dotIndex),
      name: ownerAndName.slice(dotIndex + 1),
      descriptor: normalized.slice(descriptorStart)
    };
  }

  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0) {
    return {
      kind: "class",
      name: normalized
    };
  }
  const owner = normalized.slice(0, dotIndex);
  const name = normalized.slice(dotIndex + 1);
  if (/^[A-Z$]/.test(name)) {
    return {
      kind: "class",
      name: normalized
    };
  }
  return {
    kind: "field",
    owner,
    name
  };
}

// Defined mid-file in the original immediately before its sole consumer; moved here so
// the Loom/Maven slice can resolve it.
export const TEST_TINY_V1 = [
  "tiny\t2\t0\tobfuscated\tintermediary\tnamed",
  "c\ta/b/C\tintermediary/pkg/InterClass\tv1/pkg/VersionOneClass",
  "\tf\tI\td\tinterField\tnamedField",
  "\tm\t(I)V\te\tinterMethod\tnamedMethod",
  "\tm\t(I)V\tf\tinterOverloadInt\toverloaded",
  "\tm\t(Ljava/lang/String;)V\tf\tinterOverloadString\toverloaded"
].join("\n");
