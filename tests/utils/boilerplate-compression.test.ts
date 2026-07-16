import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CheckSymbolExistsInput } from "../../src/source-service.ts";
import { SourceService } from "../../src/source-service.ts";
import { stubExplorer } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

const GRAPH_SENTENCE_RE = /unobfuscated; mapping graph is empty/;
const RUNTIME_SENTENCE_RE = /unobfuscated; validated symbol existence/;

async function makeService(): Promise<SourceService> {
  const root = await mkdtemp(join(tmpdir(), "boilerplate-"));
  const service = new SourceService(buildTestConfig(root));
  (service as unknown as {
    versionService: { resolveVersionJar: (version: string) => Promise<{ jarPath: string }> };
  }).versionService.resolveVersionJar = async () => ({ jarPath: "/fake/26.2.jar" });
  stubExplorer(service, {
    fields: [
      {
        ownerFqn: "net.minecraft.world.entity.EntityType",
        name: "ITEM",
        javaSignature: "public static final EntityType ITEM",
        jvmDescriptor: "Lnet/minecraft/world/entity/EntityType;",
        accessFlags: 0x0019,
        isSynthetic: false
      }
    ]
  });
  return service;
}

test("unobfuscated responses carry structured flags instead of the two boilerplate sentences", async () => {
  const service = await makeService();

  const result = await service.checkSymbolExists({
    version: "26.2",
    kind: "field",
    owner: "net.minecraft.world.entity.EntityType",
    name: "ITEM",
    sourceMapping: "mojang"
  } as CheckSymbolExistsInput);

  assert.equal(result.resolved, true);
  assert.ok(!result.warnings.some((warning) => GRAPH_SENTENCE_RE.test(warning)));
  assert.ok(!result.warnings.some((warning) => RUNTIME_SENTENCE_RE.test(warning)));
  const context = result.mappingContext as {
    unobfuscatedRuntime?: boolean;
    runtimeValidated?: boolean;
  };
  assert.equal(context.unobfuscatedRuntime, true);
  assert.equal(context.runtimeValidated, true);
});

test("the structured flags shrink the serialized response versus the former sentences", async () => {
  const service = await makeService();

  const result = await service.checkSymbolExists({
    version: "26.2",
    kind: "field",
    owner: "net.minecraft.world.entity.EntityType",
    name: "ITEM",
    sourceMapping: "mojang"
  } as CheckSymbolExistsInput);

  const compactBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  // The true former shape: no flags on mappingContext, both sentences in
  // warnings. This makes the comparison flags-vs-sentences, not a tautology.
  const {
    unobfuscatedRuntime: _graphFlag,
    runtimeValidated: _runtimeFlag,
    ...legacyContext
  } = result.mappingContext as Record<string, unknown>;
  const legacyShape = {
    ...result,
    mappingContext: legacyContext,
    warnings: [
      ...result.warnings,
      "Version 26.2 is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names.",
      "Version 26.2 is unobfuscated; validated symbol existence against runtime bytecode."
    ]
  };
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacyShape), "utf8");

  assert.ok(
    compactBytes < legacyBytes,
    `expected structured flags to be smaller: ${compactBytes} vs ${legacyBytes}`
  );
});

test("find-mapping on unobfuscated versions reports the graph flag without the sentence", async () => {
  const service = await makeService();

  const result = await service.findMapping({
    version: "26.2",
    kind: "class",
    name: "net.minecraft.world.entity.EntityType",
    sourceMapping: "obfuscated",
    targetMapping: "mojang"
  });

  assert.ok(!result.warnings.some((warning) => GRAPH_SENTENCE_RE.test(warning)));
  assert.equal(
    (result.mappingContext as { unobfuscatedRuntime?: boolean }).unobfuscatedRuntime,
    true
  );
});


test("get-class-api-matrix reports the unobfuscated-runtime flag instead of the removed sentence", async () => {
  const service = await makeService();

  const result = await service.getClassApiMatrix({
    version: "26.2",
    className: "net.minecraft.world.entity.EntityType",
    classNameMapping: "mojang"
  });

  assert.ok(!result.warnings.some((warning) => GRAPH_SENTENCE_RE.test(warning)));
  assert.equal(result.unobfuscatedRuntime, true);
});
