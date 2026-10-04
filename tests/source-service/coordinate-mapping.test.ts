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
        const examples = details?.exampleCalls as
          | Array<{ params?: { target?: { kind?: string; value?: string } } }>
          | undefined;
        return (
          details?.mapping === mapping &&
          typeof details?.nextAction === "string" &&
          details.nextAction.includes("target: { kind: \"version\", value") &&
          // The recovery advice must be usable: a jar path is not a version id,
          // so it may never be handed back as a version target's value. The
          // version is offered as a template the caller fills in instead.
          details?.suggestedCall === undefined &&
          examples?.length === 1 &&
          examples[0]?.params?.target?.kind === "version" &&
          examples[0]?.params?.target?.value === "<your-mc-version>"
        );
      }
    );
  }
  assert.equal(called, false);
});
