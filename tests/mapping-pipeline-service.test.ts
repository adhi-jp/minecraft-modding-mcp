import assert from "node:assert/strict";
import test from "node:test";

import { applyMappingPipeline } from "../src/mapping-pipeline-service.ts";

test("applyMappingPipeline keeps mojang for unobfuscated decompiled runtime artifacts", () => {
  const result = applyMappingPipeline({
    requestedMapping: "mojang",
    runtimeNamesUnobfuscated: true,
    target: { kind: "version", value: "26.1" },
    resolved: {
      artifactId: "artifact-unobf-decompiled",
      artifactSignature: "sig",
      origin: "decompiled",
      binaryJarPath: "/tmp/client-26.1.jar",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: [],
      isDecompiled: true,
      resolvedAt: new Date().toISOString()
    }
  });

  assert.deepEqual(result, {
    mappingApplied: "mojang",
    qualityFlags: ["decompiled"],
    transformChain: ["mapping:mojang-runtime-unobfuscated"]
  });
});

test("applyMappingPipeline keeps mojang for unobfuscated source-backed runtime artifacts", () => {
  const result = applyMappingPipeline({
    requestedMapping: "mojang",
    runtimeNamesUnobfuscated: true,
    target: { kind: "version", value: "26.1" },
    resolved: {
      artifactId: "artifact-unobf-source",
      artifactSignature: "sig",
      origin: "local-jar",
      binaryJarPath: "/tmp/client-26.1.jar",
      sourceJarPath: "/tmp/client-26.1-sources.jar",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: [],
      isDecompiled: false,
      resolvedAt: new Date().toISOString()
    }
  });

  assert.deepEqual(result, {
    mappingApplied: "mojang",
    qualityFlags: ["source-backed"],
    transformChain: ["mapping:mojang-runtime-unobfuscated"]
  });
});

test("applyMappingPipeline authorizes binary-remap when mojang lands on binary-only artifact and gate is open", () => {
  const result = applyMappingPipeline({
    requestedMapping: "mojang",
    target: { kind: "version", value: "1.21.10" },
    allowBinaryRemap: true,
    resolved: {
      artifactId: "artifact-binary-only",
      artifactSignature: "sig",
      origin: "decompiled",
      binaryJarPath: "/tmp/client-1.21.10.jar",
      requestedMapping: "mojang",
      mappingApplied: "mojang",
      qualityFlags: [],
      isDecompiled: true,
      resolvedAt: new Date().toISOString()
    }
  });

  assert.deepEqual(result, {
    mappingApplied: "mojang",
    qualityFlags: ["binary-remapped", "decompiled"],
    transformChain: ["binary-remap:obf->mojang", "decompile:vineflower"]
  });
});

test("applyMappingPipeline still throws MAPPING_NOT_APPLIED when binary-only artifact is missing the gate", () => {
  assert.throws(
    () =>
      applyMappingPipeline({
        requestedMapping: "mojang",
        target: { kind: "version", value: "1.21.10" },
        allowBinaryRemap: false,
        resolved: {
          artifactId: "artifact-binary-only",
          artifactSignature: "sig",
          origin: "decompiled",
          binaryJarPath: "/tmp/client-1.21.10.jar",
          requestedMapping: "mojang",
          mappingApplied: "mojang",
          qualityFlags: [],
          isDecompiled: true,
          resolvedAt: new Date().toISOString()
        }
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ERR_MAPPING_NOT_APPLIED"
      );
    }
  );
});

test("applyMappingPipeline ignores allowBinaryRemap when binary jar path is also missing", () => {
  assert.throws(
    () =>
      applyMappingPipeline({
        requestedMapping: "mojang",
        target: { kind: "version", value: "1.21.10" },
        allowBinaryRemap: true,
        resolved: {
          artifactId: "artifact-no-binary",
          artifactSignature: "sig",
          origin: "decompiled",
          requestedMapping: "mojang",
          mappingApplied: "mojang",
          qualityFlags: [],
          isDecompiled: true,
          resolvedAt: new Date().toISOString()
        }
      }),
    (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ERR_MAPPING_NOT_APPLIED"
      );
    }
  );
});
