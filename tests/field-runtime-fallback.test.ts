import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CheckSymbolExistsInput, CheckSymbolExistsOutput } from "../src/source-service.ts";
import { SourceService } from "../src/source-service.ts";
import { buildClassFile } from "./helpers/classfile.ts";
import { stubExplorer } from "./helpers/seed-artifact.ts";
import { buildTestConfig } from "./helpers/test-config.ts";
import { createJar } from "./helpers/zip.ts";

function runtimeField(ownerFqn: string, name: string): Record<string, unknown> {
  return {
    ownerFqn,
    name,
    javaSignature: `public static final EntityType<ItemEntity> ${name}`,
    jvmDescriptor: "Lnet/minecraft/world/entity/EntityType;",
    accessFlags: 0x0019,
    isSynthetic: false
  };
}

// The mapping graph is non-empty for the source mapping but lacks the target
// record — an empty graph would degrade to mapping_unavailable and mask the
// per-kind eligibility difference this suite pins.
function mappingNotFound(input: CheckSymbolExistsInput): CheckSymbolExistsOutput {
  return {
    querySymbol: {
      kind: input.kind,
      ...(input.owner ? { owner: input.owner } : {}),
      name: input.name,
      symbol: input.owner ? `${input.owner}.${input.name}` : input.name
    },
    mappingContext: {
      version: input.version,
      sourceMapping: input.sourceMapping,
      sourcePriorityApplied: "loom-first"
    },
    resolved: false,
    status: "not_found",
    candidates: [],
    candidateCount: 0,
    warnings: []
  } as unknown as CheckSymbolExistsOutput;
}

async function makeService(opts: {
  explorerFields?: Record<string, unknown>[];
  onExplorerCall?: () => void;
}): Promise<SourceService> {
  const root = await mkdtemp(join(tmpdir(), "field-fallback-"));
  const service = new SourceService(buildTestConfig(root));
  (service as unknown as { mappingService: unknown }).mappingService = {
    checkSymbolExists: async (input: CheckSymbolExistsInput) => mappingNotFound(input)
  };
  (service as unknown as {
    versionService: { resolveVersionJar: (version: string) => Promise<{ jarPath: string }> };
  }).versionService.resolveVersionJar = async () => ({ jarPath: "/fake/26.2.jar" });
  stubExplorer(service, { fields: opts.explorerFields ?? [] });
  if (opts.onExplorerCall) {
    const explorer = (service as unknown as {
      explorerService: { getSignature: (input: unknown) => Promise<unknown> };
    }).explorerService;
    const original = explorer.getSignature.bind(explorer);
    explorer.getSignature = async (input: unknown) => {
      opts.onExplorerCall?.();
      return original(input);
    };
  }
  return service;
}

test("a field reported not_found by the mapping graph is runtime-checked on unobfuscated versions", async () => {
  const service = await makeService({
    explorerFields: [runtimeField("net.minecraft.world.entity.EntityType", "ITEM")]
  });

  const result = await service.checkSymbolExists({
    version: "26.2",
    kind: "field",
    owner: "net.minecraft.world.entity.EntityType",
    name: "ITEM",
    sourceMapping: "mojang"
  } as CheckSymbolExistsInput);

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
  // Runtime validation surfaces as a structured flag, not a warning sentence.
  assert.equal(
    (result.mappingContext as { runtimeValidated?: boolean }).runtimeValidated,
    true
  );
});

test("a class reported not_found by the mapping graph is runtime-checked on unobfuscated versions", async () => {
  const service = await makeService({ explorerFields: [] });

  const result = await service.checkSymbolExists({
    version: "26.2",
    kind: "class",
    name: "net.minecraft.world.entity.EntityType",
    sourceMapping: "mojang",
    nameMode: "fqcn"
  } as CheckSymbolExistsInput);

  assert.equal(result.resolved, true);
  assert.equal(result.status, "resolved");
});

test("a field absent from runtime bytecode stays not_found after the runtime check", async () => {
  const service = await makeService({
    explorerFields: [runtimeField("net.minecraft.world.entity.EntityType", "OTHER_FIELD")]
  });

  const result = await service.checkSymbolExists({
    version: "26.2",
    kind: "field",
    owner: "net.minecraft.world.entity.EntityType",
    name: "ITEM",
    sourceMapping: "mojang"
  } as CheckSymbolExistsInput);

  assert.equal(result.resolved, false);
  assert.equal(result.status, "not_found");
});

test("obfuscated versions keep the mapping-graph verdict without touching runtime bytecode", async () => {
  let explorerCalls = 0;
  const service = await makeService({
    explorerFields: [runtimeField("net.minecraft.world.entity.EntityType", "ITEM")],
    onExplorerCall: () => {
      explorerCalls += 1;
    }
  });

  const result = await service.checkSymbolExists({
    version: "1.20.1",
    kind: "field",
    owner: "net.minecraft.world.entity.EntityType",
    name: "ITEM",
    sourceMapping: "mojang"
  } as CheckSymbolExistsInput);

  assert.equal(result.resolved, false);
  assert.equal(result.status, "not_found");
  assert.equal(explorerCalls, 0);
});

test("bytecode-derived contexts report the version-appropriate namespace instead of hardcoded obfuscated", async () => {
  const root = await mkdtemp(join(tmpdir(), "context-namespace-"));
  const jarDir = join(root, "jars", "26.2");
  await mkdir(jarDir, { recursive: true });
  const jarPath = join(jarDir, "client.jar");
  await createJar(jarPath, {
    "net/minecraft/world/entity/EntityType.class": buildClassFile({
      internalName: "net/minecraft/world/entity/EntityType",
      fields: [{ name: "ITEM", descriptor: "Ljava/lang/Object;", accessFlags: 0x0019 }]
    })
  });

  const service = new SourceService(buildTestConfig(root));
  const signature = await service.explorerService.getSignature({
    fqn: "net.minecraft.world.entity.EntityType",
    jarPath
  });

  assert.equal(signature.context.minecraftVersion, "26.2");
  assert.equal(signature.context.mappingNamespace, "mojang");
});

test("a class absent from runtime bytecode stays not_found after the runtime check", async () => {
  const { createError, ERROR_CODES } = await import("../src/errors.ts");
  const service = await makeService({ explorerFields: [] });
  (service as unknown as {
    explorerService: { getSignature: (input: unknown) => Promise<unknown> };
  }).explorerService.getSignature = async () => {
    throw createError({ code: ERROR_CODES.CLASS_NOT_FOUND, message: "not in jar" });
  };

  const result = await service.checkSymbolExists({
    version: "26.2",
    kind: "class",
    name: "net.minecraft.world.entity.DoesNotExist",
    sourceMapping: "mojang",
    nameMode: "fqcn"
  } as CheckSymbolExistsInput);

  assert.equal(result.resolved, false);
  assert.equal(result.status, "not_found");
  assert.ok(result.warnings.some((warning) => warning.includes("was not found in the Minecraft")));
});
