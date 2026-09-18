import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { SignatureMember } from "../../src/minecraft-explorer-service.ts";
import { remapSignatureMembers, resolveToObfuscatedMemberName } from "../../src/source/lifecycle.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

// On Minecraft 26.1+ the as-shipped ("obfuscated") names are the Mojang names and the
// mapping graph is deliberately empty. Remapping obfuscated<->mojang through that graph
// used to keep every member but mark it failed with a "Could not remap" warning.

const ITEM = "net.minecraft.world.item.Item";
const USE_DESCRIPTOR = "(Lnet/minecraft/world/item/ItemStack;)Lnet/minecraft/world/InteractionResult;";
const REMAP_FAILURE = /Could not remap|Remap failed for|Could not map/;

function member(name: string, jvmDescriptor: string, javaSignature: string): SignatureMember {
  return {
    ownerFqn: ITEM,
    name,
    javaSignature,
    jvmDescriptor,
    accessFlags: 0x0001,
    isSynthetic: false
  };
}

const USE = member(
  "use",
  USE_DESCRIPTOR,
  "public net.minecraft.world.InteractionResult use(net.minecraft.world.item.ItemStack)"
);

/** A mapping service over an empty graph (as on 26.x) that records every lookup. */
function emptyGraphMappingService() {
  const calls: string[] = [];
  const unavailable = (input: { version: string; kind?: string; name: string }) => ({
    querySymbol: { kind: input.kind ?? "method", name: input.name, symbol: input.name },
    mappingContext: { version: input.version, sourceMapping: "obfuscated", sourcePriorityApplied: "loom-first" },
    resolved: false,
    status: "mapping_unavailable" as const,
    candidates: [],
    candidateCount: 0,
    warnings: []
  });
  return {
    calls,
    mappingService: {
      async findMapping(input: { version: string; kind: string; name: string }) {
        calls.push(`findMapping:${input.kind}:${input.name}`);
        return unavailable(input);
      },
      async resolveMethodMappingExact(input: { version: string; name: string }) {
        calls.push(`resolveMethodMappingExact:${input.name}`);
        return unavailable(input);
      }
    }
  };
}

test("remapSignatureMembers is the identity for obfuscated<->mojang on an unobfuscated version", async () => {
  for (const [sourceMapping, targetMapping] of [
    ["obfuscated", "mojang"],
    ["mojang", "obfuscated"]
  ] as const) {
    const { calls, mappingService } = emptyGraphMappingService();
    const warnings: string[] = [];
    const members = [USE];

    const result = await remapSignatureMembers(
      { mappingService } as never,
      members,
      "method",
      "26.2",
      sourceMapping,
      targetMapping,
      undefined,
      warnings
    );

    assert.deepEqual(result.members, [USE], `${sourceMapping}->${targetMapping} must keep members unchanged`);
    assert.equal(result.failedNames.size, 0, `${sourceMapping}->${targetMapping} must not mark members failed`);
    assert.deepEqual(warnings, [], `${sourceMapping}->${targetMapping} must not warn`);
    assert.deepEqual(calls, [], `${sourceMapping}->${targetMapping} must not consult the empty mapping graph`);
  }
});

test("remapSignatureMembers still remaps through mappings on a legacy version and for intermediary on 26.x", async () => {
  for (const [version, targetMapping] of [
    ["1.21.10", "mojang"],
    ["26.2", "intermediary"]
  ] as const) {
    const { calls, mappingService } = emptyGraphMappingService();
    const warnings: string[] = [];

    const result = await remapSignatureMembers(
      { mappingService } as never,
      [USE],
      "method",
      version,
      "obfuscated",
      targetMapping,
      undefined,
      warnings
    );

    assert.ok(calls.length > 0, `${version} obfuscated->${targetMapping} must consult mappings`);
    assert.ok(result.failedNames.has("use"), `${version} obfuscated->${targetMapping} keeps today's failure mark`);
    assert.ok(
      warnings.some((warning) => warning.startsWith(`Could not remap 1 method from obfuscated to ${targetMapping}`)),
      `${version} obfuscated->${targetMapping} keeps today's warning, got ${JSON.stringify(warnings)}`
    );
  }
});

