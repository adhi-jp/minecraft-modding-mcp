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

test("SourceService resolves intermediary mapping for source-backed coordinate artifacts", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-intermediary-map-"));
  const coordinate = "com.example:demo:1.0.0";
  const localSourceJarPath = join(
    root,
    "m2",
    "com",
    "example",
    "demo",
    "1.0.0",
    "demo-1.0.0-sources.jar"
  );
  await createJar(localSourceJarPath, {
    "com/example/Demo.java": [
      "package com.example;",
      "public class Demo {}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const mappingCalls: Array<{ version: string; mapping: string }> = [];
  const mappingStub = {
    async ensureMappingAvailable(input: {
      version: string;
      sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
      targetMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    }) {
      mappingCalls.push({ version: input.version, mapping: input.targetMapping });
      return {
        transformChain: ["mapping-source:loom-cache"],
        warnings: []
      };
    }
  };
  (service as unknown as { mappingService: unknown }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    ...mappingStub
  };

  const resolved = await service.resolveArtifact({
    target: {
      kind: "coordinate",
      value: coordinate
    },
    mapping: "intermediary"
  });

  assert.equal(resolved.mappingApplied, "intermediary");
  assert.equal(resolved.requestedMapping, "intermediary");
  assert.equal(resolved.version, "1.0.0");
  assert.ok(resolved.provenance.transformChain.includes("mapping-source:loom-cache"));
  assert.deepEqual(mappingCalls, [{ version: "1.0.0", mapping: "intermediary" }]);
});

test("SourceService accepts unobfuscated mojang mapping for decompiled coordinate artifacts", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-coordinate-unobfuscated-mojang-"));
  const coordinate = "net.minecraft:client:26.1";
  const remoteJarPath = join(root, "client-26.1.jar");
  await createJar(remoteJarPath, {
    "net/minecraft/world/item/Item.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  const remoteJarBytes = await readFile(remoteJarPath);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/net/minecraft/client/26.1/client-26.1-sources.jar")) {
      return new Response("not found", { status: 404 });
    }
    if (url.endsWith("/net/minecraft/client/26.1/client-26.1.jar")) {
      return new Response(remoteJarBytes, {
        status: 200,
        headers: {
          "content-length": String(remoteJarBytes.byteLength),
          etag: "coordinate-26.1"
        }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const service = new SourceService(
      buildTestConfig(root, { sourceRepos: ["https://repo.example.test"] })
    );
    (service as unknown as {
      ingestIfNeeded: (resolved: unknown) => Promise<void>;
    }).ingestIfNeeded = async () => {};

    const resolved = await service.resolveArtifact({
      target: {
        kind: "coordinate",
        value: coordinate
      },
      mapping: "mojang"
    });

    assert.equal(resolved.version, "26.1");
    assert.equal(resolved.requestedMapping, "mojang");
    assert.equal(resolved.mappingApplied, "mojang");
    assert.equal(resolved.origin, "decompiled");
    assert.equal(resolved.resolvedSourceJarPath, undefined);
    assert.equal(resolved.coordinate, coordinate);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SourceService rejects intermediary and yarn mappings when artifact version is unknown", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "service-unsupported-map-"));
  const sourceJarPath = join(root, "server-sources.jar");
  await createJar(sourceJarPath, {
    "com/example/NoVersion.java": [
      "package com.example;",
      "public class NoVersion {}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  let called = false;
  const mappingStub = {
    async ensureMappingAvailable() {
      called = true;
      return { transformChain: [], warnings: [] };
    }
  };
  (service as unknown as { mappingService: unknown }).mappingService = {
    ...(service as unknown as { mappingService: Record<string, unknown> }).mappingService,
    ...mappingStub
  };

  for (const mapping of ["intermediary", "yarn"] as const) {
    await assert.rejects(
      () =>
        service.resolveArtifact({
          target: {
            kind: "jar",
            value: sourceJarPath
          },
          mapping
        }),
      (error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error)) {
          return false;
        }
        if ((error as { code: string }).code !== ERROR_CODES.MAPPING_NOT_APPLIED) {
          return false;
        }
        const details = (error as { details?: Record<string, unknown> }).details;
        return (
          details?.mapping === mapping &&
          typeof details?.nextAction === "string" &&
          details.nextAction.includes("target: { kind: \"version\", value") &&
          typeof details?.suggestedCall === "object" &&
          details.suggestedCall !== null &&
          (details.suggestedCall as { params?: Record<string, unknown> }).params?.target !== undefined
        );
      }
    );
  }
  assert.equal(called, false);
});

test("SourceService delegates representative mapping queries to MappingService", async (t) => {
  const cases: Array<{
    name: string;
    rootPrefix: string;
    method:
      | "findMapping"
      | "resolveMethodMappingExact"
      | "getClassApiMatrix"
      | "checkSymbolExists";
    input: Record<string, unknown>;
    response: Record<string, unknown>;
    verifyDelegateInput: (input: Record<string, unknown>) => void;
    verifyResult: (result: Record<string, unknown>) => void;
  }> = [
    {
      name: "findMapping returns lookup payload",
      rootPrefix: "service-find-mapping-",
      method: "findMapping",
      input: {
        version: "1.21.10",
        kind: "class",
        name: "a.b.C",
        sourceMapping: "obfuscated",
        targetMapping: "mojang",
        maxCandidates: 1
      },
      response: {
        querySymbol: {
          kind: "class",
          name: "a.b.C",
          symbol: "a.b.C"
        },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "obfuscated",
          targetMapping: "mojang"
        },
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "class",
          name: "net.minecraft.server.Main",
          symbol: "net.minecraft.server.Main"
        },
        candidates: [
          {
            kind: "class",
            name: "net.minecraft.server.Main",
            symbol: "net.minecraft.server.Main",
            matchKind: "exact",
            confidence: 1
          }
        ],
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.version, "1.21.10");
        assert.equal(input.kind, "class");
        assert.equal(input.maxCandidates, 1);
      },
      verifyResult: (result) => {
        assert.equal((result.candidates as Array<{ symbol: string }>)[0]?.symbol, "net.minecraft.server.Main");
      }
    },
    {
      name: "resolveMethodMappingExact forwards maxCandidates",
      rootPrefix: "service-method-exact-",
      method: "resolveMethodMappingExact",
      input: {
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(Ljava/lang/String;)V",
        sourceMapping: "obfuscated",
        targetMapping: "mojang",
        maxCandidates: 1
      },
      response: {
        querySymbol: {
          kind: "method",
          owner: "a.b.C",
          name: "f",
          descriptor: "(Ljava/lang/String;)V",
          symbol: "a.b.C.f(Ljava/lang/String;)V"
        },
        mappingContext: {
          version: "1.21.10",
          sourceMapping: "obfuscated",
          targetMapping: "mojang",
          sourcePriorityApplied: "loom-first"
        },
        resolved: true,
        status: "resolved",
        resolvedSymbol: {
          kind: "method",
          owner: "com.example.ValueOutput",
          name: "remove",
          descriptor: "(Ljava/lang/String;)V",
          symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V"
        },
        candidates: [
          {
            kind: "method",
            owner: "com.example.ValueOutput",
            name: "remove",
            descriptor: "(Ljava/lang/String;)V",
            symbol: "com.example.ValueOutput.remove(Ljava/lang/String;)V",
            matchKind: "exact",
            confidence: 1
          }
        ],
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.maxCandidates, 1);
        assert.equal(input.owner, "a.b.C");
      },
      verifyResult: (result) => {
        assert.equal(result.resolved, true);
        assert.equal(
          (result.resolvedSymbol as { name?: string } | undefined)?.name,
          "remove"
        );
      }
    },
    {
      name: "getClassApiMatrix forwards maxRows",
      rootPrefix: "service-class-matrix-",
      method: "getClassApiMatrix",
      input: {
        version: "1.21.10",
        className: "a.b.C",
        classNameMapping: "obfuscated",
        maxRows: 2
      },
      response: {
        classIdentity: {
          obfuscated: "a.b.C",
          mojang: "com.example.ValueOutput",
          intermediary: "intermediary/pkg/ValueOutput",
          yarn: "net/minecraft/nbt/visitors/StringNbtWriter$ValueOutput"
        },
        rows: [],
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.className, "a.b.C");
        assert.equal(input.maxRows, 2);
      },
      verifyResult: (result) => {
        assert.equal(
          (result.classIdentity as Record<string, string | undefined>).mojang,
          "com.example.ValueOutput"
        );
      }
    },
    {
      name: "checkSymbolExists forwards maxCandidates",
      rootPrefix: "service-symbol-exists-",
      method: "checkSymbolExists",
      input: {
        version: "1.21.10",
        kind: "method",
        owner: "a.b.C",
        name: "f",
        descriptor: "(I)V",
        sourceMapping: "obfuscated",
        maxCandidates: 1
      },
      response: {
        resolved: true,
        status: "resolved",
        warnings: []
      },
      verifyDelegateInput: (input) => {
        assert.equal(input.maxCandidates, 1);
        assert.equal(input.name, "f");
      },
      verifyResult: (result) => {
        assert.equal(result.resolved, true);
        assert.equal(result.status, "resolved");
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { SourceService } = await import("../../src/source-service.ts");
      const root = await mkdtemp(join(tmpdir(), testCase.rootPrefix));
      const service = new SourceService(buildTestConfig(root));

      (service as unknown as { mappingService: Record<string, (input: unknown) => Promise<unknown>> }).mappingService = {
        [testCase.method]: async (input: unknown) => {
          testCase.verifyDelegateInput(input as Record<string, unknown>);
          return testCase.response;
        }
      };

      const result = await (
        service as unknown as Record<string, (input: Record<string, unknown>) => Promise<Record<string, unknown>>>
      )[testCase.method](testCase.input);

      testCase.verifyResult(result);
    });
  }
});
