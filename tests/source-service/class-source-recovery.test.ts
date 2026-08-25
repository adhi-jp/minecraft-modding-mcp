import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import type { Config } from "../../src/types.ts";
import { buildClassFile } from "../helpers/classfile.ts";
import { withGradleUserHome } from "../helpers/env.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import {
  readCacheAccountingMetrics,
  readSearchModeMetrics,
  readSearchPathMetrics
} from "../helpers/source-service-metrics.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";
import {
  type SourceServiceFixture,
  withVersionApproximationFixture
} from "../helpers/source-service-fixtures.ts";

test("SourceService getClassSource rejects package-incompatible fallback matches", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-pkg-compat-"));
  const binaryJarPath = join(root, "pkg-compat.jar");
  const sourcesJarPath = join(root, "pkg-compat-sources.jar");

  // Tags.java contains an inner class named "Blocks", but lives in a different package.
  // When requesting net.minecraft.world.level.block.Blocks, the service should NOT
  // return Tags.java just because it contains a symbol named "Blocks".
  await createJar(binaryJarPath, {
    "net/neoforged/neoforge/common/Tags.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "net/neoforged/neoforge/common/Tags.java": [
      "package net.neoforged.neoforge.common;",
      "public class Tags {",
      "  public static class Blocks {",
      "    public static final String STONE = \"stone\";",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  // Requesting a class from a completely different package should fail with
  // CLASS_NOT_FOUND rather than returning the wrong file
  await assert.rejects(
    () =>
      service.getClassSource({
        artifactId: resolved.artifactId,
        className: "net.minecraft.world.level.block.Blocks"
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === ERROR_CODES.CLASS_NOT_FOUND
      );
    }
  );
});

test("SourceService getClassSource accepts canonical inner-class dot notation", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-inner-class-dot-"));
  const binaryJarPath = join(root, "inner-class.jar");
  const sourcesJarPath = join(root, "inner-class-sources.jar");

  await createJar(binaryJarPath, {
    "com/example/Outer.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "com/example/Outer$Inner.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "com/example/Outer.java": [
      "package com.example;",
      "public class Outer {",
      "  public static class Inner {",
      "    public static final String VALUE = \"ok\";",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const source = await service.getClassSource({
    artifactId: resolved.artifactId,
    className: "com.example.Outer.Inner"
  });

  assert.match(source.sourceText, /class Outer/);
  assert.match(source.sourceText, /class Inner/);
});

test("getClassSource CLASS_NOT_FOUND preserves representative context details", async (t) => {
  const { SourceService } = await import("../../src/source-service.ts");

  type ClassNotFoundFixture = {
    root: string;
    binaryJarPath: string;
    service: InstanceType<typeof SourceService>;
  };

  async function createClassNotFoundFixture(input: {
    rootPrefix: string;
    binaryJarName: string;
    binaryEntries: Record<string, Buffer>;
    sourceEntries: Record<string, string>;
  }): Promise<ClassNotFoundFixture> {
    const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
    const binaryJarPath = join(root, input.binaryJarName);
    const sourcesJarPath = join(root, input.binaryJarName.replace(/\.jar$/, "-sources.jar"));
    await createJar(binaryJarPath, input.binaryEntries);
    await createJar(sourcesJarPath, input.sourceEntries);

    return {
      root,
      binaryJarPath,
      service: new SourceService(buildTestConfig(root))
    };
  }

  async function expectClassNotFound(
    action: () => Promise<unknown>,
    verify: (details: Record<string, unknown>) => void
  ): Promise<void> {
    await assert.rejects(action, (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      if ((error as { code: string }).code !== ERROR_CODES.CLASS_NOT_FOUND) return false;
      verify((error as { details?: Record<string, unknown> }).details ?? {});
      return true;
    });
  }

  const cases: Array<{
    name: string;
    createFixture: () => Promise<ClassNotFoundFixture>;
    run: (fixture: ClassNotFoundFixture) => Promise<void>;
  }> = [
    {
      name: "includes scope-independent artifact context and retry hints",
      createFixture: () =>
        createClassNotFoundFixture({
          rootPrefix: "service-b1-class-",
          binaryJarName: "server-b1.jar",
          binaryEntries: {
            "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
          },
          sourceEntries: {
            "net/minecraft/server/Main.java": "package net.minecraft.server;\npublic class Main {}"
          }
        }),
      run: async ({ binaryJarPath, service }) => {
        const resolved = await service.resolveArtifact({
          target: { kind: "jar", value: binaryJarPath },
          mapping: "obfuscated"
        });

        await expectClassNotFound(
          () =>
            service.getClassSource({
              artifactId: resolved.artifactId,
              className: "net.minecraft.world.level.block.Blocks",
              mode: "full"
            }),
          (details) => {
            assert.equal(details.artifactId, resolved.artifactId);
            assert.equal(details.mapping, "obfuscated");
            assert.equal(typeof details.nextAction, "string");
            assert.ok(details.suggestedCall != null);
          }
        );
      }
    },
    {
      name: "includes target scope and explicit target coordinates",
      createFixture: () =>
        createClassNotFoundFixture({
          rootPrefix: "service-b1-target-",
          binaryJarName: "server-b1t.jar",
          binaryEntries: {
            "com/example/Existing.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
          },
          sourceEntries: {
            "com/example/Existing.java": "package com.example;\npublic class Existing {}"
          }
        }),
      run: async ({ binaryJarPath, service }) => {
        await expectClassNotFound(
          () =>
            service.getClassSource({
              target: { kind: "jar", value: binaryJarPath },
              className: "com.example.Missing",
              scope: "vanilla",
              mode: "full"
            } as any),
          (details) => {
            assert.equal(details.scope, "vanilla");
            assert.equal(details.targetKind, "jar");
            assert.equal(details.targetValue, binaryJarPath);
          }
        );
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = await testCase.createFixture();
      await testCase.run(fixture);
    });
  }
});

// The hint ends in `mapping="mojang"`, so firing it at a caller who already sent
// a non-obfuscated mapping asks for the argument they just supplied and sends
// them round the same call again. `dropSatisfiedParameterAsks` is the generic
// backstop for exactly that, and it cannot reach this one: it matches an
// imperative "Provide/Pass mapping", while this sentence reads `usually require
// mapping="mojang"`, and the sentence is concatenated into the SAME nextAction
// string as the find-class guidance, which is published as one hint that no
// mid-string excision can repair. So the suppression has to happen at the site.
test("the obfuscated namespace hint is suppressed when the caller already supplied a mapping", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const { buildClassSourceNotFoundError } = await import("../../src/source/class-source.ts");
  const root = await mkdtemp(join(tmpdir(), "class-source-obf-hint-"));
  const service = new SourceService(buildTestConfig(root));

  const base = {
    artifactId: "obf-hint-artifact",
    className: "net.minecraft.world.item.Item",
    lookupClassName: "net.minecraft.world.item.Item",
    mappingApplied: "obfuscated" as const,
    qualityFlags: [] as string[],
    attemptedBinaryFallback: false
  };

  // Control: with no caller-supplied mapping the advice is correct and must
  // survive, otherwise the assertion below would pass on a hint that never fires.
  const omitted = buildClassSourceNotFoundError(service, {
    ...base,
    requestedMapping: "obfuscated" as const
  });
  const omittedNextAction = (omitted.details as { nextAction?: string }).nextAction ?? "";
  assert.ok(
    omittedNextAction.includes("indexed in obfuscated runtime names"),
    `control: the hint must still fire when the caller named no mapping; got: ${omittedNextAction}`
  );

  const supplied = buildClassSourceNotFoundError(service, {
    ...base,
    requestedMapping: "mojang" as const,
    callerSuppliedMapping: "mojang" as const
  });
  const suppliedNextAction = (supplied.details as { nextAction?: string }).nextAction ?? "";
  assert.ok(
    suppliedNextAction.includes("find-class"),
    "the recovery guidance itself must survive the suppression"
  );
  assert.ok(
    !suppliedNextAction.includes("mapping=\"mojang\""),
    `the hint must not re-ask for the mapping the caller already sent; got: ${suppliedNextAction}`
  );
});