test("resolveToObfuscatedMemberName is the identity for mojang names on an unobfuscated version only", async () => {
  const unobfuscated = emptyGraphMappingService();
  const unobfuscatedWarnings: string[] = [];
  const resolved = await resolveToObfuscatedMemberName(
    { mappingService: unobfuscated.mappingService } as never,
    "use",
    ITEM,
    USE_DESCRIPTOR,
    "method",
    "26.2",
    "mojang",
    undefined,
    unobfuscatedWarnings
  );
  assert.deepEqual(resolved, { name: "use", descriptor: USE_DESCRIPTOR });
  assert.deepEqual(unobfuscatedWarnings, []);
  assert.deepEqual(unobfuscated.calls, []);

  for (const [version, mapping] of [
    ["1.21.10", "mojang"],
    ["26.2", "intermediary"]
  ] as const) {
    const { calls, mappingService } = emptyGraphMappingService();
    const warnings: string[] = [];
    await resolveToObfuscatedMemberName(
      { mappingService } as never,
      "use",
      ITEM,
      USE_DESCRIPTOR,
      "method",
      version,
      mapping,
      undefined,
      warnings
    );
    assert.ok(calls.length > 0, `${version} ${mapping} must consult mappings`);
    assert.ok(warnings.some((warning) => warning.includes(`from ${mapping} to obfuscated`)));
  }
});

async function createLifecycleService(t: TestContext, prefix: string, versionsNewestFirst: string[]) {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new SourceService(buildTestConfig(root));
  const { calls, mappingService } = emptyGraphMappingService();

  (service as unknown as { versionService: unknown }).versionService = {
    async listVersionIds() {
      return versionsNewestFirst;
    },
    async resolveVersionJar(version: string) {
      return {
        version,
        jarPath: join(root, `${version}.jar`),
        source: "downloaded" as const,
        clientJarUrl: `https://example.test/${version}.jar`
      };
    }
  };
  (service as unknown as { mappingService: unknown }).mappingService = mappingService;
  // Class-name lookup is covered elsewhere; keep it the identity so these tests observe
  // only the member remap path.
  (service as unknown as { resolveClassNameForLookup: unknown }).resolveClassNameForLookup = async (input: {
    className: string;
  }) => input.className;

  return { root, service, calls };
}

test("diffClassSignatures with mapping mojang across unobfuscated versions keeps member names without remap warnings", async (t) => {
  const { root, service, calls } = await createLifecycleService(t, "lifecycle-unobf-diff-", ["26.2", "26.1"]);
  const membersByVersion: Record<string, { fields: SignatureMember[]; methods: SignatureMember[] }> = {
    "26.1": {
      fields: [member("count", "I", "public int count")],
      methods: [member("oldMethod", "()V", "public void oldMethod()")]
    },
    "26.2": {
      fields: [member("count", "J", "public long count")],
      methods: [member("newMethod", "()V", "public void newMethod()"), USE]
    }
  };
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string; jarPath: string }) {
      assert.equal(input.fqn, ITEM);
      const version = input.jarPath === join(root, "26.1.jar") ? "26.1" : "26.2";
      return { constructors: [], ...membersByVersion[version], warnings: [] };
    }
  };

  const result = await service.diffClassSignatures({
    className: ITEM,
    fromVersion: "26.1",
    toVersion: "26.2",
    mapping: "mojang"
  });

  assert.equal(result.query.mapping, "mojang");
  assert.deepEqual(result.methods.added.map((entry) => entry.name).sort(), ["newMethod", "use"]);
  assert.deepEqual(result.methods.removed.map((entry) => entry.name), ["oldMethod"]);
  assert.ok(result.methods.added.every((entry) => entry.ownerFqn === ITEM));
  assert.equal(result.fields.modified.length, 1);
  assert.equal(result.fields.modified[0]?.from?.jvmDescriptor, "I");
  assert.equal(result.fields.modified[0]?.to?.jvmDescriptor, "J");
  assert.ok(
    !result.warnings.some((warning) => REMAP_FAILURE.test(warning)),
    `expected no remap warnings, got ${JSON.stringify(result.warnings)}`
  );
  assert.deepEqual(calls, []);
});

test("traceSymbolLifecycle with mapping mojang on unobfuscated versions finds the method without map warnings", async (t) => {
  const { service, calls } = await createLifecycleService(t, "lifecycle-unobf-trace-", ["26.2", "26.1"]);
  (service as unknown as { explorerService: unknown }).explorerService = {
    async getSignature(input: { fqn: string }) {
      assert.equal(input.fqn, ITEM);
      return { constructors: [], fields: [], methods: [USE], warnings: [] };
    }
  };

  const result = await service.traceSymbolLifecycle({
    symbol: `${ITEM}.use`,
    descriptor: USE_DESCRIPTOR,
    mapping: "mojang"
  });

  assert.equal(result.presence.firstSeen, "26.1");
  assert.equal(result.presence.existsNow, true);
  assert.ok(
    !result.warnings.some((warning) => REMAP_FAILURE.test(warning)),
    `expected no map warnings, got ${JSON.stringify(result.warnings)}`
  );
  assert.deepEqual(calls, []);
});
